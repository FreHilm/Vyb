import * as pty from 'node-pty';
import * as os from 'os';
import { Profile } from '../shared/types';

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
  ): void {
    if (this.ptys.has(profileId)) {
      this.destroy(profileId);
    }

    const shell =
      profile.command ||
      (os.platform() === 'win32'
        ? 'powershell.exe'
        : process.env.SHELL || '/bin/bash');

    const ptyProcess = pty.spawn(shell, profile.args || [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: profile.workingDirectory || os.homedir(),
      env: { ...process.env } as { [key: string]: string },
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
