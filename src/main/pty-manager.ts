import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Profile } from '../shared/types';
import { getResolvedShellEnv } from './shell-env';

// Compare two nvm version dir names ("v24.14.1") numerically so the
// newest sorts last. Non-numeric segments compare as 0.
function compareNodeVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Resolve the nvm node `bin` dir the user would get in a terminal.
//
// nvm activates a version by mutating the *current shell's* PATH; that
// doesn't survive Vyb's env capture, which spawns a non-interactive,
// TTY-less shell where `nvm.sh` often doesn't re-apply the default. So
// node CLIs installed under nvm (codex, gemini) silently fall off the
// agent's PATH. We replicate nvm's own resolution: honor the `default`
// alias if it maps to an installed version, else fall back to the newest
// installed. Returns null when nvm isn't present.
function nvmDefaultBin(home: string): string | null {
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    const installed = fs.readdirSync(versionsDir).filter((d) => d.startsWith('v'));
    if (installed.length === 0) return null;

    let chosen = '';
    try {
      const alias = fs.readFileSync(path.join(home, '.nvm', 'alias', 'default'), 'utf8').trim();
      if (alias) {
        const norm = alias.startsWith('v') ? alias : `v${alias}`;
        if (installed.includes(norm)) {
          chosen = norm; // exact version, e.g. "24.14.1"
        } else {
          // Partial ("24" / "v24") → newest installed under that prefix.
          const prefix = norm.replace(/\.+$/, '');
          const matches = installed.filter((v) => v === prefix || v.startsWith(prefix + '.'));
          if (matches.length) chosen = matches.sort(compareNodeVersions)[matches.length - 1];
        }
      }
    } catch { /* no default alias — fall through to newest */ }

    if (!chosen) chosen = installed.slice().sort(compareNodeVersions)[installed.length - 1];
    const bin = path.join(versionsDir, chosen, 'bin');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null; // no ~/.nvm/versions/node
  }
}

// fnm has the same TTY-activation gap as nvm. Its `default` alias is a
// symlink to the active version's install dir; resolve it (or fall back to
// the newest installed version) and return that `bin`. fnm's data dir
// varies, so we probe the common locations.
function fnmDefaultBin(home: string): string | null {
  const roots = [
    process.env.FNM_DIR,
    path.join(home, '.fnm'),
    path.join(home, 'Library', 'Application Support', 'fnm'),
    path.join(home, '.local', 'share', 'fnm'),
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    try {
      // The `default` alias symlinks to <root>/node-versions/<v>/installation.
      const aliasInstall = path.join(root, 'aliases', 'default');
      const bin = path.join(fs.realpathSync(aliasInstall), 'bin');
      if (fs.existsSync(bin)) return bin;
    } catch { /* no default alias in this root */ }
    try {
      const versionsDir = path.join(root, 'node-versions');
      const installed = fs.readdirSync(versionsDir).filter((d) => d.startsWith('v'));
      if (installed.length) {
        const newest = installed.sort(compareNodeVersions)[installed.length - 1];
        const bin = path.join(versionsDir, newest, 'installation', 'bin');
        if (fs.existsSync(bin)) return bin;
      }
    } catch { /* no node-versions in this root */ }
  }
  return null;
}

