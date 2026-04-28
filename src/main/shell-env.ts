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

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (os.platform() === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return '/bin/zsh';
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
    const cmd = `echo ${START_MARKER}; env; echo ${END_MARKER}`;
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

    child.on('close', () => {
      clearTimeout(timer);
      const start = stdout.indexOf(START_MARKER);
      const end = stdout.indexOf(END_MARKER);
      if (start < 0 || end <= start) {
        resolve({});
        return;
      }
      const block = stdout.slice(start + START_MARKER.length, end);
      resolve(parseEnvBlock(block));
    });

    child.on('error', () => {
      clearTimeout(timer);
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
    if (!fs.existsSync(shell)) {
      const fallback = { ...(process.env as Record<string, string>) };
      resolved = fallback;
      return fallback;
    }
    const env = await runShellAndCaptureEnv(shell);
    // Merge over process.env so we never *lose* anything Electron set; the
    // shell-resolved values take precedence.
    const merged = { ...(process.env as Record<string, string>), ...env };
    resolved = merged;
    return merged;
  })();

  return inflight;
}

/** Synchronous accessor for already-resolved env. Returns null if not loaded yet. */
export function getResolvedShellEnv(): Record<string, string> | null {
  return resolved;
}
