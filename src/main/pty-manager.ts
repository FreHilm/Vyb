import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import { Profile } from '../shared/types';
import { getResolvedShellEnv } from './shell-env';

// Final fallback PATH if the user's interactive shell didn't resolve cleanly.
// Electron launched from Finder/dock inherits a minimal PATH from launchd
// that is missing tool-prefix dirs the user has in their ~/.zshrc.
function fallbackPath(): string {
  let p = process.env.PATH || '';
  if (os.platform() === 'win32') return p;
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
  try {
    const extra = candidates.filter((c) => fs.existsSync(c) && !p.includes(c));
    if (extra.length > 0) p = extra.join(':') + ':' + p;
  } catch { /* keep p as-is */ }
  return p;
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

    if (agentCmd) {
      // Split command into cmd + args and spawn directly
      const parts = agentCmd.split(/\s+/);
      spawnCmd = parts[0];
      spawnArgs = parts.slice(1);
    } else {
      // No command — open an interactive shell
      spawnCmd = os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh';
      spawnArgs = [];
    }

    let cwd = profile.workingDirectory || os.homedir();
    if (cwd.startsWith('~')) {
      cwd = cwd.replace(/^~/, os.homedir());
    }

    // Build clean env for child processes. Prefer the env resolved from the
    // user's interactive shell (zshrc/zshenv/etc.) so PATH and tool managers
    // (asdf/mise/nvm/rbenv/pyenv/...) are visible. Fall back to process.env
    // if the resolution didn't run or hadn't completed.
    const shellResolved = getResolvedShellEnv();
    const baseEnv: Record<string, string> = shellResolved
      ? { ...shellResolved }
      : { ...(process.env as Record<string, string>), PATH: fallbackPath() };

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