// Common per-user binary dirs that should be on PATH regardless of
// whether the user's interactive shell env capture worked. Electron
// launched from Finder/dock inherits a minimal PATH from launchd
// missing these. We always supplement so a bash user whose rc file
// resolution stumbled doesn't end up with PTYs that can't find
// `node`, `npx`, `claude`, etc. Cheap: each candidate is a single
// existsSync; entries already in PATH are skipped.
function supplementPath(currentPath: string): string {
  const home = os.homedir();
  // Windows GUI processes inherit the user's registry PATH, but per-user
  // tool installers (the native `claude` installer drops `claude.exe` in
  // %USERPROFILE%\.local\bin, npm puts shims in %APPDATA%\npm, scoop/bun/
  // cargo have their own dirs) frequently aren't on it — leaving PTYs
  // unable to resolve `claude`, `npx`, etc. exactly like the launchd
  // problem on macOS. Supplement with `;` separators and case-insensitive
  // dedupe (Windows paths are case-insensitive).
  if (os.platform() === 'win32') {
    const candidates = [
      path.join(home, '.local', 'bin'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, 'scoop', 'shims'),
    ].filter(Boolean);
    const existing = new Set(
      currentPath.split(';').filter(Boolean).map((p) => p.toLowerCase()),
    );
    try {
      const extra = candidates.filter(
        (c) => fs.existsSync(c) && !existing.has(c.toLowerCase()),
      );
      if (extra.length > 0) return extra.join(';') + (currentPath ? ';' + currentPath : '');
    } catch { /* keep currentPath as-is */ }
    return currentPath;
  }
  const candidates = [
    // Version-manager node dirs first — so node CLIs (codex, gemini) and
    // `node` itself resolve to the version the user gets in a terminal,
    // which the TTY-less env capture frequently drops. nvm/fnm need their
    // active version resolved; Volta/asdf/mise expose stable shim dirs that
    // dispatch to the right version themselves.
    nvmDefaultBin(home),
    fnmDefaultBin(home),
    `${home}/.volta/bin`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/mise/shims`,
    `${home}/.local/bin`,
    `${home}/.opencode/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.deno/bin`,
    `${home}/.npm-global/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ].filter((c): c is string => !!c);
  const existing = new Set(currentPath.split(':').filter(Boolean));
  try {
    const extra = candidates.filter((c) => fs.existsSync(c) && !existing.has(c));
    if (extra.length > 0) return extra.join(':') + (currentPath ? ':' + currentPath : '');
  } catch { /* keep currentPath as-is */ }
  return currentPath;
}

// Resolve a bare command name (e.g. `claude`) to a full executable path on
// Windows. node-pty's Windows backend doesn't reliably search the PATH from
// the *passed* env when resolving the spawn target — so without this a
// freshly-supplemented PATH wouldn't help. We replicate cmd.exe's lookup:
// walk each PATH dir × each PATHEXT extension and return the first real file.
// Commands that already carry a directory or extension are trusted as-is;
// if nothing matches we return the original so spawn() fails with the banner.
function resolveWindowsCommand(cmd: string, pathEnv: string): string {
  if (!cmd || cmd.includes('\\') || cmd.includes('/') || path.extname(cmd)) {
    return cmd;
  }
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathEnv.split(';').filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
  }
  return cmd;
}

