#!/usr/bin/env python3
"""Build data.json for the NFL PrizePicks prop app from nflverse.

Usage: python3 -I build.py <work_dir> <out_json>
Downloads each source into <work_dir> (an empty folder), then writes <out_json>.
Standard library only; downloads use curl so the session's proxy settings apply.
"""
import csv, json, os, subprocess, sys, datetime, collections

SEASON = 2026
SOURCES = {
    "stats": f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{SEASON}.csv",
    "stats_prev": f"https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{SEASON-1}.csv",
    "injuries": f"https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{SEASON}.csv",
    "games": "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv",
}
SKILL = {"QB", "RB", "WR", "TE"}
POS_MAP = {"FB": "RB", "HB": "RB"}


def fetch(work):
    os.makedirs(work, exist_ok=True)
    paths = {}
    for key, url in SOURCES.items():
        out = os.path.join(work, key + ".csv")
        subprocess.run(["curl", "-sSfL", "--retry", "3", "--max-time", "300", "-o", out, url], check=True)
        if os.path.getsize(out) < 1000:
            raise SystemExit(f"{key}: download too small, aborting")
        paths[key] = out
    return paths


def num(v):
    if v in (None, "", "NA"):
        return 0
    try:
        f = float(v)
    except ValueError:
        return 0
    return int(f) if f.is_integer() else round(f, 2)


# Per-game stat vector order (the page reads this list from meta.fields)
FIELDS = ["cmp", "att", "pyd", "ptd", "int", "car", "ryd", "rtd", "tgt", "rec", "recyd", "rectd", "fl", "two", "sttd"]


def vec(r):
    fl = num(r.get("sack_fumbles_lost")) + num(r.get("rushing_fumbles_lost")) + num(r.get("receiving_fumbles_lost"))
    two = num(r.get("passing_2pt_conversions")) + num(r.get("rushing_2pt_conversions")) + num(r.get("receiving_2pt_conversions"))
    return [num(r["completions"]), num(r["attempts"]), num(r["passing_yards"]), num(r["passing_tds"]),
            num(r["passing_interceptions"]), num(r["carries"]), num(r["rushing_yards"]), num(r["rushing_tds"]),
            num(r["targets"]), num(r["receptions"]), num(r["receiving_yards"]), num(r["receiving_tds"]),
            fl, two, num(r.get("special_teams_tds"))]


def pos_of(r):
    p = r.get("position") or ""
    p = POS_MAP.get(p, p)
    return p if p in SKILL else None


def active(v):
    return v[1] > 0 or v[5] > 0 or v[8] > 0 or v[9] > 0


def main():
    work, out_json = sys.argv[1], sys.argv[2]
    paths = fetch(work)

    games_all = list(csv.DictReader(open(paths["games"], newline="")))
    games = [g for g in games_all if g["season"] == str(SEASON) and g["game_type"] == "REG"]
    gmap = {g["game_id"]: g for g in games}
    sched = []
    for g in games:
        sched.append({
            "id": g["game_id"], "wk": int(g["week"]), "date": g["gameday"], "time": g["gametime"],
            "away": g["away_team"], "home": g["home_team"],
            "as": num(g["away_score"]) if g["away_score"] not in ("", "NA") else None,
            "hs": num(g["home_score"]) if g["home_score"] not in ("", "NA") else None,
            "spread": num(g["spread_line"]) if g["spread_line"] not in ("", "NA") else None,
            "total": num(g["total_line"]) if g["total_line"] not in ("", "NA") else None,
            "roof": g["roof"] or None,
        })

    rows = [r for r in csv.DictReader(open(paths["stats"], newline="")) if r["season_type"] == "REG"]
    players = {}
    defense = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0] * len(FIELDS)))
    def_games = collections.defaultdict(set)
    for r in rows:
        p = pos_of(r)
        v = vec(r)
        opp = r["opponent_team"]
        def_games[opp].add(r["game_id"])
        if not p or not active(v):
            continue
        g = gmap.get(r["game_id"])
        home = 1 if g and g["home_team"] == r["team"] else 0
        pid = r["player_id"] or ("noid-" + r["player_display_name"])
        pl = players.setdefault(pid, {"id": pid, "n": r["player_display_name"], "p": p, "t": r["team"], "g": [], "lw": 0})
        pl["g"].append([int(r["week"]), opp, home] + v)
        if int(r["week"]) >= pl["lw"]:
            pl["lw"], pl["t"], pl["p"] = int(r["week"]), r["team"], p
        acc = defense[opp][p]
        for i, x in enumerate(v):
            acc[i] += x
    for pl in players.values():
        pl["g"].sort(key=lambda x: x[0])

    # Prior-season per-game averages (games with an active stat row)
    prev = collections.defaultdict(lambda: [0, [0.0] * len(FIELDS)])
    for r in csv.DictReader(open(paths["stats_prev"], newline="")):
        if r["season_type"] != "REG" or not pos_of(r):
            continue
        v = vec(r)
        if not active(v) or not r["player_id"]:
            continue
        a = prev[r["player_id"]]
        a[0] += 1
        for i, x in enumerate(v):
            a[1][i] += x
    for pid, pl in players.items():
        if pid in prev:
            n, s = prev[pid]
            pl["prev"] = [n] + [round(x / n, 2) for x in s]

    def_out = {}
    for team, bypos in defense.items():
        ng = len(def_games[team])
        def_out[team] = {"gp": ng, **{p: [round(x / ng, 2) for x in s] for p, s in bypos.items()}}

    inj_rows = list(csv.DictReader(open(paths["injuries"], newline="")))
    inj_week = max((int(r["week"]) for r in inj_rows), default=0)
    inj = {}
    for r in inj_rows:
        if int(r["week"]) != inj_week or POS_MAP.get(r["position"], r["position"]) not in SKILL:
            continue
        inj[r["gsis_id"]] = {
            "s": r["report_status"] or None, "pr": r["practice_status"] or None,
            "inj": r["report_primary_injury"] or r["practice_primary_injury"] or None, "t": r["team"],
        }

    weeks = sorted({int(r["week"]) for r in rows})
    finals = [s for s in sched if s["hs"] is not None]
    meta = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "season": SEASON, "fields": FIELDS, "statWeeks": weeks,
        "lastFinal": max(finals, key=lambda s: (s["date"], s["time"] or "")) if finals else None,
        "finalGames": len(finals), "injuryWeek": inj_week, "sources": SOURCES,
        "players": len(players),
    }
    data = {"meta": meta, "players": list(players.values()), "def": def_out, "sched": sched, "inj": inj}
    with open(out_json, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(json.dumps({k: meta[k] for k in ("generated", "statWeeks", "finalGames", "injuryWeek", "players")}))
    print("lastFinal", meta["lastFinal"])
    print("bytes", os.path.getsize(out_json))


if __name__ == "__main__":
    main()
