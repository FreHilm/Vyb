import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile, ExecFileException } from 'child_process';
import { app } from 'electron';
import { Profile, ParallelAgent, ParallelAgentPhase, resolveAgent, AgentConfig } from '../shared/types';
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

  /** Tear down PTY + worktree + drop the entry. Idempotent. Before removing
   * the worktree we attempt to commit any uncommitted changes as a WIP commit
   * so the branch keeps the agent's work even if the agent never marked the
   * task as done. */
  async destroy(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.agents.delete(id);

    const ptyId = `parallel:${id}`;
    try {
      this.ptyManager.destroy(ptyId);
    } catch {
      // already gone
    }
    this.statusDetector.unregister(ptyId);

    if (fs.existsSync(agent.worktreePath)) {
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
    return Promise.all([...this.agents.keys()].map((id) => this.destroy(id)));
  }
}