// True when `p` is a regular file with at least one executable bit
// set. Used to reject $SHELL values that point at a directory or a
// non-executable — both observed in the wild on a user whose
// /etc/shells had a typo and ended up with `chsh -s
// /opt/homebrew/Cellar/bash` (a directory, not the bash binary
// inside it). Without this check, `fs.existsSync()` returned true
// for the directory and node-pty's spawn failed with EACCES,
// closing the terminal silently.
export function isExecutableFile(p: string): boolean {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Resolve the best login shell to spawn for a plain shell-terminal
// (no agent command). Picks the user's actual $SHELL first so bash
// users get bash, fish users get fish, etc. — historically this was
// hardcoded to `/bin/zsh`, which silently broke pre-Catalina macs
// (no zsh installed) and is surprising for anyone deliberately
// running another shell. Falls back to zsh, then bash, then sh.
// Crucially each candidate is validated as an actual executable
// file, not just `existsSync` — directories and non-executables
// would pass an existence check but break spawn().
export function loginShellPath(envShell?: string): string {
  if (os.platform() === 'win32') return 'powershell.exe';
  const candidates: string[] = [];
  if (envShell) candidates.push(envShell);
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  for (const c of candidates) {
    if (isExecutableFile(c)) return c;
  }
  return '/bin/sh'; // unreachable in practice — /bin/sh ships everywhere
}

interface PtyInstance {
  process: pty.IPty;
  profile: Profile;
  // node-pty's onData/onExit return IDisposable. We keep them so
  // destroy() can detach our callbacks *before* killing — otherwise
  // our onExit fires during app teardown and tries to IPC to an
  // already-destroyed window.
  disposables: { dispose(): void }[];
  /** True when this PTY is hosting the user's interactive shell directly
   * (no agent command was set on the profile). Used by the Windows Ctrl+C
   * helper to decide whether sending a console-ctrl event is safe — agent
   * CLIs read `\x03` as a TUI key and a second signal can over-cancel. */
  isShell: boolean;
}

export class PtyManager {
  private ptys: Map<string, PtyInstance> = new Map();
  private onData: (profileId: string, data: string) => void;
  private onExit: (profileId: string, exitCode: number) => void;
  // Set during destroyAll() on quit so a late exit event doesn't run
  // the normal onExit path while the app is shutting down.
  private disposing = false;

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
    let bareAgentCmd: string | null = null;

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
    //
    // Windows stores the var as `Path` (any casing). Spreading process.env
    // into a plain object loses Node's case-insensitive proxy, so we must
    // locate the existing key and update *it* — writing a fresh `PATH` would
    // leave a second, conflicting key and node-pty might read the stale one.
    const pathKey =
      Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const resolvedPath = supplementPath(baseEnv[pathKey] || '');
    baseEnv[pathKey] = resolvedPath;

    if (agentCmd) {
      // Split command into cmd + args and spawn directly.
      const parts = agentCmd.split(/\s+/);
      spawnCmd = parts[0];
      spawnArgs = parts.slice(1);
      // Remember the bare name so a spawn failure can invalidate its
      // cached resolution (binary moved / updated / uninstalled).
      bareAgentCmd = parts[0];
      if (os.platform() === 'win32') {
        // The agent CLIs (claude, codex, gemini, opencode) install as
        // .cmd / .ps1 shims via npm's global bin. node-pty →
        // CreateProcess does no PATHEXT lookup, so a bare "claude"
        // fails with ENOENT even though it works typed in a shell.
        // First resolve it to a full path on PATH...
        const resolved = resolveWindowsCommand(spawnCmd, resolvedPath);
        if (/\.(cmd|bat)$/i.test(resolved)) {
          // ...then route batch shims through cmd.exe — CreateProcess
          // can't execute a .cmd/.bat directly. `/c` exits cmd when
          // the agent exits.
          spawnArgs = ['/c', resolved, ...spawnArgs];
          spawnCmd = process.env.COMSPEC || 'cmd.exe';
        } else {
          // Real .exe (or anything else) runs directly.
          spawnCmd = resolved;
        }
      }
      // macOS/Linux: no per-spawn resolution needed — supplementPath()
      // above has already put the right tool dirs (nvm/fnm default node,
      // Volta/asdf/mise shims, ~/.local/bin, Homebrew) on PATH, so node-pty
      // resolves the bare command to the same binary a terminal would.
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

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: spawnEnv,
      });
    } catch (err) {
      // Synchronous spawn failure — common when the resolved binary
      // is a directory, missing the executable bit, or the cwd is
      // unreadable. Previously this dropped through silently and the
      // renderer just closed the pane ("flickered and died"). Now we
      // synthesize a red error banner into the renderer's terminal
      // view first via the onData callback, then emit onExit with a
      // distinctive negative code so the renderer can keep the pane
      // open and show context.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pty] spawn failed: cmd="${spawnCmd}" args=${JSON.stringify(spawnArgs)} :: ${msg}`);
      // Tailor the hint: an agent command that couldn't be found is almost
      // always a PATH / install issue, and the fastest check is whether the
      // user's own terminal can find it.
      const hint = bareAgentCmd
        ? [
          `\x1b[2mVyb couldn't locate "${bareAgentCmd}". In a terminal run:  command -v ${bareAgentCmd}`,
          'If that prints nothing, the agent isn\'t installed on your PATH.',
          'If it prints a path but this still fails, set the profile\'s command to',
          'that absolute path. Tip: a stale npm "prefix" can install global CLIs',
          'into a dir that isn\'t on your PATH.\x1b[0m',
        ]
        : [
          '\x1b[2mCheck $SHELL points at an actual executable (not a directory)',
          'and that the binary exists + has its executable bit set.\x1b[0m',
        ];
      const banner = [
        '',
        '\x1b[1;31m✖ Failed to start terminal\x1b[0m',
        `  command: ${spawnCmd} ${spawnArgs.join(' ')}`,
        `  reason:  ${msg}`,
        '',
        ...hint,
        '',
      ].join('\r\n');
      this.onData(profileId, banner);
      // -1 is the convention for "we never got a process going" so
      // the renderer can distinguish it from a normal exit code.
      this.onExit(profileId, -1);
      return;
    }

    // Track how much the child actually printed. A non-zero exit with
    // ~no output is the "blank pane + cursor" case — the process started
    // but bailed before drawing anything (bad config, missing native dep,
    // auth check, wrong cwd). We can't see *why* without its own output,
    // so at least tell the user it happened and how to reproduce.
    let outputBytes = 0;
    const startedAt = Date.now();
    const dataDisp = ptyProcess.onData((data) => {
      outputBytes += data.length;
      this.onData(profileId, data);
    });

    const exitDisp = ptyProcess.onExit(({ exitCode }) => {
      // Don't run the normal exit path during app shutdown — the
      // window is being torn down and the IPC would target a dead
      // renderer.
      if (this.disposing) return;
      // Surface non-zero exits so users diagnosing "my terminal closed
      // immediately" can see the underlying cause in `npm start`'s
      // console. 127 = command-not-found (PATH issue), 126 = found
      // but not executable, 2 = bash syntax error in rc files,
      // negative / signal codes = killed.
      if (exitCode !== 0) {
        console.warn(`[pty] ${profileId} exited code=${exitCode} cmd="${spawnCmd}" args=${JSON.stringify(spawnArgs)}`);
        // Agent that died on startup (near-silent, or just exited within
        // a few seconds of launch) → don't leave a blank/alt-screen pane.
        // Print a banner with the exit code + how to see the real error.
        const elapsed = Date.now() - startedAt;
        if (agentCmd && (outputBytes < 16 || elapsed < 4000)) {
          const name = bareAgentCmd || spawnCmd;
          const banner = [
            '',
            `\x1b[1;31m✖ ${name} exited immediately (code ${exitCode}) with no output\x1b[0m`,
            `  command: ${spawnCmd} ${spawnArgs.join(' ')}`,
            '',
            `\x1b[2mThe agent started but bailed before drawing anything. To see why,`,
            `open a shell terminal here (Ctrl+Cmd+=) and run:  ${name} ${spawnArgs.join(' ')}`,
            'Common causes: incomplete install (missing native dep), failed auth,',
            'or a project config in this working directory the agent rejects.\x1b[0m',
            '',
          ].join('\r\n');
          this.onData(profileId, banner);
        }
      }
      this.onExit(profileId, exitCode);
    });

    this.ptys.set(profileId, {
      process: ptyProcess,
      profile,
      disposables: [dataDisp, exitDisp],
      isShell: !agentCmd,
    });
  }

  write(profileId: string, data: string): void {
    const instance = this.ptys.get(profileId);
    if (instance) {
      instance.process.write(data);
    }
  }

  getPid(profileId: string): number | undefined {
    return this.ptys.get(profileId)?.process.pid;
  }

  isShell(profileId: string): boolean {
    return this.ptys.get(profileId)?.isShell ?? false;
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

  destroy(profileId: string, force = false): void {
    const instance = this.ptys.get(profileId);
    if (instance) {
      // Detach our onData/onExit listeners before killing so a late
      // exit event doesn't call back into a torn-down renderer.
      for (const d of instance.disposables) {
        try { d.dispose(); } catch { /* already disposed */ }
      }
      const pid = instance.process.pid;
      // Kill the whole process GROUP, not just the leader. node-pty runs
      // each child in its own session (forkpty → setsid), so pid == pgid
      // and `process.kill(-pid, …)` reaps the agent *and any helpers it
      // spawned*. This matters because some agents (e.g. Gemini's Ink TUI)
      // ignore/survive a plain SIGHUP on the leader, or leave a child
      // holding the pty open — which keeps node-pty's fd handle (and thus
      // the main process's event loop) alive and blocks app quit.
      //
      // On quit (`force`) we go straight to SIGKILL, which can't be caught
      // or ignored, guaranteeing the fd is released. A normal single-agent
      // stop stays graceful (SIGHUP) so well-behaved agents can clean up.
      const signal = force ? 'SIGKILL' : 'SIGHUP';
      if (pid && pid > 1) {
        try { process.kill(-pid, signal); } catch { /* group gone / not leader */ }
      }
      try { instance.process.kill(force ? 'SIGKILL' : undefined); } catch { /* already dead */ }
      this.ptys.delete(profileId);
    }
  }

  /** Destroy every PTY whose id starts with `prefix`. Used to reap the
   * shell terminals belonging to a parallel/session view
   * (`shell:<profileId>|<agentId>:N`) when that agent's worktree is torn
   * down — otherwise those shells keep running in a deleted directory. */
  destroyByPrefix(prefix: string): void {
    for (const id of [...this.ptys.keys()]) {
      if (id.startsWith(prefix)) this.destroy(id);
    }
  }

  destroyAll(): void {
    // Flag shutdown so the (node-pty internal) async exit callbacks
    // that fire after kill() don't run the normal exit path.
    this.disposing = true;
    for (const [id] of this.ptys) {
      // force = true → SIGKILL the group so nothing survives to hold the
      // event loop open and stall the quit (see before-quit in main.ts).
      this.destroy(id, true);
    }
  }
}
