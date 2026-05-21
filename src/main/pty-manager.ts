import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import { Profile } from '../shared/types';
import { getResolvedShellEnv } from './shell-env';

// Common per-user binary dirs that should be on PATH regardless of
// whether the user's interactive shell env capture worked. Electron
// launched from Finder/dock inherits a minimal PATH from launchd
// missing these. We always supplement so a bash user whose rc file
// resolution stumbled doesn't end up with PTYs that can't find
// `node`, `npx`, `claude`, etc. Cheap: each candidate is a single
// existsSync; entries already in PATH are skipped.
function supplementPath(currentPath: string): string {
  if (os.platform() === 'win32') return currentPath;
  const home = os.homedir();
  const candidates = [
    `${home}/.local/bin`,
    `${home}/.opencode/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.deno/bin`,
    `${home}/.npm-global/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const existing = new Set(currentPath.split(':').filter(Boolean));
  try {
    const extra = candidates.filter((c) => fs.existsSync(c) && !existing.has(c));
    if (extra.length > 0) return extra.join(':') + (currentPath ? ':' + currentPath : '');
  } catch { /* keep currentPath as-is */ }
  return currentPath;
}

// Resolve the best login shell to spawn for a plain shell-terminal
// (no agent command). Picks the user's actual $SHELL first so bash
// users get bash, fish users get fish, etc. — historically this was
// hardcoded to `/bin/zsh`, which silently broke pre-Catalina macs
// (no zsh installed) and is surprising for anyone deliberately
// running another shell. Falls back to zsh, then bash if zsh is
// missing.
function loginShellPath(envShell?: string): string {
  if (os.platform() === 'win32') return 'powershell.exe';
  const candidates: string[] = [];
  if (envShell) candidates.push(envShell);
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return '/bin/sh'; // unreachable in practice — /bin/sh ships everywhere
}

interface PtyInstance {
  process: pty.IPty;
  profile: Profile;
}

export class PtyManager {
  private ptys: Map<string, PtyInstance> = new Map();
  private onData: (profileId: string, data: string) => void;
  private onExit: (profileId: string, exitCode: number) => void;

  constructor(
    onData: (profileId: string, data: string) => void,
    onExit: (profileId: string, exitCode: number) => void,
  ) {
    this.onData = onData;
    this.onExit = onExit;
  }

  create(
    profileId: string,
    profile: Profile,
    cols = 80,
    rows = 24,
    extraEnv?: Record<string, string>,
  ): void {
    if (this.ptys.has(profileId)) {
      this.destroy(profileId);
    }

    // Build the agent command (if any)
    let agentCmd: string | null = null;
    if (profile.command) {
      if ((!profile.args || profile.args.length === 0) && profile.command.includes(' ')) {
        agentCmd = profile.command;
      } else {
        agentCmd = [profile.command, ...(profile.args || [])].join(' ');
      }
    }

    let spawnCmd: string;
    let spawnArgs: string[];

    // Build clean env for child processes. Prefer the env resolved from the
    // user's interactive shell (zshrc/zshenv/.bash_profile/etc.) so PATH +
    // tool managers (asdf/mise/nvm/rbenv/pyenv/...) are visible. Fall back
    // to process.env if the resolution didn't run or returned empty.
    const shellResolved = getResolvedShellEnv();
    const baseEnv: Record<string, string> = shellResolved
      ? { ...shellResolved }
      : { ...(process.env as Record<string, string>) };
    // ALWAYS layer the candidate per-user binary dirs over whatever PATH
    // we ended up with. This used to only run on the fallback path, so a
    // user whose shell env capture "succeeded" but came back missing
    // /opt/homebrew/bin (common on bash setups where -l -i -c behaves
    // differently than under zsh) silently ended up with terminals that
    // couldn't find `node`, `npx`, `claude`. Cheap belt-and-suspenders.
    baseEnv.PATH = supplementPath(baseEnv.PATH || '');

    if (agentCmd) {
      // Split command into cmd + args and spawn directly
      const parts = agentCmd.split(/\s+/);
      spawnCmd = parts[0];
      spawnArgs = parts.slice(1);
    } else {
      // No command — open the user's preferred login shell rather than
      // hardcoded zsh. Bash / fish / other-shell users now get their
      // actual shell. `-l` makes it a *login* shell, matching what
      // Terminal.app does on macOS: bash sources .bash_profile /
      // .profile / .bash_login; zsh sources .zprofile + .zshrc. This
      // is critical for bash users — without -l, bash starts as a
      // non-login interactive shell that skips .bash_profile, and any
      // PATH / prompt setup that lives only there isn't applied,
      // which on some configs makes the shell exit immediately.
      spawnCmd = loginShellPath(baseEnv.SHELL);
      spawnArgs = spawnCmd === '/bin/sh' ? [] : ['-l'];
    }

    let cwd = profile.workingDirectory || os.homedir();
    if (cwd.startsWith('~')) {
      cwd = cwd.replace(/^~/, os.homedir());
    }

    const spawnEnv: Record<string, string> = {
      ...baseEnv,
      HOME: baseEnv.HOME || os.homedir(),
      USER: baseEnv.USER || process.env.USER || os.userInfo().username,
      LOGNAME: baseEnv.LOGNAME || process.env.LOGNAME || os.userInfo().username,
      SHELL: baseEnv.SHELL || process.env.SHELL || '/bin/zsh',
      LANG: baseEnv.LANG || process.env.LANG || 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: baseEnv.TMPDIR || process.env.TMPDIR || '/tmp',
    };
    // Remove vars that interfere with child CLI tools
    delete spawnEnv.NODE_ENV;
    delete spawnEnv.ELECTRON_RUN_AS_NODE;
    delete spawnEnv.__CFBundleIdentifier;
    spawnEnv.XPC_SERVICE_NAME = '0';

    // Apply caller-supplied env (e.g. ORDNA_AGENT_HOOK_*)
    if (extraEnv) {
      for (const [k, v] of Object.entries(extraEnv)) {
        spawnEnv[k] = v;
      }
    }

    const ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: spawnEnv,
    });

    ptyProcess.onData((data) => {
      this.onData(profileId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      // Surface non-zero exits so users diagnosing "my terminal closed
      // immediately" can see the underlying cause in `npm start`'s
      // console. 127 = command-not-found (PATH issue), 126 = found
      // but not executable, 2 = bash syntax error in rc files,
      // negative / signal codes = killed.
      if (exitCode !== 0) {
        console.warn(`[pty] ${profileId} exited code=${exitCode} cmd="${spawnCmd}" args=${JSON.stringify(spawnArgs)}`);
      }
      this.onExit(profileId, exitCode);
    });

    this.ptys.set(profileId, { process: ptyProcess, profile });
  }

  write(profileId: string, data: string): void {
    const instance = this.ptys.get(profileId);
    if (instance) {
      instance.process.write(data);
    }
  }

  resize(profileId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(profileId);
    if (instance) {
      try {
        instance.process.resize(cols, rows);
      } catch {
        // Process may have exited
      }
    }
  }

  destroy(profileId: string): void {
    const instance = this.ptys.get(profileId);
    if (instance) {
      try {
        instance.process.kill();
      } catch {
        // Already dead
      }
      this.ptys.delete(profileId);
    }
  }

  destroyAll(): void {
    for (const [id] of this.ptys) {
      this.destroy(id);
    }
  }
}
