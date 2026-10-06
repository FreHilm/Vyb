import * as http from 'http';
import { OrdnaTaskPayload } from '../shared/types';

let server: http.Server | null = null;
let activePort = 0;

export function getActivePort(): number {
  return activePort;
}

/** Agent lifecycle event POSTed by an injected CLI hook (see the
 * claude `--settings` hook config written in ipc-handlers). The event
 * kind and owning profile travel in headers; the body is the hook's own
 * JSON payload (passed through untouched for content-based decisions,
 * e.g. distinguishing permission prompts from idle reminders). */
export interface AgentHookEvent {
  profileId: string;
  event: string;
  payload: Record<string, unknown> | null;
}

export interface StartOptions {
  preferredPort: number;
  token: string;
  onTask: (payload: OrdnaTaskPayload) => void;
  onAgentHook?: (event: AgentHookEvent) => void;
}

export async function start(opts: StartOptions): Promise<number> {
  await stop();

  const { preferredPort, token, onTask, onAgentHook } = opts;

  return new Promise<number>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = (req.url || '').replace(/\/+$/, '');
      const isTask = url === '/agent';
      const isAgentHook = url === '/agent-status';
      // Only accept known POST routes on the loopback interface
      if (req.method !== 'POST' || (!isTask && !isAgentHook)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const provided = req.headers['x-token'];
      if (typeof provided !== 'string' || provided !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          if (isAgentHook) {
            // Agent lifecycle hook (e.g. claude Stop/Notification). Kind +
            // profile ride in headers; the body is the hook's own JSON
            // payload and may be empty or non-JSON — never reject on it.
            const profileId = req.headers['x-vyb-profile'];
            const event = req.headers['x-vyb-event'];
            if (typeof profileId !== 'string' || typeof event !== 'string' || !profileId || !event) {
              throw new Error('missing profile/event headers');
            }
            let payload: Record<string, unknown> | null = null;
            try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
            onAgentHook?.({ profileId, event, payload });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          const payload = JSON.parse(body) as OrdnaTaskPayload;
          if (!payload || typeof payload !== 'object' || !payload.task) {
            throw new Error('malformed payload');
          }
          onTask(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      req.on('error', () => {
        // socket aborted
      });
    });

    const tryListen = (port: number, attempt: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          srv.removeListener('error', onError);
          tryListen(port + 1, attempt + 1);
        } else {
          reject(err);
        }
      };
      srv.once('error', onError);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        activePort = typeof addr === 'object' && addr ? addr.port : port;
        server = srv;
        resolve(activePort);
      });
    };

    tryListen(preferredPort, 0);
  });
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const s = server;
    server = null;
    activePort = 0;
    s.close(() => resolve());
  });
}

export function getHookUrl(): string {
  if (!activePort) return '';
  return `http://127.0.0.1:${activePort}/agent`;
}
