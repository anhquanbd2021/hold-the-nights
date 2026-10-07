// Hold the Nights Lab — the booking model.
// One calendar (the truth), one lagging search index (a copy), one ledger,
// two guests racing for the same nights. Shared by the browser UI, the
// HTTP API, and the test suite. Erasable-syntax-only TypeScript: Node 24
// strips the types; the browser gets the same file through the same stripper.

// --- Domain ----------------------------------------------------------------

export type NightStatus = 'open' | 'held' | 'booked' | 'double';
export type TraceFlag = 'stale' | 'conflict' | 'fail' | null;

export interface Hold {
  holdId: string;
  guest: string;
  dates: string[];
  expiresAt: number; // ms offset from scenario start
}

export interface Night {
  date: string;
  bookedBy: string[]; // >1 entries means the impossible happened
}

export interface Calendar {
  listingId: string;
  nights: Night[]; // one row per night — the only real source of truth
  holds: Hold[];   // expiry is just time passing; dead holds stop counting
}

export interface LedgerEntry {
  kind: 'charge' | 'refund';
  guest: string;
  cents: number;
  memo: string;
}

export interface SearchDoc {
  listingId: string;
  priceCents: number;
  openDates: string[]; // a copy built for speed — allowed to lag
  builtAt: number;
}

export interface CalCellView {
  date: string;
  status: NightStatus;
  who: string[]; // booked guests, or the holder while a hold is live
}

// --- Fixture ---------------------------------------------------------------

export const GUESTS = ['Ada', 'Bo'] as const;
export const LISTING = {
  id: 'loft-42',
  title: 'Loft 42',
  priceCentsPerNight: 18000,
} as const;
export const NIGHTS = [
  '2026-03-12',
  '2026-03-13',
  '2026-03-14',
  '2026-03-15',
] as const;
export const HOLD_TTL_MS = 15 * 60 * 1000; // nights stay locked while you pay

export function usd(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US');
}

// --- Calendar operations ----------------------------------------------------

export function createCalendar(listingId: string, dates: readonly string[]): Calendar {
  return {
    listingId,
    nights: dates.map(date => ({ date, bookedBy: [] })),
    holds: [],
  };
}

export function liveHolds(cal: Calendar, now: number): Hold[] {
  return cal.holds.filter(h => h.expiresAt > now);
}

export function nightStatus(night: Night, cal: Calendar, now: number): NightStatus {
  if (night.bookedBy.length > 1) return 'double';
  if (night.bookedBy.length === 1) return 'booked';
  if (liveHolds(cal, now).some(h => h.dates.includes(night.date))) return 'held';
  return 'open';
}

export function calendarView(cal: Calendar, now: number): CalCellView[] {
  return cal.nights.map(n => {
    const hold = liveHolds(cal, now).find(h => h.dates.includes(n.date));
    return {
      date: n.date,
      status: nightStatus(n, cal, now),
      who: n.bookedBy.length > 0 ? [...n.bookedBy] : hold ? [hold.guest] : [],
    };
  });
}

// The read half of check-then-insert. Correct the instant it runs —
// and silently wrong by the time the write lands.
export function nightsAvailable(
  cal: Calendar,
  dates: readonly string[],
  now: number,
): { ok: boolean; conflicts: string[] } {
  const conflicts = dates.filter(d => {
    const night = cal.nights.find(n => n.date === d);
    return !night
      || night.bookedBy.length > 0
      || liveHolds(cal, now).some(h => h.dates.includes(d));
  });
  return { ok: conflicts.length === 0, conflicts };
}

// The atomic lock. Every date is checked before any row changes —
// all-or-nothing, so a guest never holds half a stay.
export function holdNights(
  cal: Calendar,
  guest: string,
  dates: readonly string[],
  now: number,
  holdId: string,
): { ok: true; holdId: string } | { ok: false; conflict: string } {
  for (const d of dates) {
    const night = cal.nights.find(n => n.date === d);
    if (!night || night.bookedBy.length > 0) return { ok: false, conflict: d };
    const live = liveHolds(cal, now).find(h => h.dates.includes(d));
    if (live && live.guest !== guest) return { ok: false, conflict: d };
  }
  cal.holds.push({ holdId, guest, dates: [...dates], expiresAt: now + HOLD_TTL_MS });
  return { ok: true, holdId };
}

