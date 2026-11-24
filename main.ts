// Pump.fun paper replay bot — Closer + guardrail probes (probe24 config).
//
// Strategy, in two parts:
//
//   CLOSER — ride coins that are about to complete. Buy once per coin, 0.5 SOL,
//   when a coin's real reserves reach 50 SOL having grown at least 10 SOL over
//   the last 50 slots, and the coin is at most 500 slots old. Most completions
//   are unbuyable (they complete in the same slot they cross 50 SOL), so the
//   edge lives in the enterable tail: coins that stall above 50 SOL and then
//   complete, or spike 2x first. Exits: take-profit at 2x the fill price,
//   stop-loss at 0.75x, timeout 600 slots after the buy fill. Completion
//   force-closes whatever is left at roughly 2x. No re-entry, ever.
//
//   PROBES — bank the 20-coin guardrail with margin. While fewer than 25 coins
//   have round-tripped, buy 0.012 SOL of the highest-reserve liquid coin
//   (real reserves >= 5 SOL), at most 24 probes, spaced at least 300 slots
//   apart, and sell it straight back on the next batch. A probe is not a bet:
//   it exists only so the guardrail holds on a completion-poor day.
//
// The bot is fully deterministic: bigint arithmetic only, no clock, no
// randomness, no environment, no network. Every decision comes from the
// hello/batch stream the harness sends (state.hello, state.slot, the batch's
// events, marks and fills) and the bot's own books.
//
// Run by the grader as `node /bot/main.ts` (Node strips the types; no build,
// no install). Grade locally with the kit:
//   node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---- parameters (probe24: frozen after the 9-config exact validation) ----

const SOL = LAMPORTS_PER_SOL;

/** Closer stake per coin: 0.5 SOL (also the size cap at 50 SOL reserves). */
const CLOSER_STAKE = SOL / 2n;
/** Real reserves must reach 50 SOL before a closer buy. */
const ENTRY_MIN_RQ = 50n * SOL;
/** ...and must have grown by at least 10 SOL over the last 50 slots. */
const VELOCITY_MIN = 10n * SOL;
const VELOCITY_WINDOW_SLOTS = 50;
/** Coins older than 500 slots at the trigger never get a closer buy. */
const MAX_AGE_SLOTS = 500;
/** Take-profit at 2x the fill price. */
const TAKE_PROFIT_NUM = 2n;
const TAKE_PROFIT_DEN = 1n;
/** Stop-loss at 0.75x the fill price. */
const STOP_LOSS_NUM = 3n;
const STOP_LOSS_DEN = 4n;
/** Exit a closer position 600 slots after its buy fill. */
const HOLD_TIMEOUT_SLOTS = 600;

/** Probe round-trip size: 0.012 SOL (above the 0.01 SOL guardrail floor). */
const PROBE_SIZE = 12_000_000n;
/** A probe target needs real reserves of at least 5 SOL to count as liquid. */
const PROBE_MIN_RQ = 5n * SOL;
/** At most 24 probes in a run. */
const PROBE_MAX = 24;
/** At least 300 slots between probe buys. */
const PROBE_SPACING_SLOTS = 300;
/** Stop probing once 25 distinct coins have round-tripped. */
const PROBE_STOP_ROUND_TRIPS = 25;

/** Wide-open slippage: a fill is never refused for the price moving. */
const MAX_SLIPPAGE_BPS = 10_000;

// ---- the bot's own books ----

interface FillInfo {
  /** The curve's virtual reserves when the buy fill landed: the fill price
   *  is vq0/vt0, the marginal price at the fill, not the average execution
   *  price (which bakes in the buy's own curve impact and its fees). TP/SL
   *  compare the current marginal price against it. */
  vq0: bigint;
  vt0: bigint;
  /** Slot the buy filled at (timeout counts from here). */
  fillSlot: number;
  kind: 'closer' | 'probe';
}

/** Reserve samples per mint, appended in slot order: the create (0) plus
 *  every trade's post-trade real reserves. Append-only on purpose: the
 *  earliest sample is the velocity reference for coins younger than the
 *  window, and overwriting same-slot samples would erase the create. */
const history = new Map<string, { slot: number; rq: bigint }[]>();
/** Mints a buy was ever sent for (closer or probe): no re-entry. */
const bought = new Set<string>();
/** Mints whose closer gate has held once: each coin is decided a single time,
 *  on the first batch its gate holds — if no slot or cash is free then, it
 *  is skipped for good rather than retried while the gate holds. */
const decided = new Set<string>();
/** Mints bought as probes (they sell back at once). */
const probeMints = new Set<string>();
/** Mints with a filled buy, with the fill's price and slot. */
const filled = new Map<string, FillInfo>();
/** Mints with a filled buy that later filled a sell (harness closes count). */
const roundTripped = new Set<string>();
let probesSent = 0;
let lastProbeSlot = -1_000_000_000;

/**
 * Real-reserve growth over the last VELOCITY_WINDOW_SLOTS slots: the current
 * reserves minus the latest sample at or before (now - window), or minus the
 * earliest sample when the coin is younger than the window. Null when the
 * mint has no samples at all.
 */
