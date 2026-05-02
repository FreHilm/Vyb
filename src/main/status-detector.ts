import { Worker } from 'worker_threads';
import * as path from 'path';
import { AgentStatus, Profile } from '../shared/types';

/**
 * Thin main-thread wrapper around the status-detection worker.
 *
 * All of the regex/ANSI-strip work and per-profile state management lives on
 * a Node.js worker thread (see `status-worker.ts`). This class just forwards
 * register/unregister/feedData/setWorking calls as messages and listens for
 * `statusChange` messages coming back. A small shadow status map is kept here
 * so synchronous getters (`getStatus`, `getAll`) keep working without async.
 */
export class StatusDetector {
  private worker: Worker;
  private shadow: Map<string, AgentStatus> = new Map();
  private onStatusChange: (
    profileId: string,
    status: AgentStatus,
    previousStatus: AgentStatus,
    output: string,
    hasNewContent: boolean,
  ) => void;

  constructor(
    onStatusChange: (
      profileId: string,
      status: AgentStatus,
      previousStatus: AgentStatus,
      output: string,
      hasNewContent: boolean,
    ) => void,
  ) {
    this.onStatusChange = onStatusChange;

    // Worker bundle ends up next to main.js (see forge.config.ts + vite.worker.config.ts)
    const workerPath = path.join(__dirname, 'status-worker.js');
    this.worker = new Worker(workerPath);

    this.worker.on('message', (msg: {
      type: 'statusChange';
      profileId: string;
      status: AgentStatus;
      previousStatus: AgentStatus;
      output: string;
      hasNewContent: boolean;
    }) => {
      if (msg.type !== 'statusChange') return;
      this.shadow.set(msg.profileId, msg.status);
      this.onStatusChange(
        msg.profileId,
        msg.status,
        msg.previousStatus,
        msg.output,
        msg.hasNewContent,
      );
    });

    this.worker.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[status-worker] error:', err);
    });
  }

  register(profileId: string, profile: Profile): void {
    // Optimistic: shadow shows ready immediately so synchronous getStatus()
    // sees the new profile before the worker's first message arrives.
    this.shadow.set(profileId, 'ready');
    this.worker.postMessage({ type: 'register', profileId, command: profile.command });
  }

  unregister(profileId: string): void {
    this.shadow.delete(profileId);
    this.worker.postMessage({ type: 'unregister', profileId });
  }

  feedData(profileId: string, data: string): void {
    this.worker.postMessage({ type: 'feed', profileId, data });
  }

  setWorking(profileId: string): void {
    this.shadow.set(profileId, 'working');
    this.worker.postMessage({ type: 'setWorking', profileId });
  }

  getStatus(profileId: string): AgentStatus {
    return this.shadow.get(profileId) ?? 'offline';
  }

  getAll(): Record<string, AgentStatus> {
    const out: Record<string, AgentStatus> = {};
    for (const [id, status] of this.shadow) out[id] = status;
    return out;
  }
}
