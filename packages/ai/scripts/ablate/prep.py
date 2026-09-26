"""Parse self-play batch files (in game order) into one .npz for offline
target/architecture ablations. Adds alternative value targets and per-round
auxiliary targets that the stored rows don't carry directly.

Usage: python3 prep.py --out data.npz file1.jsonl file2.jsonl ...
"""
import argparse, json, sys
import numpy as np

P = ["xarm", "gormen", "tenzen", "lasha"]
THREAT_MAX = {"xarm": 32, "gormen": 34, "tenzen": 29, "lasha": 27}
RANK_VALUES = [1.0, 0.66, 0.33, 0.0]
ACTION_DIM = 298


def rank_target(winners, vp, threat):
    ws = set(winners or [])
    if not ws:
        return None
    sc = sorted(((1000 if p in ws else 0) + max(vp[p] / 55, threat[p] / THREAT_MAX[p]), i) for i, p in enumerate(P))[::-1]
    out = [0.0] * 4
    pos = 0
    while pos < 4:
        end = pos + 1
        while end < 4 and sc[end][0] == sc[pos][0]:
            end += 1
        avg = sum(RANK_VALUES[pos:end]) / (end - pos)
        for k in range(pos, end):
            out[sc[k][1]] = avg
        pos = end
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    X, T, Q, R, W, AUX, POL, HP, PI, GID = [], [], [], [], [], [], [], [], [], []
    gid = 0
    for fi, f in enumerate(a.files):
        rows = [json.loads(l) for l in open(f) if l.strip()]
        # Split into games: gamePly resets (drops) at each new game.
        games, cur, last = [], [], None
        for r in rows:
            ply = r["meta"]["gamePly"]
            if last is not None and ply < last:
                games.append(cur); cur = []
            cur.append(r); last = ply
        if cur:
            games.append(cur)
        for g in games:
            gid += 1
            m0 = g[-1]["meta"]
            final_vp, final_th = m0["finalVp"], m0["finalThreat"]
            rk = rank_target(m0.get("winners"), final_vp, final_th)
            winners = set(m0.get("winners") or [])
            # VP/threat at the first decision of each later round.
            first_of_round = {}
            for r in g:
                rd = r["meta"]["round"]
                first_of_round.setdefault(rd, r["meta"])
            rounds = sorted(first_of_round)
            for r in g:
                m = r["meta"]
                nxt = [rd for rd in rounds if rd > m["round"]]
                if nxt:
                    vp_n, th_n = first_of_round[nxt[0]]["vp"], first_of_round[nxt[0]]["threat"]
                else:
                    vp_n, th_n = final_vp, final_th
                aux = [(vp_n[p] - m["vp"][p]) / 10.0 for p in P] + [(th_n[p] - m["threat"][p]) / 5.0 for p in P]
                X.append(r["x"]); T.append(r["t"]); Q.append(r.get("q") or r["t"])
                R.append(rk if rk is not None else r["t"])
                W.append([1.0 if p in winners else 0.0 for p in P])
                AUX.append(aux)
                pol = np.zeros(ACTION_DIM, dtype=np.float32); has = False
                v = r.get("visits")
                if v:
                    tot = sum(v.values())
                    if tot > 0:
                        for k, c in v.items():
                            pol[int(k)] = c / tot
                        has = True
                POL.append(pol); HP.append(has); PI.append(r["p"]); GID.append(gid)
        if fi % 20 == 0:
            print(f"{fi+1}/{len(a.files)} files, {len(X)} rows, {gid} games", flush=True)
    np.savez(a.out, X=np.array(X, dtype=np.float32), T=np.array(T, dtype=np.float32),
             Q=np.array(Q, dtype=np.float32), R=np.array(R, dtype=np.float32),
             W=np.array(W, dtype=np.float32), AUX=np.array(AUX, dtype=np.float32),
             POL=np.array(POL, dtype=np.float32), HP=np.array(HP), PI=np.array(PI, dtype=np.int32),
             GID=np.array(GID, dtype=np.int64))
    print(f"saved {a.out}: {len(X)} rows, {gid} games")


if __name__ == "__main__":
    main()
