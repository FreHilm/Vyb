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
/** Where a status transition originated: the regex worker's heuristics,
 * or an exact CLI lifecycle hook (claude/gemini hooks, codex notify). */
export type StatusSource = 'worker' | 'hook';

/** How a profile's status is detected:
 *  - 'full'    — hooks own everything; the regex worker never sees this
 *                profile (no registration, no feed). claude.
 *  - 'augment' — the regex worker runs as normal, and hook events land
 *                on top as authoritative overrides. gemini / codex,
 *                whose hooks don't cover every transition. */
export type HookMode = 'full' | 'augment';

export class StatusDetector {
  private worker: Worker;
  private shadow: Map<string, AgentStatus> = new Map();
  /** hookMode 'full' profiles — never registered with the worker. */
  private external: Set<string> = new Set();
  /** hookMode 'augment' profiles — worker active + hook overrides. */
  private augmented: Set<string> = new Set();
  /** Held regex-'ready' sightings for augmented profiles. Their idle
   * heuristics misfire mid-turn (codex thinks silently for >3 s and the
   * adapter calls it ready), so a worker 'ready' is quarantined: a real
   * completion arrives via the hook within moments, and resumed output
   * (worker 'working') cancels the hold. Only if hooks stay silent does
   * the held ready apply — a badge-only fallback for lost hook events. */
  private heldWorkerReady: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    msg: { profileId: string; status: AgentStatus; previousStatus: AgentStatus; output: string; hasNewContent: boolean };
  }> = new Map();
  private static readonly AUGMENT_READY_HOLD_MS = 30000;
  private onStatusChange: (
    profileId: string,
    status: AgentStatus,
    previousStatus: AgentStatus,
    output: string,
    hasNewContent: boolean,
    source: StatusSource,
  ) => void;

  constructor(
    onStatusChange: (
      profileId: string,
      status: AgentStatus,
      previousStatus: AgentStatus,
      output: string,
      hasNewContent: boolean,
      source: StatusSource,
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
      if (this.augmented.has(msg.profileId)) {
        if (msg.status === 'ready') {
          // Quarantine — see heldWorkerReady. Re-arm on repeat sightings.
          this.clearHeldReady(msg.profileId);
          const timer = setTimeout(() => {
            this.heldWorkerReady.delete(msg.profileId);
            this.shadow.set(msg.profileId, msg.status);
            this.onStatusChange(
              msg.profileId, msg.status, msg.previousStatus, msg.output, msg.hasNewContent, 'worker',
            );
          }, StatusDetector.AUGMENT_READY_HOLD_MS);
          this.heldWorkerReady.set(msg.profileId, { timer, msg });
          return;
        }
        // Any non-ready worker transition proves the turn isn't over.
        this.clearHeldReady(msg.profileId);
      }
      this.shadow.set(msg.profileId, msg.status);
      this.onStatusChange(
        msg.profileId,
        msg.status,
        msg.previousStatus,
        msg.output,
        msg.hasNewContent,
        'worker',
      );
    });

    this.worker.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[status-worker] error:', err);
    });
  }

  register(profileId: string, profile: Profile, opts?: { hookMode?: HookMode }): void {
    // Optimistic: shadow shows ready immediately so synchronous getStatus()
    // sees the new profile before the worker's first message arrives.
    this.shadow.set(profileId, 'ready');
    this.external.delete(profileId);
    this.augmented.delete(profileId);
    if (opts?.hookMode === 'full') {
      this.external.add(profileId);
      return; // no worker registration — hooks own this profile's status
    }
    if (opts?.hookMode === 'augment') this.augmented.add(profileId);
    this.worker.postMessage({ type: 'register', profileId, command: profile.command });
  }

  private clearHeldReady(profileId: string): void {
    const held = this.heldWorkerReady.get(profileId);
    if (held) {
      clearTimeout(held.timer);
      this.heldWorkerReady.delete(profileId);
    }
  }

  unregister(profileId: string): void {
    this.shadow.delete(profileId);
    this.augmented.delete(profileId);
    this.clearHeldReady(profileId);
    if (this.external.delete(profileId)) return;
    this.worker.postMessage({ type: 'unregister', profileId });
  }

  feedData(profileId: string, data: string): void {
    // Hook-driven profiles skip the worker entirely — no ANSI stripping
    // or regex work for their (often very chatty) output.
    if (this.external.has(profileId)) return;
    this.worker.postMessage({ type: 'feed', profileId, data });
  }

  setWorking(profileId: string): void {
    // For hook-driven profiles, keystrokes are NOT evidence of a turn
    // starting (the regex path uses an idle timer to recover from that
    // guess; hooks have no such safety net). UserPromptSubmit reports
    // real submissions instead.
    if (this.external.has(profileId)) return;
    this.shadow.set(profileId, 'working');
    this.worker.postMessage({ type: 'setWorking', profileId });
  }

  /** True when this profile accepts hook-driven transitions. */
  isHookDriven(profileId: string): boolean {
    return this.external.has(profileId) || this.augmented.has(profileId);
  }

  /** Apply a hook-reported status. `hasNewContent` marks a completed
   * turn (claude/gemini Stop, codex agent-turn-complete). For completions
   * the previousStatus reported to the callback is forced to 'working' —
   * the hook is authoritative about "a turn just ended", even if the
   * working transition was missed (e.g. hook server started
   * mid-session, or an augment-mode agent whose hooks don't report
   * turn starts). */
  applyExternalStatus(profileId: string, status: AgentStatus, hasNewContent: boolean): void {
    if (!this.isHookDriven(profileId)) return;
    // A hook event supersedes any quarantined regex 'ready' sighting.
    this.clearHeldReady(profileId);
    const prev = this.shadow.get(profileId) ?? 'offline';
    const isCompletion = status === 'ready' && hasNewContent;
    if (prev === status && !isCompletion) return;
    this.shadow.set(profileId, status);
    this.onStatusChange(
      profileId,
      status,
      isCompletion ? 'working' : prev,
      '',
      hasNewContent,
      'hook',
    );
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
