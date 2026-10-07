import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  SCENARIOS,
  GUESTS,
  NIGHTS,
  HOLD_TTL_MS,
  createCalendar,
  holdNights,
  bookHold,
  releaseHold,
  sweepExpired,
  nightsAvailable,
  insertUnchecked,
  insertUnique,
  rebuildIndex,
  runScenario,
  scenarioSummaries,
  type Calendar,
} from '../app/booking.ts';
import { createStaticServer } from '../app/server.ts';

// --- The lock itself ----------------------------------------------------------

test('the atomic hold rejects the second guest before money moves', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  const ada = holdNights(cal, 'Ada', NIGHTS, 0, 'H-1');
  assert.equal(ada.ok, true);
  const bo = holdNights(cal, 'Bo', NIGHTS, 0, 'H-2');
  assert.equal(bo.ok, false);
  if (!bo.ok) assert.equal(bo.conflict, NIGHTS[0]);
});

test('a hold is all-or-nothing: a partially taken stay holds nothing', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  insertUnique(cal, 'Someone', [NIGHTS[2]]);
  const r = holdNights(cal, 'Ada', NIGHTS, 0, 'H-1');
  assert.equal(r.ok, false);
  assert.equal(cal.holds.length, 0, 'no partial hold may be left behind');
});

test('check-then-insert reads free while a hold is already gone', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  // Both guests read at the same instant: the read is correct for both…
  assert.equal(nightsAvailable(cal, NIGHTS, 0).ok, true);
  assert.equal(nightsAvailable(cal, NIGHTS, 0).ok, true);
  // …and unconstrained writes land for both — the race the post warns about.
  insertUnchecked(cal, 'Ada', NIGHTS);
  insertUnchecked(cal, 'Bo', NIGHTS);
  const doubled = cal.nights.filter(n => n.bookedBy.length > 1);
  assert.equal(doubled.length, NIGHTS.length, 'every night now has two owners');
});

test('UNIQUE (listing, night) saves the row even under the same interleave', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  assert.equal(insertUnique(cal, 'Ada', NIGHTS).ok, true);
  const bo = insertUnique(cal, 'Bo', NIGHTS);
  assert.equal(bo.ok, false);
  assert.ok(cal.nights.every(n => n.bookedBy.length === 1), 'one row per night, always');
});

test('holds die on their own: expiry frees the nights without a sweeper', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  const ada = holdNights(cal, 'Ada', NIGHTS, 0, 'H-1');
  assert.ok(ada.ok);
  const after = HOLD_TTL_MS + 1;
  assert.equal(bookHold(cal, 'H-1', after).ok, false, 'a dead hold cannot convert');
  const bo = holdNights(cal, 'Bo', NIGHTS, after, 'H-2');
  assert.equal(bo.ok, true, 'expired holds stop counting');
  assert.deepEqual(sweepExpired(cal, after), ['H-1'], 'sweeping prunes the corpse — it never kept anyone out');
});

test('a released hold frees the nights for the next guest', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  holdNights(cal, 'Ada', NIGHTS, 0, 'H-1');
  releaseHold(cal, 'H-1');
  assert.equal(holdNights(cal, 'Bo', NIGHTS, 0, 'H-2').ok, true);
});

test('the search index is a rebuildable copy, never the truth', () => {
  const cal = createCalendar('loft-42', NIGHTS);
  const stale = rebuildIndex(cal, 0);
  holdNights(cal, 'Ada', NIGHTS, 0, 'H-1');
  bookHold(cal, 'H-1', 0);
  assert.equal(stale.openDates.length, NIGHTS.length, 'snapshot still says open');
  const fresh = rebuildIndex(cal, 60_000);
  assert.equal(fresh.openDates.length, 0, 'rebuilt copy catches up');
});

// --- The scripted races ---------------------------------------------------------

test('check-then-insert scenario: two confirmations, one room', () => {
  const r = runScenario('check-then-insert');
  assert.equal(r.outcome, 'double-booked');
  assert.ok(r.blastRadius && r.blastRadius.includes('Ada') && r.blastRadius.includes('Bo'));
  assert.equal(r.ledger.filter(e => e.kind === 'charge').length, 2, 'both guests were charged');
  assert.equal(r.ledger.filter(e => e.kind === 'refund').length, 0, 'nobody was refunded');
});

