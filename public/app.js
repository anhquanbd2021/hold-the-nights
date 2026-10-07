// Hold the Nights Lab — browser wiring.
// This file is intentionally plain JavaScript: browsers cannot strip
// TypeScript types and this project allows no build step. The typed domain
// model lives in app/booking.ts and reaches the browser as /app/booking.js
// via node:module's stripTypeScriptTypes — the same file the tests exercise.
// This is the project's documented JS exception.

import { runScenario, NIGHTS, LISTING, usd } from '/app/booking.js';

const $ = id => document.getElementById(id);
const state = { result: null, step: 0, timer: null };

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(iso) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(iso + 'T00:00:00Z');
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function dateRange(dates) {
  return `${fmtDate(dates[0])}–${fmtDate(dates[dates.length - 1])}`;
}

// --- Rendering ---------------------------------------------------------------

function renderIndexLine() {
  const el = $('indexLine');
  const r = state.result;
  const ev = state.step > 0 ? r.trace[state.step - 1] : null;
  const open = ev ? ev.indexOpen : [...NIGHTS];
  const stale = ev && ev.flag === 'stale';
  const status = open.length
    ? `${open.length} night${open.length === 1 ? '' : 's'} open`
    : 'no nights open';
  el.innerHTML = stale
    ? `says ${esc(status)} <span class="stale">— stale snapshot, still showing the room free</span>`
    : `says ${esc(status)} <span class="fresh">for ${esc(LISTING.title)}</span>`;
}

const STATUS_LABEL = { open: 'open', held: 'held', booked: 'booked', double: 'double-booked' };

function renderNights() {
  const view = state.step > 0
    ? state.result.trace[state.step - 1].view
    : [...NIGHTS].map(date => ({ date, status: 'open', who: [] }));
  $('nights').innerHTML = view.map(cell => `
    <div class="night ${esc(cell.status)}" role="img"
         aria-label="${esc(cell.date)}: ${esc(STATUS_LABEL[cell.status])}${cell.who.length ? ' by ' + esc(cell.who.join(' and ')) : ''}">
      <span class="d">${esc(fmtDate(cell.date))}</span>
      <span class="s">${esc(STATUS_LABEL[cell.status])}</span>
      <span class="w">${esc(cell.who.join(' & '))}</span>
    </div>`).join('');
}

function renderLedger() {
  const upto = state.result.trace.slice(0, state.step);
  const total = usd(LISTING.priceCentsPerNight * NIGHTS.length);
  const lines = [];
  for (const ev of upto) {
    if (ev.action === 'charge' && ev.ok) lines.push(`<li class="charge">− ${esc(ev.actor)} charged ${esc(total)}</li>`);
    if (ev.action === 'charge' && !ev.ok) lines.push(`<li class="refund">× ${esc(ev.actor)} — payment failed, no charge</li>`);
    if (ev.action === 'refund') lines.push(`<li class="refund">+ ${esc(ev.actor)} refunded ${esc(total)}</li>`);
  }
  $('ledger').innerHTML = lines.length ? lines.join('') : '<li>No payments yet.</li>';
}

function renderTrace() {
  const items = state.result.trace.map((ev, i) => {
    const pos = i + 1;
    const cls = [pos === state.step ? 'active' : pos < state.step ? 'seen' : 'pending', ev.flag || ''].join(' ').trim();
    return `<li class="${cls}" data-seq="${ev.seq}"><span class="tag">${esc(ev.action)}</span><span class="who">${esc(ev.actor)}</span>${esc(ev.detail)}</li>`;
  });
  $('trace').innerHTML = items.join('');
}

const OUTCOME_LABEL = {
  'double-booked': 'Double-booked — two guests hold confirmations for the same nights.',
  'charged-no-room': 'Charged, no room — the constraint saved the row, not the guest.',
  'clean-booking': 'Clean booking — the loser was rejected before money moved.',
  'hold-expired': 'Hold expired — the lock died on its own and the next guest booked.',
  'stale-but-safe': 'Stale but safe — the index lied, the calendar told the truth.',
};
const BAD_OUTCOMES = new Set(['double-booked', 'charged-no-room']);

function renderOutcome() {
  const done = state.step >= state.result.trace.length;
  const outcomeEl = $('outcome');
  const blastEl = $('blast');
  if (!done) {
    outcomeEl.hidden = true;
    blastEl.hidden = true;
    return;
  }
  const r = state.result;
  outcomeEl.hidden = false;
  outcomeEl.className = 'outcome' + (BAD_OUTCOMES.has(r.outcome) ? ' bad' : '');
  outcomeEl.textContent = OUTCOME_LABEL[r.outcome] || r.outcome;
  blastEl.hidden = !r.blastRadius;
  blastEl.textContent = r.blastRadius ? `Blast radius: ${r.blastRadius}` : '';
}

function renderAll() {
  renderIndexLine();
  renderNights();
  renderLedger();
  renderTrace();
  renderOutcome();
  const n = state.result.trace.length;
  $('progress').textContent = `event ${state.step} of ${n}`;
  $('playBtn').textContent = state.timer ? 'Pause' : 'Play';
  const active = $('trace').querySelector('li.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function select(id) {
  stopTimer();
  state.result = runScenario(id);
  state.step = 0;
  for (const btn of document.querySelectorAll('#scenarioBar button')) {
    const on = btn.dataset.id === id;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  $('scenarioLede').textContent = state.result.lede;
  renderAll();
}

function stepOnce() {
  if (state.step < state.result.trace.length) {
    state.step += 1;
    renderAll();
  } else {
    stopTimer();
    renderAll();
  }
}

// --- Boot --------------------------------------------------------------------

async function init() {
  const scenarios = await (await fetch('/api/scenarios')).json();
  $('scenarioBar').innerHTML = scenarios.map((s, i) =>
    `<button type="button" class="toggle" data-id="${esc(s.id)}" aria-pressed="false">${i + 1}. ${esc(s.title)}</button>`).join('');
  for (const btn of document.querySelectorAll('#scenarioBar button')) {
    btn.addEventListener('click', () => select(btn.dataset.id));
  }
  $('playBtn').addEventListener('click', () => {
    if (state.timer) { stopTimer(); renderAll(); return; }
    if (state.step >= state.result.trace.length) state.step = 0;
    state.timer = setInterval(stepOnce, 1100);
    stepOnce();
  });
  $('stepBtn').addEventListener('click', () => { stopTimer(); stepOnce(); });
  $('resetBtn').addEventListener('click', () => { stopTimer(); state.step = 0; renderAll(); });
  select(scenarios[0].id);
}

init();