// Hold -> booking, but only while the hold is alive.
export function bookHold(
  cal: Calendar,
  holdId: string,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  const i = cal.holds.findIndex(h => h.holdId === holdId);
  if (i < 0) return { ok: false, reason: 'no-such-hold' };
  const hold = cal.holds[i];
  if (hold.expiresAt <= now) return { ok: false, reason: 'hold-expired' };
  for (const d of hold.dates) {
    const night = cal.nights.find(n => n.date === d);
    if (night && !night.bookedBy.includes(hold.guest)) night.bookedBy.push(hold.guest);
  }
  cal.holds.splice(i, 1);
  return { ok: true };
}

export function releaseHold(cal: Calendar, holdId: string): Hold | null {
  const i = cal.holds.findIndex(h => h.holdId === holdId);
  if (i < 0) return null;
  return cal.holds.splice(i, 1)[0];
}

// Prune dead holds; returns their ids. Correctness never depends on
// sweeping — an expired hold simply stops counting — this just tidies up.
export function sweepExpired(cal: Calendar, now: number): string[] {
  const expired = cal.holds.filter(h => h.expiresAt <= now).map(h => h.holdId);
  cal.holds = cal.holds.filter(h => h.expiresAt > now);
  return expired;
}

// The bug: INSERT with no unique index. Two rows, one night, two
// confirmations for one room.
export function insertUnchecked(cal: Calendar, guest: string, dates: readonly string[]): void {
  for (const d of dates) {
    const night = cal.nights.find(n => n.date === d);
    if (night) night.bookedBy.push(guest);
  }
}

// UNIQUE (listing_id, night): the multi-row INSERT aborts on the first
// conflict — the row is saved even when the guest cannot be.
export function insertUnique(
  cal: Calendar,
  guest: string,
  dates: readonly string[],
): { ok: true } | { ok: false; conflict: string } {
  for (const d of dates) {
    const night = cal.nights.find(n => n.date === d);
    if (!night || night.bookedBy.length > 0) return { ok: false, conflict: d };
  }
  for (const d of dates) {
    const night = cal.nights.find(n => n.date === d);
    if (night) night.bookedBy.push(guest);
  }
  return { ok: true };
}

// The search index is a projection of the calendar — disposable,
// rebuildable, and never consulted on the write path.
export function rebuildIndex(cal: Calendar, now: number): SearchDoc {
  return {
    listingId: cal.listingId,
    priceCents: LISTING.priceCentsPerNight,
    openDates: cal.nights
      .filter(n => nightStatus(n, cal, now) === 'open')
      .map(n => n.date),
    builtAt: now,
  };
}

export function ledgerTotals(ledger: LedgerEntry[]): Record<string, { charged: number; refunded: number }> {
  const totals: Record<string, { charged: number; refunded: number }> = {};
  for (const e of ledger) {
    const t = (totals[e.guest] ??= { charged: 0, refunded: 0 });
    if (e.kind === 'charge') t.charged += e.cents;
    else t.refunded += e.cents;
  }
  return totals;
}

// --- The race, scripted -----------------------------------------------------

export type Action =
  | 'search' | 'check' | 'hold' | 'charge' | 'write'
  | 'book' | 'release' | 'expire' | 'refund' | 'advance' | 'reindex';

export interface TraceEvent {
  seq: number;
  now: number;          // ms since scenario start
  actor: string;        // guest name or 'system'
  action: Action;
  ok: boolean;
  flag: TraceFlag;      // stale | conflict | fail | null
  detail: string;       // one line of narration for the UI log
  dates: string[];      // dates this event touched
  view: CalCellView[];  // calendar truth after this event
  indexOpen: string[];  // what the lagging index claims after this event
}

