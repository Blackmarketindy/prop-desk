#!/usr/bin/env python3
"""Build data.json for Prop Desk from nflverse.

Usage:
  python3 -I scripts/build.py <download_dir> <out_json>

Standard library only. Downloads go through curl so proxy settings apply.
The assemble() function is also used by scripts/backtest_data.py to build
"as of week N" snapshots, so the app and the backtest read identical data.
"""
import csv, json, os, subprocess, sys, datetime, collections

SEASON = 2026
SKILL = {"QB", "RB", "WR", "TE"}
POS_MAP = {"FB": "RB", "HB": "RB"}
BASE = "https://github.com/nflverse/nflverse-data/releases/download"


def sources(season):
    return {
        "stats": f"{BASE}/stats_player/stats_player_week_{season}.csv",
        "stats_prev": f"{BASE}/stats_player/stats_player_week_{season - 1}.csv",
        "snaps": f"{BASE}/snap_counts/snap_counts_{season}.csv",
        "snaps_prev": f"{BASE}/snap_counts/snap_counts_{season - 1}.csv",
        "players": f"{BASE}/players/players.csv",
        "injuries": f"{BASE}/injuries/injuries_{season}.csv",
        "games": f"{BASE}/schedules/games.csv",
    }


def fetch(work, srcs, keys=None):
    os.makedirs(work, exist_ok=True)
    paths = {}
    for key, url in srcs.items():
        if keys and key not in keys:
            continue
        out = os.path.join(work, os.path.basename(url))
        if not os.path.exists(out):
            subprocess.run(["curl", "-sSfL", "--retry", "3", "--max-time", "300", "-o", out, url], check=True)
        if os.path.getsize(out) < 1000:
            raise SystemExit(f"{key}: download too small, aborting")
        paths[key] = out
    return paths


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def num(v):
    if v in (None, "", "NA"):
        return 0
    try:
        f = float(v)
    except ValueError:
        return 0
    return int(f) if f.is_integer() else round(f, 2)


# Per-game stat vector order. Game rows also carry "snp" (offense snap %) after these.
FIELDS = ["cmp", "att", "pyd", "ptd", "int", "car", "ryd", "rtd", "tgt", "rec", "recyd", "rectd", "fl", "two", "sttd"]
ZERO = [0] * len(FIELDS)


def vec(r):
    fl = num(r.get("sack_fumbles_lost")) + num(r.get("rushing_fumbles_lost")) + num(r.get("receiving_fumbles_lost"))
    two = num(r.get("passing_2pt_conversions")) + num(r.get("rushing_2pt_conversions")) + num(r.get("receiving_2pt_conversions"))
    return [num(r["completions"]), num(r["attempts"]), num(r["passing_yards"]), num(r["passing_tds"]),
            num(r["passing_interceptions"]), num(r["carries"]), num(r["rushing_yards"]), num(r["rushing_tds"]),
            num(r["targets"]), num(r["receptions"]), num(r["receiving_yards"]), num(r["receiving_tds"]),
            fl, two, num(r.get("special_teams_tds"))]


def pos_of(p):
    p = POS_MAP.get(p or "", p or "")
    return p if p in SKILL else None


def active(v):
    return v[1] > 0 or v[5] > 0 or v[8] > 0 or v[9] > 0


def snap_index(snap_rows, pfr2gsis, through_week=None):
    """(gsis_id, game_id) -> snap row, for skill players with at least one offensive snap."""
    out = {}
    for r in snap_rows:
        if r.get("game_type") != "REG" or not pos_of(r.get("position")):
            continue
        if through_week is not None and int(r["week"]) >= through_week:
            continue
        if float(r.get("offense_snaps") or 0) <= 0:
            continue
        gid = pfr2gsis.get(r.get("pfr_player_id"))
        if gid:
            out[(gid, r["game_id"])] = r
    return out


def played_games(stat_rows, snaps, through_week=None):
    """Yield (player_id, name, pos, team, opp, week, game_id, vector, snap_pct) for every game a
    skill player took part in: any game with an opportunity, plus games with offensive snaps
    but no touches (those count as zeros instead of being dropped)."""
    seen = set()
    for r in stat_rows:
        if r.get("season_type") != "REG":
            continue
        wk = int(r["week"])
        if through_week is not None and wk >= through_week:
            continue
        p = pos_of(r.get("position"))
        if not p:
            continue
        v = vec(r)
        pid = r["player_id"]
        s = snaps.get((pid, r["game_id"]))
        if not active(v) and s is None:
            continue  # no touches and no recorded offensive snaps: treat as not played
        seen.add((pid, r["game_id"]))
        pct = round(float(s["offense_pct"]) * 100) if s else None
        yield pid, r["player_display_name"], p, r["team"], r["opponent_team"], wk, r["game_id"], v, pct
    for (pid, gid), s in snaps.items():
        if (pid, gid) in seen:
            continue
        yield pid, s["player"], pos_of(s["position"]), s["team"], s["opponent"], int(s["week"]), gid, list(ZERO), round(float(s["offense_pct"]) * 100)


