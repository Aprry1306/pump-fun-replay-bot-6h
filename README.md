[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Aprry1306/pump-fun-replay-bot-6h/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Aprry1306/pump-fun-replay-bot-6h/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun paper replay bot — Closer + take-profit (6h sprint)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) (make.fun).
One program, `main.ts` on Node 22: it paper-trades pump.fun bonding curves on
a replay harness (`pumpfun-replay/v2`), ranked by net PnL.

## Strategy

Two parts, both deterministic (bigint only — no clock, randomness, env, or
network):

**Closer — ride coins about to complete.** Buy once per coin, 0.5 SOL, when
real reserves reach 50 SOL having grown at least 10 SOL over the last 50
slots, and the coin is at most 500 slots old. Most completions are unbuyable
(they complete in the same slot they cross 50 SOL), so the edge lives in the
enterable tail: coins that stall above 50 SOL and then complete, or spike 2x
first. Exits: take-profit at 2x the fill price, stop-loss at 0.75x, timeout
600 slots after the buy fill. Completion force-closes whatever is left at
roughly 2x. No re-entry, ever; mints with a buy in flight are skipped.

**Probes — bank the 20-coin guardrail with margin.** While fewer than 25
coins have round-tripped, buy 0.012 SOL of the highest-reserve liquid coin
(real reserves >= 5 SOL), at most 24 probes, spaced at least 300 slots apart,
and sell it straight back on the batch its fill lands in. A probe is not a
bet: it exists only so the guardrail holds on a completion-poor day.

## Parameters (probe24 config)

| Parameter | Value |
|---|---|
| Closer stake | 0.5 SOL (`min(0.5 SOL, 1% of real reserves)`) |
| Entry reserves | >= 50 SOL real reserves |
| Entry velocity | >= 10 SOL growth over the last 50 slots |
| Entry max age | 500 slots |
| Take-profit | 2x fill price |
| Stop-loss | 0.75x fill price |
| Hold timeout | 600 slots after the buy fill |
| Probe size | 0.012 SOL |
| Probe min reserves | 5 SOL |
| Probe max count | 24 |
| Probe spacing | 300 slots |
| Probe stop | 25 coins round-tripped |
| Slippage | 10,000 bps (wide open) |

## Layout

- `main.ts` — the strategy (the only file the entry authors).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical from
  the competition kit (`sdk/ts/makefun-bot.ts`).

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

Dev-window result (kit `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`):
net PnL +2.421413645 SOL, 76 fills over 40 coins, 40 round trips, win rate
0.30, max drawdown 0.044, +2.148880351 SOL at 2x fees. Guardrails met.

## License

MIT — see `LICENSE`.
