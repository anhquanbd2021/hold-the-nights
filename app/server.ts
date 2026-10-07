import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { runScenario, scenarioSummaries } from './booking.ts';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

// Static files from public/; app.js is the documented JS exception (browsers
// cannot strip TypeScript — see the header comment in public/app.js).
const STATIC = new Map<string, [string, string | null]>(
  ([
    ['/', 'text/html; charset=utf-8', 'index.html'],
    ['/index.html', 'text/html; charset=utf-8', 'index.html'],
    ['/guide.html', 'text/html; charset=utf-8', 'guide.html'],
    ['/tokens.css', 'text/css; charset=utf-8', 'tokens.css'],
    ['/styles.css', 'text/css; charset=utf-8', 'styles.css'],
    ['/pb-shell.css', 'text/css; charset=utf-8', 'pb-shell.css'],
    ['/pb-back.css', 'text/css; charset=utf-8', 'pb-back.css'],
    ['/app/app.js', 'text/javascript; charset=utf-8', 'app.js'],
  ] as [string, string, string][]).map(([path, type, file]) => [
    path,
    [type, readFileSync(join(PUBLIC, file), 'utf8')],
  ]),
);

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

export function createStaticServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (url.pathname === '/version') {
      json(res, 200, {
        name: PACKAGE.name,
        version: PACKAGE.version,
        commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
      });
      return;
    }
    if (url.pathname === '/api/scenarios') {
      json(res, 200, scenarioSummaries());
      return;
    }
    if (url.pathname === '/api/run') {
      const id = url.searchParams.get('scenario') ?? '';
      try {
        json(res, 200, runScenario(id));
      } catch {
        json(res, 400, { error: `unknown scenario: ${id}` });
      }
      return;
    }
    if (url.pathname.startsWith('/app/')) {
      // Serve app modules live so the UI shares the exact logic under test.
      const rel = url.pathname.slice('/app/'.length);
      if (rel === 'booking.js') {
        const src = readFileSync(fileURLToPath(new URL('./booking.ts', import.meta.url)), 'utf8');
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8' })
          .end(stripTypeScriptTypes(src, { mode: 'strip' }));
        return;
      }
      if (rel === 'app.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        const asset = STATIC.get('/app/app.js');
        if (asset) {
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset[0] })
            .end(req.method === 'HEAD' ? undefined : asset[1]);
          return;
        }
      }
      res.writeHead(404, SECURITY_HEADERS).end('not found');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC.get(url.pathname);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}): Promise<{
  server: Server;
  close: () => Promise<void>;
}> {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  const addr = server.address();
  console.log(`Hold the Nights Lab listening on ${typeof addr === 'object' && addr ? addr.port : '?'}`);
  const shutdown = async (): Promise<void> => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
