# Prop Desk

NFL player-prop research for PrizePicks. Open the site, check a player's projection against a line, paste a whole board of lines, get weekly More/Less recommendations, build a slip, and track how your saved picks graded out.

**Live site:** https://blackmarketindy.github.io/prop-desk/

## How it works

- `index.html` is the whole app: plain HTML, CSS and JavaScript, no build step.
- `data.json` holds the season's player game logs, team defense numbers, schedule with spreads and totals, and the latest injury report.
- `scripts/build.py` rebuilds `data.json` from [nflverse](https://github.com/nflverse/nflverse-data) using only the Python standard library.
- `.github/workflows/refresh.yml` runs the build at 7:40 a.m. and 4:40 p.m. Eastern and commits new data when it changes. Run it any time from **Actions → Refresh NFL data → Run workflow**.

Saved picks live in your browser's local storage, so they stay on the device and browser where you saved them.

## Run it locally

```
python3 scripts/build.py /tmp/nfl-dl data.json   # optional: fresh data
python3 -m http.server 8000                      # then open http://localhost:8000
```

## Notes

Projections are estimates from past games, not guarantees. PrizePicks lines and payouts are entered by you; the app does not connect to PrizePicks. Data: nflverse player stats, schedules and injury reports. If gambling stops being fun, call 1-800-GAMBLER.
