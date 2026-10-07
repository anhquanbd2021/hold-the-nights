// e2e.test.ts — boots the real server on an ephemeral port and drives it
// with fetch(). Covers the two pages, the ops endpoints, one real API
// endpoint, and the type-stripped module route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createStaticServer } from '../app/server.ts';
import { SCENARIOS } from '../app/booking.ts';

async function boot(): Promise<{ server: Server; base: string }> {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

test('GET / serves the Lab page with nav and every id the JS queries', async () => {
  const { server, base } = await boot();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('aria-label="Primary"'), 'primary nav present');
    assert.ok(html.includes('aria-current="page"'), 'active tab marked');
    assert.ok(html.includes('class="skip-link"'), 'skip link present');
    assert.ok(html.includes('/guide.html'), 'guide tab linked');
    for (const id of [
      'scenarioBar', 'scenarioLede', 'indexLine', 'ledger', 'nights',
      'playBtn', 'stepBtn', 'resetBtn', 'progress', 'outcome', 'blast',
      'trace', 'pb-back',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `#${id} exists in the DOM`);
    }
  } finally {
    server.close();
  }
});

test('GET /guide.html serves the Guide page', async () => {
  const { server, base } = await boot();
  try {
    const res = await fetch(`${base}/guide.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('aria-label="Primary"'), 'primary nav present');
    assert.ok(html.includes('guide-section'), 'guide sections rendered');
    assert.ok(html.includes('control-grid'), 'control grid rendered');
    assert.ok(html.includes('>Proves<') && html.includes('>Key detail<'), 'dl terms present');
  } finally {
    server.close();
  }
});

test('/health returns ok and /version returns package JSON', async () => {
  const { server, base } = await boot();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    const meta = await version.json() as { name: string; version: string; commit: string };
    assert.equal(meta.name, 'hold-the-nights-demo');
    assert.ok(meta.version && meta.commit, 'version payload is complete');
  } finally {
    server.close();
  }
});

test('/api/run runs a real race over HTTP', async () => {
  const { server, base } = await boot();
  try {
    const list = await (await fetch(`${base}/api/scenarios`)).json() as { id: string }[];
    assert.equal(list.length, SCENARIOS.length);

    const res = await fetch(`${base}/api/run?scenario=hold-then-pay`);
    assert.equal(res.status, 200);
    const r = await res.json() as { outcome: string; trace: unknown[] };
    assert.equal(r.outcome, 'clean-booking');
    assert.ok(r.trace.length > 0, 'trace crosses the wire');
  } finally {
    server.close();
  }
});

test('/app/*.js serves the browser stripped JavaScript', async () => {
  const { server, base } = await boot();
  try {
    for (const path of ['/app/booking.js', '/app/app.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.ok(!body.includes('interface '), `${path} has no TypeScript interfaces`);
    }
    const booking = await (await fetch(`${base}/app/booking.js`)).text();
    assert.ok(booking.includes('export function holdNights'), 'the model is served');
  } finally {
    server.close();
  }
});

test('stylesheets and unknown routes behave', async () => {
  const { server, base } = await boot();
  try {
    for (const path of ['/tokens.css', '/styles.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/css/, path);
    }
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
