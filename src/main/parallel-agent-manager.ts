import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile, ExecFileException } from 'child_process';
import { app } from 'electron';
import { Profile, ParallelAgent, ParallelAgentPhase, resolveAgent, AgentConfig, buildSessionArgs } from '../shared/types';
import { PtyManager } from './pty-manager';
import { StatusDetector } from './status-detector';
import { applyAgentArgsGuards } from './agent-args-guard';

function run(cmd: string, args: string[], cwd: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as ExecFileException;
        reject(Object.assign(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || e.message}`), { code: e.code }));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function shortId(): string {
  return crypto.randomBytes(3).toString('hex'); // 6 hex chars
}

interface ManagerCallbacks {
  onChange: (agent: ParallelAgent) => void;
  onExited: (agent: ParallelAgent) => void;
}

/** Internal record extends the wire-shape with metadata we need server-side. */
interface ParallelAgentInternal extends ParallelAgent {
  /** Relative path of the task md file within the repo (e.g. tasks/T-014.md).
   * Used to detect `status: done` set by the agent. */
  taskFileRel?: string;
}

export class ParallelAgentManager {
  private agents: Map<string, ParallelAgentInternal> = new Map();
  private ptyManager: PtyManager;
  private statusDetector: StatusDetector;
  private cb: ManagerCallbacks;
  private rootDir: string;

  constructor(ptyManager: PtyManager, statusDetector: StatusDetector, cb: ManagerCallbacks) {
    this.ptyManager = ptyManager;
    this.statusDetector = statusDetector;
    this.cb = cb;
    this.rootDir = path.join(app.getPath('userData'), 'parallel-agents');
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
    this.restoreSessions();
  }

  // ── Session persistence ─────────────────────────────────────────
  // Free-form sessions survive app restarts: their records are saved to
  // sessions.json and their worktrees are exempt from the quit-time
  // destroyAll. On launch they come back as phase 'stopped' (worktree
  // intact, no PTY); selecting one respawns its agent via resumeSession.

  private sessionsFile(): string {
    return path.join(this.rootDir, 'sessions.json');
  }

  private persistSessions(): void {
    try {
      const sessions = [...this.agents.values()]
        .filter((a) => a.kind === 'session' && a.phase !== 'failed')
        .map(({ id, profileId, taskId, taskTitle, branch, worktreePath, parentRepoPath, createdAt }) => ({
          id, profileId, taskId, taskTitle, branch, worktreePath, parentRepoPath, createdAt,
        }));
      fs.writeFileSync(this.sessionsFile(), JSON.stringify(sessions, null, 2));
    } catch {
      // best-effort — a failed save only costs restore-after-restart
    }
  }

  private restoreSessions(): void {
    let records: Partial<ParallelAgentInternal>[] = [];
    try {
      records = JSON.parse(fs.readFileSync(this.sessionsFile(), 'utf-8'));
    } catch {
      return; // no file yet
    }
    if (!Array.isArray(records)) return;
    let dropped = false;
    // Parent repos needing `git worktree prune` (worktree folder deleted
    // outside Vyb → stale .git/worktrees registration + "checked out" branch).
    const pruneRepos = new Set<string>();
    for (const r of records) {
      if (!r?.id || !r.profileId || !r.worktreePath || !r.branch) { dropped = true; continue; }
      // Worktree removed outside Vyb → drop the record silently.
      if (!fs.existsSync(r.worktreePath)) {
        dropped = true;
        if (r.parentRepoPath) pruneRepos.add(r.parentRepoPath);
        continue;
      }
      this.agents.set(r.id, {
        id: r.id,
        profileId: r.profileId,
        taskId: r.taskId ?? 'new',
        taskTitle: r.taskTitle ?? 'Session',
        branch: r.branch,
        worktreePath: r.worktreePath,
        parentRepoPath: r.parentRepoPath ?? '',
        phase: 'stopped',
        createdAt: r.createdAt ?? Date.now(),
        kind: 'session',
      });
    }
    if (dropped) this.persistSessions();
    for (const repo of pruneRepos) {
      if (fs.existsSync(repo)) {
        void run('git', ['worktree', 'prune'], repo, 30000).catch((): void => undefined);
      }
    }
  }

  /** Respawn the agent of a restored ('stopped') session inside its
   * surviving worktree. Uses the agent's "continue most recent
   * conversation in this cwd" invocation where the CLI supports it —
   * the worktree's own conversation is the session's continuation.
   * Gemini has no stable equivalent, so it starts a fresh conversation
   * in the worktree. */
  resumeSession(profile: Profile, agents: AgentConfig[], id: string): ParallelAgent | { error: string } {
    const agent = this.agents.get(id);
    if (!agent) return { error: 'session not found' };
    if (agent.phase !== 'stopped') return agent; // already live — no-op
    if (!fs.existsSync(agent.worktreePath)) {
      this.agents.delete(id);
      this.persistSessions();
      // Clear git's stale worktree registration so the branch isn't left
      // "checked out" in a folder that no longer exists.
      if (fs.existsSync(agent.parentRepoPath)) {
        void run('git', ['worktree', 'prune'], agent.parentRepoPath, 30000).catch((): void => undefined);
      }
      // Tell the renderer so the sidebar row disappears (without this the
      // dead row would linger until the next app restart).
      this.cb.onExited(agent);
      return { error: 'the session worktree no longer exists' };
    }

    const resolved = resolveAgent(profile, agents);
    const continueArgs: Record<string, string[]> = {
      claude: ['--continue'],
      codex: ['resume', '--last'],
      opencode: ['--continue'],
      gemini: [],
    };
    const ptyId = `parallel:${id}`;
    const ptyProfile: Profile = {
      ...profile,
      id: ptyId,
      workingDirectory: agent.worktreePath,
      command: resolved.command,
      args: continueArgs[resolved.command] ?? [],
    };
    this.statusDetector.register(ptyId, ptyProfile);
    this.ptyManager.create(ptyId, ptyProfile);
    agent.phase = 'running';
    this.cb.onChange(agent);
    return agent;
  }

  list(profileId?: string): ParallelAgent[] {
    const all = [...this.agents.values()];
    return profileId ? all.filter((a) => a.profileId === profileId) : all;
  }

  get(id: string): ParallelAgent | undefined {
    return this.agents.get(id);
  }

  /** Create the worktree + PTY but do NOT submit any input yet. */
  async spawn(
    profile: Profile,
    agents: AgentConfig[],
    task: { id: string; title: string; filePath?: string },
  ): Promise<ParallelAgent> {
    const id = shortId();
    const ptyId = `parallel:${id}`;
    const slug = slugify(task.title) || 'task';
    const branch = `agent/${task.id}-${slug}`;

    let parentRepo = profile.workingDirectory || os.homedir();
    if (parentRepo.startsWith('~')) parentRepo = parentRepo.replace(/^~/, os.homedir());

    const profileDir = path.join(this.rootDir, profile.id);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const worktreePath = path.join(profileDir, `${task.id}-${id}`);

    // Translate the task's absolute filePath into a path relative to the repo,
    // so we can find the same file inside the new worktree.
    let taskFileRel: string | undefined;
    if (task.filePath && task.filePath.startsWith(parentRepo)) {
      taskFileRel = task.filePath.slice(parentRepo.length).replace(/^\/+/, '');
    }

    const agent: ParallelAgentInternal = {
      id,
      profileId: profile.id,
      taskId: task.id,
      taskTitle: task.title,
      branch,
      worktreePath,
      parentRepoPath: parentRepo,
      phase: 'starting',
      createdAt: Date.now(),
      taskFileRel,
    };
    this.agents.set(id, agent);
    this.cb.onChange(agent);

    try {
      // Create the worktree on a fresh branch off HEAD
      await run('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], parentRepo);
    } catch (err) {
      // Branch may already exist from a prior abandoned run — try without -b
      try {
        await run('git', ['worktree', 'add', worktreePath, branch], parentRepo);
      } catch (err2) {
        agent.phase = 'failed';
        agent.errorMessage = `git worktree add: ${(err2 as Error).message || (err as Error).message}`;
        this.cb.onChange(agent);
        return agent;
      }
    }

    // Build the agent command from the parent profile's agent config. Append
    // the agent's permissionModeArgs (claude `--permission-mode acceptEdits`,
    // codex `--full-auto`, gemini `--approval-mode yolo` by default) so the
    // worktree agent can act without per-edit prompts. Then strip any
    // resume/continue flags whose state directory doesn't exist in the
    // freshly-created worktree (otherwise the CLI errors and exits).
    const resolved = resolveAgent(profile, agents);
    const agentCfg = profile.agentId
      ? agents.find((a) => a.id === profile.agentId)
      : agents.find((a) => a.command === resolved.command);
    const permissionArgs = agentCfg?.permissionModeArgs ?? [];
    const ptyProfile = applyAgentArgsGuards({
      ...profile,
      id: ptyId,
      workingDirectory: worktreePath,
      command: resolved.command,
      args: [...resolved.args, ...permissionArgs],
    });

    // Register status detector under the PTY id, then spawn the PTY
    this.statusDetector.register(ptyId, ptyProfile);
    this.ptyManager.create(ptyId, ptyProfile);

    agent.phase = 'awaiting';
    this.cb.onChange(agent);
    return agent;
  }

  /** Spawn a free-form agent SESSION in its own worktree — like a parallel
   * agent but not task-bound: it never auto-finishes (no task-done polling)
   * and is closed only by the user. With `sessionId` the agent resumes that
   * session; with null it starts fresh. Unlike `spawn`, we build the args
   * directly and DON'T run applyAgentArgsGuards — that guard strips
   * `--resume` when the worktree has no local conversation, which is exactly
   * the case we're deliberately overriding (e.g. Claude resolves sessions
   * across the repo + its worktrees). */
  async spawnSession(
    profile: Profile,
    agents: AgentConfig[],
    opts: { sessionId: string | null; label: string },
  ): Promise<ParallelAgent> {
    const id = shortId();
    const ptyId = `parallel:${id}`;
    const resolved = resolveAgent(profile, agents);
    const branch = `session/${resolved.command}-${id}`;

    let parentRepo = profile.workingDirectory || os.homedir();
    if (parentRepo.startsWith('~')) parentRepo = parentRepo.replace(/^~/, os.homedir());

    const profileDir = path.join(this.rootDir, profile.id);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const worktreePath = path.join(profileDir, `session-${id}`);

    const agent: ParallelAgentInternal = {
      id,
      profileId: profile.id,
      taskId: opts.sessionId ?? 'new',
      taskTitle: opts.label,
      branch,
      worktreePath,
      parentRepoPath: parentRepo,
      phase: 'starting',
      createdAt: Date.now(),
      kind: 'session',
    };
    this.agents.set(id, agent);
    this.cb.onChange(agent);

    try {
      await run('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], parentRepo);
    } catch (err) {
      try {
        await run('git', ['worktree', 'add', worktreePath, branch], parentRepo);
      } catch (err2) {
        agent.phase = 'failed';
        agent.errorMessage = `git worktree add: ${(err2 as Error).message || (err as Error).message}`;
        this.cb.onChange(agent);
        return agent;
      }
    }

    // NB: unlike Kanban parallel agents, session worktrees do NOT append the
    // agent's permissionModeArgs (auto-approve). A session is the user
    // continuing their own conversation interactively, so normal approval
    // prompts are the right default — and those flags are global anyway:
    // `codex resume <id> --full-auto` is rejected ("unexpected argument"),
    // which broke codex resume. Just the resume/new args.
    const sessionArgs = buildSessionArgs(resolved.command, resolved.args, opts.sessionId);
    const ptyProfile: Profile = {
      ...profile,
      id: ptyId,
      workingDirectory: worktreePath,
      command: resolved.command,
      args: sessionArgs,
    };

    this.statusDetector.register(ptyId, ptyProfile);
    this.ptyManager.create(ptyId, ptyProfile);

    // Sessions are interactive from the first prompt — there's no queued
    // task to await, so go straight to 'running'. ('awaiting' would pin the
    // sidebar dot to the phase color forever: the row only reflects live
    // PTY status once the phase is 'running', and the transition normally
    // happens on Kanban task submit, which sessions never do.)
    agent.phase = 'running';
    this.cb.onChange(agent);
    this.persistSessions();
    return agent;
  }

  /** Read the task md file inside the worktree and check if its frontmatter
   * has `status: done`. Used to decide when working→ready means the task is
   * finished (vs. just an interim idle prompt). */
  isTaskDone(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || !agent.taskFileRel) return false;
    const filePath = path.join(agent.worktreePath, agent.taskFileRel);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) return false;
      return /^status:\s*done\s*$/m.test(m[1]);
    } catch {
      return false;
    }
  }

  /** Tear down PTY + worktree + drop the entry. Idempotent.
   *
   * `discardWork` controls what happens to uncommitted work:
   * - false (default): commit anything outstanding as a WIP commit so the
   *   branch keeps the agent's work — the branch survives so the user can
   *   recover it later. Used for crashes, soft-deletes after PR, and the
   *   "Save WIP" choice from the Stop dialog.
   * - true: skip the WIP commit AND delete the agent's branch. The work
   *   in the worktree is thrown away. Used when the user explicitly picks
   *   "Discard work" from the Stop dialog. */
  async destroy(id: string, discardWork = false): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.agents.delete(id);
    if (agent.kind === 'session') this.persistSessions();

    const ptyId = `parallel:${id}`;
    try {
      this.ptyManager.destroy(ptyId);
    } catch {
      // already gone
    }
    this.statusDetector.unregister(ptyId);
    // Reap any shell terminals opened inside this agent's view — their ids
    // are `shell:<profileId>|<agentId>:N` (ShellPane keys shells by view).
    // Without this they'd keep running in the soon-to-be-deleted worktree.
    try {
      this.ptyManager.destroyByPrefix(`shell:${agent.profileId}|${id}:`);
    } catch {
      // best-effort
    }

    if (fs.existsSync(agent.worktreePath)) {
      if (!discardWork) {
        // Safety net: commit any uncommitted work as WIP so it isn't lost
        // when the worktree directory is removed.
        try {
          await run('git', ['add', '-A'], agent.worktreePath, 60000);
          let nothingStaged = false;
          try {
            await run('git', ['diff', '--cached', '--quiet'], agent.worktreePath, 30000);
            nothingStaged = true;
          } catch {
            // exit non-zero ⇒ there are staged changes
          }
          if (!nothingStaged) {
            const wipMsg =
              agent.phase === 'completed'
                ? `${agent.taskId}: ${agent.taskTitle}`
                : `WIP: ${agent.taskId}: ${agent.taskTitle}`;
            await run('git', ['commit', '-m', wipMsg], agent.worktreePath, 60000);
          }
        } catch {
          // best-effort; never block the destroy on a failed commit
        }
      }

      // Remove the worktree directory
      try {
        await run('git', ['worktree', 'remove', '--force', agent.worktreePath], agent.worktreePath);
      } catch {
        try {
          fs.rmSync(agent.worktreePath, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } else if (fs.existsSync(agent.parentRepoPath)) {
      // Folder already gone (deleted outside Vyb) — clear git's stale
      // worktree registration so the branch isn't left "checked out".
      try {
        await run('git', ['worktree', 'prune'], agent.parentRepoPath, 30000);
      } catch {
        // best-effort
      }
    }

    if (discardWork) {
      // Drop the branch from the parent repo so a future retry of the same
      // task ID isn't blocked by a stale branch reference. Only safe with
      // `-D` (force) since the branch was never merged into anything.
      try {
        await run('git', ['branch', '-D', agent.branch], agent.parentRepoPath, 30000);
      } catch {
        // best-effort — if it can't be deleted, leave it for manual cleanup
      }
    }

    this.cb.onExited(agent);
  }

  /** Always stage + commit any pending changes in the worktree. When autoPush
   * is on we additionally push the branch and try to open a PR via `gh`. */
  async finish(id: string, autoPush: boolean): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;

    agent.phase = 'pushing';
    this.cb.onChange(agent);

    const cwd = agent.worktreePath;
    const commitMsg = `${agent.taskId}: ${agent.taskTitle}`;

    try {
      // Stage anything outstanding (the agent likely committed already, this
      // catches stragglers like new untracked files).
      await run('git', ['add', '-A'], cwd);

      // Commit only if there's something to commit.
      try {
        await run('git', ['diff', '--cached', '--quiet'], cwd);
        // exit 0 ⇒ nothing staged, skip commit
      } catch {
        await run('git', ['commit', '-m', commitMsg], cwd);
      }

      if (autoPush) {
        // Push the branch (force-with-lease in case agent already pushed once)
        await run('git', ['push', '-u', '--force-with-lease', 'origin', agent.branch], cwd, 90000);

        // Try to open a PR via gh. If gh isn't available or unauthed, surface
        // the error but keep the branch pushed.
        try {
          const { stdout } = await run('gh', ['pr', 'create', '--fill'], cwd, 90000);
          const urlMatch = stdout.match(/https?:\/\/\S+/);
          agent.prUrl = urlMatch ? urlMatch[0] : undefined;
        } catch (ghErr) {
          agent.errorMessage = `branch pushed but gh pr create failed: ${(ghErr as Error).message}`;
        }
      }

      agent.phase = 'completed';
      this.cb.onChange(agent);
    } catch (err) {
      agent.phase = 'failed';
      agent.errorMessage = (err as Error).message;
      this.cb.onChange(agent);
    }
  }

  /** Look up the parallel agent record by its `parallel:<id>` PTY id. */
  fromPtyId(ptyId: string): ParallelAgent | undefined {
    if (!ptyId.startsWith('parallel:')) return undefined;
    return this.agents.get(ptyId.slice('parallel:'.length));
  }

  /** Update an agent's phase and notify listeners. */
  updatePhase(id: string, phase: ParallelAgentPhase): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    if (agent.phase === phase) return;
    agent.phase = phase;
    this.cb.onChange(agent);
  }

  destroyAll(): Promise<void[]> {
    // Quit-time teardown. Free-form SESSIONS are exempt: their records are
    // persisted and their worktrees survive so they can be restored (as
    // 'stopped') on the next launch — a session only dies when the user
    // closes it. Their PTYs are reaped by ptyManager.destroyAll() right
    // after this (with the `disposing` guard keeping the exit hook from
    // cascading back into destroy()). Kanban task agents keep the old
    // behavior: WIP-commit + remove worktree.
    this.persistSessions();
    return Promise.all(
      [...this.agents.values()]
        .filter((a) => a.kind !== 'session')
        .map((a) => this.destroy(a.id)),
    );
  }
}
