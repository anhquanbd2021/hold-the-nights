# Hold the Nights Lab — companion demo

Interactive lab for the article on booking concurrency: two guests race for
the same four nights at Loft 42. Search hits a lagging index — a copy built
for speed — while the calendar, one row per night, is the only real source
of truth and the only thing that needs a lock.

Zero dependencies — Node 24+ only. The domain model (`app/booking.ts`) is
erasable-syntax-only TypeScript shared by the browser UI, the HTTP API, and
the test suite: Node strips its types at runtime, and the server re-strips
the same file for the browser at `/app/booking.js`.

## Two tabs

- **Lab** (`/`) — pick one of six scripted races, then play or step the
  trace while the board paints the search index, the ledger, and the
  calendar night by night.
- **Guide** (`/guide.html`) — what each lab feature proves, the key detail
  behind it, how the demo is built, and the honest limits of the model.

## What it proves

| Claim | How the lab proves it |
|---|---|
| **Check-then-insert double-books** | Two guests read "free" at the same instant; two unconstrained writes land; every night ends with two owners. |
| **A UNIQUE index saves the row, not the guest** | `UNIQUE (listing_id, night)` rejects the second write — but only after the loser already paid. |
| **Hold-then-pay is the fix** | The atomic hold rejects the loser before a cent moves; the winner's hold converts to a booking after charge. |
| **Pay-first is the wrong order** | Charge first, hold fails second: money taken for a room someone else got, refund as the only exit. |
| **Locks must die on their own** | A timed-out payment lets the hold expire; the next guest books — the lock never leaks. |
| **The index may lag** | A 30-second-stale index still says "open" after the room is gone — harmless, because only the calendar decides. |

## Run it

```text
npm start        # serve the lab on http://localhost:3000
npm test         # domain model, race outcomes, and end-to-end HTTP routes
npm run check    # alias for npm test
```

## Layout

```text
app/booking.ts     calendar, holds, index, ledger + the race interpreter
app/server.ts      zero-dep static host + /health + /version + /api/*
public/index.html  the Lab tab
public/guide.html  the Guide tab — what the lab proves and its limits
public/app.js      browser wiring (documented JS exception)
public/styles.css  all styling — every value resolves to a tokens.css var
tokens.css/.json   direction "night-ledger" (light + dark schemes)
test/              node:test unit + e2e suites
```

## Honest limits

This is an **in-memory model of the race**, not a live booking system. No
real database, no payment gateway, no network between guests — the
interleavings are scripted so the failure modes replay deterministically.
The atomic-hold semantics mirror what a real `INSERT … ON CONFLICT` or
`SELECT … FOR UPDATE` gives you; the point is to make the mechanism legible,
not to replace Postgres.

Source: https://github.com/anhquanbd2021/hold-the-nights

This is an educational demo, not production infrastructure.
