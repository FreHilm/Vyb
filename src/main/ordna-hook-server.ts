import * as http from 'http';
import { OrdnaTaskPayload } from '../shared/types';

let server: http.Server | null = null;
let activePort = 0;

export function getActivePort(): number {
  return activePort;
}

export interface StartOptions {
  preferredPort: number;
  token: string;
  onTask: (payload: OrdnaTaskPayload) => void;
}

export async function start(opts: StartOptions): Promise<number> {
  await stop();

  const { preferredPort, token, onTask } = opts;

  return new Promise<number>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      // Only accept POST /agent on the loopback interface
      if (req.method !== 'POST' || (req.url !== '/agent' && req.url !== '/agent/')) {
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
