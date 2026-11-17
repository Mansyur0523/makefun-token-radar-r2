# Launch Radar — Token Launch Radar (make.fun: token-radar-01)

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Mansyur0523/makefun-token-radar-r2/rank.svg)](https://make.fun/c/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Mansyur0523/makefun-token-radar-r2/reward.svg)](https://make.fun/c/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: which pre-token protocol is worth farming next, ranked by an
implied value fitted from the snapshot's own traded tokens — and a concrete farm plan
for each one, netted to dollars.

## The model: a comps curve, tested blind

On the sealed snapshot (`as_of` 2026-11-14, 758 protocols ≥ $5M TVL) the program fits

```
log(mcap) = a + b × log(TVL) + offset[category]
```

by OLS on the snapshot's own traded tokens (128 protocols with a positive market
cap and TVL; categories with ≥ 4 anchors get their own offset, the rest share
"Other"). Fitted: `a = 9.167`, `b = 0.459`, in-sample R² 0.259.

It is tested blind before it is used:

| Check | Result |
| --- | --- |
| Holdout 80/20, seed 20261114 (n=25) | R² **0.192**, log-RMSE 1.762 |
| 5-fold CV, mean of 10 seeds | R² **0.064** (range −0.049 – 0.102) |
| 90% prediction band | ×26.4 / ÷26.4 |

The band is wide and the dashboard says so: TVL explains only part of a market
cap. The board ranks by the central estimate and shows the 90% band on every row.

Implied value = exp(prediction) × P(launch), where P(launch) is a stated function
of TVL size, 7-day TVL growth and days listed with no token. Expected value to one
active farmer = implied × 0.01% − farm cost (gas for 7 transactions + 5% a year on
locked capital). Verdict: **farm** at $250+, **thin** at $0+, **skip** below $0.

## The board

226 rows: all 40 watchlist protocols plus the 186 rankable pre-token protocols
below the $50M floor (pre-token, not an exchange, not a versioned pool). The 30
largest already-trading tokens are shown separately as the anchors the curve is
fitted on — the market's own value, never a model's.

## Run it

Node 22+, standard library only, no install:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
```

Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
(via the kit's vendored `vendor/makefun-board.ts`) into the output directory.
Two runs write byte-identical output.

Screenshots are rendered with headless Chromium over CDP (see `tools/shoot.mjs`):
the board, one protocol's detail view, and a filtered view.

## Layout

- `main.ts` — entry point: read snapshot, write board, data, dashboard, screenshots, dossier
- `lib/radar.ts` — the comps fit, blind validation, launch odds, farm plans, board build
- `vendor/makefun-board.ts` — make.fun's dossier library, copied from the kit verbatim
- `dashboard/` — the page: `index.html`, `radar.css`, `radar.js` (no network, no framework)
- `screenshots/` — the three screenshots the dossier carries
- `tools/shoot.mjs` — headless-Chromium screenshot renderer (CDP, stdlib only)

## Caveats

A protocol is described as recording no token in the snapshot — never as having
none. Implied values are this radar's own claim, not a prediction that a token
will launch, or when. Farm plans are a starting point: check the protocol's own
pages before sending funds, and never pay anyone to claim an airdrop.

## License

MIT — see `LICENSE`.
