import * as os from 'os';
import { Profile } from '../shared/types';
import { PtyManager } from './pty-manager';

type WebHandle = {
  port: number;
  url: string;
  close: () => Promise<void> | void;
};

interface OrdnaInstance {
  instanceKey: string; // opaque key from the renderer (parent: profileId, parallel: `${profileId}|${parallelId}`)
  profileId: string;   // parent profile that owns this instance — used for hook routing
  mode: 'web' | 'tui';
  cwd: string;         // resolved (no ~)
  web?: WebHandle;
  tuiPtyId?: string;
}

export class OrdnaManager {
  private instances: Map<string, OrdnaInstance> = new Map();
  private ptyManager: PtyManager;
  private hookEnv: { url: string; label: string; token: string } = {
    url: '',
    label: 'AgentDispatch',
    token: '',
  };

  constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager;
  }

  setHookEnv(url: string, token: string, label = 'AgentDispatch'): void {
    this.hookEnv = { url, label, token };
  }

  private envForOrdna(): Record<string, string> {
    return {
      ORDNA_AGENT_HOOK_URL: this.hookEnv.url,
      ORDNA_AGENT_HOOK_LABEL: this.hookEnv.label,
      ORDNA_AGENT_HOOK_HEADERS: JSON.stringify({ 'X-Token': this.hookEnv.token }),
    };
  }

  /**
   * Idempotent: if an instance is already running for this instanceKey in the
   * requested mode, return its connection info. If the mode changed, the old
   * instance is stopped before the new one is created.
   *
   * `instanceKey` is the renderer's opaque view key — parent profile uses
   * just the profileId, a parallel agent uses `${profileId}|${parallelId}`.
   * Each instance gets its own cwd so a parallel agent can run Ordna over
   * its worktree independently of the parent profile's instance.
   */
  async start(
    instanceKey: string,
    profileId: string,
    cwd: string,
    mode: 'web' | 'tui',
  ): Promise<{ webUrl?: string; tuiPtyId?: string }> {
    const existing = this.instances.get(instanceKey);
    if (existing) {
      if (existing.mode === mode) {
        return { webUrl: existing.web?.url, tuiPtyId: existing.tuiPtyId };
      }
      await this.stop(instanceKey);
    }

    let resolvedCwd = cwd || os.homedir();
    if (resolvedCwd.startsWith('~')) resolvedCwd = resolvedCwd.replace(/^~/, os.homedir());

    if (mode === 'web') {
      const mod = await import('@frehilm/ordna-web');
      const handle = await mod.runWeb({
        cwd: resolvedCwd,
        port: 0,
        openBrowser: false,
        agentHook: this.hookEnv.url
          ? {
              url: this.hookEnv.url,
              label: this.hookEnv.label,
              headers: { 'X-Token': this.hookEnv.token },
            }
          : null,
      });
      const port = handle.port;
      const url = `http://127.0.0.1:${port}/`;
      const web: WebHandle = { port, url, close: handle.close.bind(handle) };
      this.instances.set(instanceKey, { instanceKey, profileId, mode: 'web', cwd: resolvedCwd, web });
      return { webUrl: url };
    }

    // TUI mode — spawn `npx -y @frehilm/ordna-cli` via PtyManager
    const tuiPtyId = `ordna:${instanceKey}`;
    const tuiProfile: Profile = {
      id: tuiPtyId,
      name: 'Ordna',
      icon: '',
      workingDirectory: resolvedCwd,
      command: 'npx',
      args: ['-y', '@frehilm/ordna-cli'],
    };
    this.ptyManager.create(tuiPtyId, tuiProfile, undefined, undefined, this.envForOrdna());
    this.instances.set(instanceKey, { instanceKey, profileId, mode: 'tui', cwd: resolvedCwd, tuiPtyId });
    return { tuiPtyId };
  }

  async stop(instanceKey: string): Promise<void> {
    const inst = this.instances.get(instanceKey);
    if (!inst) return;
    this.instances.delete(instanceKey);
    if (inst.mode === 'web' && inst.web) {
      try {
        await inst.web.close();
      } catch {
        // ignore
      }
    }
    if (inst.mode === 'tui' && inst.tuiPtyId) {
      this.ptyManager.destroy(inst.tuiPtyId);
    }
  }

  /** Stop every instance whose owning profile matches — used when a parent
   * profile is stopped/deleted to clean up its parent + parallel instances. */
  async stopForProfile(profileId: string): Promise<void> {
    const keys = [...this.instances.entries()]
      .filter(([, inst]) => inst.profileId === profileId)
      .map(([key]) => key);
    await Promise.all(keys.map((k) => this.stop(k)));
  }

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  getInstance(instanceKey: string): { mode: 'web' | 'tui'; webUrl?: string; tuiPtyId?: string } | null {
    const inst = this.instances.get(instanceKey);
    if (!inst) return null;
    return { mode: inst.mode, webUrl: inst.web?.url, tuiPtyId: inst.tuiPtyId };
  }

  /**
   * Called when an Ordna TUI PTY has already exited (e.g. user pressed `q`).
   * Drops the bookkeeping entry without trying to kill the process.
   */
  handlePtyExit(instanceKey: string): void {
    const inst = this.instances.get(instanceKey);
    if (!inst || inst.mode !== 'tui') return;
    this.instances.delete(instanceKey);
  }

  /** Find the parent profileId whose Ordna instance owns this resolved cwd.
   * Used by the hook receiver to route incoming tasks back to the right
   * profile (parent or parallel both feed back to the parent profileId). */
  resolveProfileByCwd(cwd: string): string | null {
    for (const inst of this.instances.values()) {
      if (inst.cwd === cwd) return inst.profileId;
    }
    return null;
  }
}