interface GuestOp {
  do: 'search' | 'check' | 'hold' | 'charge' | 'write-unsafe'
    | 'write-unique' | 'book' | 'release' | 'refund';
  guest: string;
}
interface AdvanceOp { do: 'advance'; ms: number }
interface ReindexOp { do: 'reindex' }
export type Op = GuestOp | AdvanceOp | ReindexOp;

export interface Scenario {
  id: string;
  title: string;
  lede: string;
  ops: Op[];
  payFailsFor?: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'check-then-insert',
    title: 'Check, then insert',
    lede: 'No hold, no constraint. Both guests read "free", both pay, both write.',
    ops: [
      { do: 'search', guest: 'Ada' },
      { do: 'search', guest: 'Bo' },
      { do: 'check', guest: 'Ada' },
      { do: 'check', guest: 'Bo' },
      { do: 'charge', guest: 'Ada' },
      { do: 'charge', guest: 'Bo' },
      { do: 'write-unsafe', guest: 'Ada' },
      { do: 'write-unsafe', guest: 'Bo' },
    ],
  },
  {
    id: 'pay-first',
    title: 'Charge first, hold second',
    lede: 'Same calendar, wrong order: money moves before the lock.',
    ops: [
      { do: 'charge', guest: 'Ada' },
      { do: 'charge', guest: 'Bo' },
      { do: 'hold', guest: 'Ada' },
      { do: 'hold', guest: 'Bo' },
      { do: 'book', guest: 'Ada' },
      { do: 'refund', guest: 'Bo' },
    ],
  },
  {
    id: 'unique-constraint',
    title: 'UNIQUE (listing, night)',
    lede: 'The index saves the row at write time — after the guest already paid.',
    ops: [
      { do: 'check', guest: 'Ada' },
      { do: 'check', guest: 'Bo' },
      { do: 'charge', guest: 'Ada' },
      { do: 'charge', guest: 'Bo' },
      { do: 'write-unique', guest: 'Ada' },
      { do: 'write-unique', guest: 'Bo' },
      { do: 'refund', guest: 'Bo' },
    ],
  },
  {
    id: 'hold-then-pay',
    title: 'Hold the nights, then pay',
    lede: 'The atomic hold rejects the loser before a cent moves.',
    ops: [
      { do: 'search', guest: 'Ada' },
      { do: 'hold', guest: 'Ada' },
      { do: 'hold', guest: 'Bo' },
      { do: 'charge', guest: 'Ada' },
      { do: 'book', guest: 'Ada' },
    ],
  },
  {
    id: 'hold-expiry',
    title: 'Holds die on their own',
    lede: 'Payment times out mid-hold; the lock expires and the next guest books.',
    payFailsFor: ['Ada'],
    ops: [
      { do: 'hold', guest: 'Ada' },
      { do: 'charge', guest: 'Ada' },
      { do: 'advance', ms: 16 * 60 * 1000 },
      { do: 'hold', guest: 'Bo' },
      { do: 'charge', guest: 'Bo' },
      { do: 'book', guest: 'Bo' },
    ],
  },
  {
    id: 'search-lag',
    title: 'The index lies — and it does not matter',
    lede: 'A 30-second-stale index says "open" after the room is gone. The calendar disagrees.',
    ops: [
      { do: 'hold', guest: 'Ada' },
      { do: 'charge', guest: 'Ada' },
      { do: 'book', guest: 'Ada' },
      { do: 'search', guest: 'Bo' },
      { do: 'hold', guest: 'Bo' },
      { do: 'reindex' },
      { do: 'search', guest: 'Bo' },
    ],
  },
];

export type Outcome =
  | 'double-booked' | 'charged-no-room' | 'clean-booking'
  | 'hold-expired' | 'stale-but-safe';

export interface ScenarioResult {
  id: string;
  title: string;
  lede: string;
  trace: TraceEvent[];
  calendar: Calendar;
  index: SearchDoc;
  ledger: LedgerEntry[];
  outcome: Outcome;
  blastRadius: string | null;
}

// --- Deterministic runner -----------------------------------------------------
// Every scenario replays the same interleaving every time. Each op appends
// trace events carrying a post-event snapshot, so the UI can step the race
// forward and backward without re-running anything.