def assemble(season, stat_rows, prev_rows, snap_rows, prev_snap_rows, pfr2gsis, games_all, inj_rows, through_week=None):
    games = [g for g in games_all if g["season"] == str(season) and g["game_type"] == "REG"]
    gmap = {g["game_id"]: g for g in games}

    def score(v, wk):
        if v in ("", "NA") or (through_week is not None and wk >= through_week):
            return None
        return num(v)

    sched = []
    for g in games:
        wk = int(g["week"])
        sched.append({
            "id": g["game_id"], "wk": wk, "date": g["gameday"], "time": g["gametime"],
            "away": g["away_team"], "home": g["home_team"],
            "as": score(g["away_score"], wk), "hs": score(g["home_score"], wk),
            "spread": num(g["spread_line"]) if g["spread_line"] not in ("", "NA") else None,
            "total": num(g["total_line"]) if g["total_line"] not in ("", "NA") else None,
            "roof": g["roof"] or None,
        })

    snaps = snap_index(snap_rows, pfr2gsis, through_week)
    rows = list(played_games(stat_rows, snaps, through_week))
    starters = {pid for pid, *_rest, v, _p in rows if active(v)}

    players = {}
    defense = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0] * len(FIELDS)))
    def_games = collections.defaultdict(set)
    for r in stat_rows:  # games each defense has played, from every row (any position)
        if r.get("season_type") == "REG" and (through_week is None or int(r["week"]) < through_week):
            def_games[r["opponent_team"]].add(r["game_id"])
    for pid, name, p, team, opp, wk, gid, v, pct in rows:
        acc = defense[opp][p]
        for i, x in enumerate(v):
            acc[i] += x
        if pid not in starters:
            continue  # never had an opportunity this season: not a prop candidate
        g = gmap.get(gid)
        home = 1 if g and g["home_team"] == team else 0
        pl = players.setdefault(pid, {"id": pid, "n": name, "p": p, "t": team, "g": [], "lw": 0})
        pl["g"].append([wk, opp, home] + v + [pct])
        if wk >= pl["lw"]:
            pl["lw"], pl["t"], pl["p"] = wk, team, p
            if active(v):
                pl["n"] = name
    for pl in players.values():
        pl["g"].sort(key=lambda x: x[0])

    prev_snaps = snap_index(prev_snap_rows, pfr2gsis)
    prev = collections.defaultdict(lambda: [0, [0.0] * len(FIELDS)])
    for pid, _n, _p, _t, _o, _w, _g, v, _pct in played_games(prev_rows, prev_snaps):
        a = prev[pid]
        a[0] += 1
        for i, x in enumerate(v):
            a[1][i] += x
    for pid, pl in players.items():
        if pid in prev and prev[pid][0]:
            n, s = prev[pid]
            pl["prev"] = [n] + [round(x / n, 2) for x in s]

    def_out = {}
    for team, bypos in defense.items():
        ng = len(def_games[team]) or 1
        def_out[team] = {"gp": ng, **{p: [round(x / ng, 2) for x in s] for p, s in bypos.items()}}

    inj, inj_team = {}, {}
    if inj_rows:
        for r in inj_rows:
            wk = int(r["week"])
            inj_team[r["team"]] = max(inj_team.get(r["team"], 0), wk)
        inj_week = max(inj_team.values())
        for r in inj_rows:
            if int(r["week"]) != inj_team.get(r["team"]) or not pos_of(r["position"]):
                continue
            inj[r["gsis_id"]] = {
                "s": r["report_status"] or None, "pr": r["practice_status"] or None,
                "inj": r["report_primary_injury"] or r["practice_primary_injury"] or None,
                "t": r["team"], "wk": int(r["week"]),
            }
    else:
        inj_week = None

    weeks = sorted({wk for _pid, _n, _p, _t, _o, wk, *_ in rows})
    finals = [s for s in sched if s["hs"] is not None]
    meta = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": season, "fields": FIELDS + ["snp"], "statWeeks": weeks,
        "lastFinal": max(finals, key=lambda s: (s["date"], s["time"] or "")) if finals else None,
        "finalGames": len(finals), "injuryWeek": inj_week, "injuryTeamWeek": inj_team,
        "players": len(players), "participation": "nflverse snap counts", "sources": sources(season),
    }
    return {"meta": meta, "players": list(players.values()), "def": def_out, "sched": sched, "inj": inj}


def pfr_map(players_path):
    return {r["pfr_id"]: r["gsis_id"] for r in read_csv(players_path) if r.get("pfr_id") and r.get("gsis_id")}


def main():
    work, out_json = sys.argv[1], sys.argv[2]
    paths = fetch(work, sources(SEASON))
    data = assemble(
        SEASON,
        read_csv(paths["stats"]), read_csv(paths["stats_prev"]),
        read_csv(paths["snaps"]), read_csv(paths["snaps_prev"]),
        pfr_map(paths["players"]), read_csv(paths["games"]), read_csv(paths["injuries"]),
    )
    with open(out_json, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    m = data["meta"]
    print(json.dumps({k: m[k] for k in ("generated", "statWeeks", "finalGames", "injuryWeek", "players")}))
    print("lastFinal", m["lastFinal"])
    print("bytes", os.path.getsize(out_json))


if __name__ == "__main__":
    main()
