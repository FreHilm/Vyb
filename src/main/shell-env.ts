import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

/**
 * On macOS (and Linux desktop launchers) GUI processes inherit a minimal
 * PATH from launchd / the desktop. The user's interactive shell rc files
 * (~/.zshrc, ~/.zshenv, ~/.bash_profile, etc.) never run inside Electron,
 * so any PATH additions, tool managers (mise/asdf/nvm/rbenv/pyenv), per-
 * tool prefixes (~/.opencode/bin, ~/.bun/bin), or env vars defined there
 * are invisible to spawned PTYs that go straight to a binary.
 *
 * VS Code, GitHub Desktop, etc. work around this by spawning a login +
 * interactive shell once at startup, asking it to print `env`, and using
 * the result as the inherited environment for all child processes. We do
 * the same here.
 *
 * The resolution is best-effort and bounded by a timeout — if the user's
 * rc files hang or print unexpected output we fall back to process.env.
 */

let resolved: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;

const START_MARKER = '__AGENTDISPATCH_SHELL_ENV_START__';
const END_MARKER = '__AGENTDISPATCH_SHELL_ENV_END__';

function isExecutableFile(p: string): boolean {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultShell(): string {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'cmd.exe';
  // Validate the OS-supplied path is actually an executable file —
  // a chsh mishap or /etc/shells typo can leave $SHELL pointing at a
  // directory (e.g. `/opt/homebrew/Cellar/bash` instead of the
  // `.../5.2.2/bin/bash` binary inside it), at which point a naive
  // spawn fails with EACCES. Fall through the candidate list when
  // the OS-supplied value isn't usable.
  const candidates: string[] = [];
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  for (const c of candidates) {
    if (isExecutableFile(c)) return c;
  }
  return '/bin/sh';
}

/**
 * Strip pollution that only exists when Vyb itself is launched from an
 * npm script (`npm start` dev mode). npm injects `npm_*` config/lifecycle
 * vars + `INIT_CWD`, and prepends a `…/@npmcli/run-script/…/node-gyp-bin`
 * entry to PATH. None of these are ever set by a user's rc files. If they
 * flow into an agent's PTY, a child `npm install -g` (e.g. Codex's own
 * "Update now") inherits the wrong prefix and tools resolve oddly. We only
 * touch the lowercase `npm_*` set npm injects — a user's deliberate
 * `NPM_CONFIG_*` (uppercase, exported in rc) is left intact.
 */
function scrubNpmLifecycle(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('npm_') || k === 'INIT_CWD') continue;
    out[k] = v;
  }
  const pathKey = Object.keys(out).find((k) => k.toLowerCase() === 'path');
  if (pathKey && out[pathKey]) {
    out[pathKey] = out[pathKey]
      .split(':')
      .filter((p) => p && !p.includes('node-gyp-bin'))
      .join(':');
  }
  return out;
}

function parseEnvBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    // Reject keys that aren't valid env var names — defensive against
    // multi-line values from upstream `env` output.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = line.slice(eq + 1);
  }
  return out;
}

async function runShellAndCaptureEnv(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    // Warm-up: lazy-loaded version managers (the common "define node/npm as
    // a function that sources nvm.sh on first call" pattern) leave their
    // bin dir OFF the PATH until something actually invokes them. A plain
    // `env` capture would miss it. So before capturing, nudge nvm to load
    // + activate its default. Output is silenced and it precedes the START
    // marker, so it never pollutes the parsed env. Best-effort (`|| true`):
    // shells without nvm just no-op. (fnm/Volta/asdf/mise are covered
    // deterministically by the shim-dir resolvers in pty-manager.)
    const warmup = '{ command -v nvm >/dev/null 2>&1 && nvm use default >/dev/null 2>&1; } >/dev/null 2>&1 || true;';
    const cmd = `${warmup} echo ${START_MARKER}; env; echo ${END_MARKER}`;
    // -l = login shell (sources ~/.zprofile, ~/.bash_profile, etc.)
    // -i = interactive (sources ~/.zshrc, ~/.bashrc)
    // Both together cover the common rc-file locations users actually edit.
    const child = spawn(shell, ['-l', '-i', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 10000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const start = stdout.indexOf(START_MARKER);
      const end = stdout.indexOf(END_MARKER);
      if (start < 0 || end <= start) {
        // Markers missing — the user's rc files probably crashed, hung,
        // or short-circuited before our `env` call. Log so the issue
        // is at least visible in `npm start`'s console; we'll still
        // fall back to process.env with PATH supplements applied
        // downstream in pty-manager.ts.
        console.warn(`[shell-env] capture from "${shell}" failed (exit ${code}); falling back to process.env`);
        resolve({});
        return;
      }
      const block = stdout.slice(start + START_MARKER.length, end);
      const parsed = parseEnvBlock(block);
      if (Object.keys(parsed).length === 0) {
        console.warn(`[shell-env] captured empty env from "${shell}" (markers matched but body parsed to nothing)`);
      }
      resolve(parsed);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[shell-env] failed to spawn "${shell}":`, err.message);
      resolve({});
    });
  });
}

/**
 * Resolve and cache the user's shell environment. Idempotent — call as
 * many times as you want; only the first call actually shells out.
 */
export async function resolveShellEnv(): Promise<Record<string, string>> {
  if (resolved) return resolved;
  if (inflight) return inflight;

  // Windows: GUI processes already inherit the user's PATH from the
  // registry, so this dance is unnecessary (and would just add cost).
  if (os.platform() === 'win32') {
    resolved = { ...(process.env as Record<string, string>) };
    return resolved;
  }

  inflight = (async () => {
    const shell = defaultShell();
    // defaultShell already validates executability; this is just a
    // last-ditch guard against an edge case where the chosen binary
    // is removed between resolution and spawn.
    if (!isExecutableFile(shell)) {
      console.warn(`[shell-env] no usable shell found; falling back to process.env`);
      resolved = scrubNpmLifecycle({ ...(process.env as Record<string, string>) });
      return resolved;
    }
    const env = await runShellAndCaptureEnv(shell);
    // Merge over process.env so we never *lose* anything Electron set; the
    // shell-resolved values take precedence.
    const merged = { ...(process.env as Record<string, string>), ...env };
    resolved = scrubNpmLifecycle(merged);
    return resolved;
  })();

  return inflight;
}

/** Synchronous accessor for already-resolved env. Returns null if not loaded yet. */
export function getResolvedShellEnv(): Record<string, string> | null {
  return resolved;
}