export function runScenario(id: string): ScenarioResult {
  const scenario = SCENARIOS.find(s => s.id === id);
  if (!scenario) throw new Error(`unknown scenario: ${id}`);

  const cal = createCalendar(LISTING.id, [...NIGHTS]);
  const ledger: LedgerEntry[] = [];
  let index = rebuildIndex(cal, 0);
  let now = 0;
  let holdSeq = 0;
  let seq = 0;
  const trace: TraceEvent[] = [];
  const payFails = new Set(scenario.payFailsFor ?? []);
  const allDates = [...NIGHTS];
  const totalCents = LISTING.priceCentsPerNight * NIGHTS.length;

  const emit = (
    actor: string,
    action: Action,
    ok: boolean,
    detail: string,
    dates: string[] = [],
    flag: TraceFlag = null,
  ): void => {
    trace.push({
      seq: ++seq, now, actor, action, ok, flag, detail,
      dates: [...dates],
      view: calendarView(cal, now),
      indexOpen: [...index.openDates],
    });
  };

  for (const op of scenario.ops) {
    if (op.do === 'search') {
      const open = allDates.every(d => index.openDates.includes(d));
      const stale = open && !nightsAvailable(cal, allDates, now).ok;
      const ago = Math.max(0, Math.round((now - index.builtAt) / 1000));
      emit(op.guest, 'search', open,
        stale
          ? `${op.guest} searches — the index still shows ${allDates.length} nights open (snapshot ${ago}s stale)`
          : open
            ? `${op.guest} searches — the index shows ${allDates.length} nights open`
            : `${op.guest} searches — the index now shows the nights taken`,
        allDates, stale ? 'stale' : null);
    } else if (op.do === 'check') {
      const r = nightsAvailable(cal, allDates, now);
      emit(op.guest, 'check', r.ok,
        r.ok
          ? `${op.guest} reads the calendar — every night still free`
          : `${op.guest} reads the calendar — ${r.conflicts[0]} is already taken`,
        allDates, r.ok ? null : 'conflict');
    } else if (op.do === 'hold') {
      const r = holdNights(cal, op.guest, allDates, now, `H-${++holdSeq}`);
      if (r.ok) {
        emit(op.guest, 'hold', true,
          `${op.guest} holds ${allDates.length} nights — locked for ${HOLD_TTL_MS / 60000} min while payment runs`,
          allDates);
      } else {
        const blocker = liveHolds(cal, now).find(h => h.dates.includes(r.conflict));
        const night = cal.nights.find(n => n.date === r.conflict);
        const why = blocker ? `held by ${blocker.guest}` : `booked by ${night?.bookedBy[0] ?? 'someone'}`;
        emit(op.guest, 'hold', false,
          `${op.guest} tries to hold — ${r.conflict} is ${why}. Rejected before money moves`,
          allDates, 'conflict');
      }
    } else if (op.do === 'charge') {
      if (payFails.has(op.guest)) {
        emit(op.guest, 'charge', false,
          `${op.guest}'s payment times out — no charge lands`, [], 'fail');
      } else {
        ledger.push({ kind: 'charge', guest: op.guest, cents: totalCents, memo: `${allDates.length} nights` });
        emit(op.guest, 'charge', true,
          `${op.guest} is charged ${usd(totalCents)} for ${allDates.length} nights`);
      }
    } else if (op.do === 'write-unsafe') {
      insertUnchecked(cal, op.guest, allDates);
      const doubled = cal.nights.filter(n => n.bookedBy.length > 1).length;
      emit(op.guest, 'write', true,
        doubled > 0
          ? `${op.guest} inserts ${allDates.length} booking rows — the table now holds two guests for the same nights`
          : `${op.guest} inserts ${allDates.length} booking rows — no constraint, no questions`,
        allDates, doubled > 0 ? 'conflict' : null);
    } else if (op.do === 'write-unique') {
      const r = insertUnique(cal, op.guest, allDates);
      emit(op.guest, 'write', r.ok,
        r.ok
          ? `${op.guest}'s INSERT lands — UNIQUE(listing_id, night) is satisfied`
          : `${op.guest}'s INSERT hits the UNIQUE index on (listing_id, night) at ${r.conflict} — write rejected`,
        allDates, r.ok ? null : 'conflict');
    } else if (op.do === 'book') {
      const hold = cal.holds.find(h => h.guest === op.guest);
      const r = hold ? bookHold(cal, hold.holdId, now) : { ok: false as const, reason: 'no-such-hold' };
      emit(op.guest, 'book', r.ok,
        r.ok
          ? `${op.guest}'s hold converts to a booking — the nights are theirs`
          : `${op.guest} tries to confirm — ${'reason' in r ? r.reason : 'no hold'}`,
        allDates, r.ok ? null : 'fail');
    } else if (op.do === 'release') {
      const hold = cal.holds.find(h => h.guest === op.guest);
      const gone = hold ? releaseHold(cal, hold.holdId) : null;
      emit(op.guest, 'release', gone !== null,
        gone
          ? `${op.guest}'s hold ${gone.holdId} is released — payment failed`
          : `${op.guest} has no hold to release`,
        [], gone ? null : 'fail');
    } else if (op.do === 'refund') {
      const charged = ledger
        .filter(e => e.kind === 'charge' && e.guest === op.guest)
        .reduce((s, e) => s + e.cents, 0);
      ledger.push({ kind: 'refund', guest: op.guest, cents: charged, memo: 'booking rejected' });
      emit(op.guest, 'refund', true,
        `${op.guest} is refunded ${usd(charged)} — money back, room gone`);
    } else if (op.do === 'advance') {
      now += op.ms;
      emit('system', 'advance', true,
        `${Math.round(op.ms / 60000)} min pass — payment still in flight`);
      for (const holdId of sweepExpired(cal, now)) {
        emit('system', 'expire', true, `hold ${holdId} expires — the lock dies on its own`);
      }
    } else if (op.do === 'reindex') {
      index = rebuildIndex(cal, now);
      emit('system', 'reindex', true,
        'search index rebuilt from the calendar — the copy catches up');
    }
  }

  const { outcome, blastRadius } = deriveOutcome(cal, ledger, trace);
  return {
    id: scenario.id, title: scenario.title, lede: scenario.lede,
    trace, calendar: cal, index, ledger, outcome, blastRadius,
  };
}

