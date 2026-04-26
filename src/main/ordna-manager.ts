import * as os from 'os';
import { Profile } from '../shared/types';
import { PtyManager } from './pty-manager';

type WebHandle = {
  port: number;
  url: string;
  close: () => Promise<void> | void;
};

interface OrdnaState {
  profileId: string;
  mode: 'web' | 'tui';
  web?: WebHandle;
  tuiPtyId?: string;
}

export class OrdnaManager {
  private current: OrdnaState | null = null;
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

  async start(profile: Profile, mode: 'web' | 'tui'): Promise<{ webUrl?: string; tuiPtyId?: string }> {
    // If something is already running for a different profile/mode, stop first
    if (this.current) await this.stop();

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
      this.current = { profileId: profile.id, mode: 'web', web };
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
    this.current = { profileId: profile.id, mode: 'tui', tuiPtyId };
    return { tuiPtyId };
  }

  async stop(): Promise<void> {
    if (!this.current) return;
    const cur = this.current;
    this.current = null;
    if (cur.mode === 'web' && cur.web) {
      try {
        await cur.web.close();
      } catch {
        // ignore
      }
    }
    if (cur.mode === 'tui' && cur.tuiPtyId) {
      this.ptyManager.destroy(cur.tuiPtyId);
    }
  }

  getActive(): { profileId: string; mode: 'web' | 'tui'; webUrl?: string; tuiPtyId?: string } | null {
    if (!this.current) return null;
    return {
      profileId: this.current.profileId,
      mode: this.current.mode,
      webUrl: this.current.web?.url,
      tuiPtyId: this.current.tuiPtyId,
    };
  }
}
