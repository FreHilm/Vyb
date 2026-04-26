import * as os from 'os';
import { Profile } from '../shared/types';
import { PtyManager } from './pty-manager';

type WebHandle = {
  port: number;
  url: string;
  close: () => Promise<void> | void;
};

interface OrdnaInstance {
  profileId: string;
  mode: 'web' | 'tui';
  cwd: string; // resolved (no ~)
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
   * Idempotent: if an instance is already running for this profile in the
   * requested mode, return its connection info. If the mode changed, the old
   * instance is stopped before the new one is created so the user only sees
   * one Ordna per profile at a time.
   */
  async start(profile: Profile, mode: 'web' | 'tui'): Promise<{ webUrl?: string; tuiPtyId?: string }> {
    const existing = this.instances.get(profile.id);
    if (existing) {
      if (existing.mode === mode) {
        return { webUrl: existing.web?.url, tuiPtyId: existing.tuiPtyId };
      }
      // Mode changed — tear down the existing instance before creating the new one.
      await this.stop(profile.id);
    }

    let cwd = profile.workingDirectory || os.homedir();
    if (cwd.startsWith('~')) cwd = cwd.replace(/^~/, os.homedir());

    if (mode === 'web') {
      const mod = await import('@frehilm/ordna-web');
      const handle = await mod.runWeb({
        cwd,
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
      this.instances.set(profile.id, { profileId: profile.id, mode: 'web', cwd, web });
      return { webUrl: url };
    }

    // TUI mode — spawn `npx -y @frehilm/ordna-cli` via PtyManager
    const tuiPtyId = `ordna:${profile.id}`;
    const tuiProfile: Profile = {
      id: tuiPtyId,
      name: 'Ordna',
      icon: '',
      workingDirectory: cwd,
      command: 'npx',
      args: ['-y', '@frehilm/ordna-cli'],
    };
    this.ptyManager.create(tuiPtyId, tuiProfile, undefined, undefined, this.envForOrdna());
    this.instances.set(profile.id, { profileId: profile.id, mode: 'tui', cwd, tuiPtyId });
    return { tuiPtyId };
  }

  async stop(profileId: string): Promise<void> {
    const inst = this.instances.get(profileId);
    if (!inst) return;
    this.instances.delete(profileId);
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

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  getInstance(profileId: string): { mode: 'web' | 'tui'; webUrl?: string; tuiPtyId?: string } | null {
    const inst = this.instances.get(profileId);
    if (!inst) return null;
    return { mode: inst.mode, webUrl: inst.web?.url, tuiPtyId: inst.tuiPtyId };
  }

  /**
   * Called when an Ordna TUI PTY has already exited (e.g. user pressed `q`).
   * Drops the bookkeeping entry without trying to kill the process.
   */
  handlePtyExit(profileId: string): void {
    const inst = this.instances.get(profileId);
    if (!inst || inst.mode !== 'tui') return;
    this.instances.delete(profileId);
  }

  /** Find the profileId whose Ordna instance owns this resolved cwd. */
  resolveProfileByCwd(cwd: string): string | null {
    for (const [id, inst] of this.instances) {
      if (inst.cwd === cwd) return id;
    }
    return null;
  }
}