export function scenarioSummaries(): { id: string; title: string; lede: string }[] {
  return SCENARIOS.map(({ id, title, lede }) => ({ id, title, lede }));
}

// The outcome is derived from the world, not declared by the scenario —
// the lab asserts what actually happened.
function deriveOutcome(
  cal: Calendar,
  ledger: LedgerEntry[],
  trace: TraceEvent[],
): { outcome: Outcome; blastRadius: string | null } {
  const doubled = cal.nights.filter(n => n.bookedBy.length > 1);
  if (doubled.length > 0) {
    const guests = [...new Set(cal.nights.flatMap(n => n.bookedBy))];
    return {
      outcome: 'double-booked',
      blastRadius: `${guests.join(' and ')} both hold confirmations for ${doubled.length} of the same nights — one room, two arrivals, somebody sleeps in the lobby.`,
    };
  }
  const chargedNoRoom = GUESTS.filter(g =>
    ledger.some(e => e.kind === 'charge' && e.guest === g)
    && !cal.nights.some(n => n.bookedBy.includes(g)));
  if (chargedNoRoom.length > 0) {
    return {
      outcome: 'charged-no-room',
      blastRadius: `${chargedNoRoom.join(' and ')} paid for a room somebody else got — even refunded, that is a support ticket and a lost guest.`,
    };
  }
  if (trace.some(e => e.action === 'expire')) return { outcome: 'hold-expired', blastRadius: null };
  if (trace.some(e => e.flag === 'stale')) return { outcome: 'stale-but-safe', blastRadius: null };
  return { outcome: 'clean-booking', blastRadius: null };
}
