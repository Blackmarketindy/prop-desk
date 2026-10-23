#!/usr/bin/env python3
"""Build walk-forward snapshots for the backtest.

Usage:
  python3 -I scripts/backtest_data.py <download_dir> <out_jsonl> [season ...]

For each season and each week W from 4 on, writes one JSON line holding the app's data
exactly as it would have looked before week W (games before W only, week W unplayed,
no injury data) plus what each player actually did in week W.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

FIRST_WEEK = 4  # need a few games of history before projecting


def main():
    work, out = sys.argv[1], sys.argv[2]
    seasons = [int(x) for x in sys.argv[3:]] or [build.SEASON - 1, build.SEASON]
    shared = build.fetch(work, build.sources(build.SEASON), keys={"players", "games"})
    pfr = build.pfr_map(shared["players"])
    games_all = build.read_csv(shared["games"])
    lines = 0
    with open(out, "w") as f:
        for season in seasons:
            paths = build.fetch(work, build.sources(season), keys={"stats", "stats_prev", "snaps", "snaps_prev"})
            stats, prev = build.read_csv(paths["stats"]), build.read_csv(paths["stats_prev"])
            snaps, prev_snaps = build.read_csv(paths["snaps"]), build.read_csv(paths["snaps_prev"])
            final_weeks = sorted({int(g["week"]) for g in games_all
                                  if g["season"] == str(season) and g["game_type"] == "REG" and g["home_score"] not in ("", "NA")})
            snap_idx = build.snap_index(snaps, pfr)
            actual = {}
            for pid, _n, _p, team, _o, wk, gid, v, pct in build.played_games(stats, snap_idx):
                actual.setdefault(wk, {})[pid] = [team, gid] + v
            for wk in final_weeks:
                if wk < FIRST_WEEK or wk not in actual:
                    continue
                snap = build.assemble(season, stats, prev, snaps, prev_snaps, pfr, games_all, [], through_week=wk)
                f.write(json.dumps({"season": season, "week": wk, "data": snap, "actual": actual[wk]}, separators=(",", ":")) + "\n")
                lines += 1
            print(f"{season}: weeks {FIRST_WEEK}-{max(final_weeks) if final_weeks else '-'}")
    print("snapshots", lines, "bytes", os.path.getsize(out))


if __name__ == "__main__":
    main()
