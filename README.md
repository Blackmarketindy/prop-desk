# Prop Desk

NFL player-prop research for PrizePicks. Open the site, check a player's projection against a line, paste a whole board of lines, get weekly More/Less recommendations, build a slip, and track how your saved picks graded out.

**Live site:** https://blackmarketindy.github.io/prop-desk/

## How it works

- `index.html` is the app: plain HTML, CSS and JavaScript, no build step.
- `model.js` is the projection model. The page and the backtest both load this one file, so they always run the same math.
- `data.json` holds the season's player game logs, team defense numbers, schedule with spreads and totals, and the latest injury report.
- `scripts/build.py` rebuilds `data.json` from [nflverse](https://github.com/nflverse/nflverse-data) using only the Python standard library.
- Participation comes from nflverse snap counts: a game where a player took offensive snaps but had no touches counts as a zero, not as a missed game.
- `.github/workflows/refresh.yml` runs the build at 7:40 a.m. and 4:40 p.m. Eastern and commits new data when it changes. Run it any time from **Actions → Refresh NFL data → Run workflow**.

## Backtest and calibration

`scripts/backtest_data.py` rebuilds the data as it stood before every week of the previous and current season, and `scripts/backtest.js` projects each of those weeks with `model.js` and compares against what happened. The results go to `backtest.json`, which the app reads to:

- scale each stat's projection so it matches actual results on average (the raw model ran high), and
- calibrate each stat's probabilities with Platt scaling, fitted on the previous season and checked on the current one.

Past PrizePicks lines aren't available, so props are tested against a stand-in line at the player's season average. Real lines are sharper. `.github/workflows/backtest.yml` reruns this every Tuesday.

```
python3 scripts/backtest_data.py /tmp/nfl-dl /tmp/snapshots.jsonl
node scripts/backtest.js /tmp/snapshots.jsonl backtest.json
```

Saved picks live in your browser's local storage, so they stay on the device and browser where you saved them.

## Run it locally

```
python3 scripts/build.py /tmp/nfl-dl data.json   # optional: fresh data
python3 -m http.server 8000                      # then open http://localhost:8000
```

## Notes

Projections are estimates from past games, not guarantees. PrizePicks lines and payouts are entered by you; the app does not connect to PrizePicks. Data: nflverse player stats, schedules and injury reports. If gambling stops being fun, call 1-800-GAMBLER.