test('pay-first scenario: the loser paid for a room they never got', () => {
  const r = runScenario('pay-first');
  assert.equal(r.outcome, 'charged-no-room');
  const booked = r.calendar.nights[0].bookedBy;
  assert.deepEqual(booked, ['Ada']);
  assert.ok(r.ledger.some(e => e.kind === 'refund' && e.guest === 'Bo'), 'Bo is refunded — after the fact');
});

test('unique-constraint scenario: row saved, guest still lost', () => {
  const r = runScenario('unique-constraint');
  assert.equal(r.outcome, 'charged-no-room');
  assert.ok(r.calendar.nights.every(n => n.bookedBy.length === 1), 'no night is double-booked');
  const conflict = r.trace.find(e => e.flag === 'conflict');
  assert.ok(conflict && conflict.action === 'write', 'the UNIQUE index rejected the second write');
});

test('hold-then-pay scenario: the loser never reaches the card charge', () => {
  const r = runScenario('hold-then-pay');
  assert.equal(r.outcome, 'clean-booking');
  assert.equal(r.blastRadius, null);
  const boEvents = r.trace.filter(e => e.actor === 'Bo');
  assert.equal(boEvents.length, 1, 'Bo acts once: the rejected hold');
  assert.equal(boEvents[0].action, 'hold');
  assert.ok(r.ledger.every(e => e.guest === 'Ada'), 'Bo was never charged');
});

test('hold-expiry scenario: the lock dies and the next guest books', () => {
  const r = runScenario('hold-expiry');
  assert.equal(r.outcome, 'hold-expired');
  assert.ok(r.trace.some(e => e.action === 'expire'), 'an expiry event was emitted');
  assert.ok(r.calendar.nights.every(n => n.bookedBy.includes('Bo')));
  assert.equal(r.ledger.filter(e => e.kind === 'charge').length, 1, 'only the winning guest paid');
});

test('search-lag scenario: the index lies and the calendar still wins', () => {
  const r = runScenario('search-lag');
  assert.equal(r.outcome, 'stale-but-safe');
  const staleSearch = r.trace.find(e => e.flag === 'stale');
  assert.ok(staleSearch && staleSearch.action === 'search', 'Bo searched a stale index');
  const rejected = r.trace.find(e => e.actor === 'Bo' && e.action === 'hold');
  assert.equal(rejected?.ok, false, 'the calendar rejected the stale read');
});

test('every scenario replays deterministically with snapshot per event', () => {
  for (const s of SCENARIOS) {
    const a = runScenario(s.id);
    const b = runScenario(s.id);
    assert.deepEqual(a, b, `${s.id} must be deterministic`);
    assert.ok(a.trace.every(e => e.view.length === NIGHTS.length), 'every event snapshots the calendar');
    assert.ok(a.trace.every(e => e.indexOpen.length <= NIGHTS.length), 'every event snapshots the index');
  }
});

test('scenario summaries match the scenario list', () => {
  assert.deepEqual(
    scenarioSummaries().map(s => s.id),
    SCENARIOS.map(s => s.id),
  );
});

// --- HTTP level -----------------------------------------------------------------

async function listen() {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('/health, /version, and the module routes', async () => {
  const server = await listen();
  const port = (server.address() as { port: number }).port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`http://127.0.0.1:${port}/version`);
    assert.equal(version.status, 200);
    const meta = await version.json() as { name: string };
    assert.equal(meta.name, 'hold-the-nights-demo');

    for (const path of ['/', '/tokens.css', '/app/app.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, path);
    }

    for (const path of ['/package.json', '/nope']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally {
    server.close();
  }
});

test('/app/booking.js serves the browser the same model, types stripped', async () => {
  const server = await listen();
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/app/booking.js`);
    assert.equal(res.status, 200);
    const src = await res.text();
    assert.ok(src.includes('export function holdNights'), 'the model is served');
    assert.ok(!src.includes('interface Calendar'), 'types are stripped before the browser sees them');
  } finally {
    server.close();
  }
});

test('/api/scenarios and /api/run expose the lab over HTTP', async () => {
  const server = await listen();
  const port = (server.address() as { port: number }).port;
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/scenarios`)).json() as { id: string }[];
    assert.equal(list.length, SCENARIOS.length);

    const res = await fetch(`http://127.0.0.1:${port}/api/run?scenario=check-then-insert`);
    assert.equal(res.status, 200);
    const r = await res.json() as { outcome: string };
    assert.equal(r.outcome, 'double-booked', 'the race outcome survives the wire');

    const bad = await fetch(`http://127.0.0.1:${port}/api/run?scenario=nope`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