function velocity(mint: string, now: number, currentRq: bigint): bigint | null {
  const h = history.get(mint);
  if (h === undefined || h.length === 0) return null;
  const target = now - VELOCITY_WINDOW_SLOTS;
  let lo = 0;
  let hi = h.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid].slot <= target) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const ref = idx >= 0 ? h[idx].rq : h[0].rq;
  return currentRq - ref;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = state.slot;
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    // Cash and open-position slots left, counting what this batch sends.
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // Orders still in flight, by mint and side.
    const buyInFlight = new Set<string>();
    const sellInFlight = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') buyInFlight.add(p.order.mint);
      else sellInFlight.add(p.order.mint);
    }

    // 1. Fold this batch's fills into the books. A filled buy records its
    //    price and slot; a filled sell (ours or a harness close) closes the
    //    round trip. A rejected or failed buy is never retried (the mint is
    //    already in `bought`); a rejected or failed sell is retried below,
    //    since the position is still held and nothing is in flight for it.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        // The fill price is the curve's marginal price as the fill lands.
        const curve = state.curves.get(f.mint);
        filled.set(f.mint, {
          vq0: curve === undefined ? BigInt(f.quote_lamports) : curve.virtual_quote_reserves,
          vt0: curve === undefined ? BigInt(f.token_amount) : curve.virtual_token_reserves,
          fillSlot: f.slot,
          kind: probeMints.has(f.mint) ? 'probe' : 'closer',
        });
      } else if (f.side === 'sell' && f.status === 'filled') {
        filled.delete(f.mint);
        if (bought.has(f.mint)) roundTripped.add(f.mint);
      }
    }

    // 2. Record reserve samples for this batch's creates and trades.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let h = history.get(e.mint);
        if (h === undefined) {
          h = [];
          history.set(e.mint, h);
        }
        h.push({ slot: e.slot, rq: 0n });
      } else if (e.event === 'TradeEvent') {
        let h = history.get(e.mint);
        if (h === undefined) {
          h = [];
          history.set(e.mint, h);
        }
        h.push({ slot: e.slot, rq: BigInt(e.real_quote_reserves) });
      }
    }

    // 3. Exits. Probes sell back at once; closer positions sell on
    //    take-profit, stop-loss or timeout. Never sell a mint with a sell
    //    already in flight, and never sell a completed curve (the harness
    //    force-closes it). Prices compare in bigint, no division: the
    //    current price is virtual_quote/virtual_token, the fill price is
    //    the same ratio as the buy fill landed (info.vq0/info.vt0).
    for (const [mint, holding] of state.positions) {
      if (sellInFlight.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = filled.get(mint);
      if (info === undefined) continue;
      let exit = false;
      if (info.kind === 'probe') {
        exit = true;
      } else if (slot - info.fillSlot >= HOLD_TIMEOUT_SLOTS) {
        exit = true;
      } else if (curve.virtual_token_reserves > 0n && info.vt0 > 0n) {
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * info.vt0 * TAKE_PROFIT_DEN >= TAKE_PROFIT_NUM * info.vq0 * vt) {
          exit = true; // at or above 2x the fill price
        } else if (vq * info.vt0 * STOP_LOSS_DEN <= STOP_LOSS_NUM * info.vq0 * vt) {
          exit = true; // at or below 0.75x the fill price
        }
      }
      if (!exit) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (free < txFee) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      sellInFlight.add(mint);
      free -= txFee;
    }

    // 4. Closer entries: buy once per coin, on the first batch the gate
    //    holds. A coin whose gate holds while no slot or cash is free is
    //    decided and skipped for good, not retried. Skip mints already
    //    bought or with a buy in flight.
    const seenThisBatch = new Set<string>();
    for (const e of batch.events) {
      const mint = e.mint;
      if (seenThisBatch.has(mint)) continue;
      seenThisBatch.add(mint);
      if (bought.has(mint) || buyInFlight.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.created_slot === null) continue;
      if (slot - curve.created_slot > MAX_AGE_SLOTS) continue;
      if (curve.real_quote_reserves < ENTRY_MIN_RQ) continue;
      const vel = velocity(mint, slot, curve.real_quote_reserves);
      if (vel === null || vel < VELOCITY_MIN) continue;
      if (decided.has(mint)) continue;
      decided.add(mint);
      const cap = state.maxBuyLamports(mint);
      const size = cap < CLOSER_STAKE ? cap : CLOSER_STAKE;
      if (size <= 0n) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (openSlots <= 0 || free < size + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      bought.add(mint);
      buyInFlight.add(mint);
      openSlots -= 1;
      free -= size + txFee;
    }

    // 5. Probes: while fewer than 25 coins have round-tripped, buy the
    //    highest-reserve liquid coin not yet bought, spaced 300 slots
    //    apart, at most 24 of them. The buy is 0.012 SOL; step 3 sells
    //    it back on the batch its fill lands in.
    if (
      probesSent < PROBE_MAX &&
      roundTripped.size < PROBE_STOP_ROUND_TRIPS &&
      slot - lastProbeSlot >= PROBE_SPACING_SLOTS
    ) {
      let best: string | null = null;
      let bestRq = -1n;
      for (const [mint, curve] of state.curves) {
        if (curve.complete || bought.has(mint) || buyInFlight.has(mint)) continue;
        if (state.positions.has(mint)) continue;
        if (curve.real_quote_reserves < PROBE_MIN_RQ) continue;
        if (curve.real_quote_reserves > bestRq) {
          best = mint;
          bestRq = curve.real_quote_reserves;
        }
      }
      if (best !== null) {
        const cap = state.maxBuyLamports(best);
        const size = cap < PROBE_SIZE ? cap : PROBE_SIZE;
        if (
          size > 0n &&
          orders.length < caps.max_orders_per_batch &&
          openSlots > 0 &&
          free >= size + txFee
        ) {
          orders.push({
            side: 'buy',
            mint: best,
            quote_lamports: size,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          bought.add(best);
          probeMints.add(best);
          buyInFlight.add(best);
          probesSent += 1;
          lastProbeSlot = slot;
          openSlots -= 1;
          free -= size + txFee;
        }
      }
    }

    return orders;
  },
});
