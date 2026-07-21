"""PRE-REGISTERED DISCRIMINATOR (Fable ruling 2, triggered by the item-1 miss).

Question: when the OPPOSITION changes, do HIGH-K pitchers' K rates move MORE than LOW-K pitchers'?
A one-sided model (events from own ratings + a scalar opponent shift) implies the response to an
opposition change does NOT depend on the pitcher's own level. If it does, that is interaction the
core structurally cannot express.

OBSERVED DATA ONLY -- cwhit raw event aggregates are ground truth. No model output anywhere.
"""
import csv, math, os, random, re, json
from collections import defaultdict

ROOT = r"C:\dev\ootp-app"
CAP = os.path.join(ROOT, "fixtures", "cwhit-capture-2026-07-21")
SEED = 20260721
IP_TO_BF = 4.3
BF_FLOOR = 600.0
IP_FLOOR = BF_FLOOR / IP_TO_BF

# sitekey -> (tournament config id, extra-eligibility note)
FMT = {
    "ironquick": ("iron-quick", None), "bronzequick": ("bronze-quick", None),
    "silverquick": ("silver-quick", None), "goldquick": ("gold-quick", None),
    "diamondquick": ("diamond-quick", None), "bronzeheart": ("bronze-heart", "Year 1930-1989"),
    "earlygold": ("early-gold", None), "diamondheart": ("diamond-heart", "Year 1930-1980"),
    "latebronze": ("late-bronze", None), "diamondcapdaily": ("diamond-cap-daily", None),
    "goldcapdaily": ("gold-cap", None), "bronzecapweekly": ("bronze-cap-weekly", None),
    "goldslotsdaily": ("gold-slots", None), "liveopendaily": ("live-open-daily", "Card Type = live"),
}

# ---------- catalog ----------
cat = open(os.path.join(ROOT, "data", "imports", "cdmx.csv"), encoding="utf-8").read().split("\n")
hdr = cat[0].split(",")
ix = {c: i for i, c in enumerate(hdr)}
def num(s):
    try: return float(s)
    except Exception: return 0.0
hitters = []   # (value, avoidK, year, cardType)
for line in cat[1:]:
    if not line.strip(): continue
    f = line.split(",")
    if len(f) < len(hdr): continue
    # NOTE: cdmx.csv has NO "Variant" column, so the variant filter the TS tools apply is a
    # no-op on this catalog. Recorded rather than silently skipped.
    is_pit = num(f[ix["Pitcher Role"]]) > 0 or f[ix["Position"]].strip() == "1"
    if is_pit: continue
    hitters.append((num(f[ix["Card Value"]]), num(f[ix["Avoid K vR"]]), num(f[ix["Year"]]), num(f[ix["Card Type"]])))

def cfg(tid):
    return json.load(open(os.path.join(ROOT, "data", "tournaments", tid + ".json"), encoding="utf-8"))

# ---------- per-format opposing hitter field ----------
opp = {}
for key, (tid, note) in FMT.items():
    t = cfg(tid)
    lo, hi = t.get("card_value_min"), t.get("card_value_max")
    sel = [h for h in hitters if (lo is None or h[0] >= lo) and (hi is None or h[0] <= hi)]
    ak = [h[1] for h in sel if h[1] > 0]
    m = sum(ak) / len(ak)
    sd = math.sqrt(sum((x - m) ** 2 for x in ak) / (len(ak) - 1))
    opp[key] = dict(n=len(ak), mu=m, sd=sd, era=t["eraId"], park=t["parkId"], note=note, vmax=hi, vmin=lo)

# ---------- observed pitcher rows ----------
rows = defaultdict(dict)     # cardkey -> {fmt: (k9, bb9, ip)}
dupes = defaultdict(int)
for fn in sorted(os.listdir(CAP)):
    if not fn.endswith("pit.txt"): continue
    key = fn.split("__")[1]
    L = [l for l in open(os.path.join(CAP, fn), encoding="utf-8").read().split("\n") if l.strip()]
    cols = L[1].split("\t"); j = {c: i for i, c in enumerate(cols)}
    seen = defaultdict(list)
    for line in L[2:]:
        p = line.split("\t")
        ck = (p[j["Name"]].strip(), p[j["VAL"]].strip(), p[j["VLvl"]].strip(), p[j["Hand"]].strip())
        seen[ck].append(p)
    for ck, ps in seen.items():
        if len(ps) > 1:
            dupes[key] += len(ps); continue          # colliding key -> excluded entirely
        p = ps[0]
        ip = num(p[j["IP"]])
        if ip < IP_FLOOR: continue
        rows[ck][key] = (num(p[j["K9"]]), num(p[j["BB9"]]), ip)

multi = {k: v for k, v in rows.items() if len(v) >= 2}
print(f"SEED {SEED} | BF floor {BF_FLOOR:.0f} (IP >= {IP_FLOOR:.1f})")
print(f"excluded colliding-key rows: {sum(dupes.values())} across {len(dupes)} formats {dict(dupes)}")
print(f"cards in >=2 formats: {len(multi)} | total (card,format) obs used: {sum(len(v) for v in multi.values())}")
dist = defaultdict(int)
for v in multi.values(): dist[len(v)] += 1
print("formats-per-card:", dict(sorted(dist.items())))

# ---------- paired contrasts ----------
pairs = []   # (dK9, dBB9, dOpp, ownK, env_matched)
for ck, fm in multi.items():
    ownK = sum(v[0] for v in fm.values()) / len(fm)
    ks = sorted(fm.keys(), key=lambda f: opp[f]["mu"])
    for a in range(len(ks)):
        for b in range(a + 1, len(ks)):
            f1, f2 = ks[a], ks[b]
            dO = opp[f2]["mu"] - opp[f1]["mu"]
            if abs(dO) < 1e-9: continue
            env = (opp[f1]["era"] == opp[f2]["era"]) and (opp[f1]["park"] == opp[f2]["park"])
            pairs.append((fm[f2][0] - fm[f1][0], fm[f2][1] - fm[f1][1], dO, ownK, env))
print(f"paired contrasts: {len(pairs)}  (env-matched: {sum(1 for p in pairs if p[4])})")

def ols(xs, ys):
    n = len(xs)
    if n < 3: return float('nan'), float('nan'), float('nan')
    mx, my = sum(xs)/n, sum(ys)/n
    sxx = sum((x-mx)**2 for x in xs); sxy = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    if sxx <= 0: return float('nan'), float('nan'), float('nan')
    b = sxy/sxx; a = my - b*mx
    ss = sum((y-my)**2 for y in ys)
    r2 = 1 - sum((y-(a+b*x))**2 for x, y in zip(xs, ys))/ss if ss > 0 else float('nan')
    return b, a, r2

def boot_slope_diff(sub, B=2000, dv=0):
    rnd = random.Random(SEED)
    lo_hi = []
    for _ in range(B):
        s = [sub[rnd.randrange(len(sub))] for _ in range(len(sub))]
        ks = sorted(s, key=lambda p: p[3])
        t = len(ks)//3
        loT, hiT = ks[:t], ks[-t:]
        bl, _, _ = ols([p[2] for p in loT], [p[dv] for p in loT])
        bh, _, _ = ols([p[2] for p in hiT], [p[dv] for p in hiT])
        if not (math.isnan(bl) or math.isnan(bh)): lo_hi.append(bh - bl)
    lo_hi.sort()
    return lo_hi[int(.025*len(lo_hi))], lo_hi[int(.975*len(lo_hi))], len(lo_hi)

def report(sub, label, dv=0, dvname="dK9"):
    if len(sub) < 30:
        print(f"\n{label}: N={len(sub)} — TOO FEW for the tercile split; reporting pooled only.")
    b, a, r2 = ols([p[2] for p in sub], [p[dv] for p in sub])
    print(f"\n{label}  (N={len(sub)})")
    print(f"  pooled  {dvname} ~ dOpp :  slope {b:+.4f}   intercept {a:+.4f}   R2 {r2:.3f}")
    if len(sub) < 30: return
    ks = sorted(sub, key=lambda p: p[3]); t = len(ks)//3
    for nm, g in (("low ownK ", ks[:t]), ("mid ownK ", ks[t:2*t]), ("high ownK", ks[-t:])):
        bb, _, rr = ols([p[2] for p in g], [p[dv] for p in g])
        mk = sum(p[3] for p in g)/len(g)
        print(f"  {nm} N={len(g):4d}  meanOwnK {mk:5.2f}  slope {bb:+.4f}  R2 {rr:.3f}")
    lo, hi, nb = boot_slope_diff(sub, dv=dv)
    bl, _, _ = ols([p[2] for p in ks[:t]], [p[dv] for p in ks[:t]])
    bh, _, _ = ols([p[2] for p in ks[-t:]], [p[dv] for p in ks[-t:]])
    excl = "EXCLUDES 0" if (lo > 0 or hi < 0) else "includes 0"
    print(f"  HIGH minus LOW slope: {bh-bl:+.4f}   boot95 [{lo:+.4f}, {hi:+.4f}]  ({nb} reps)  -> {excl}")

report(pairs, "(3) HEADLINE — all pairs, dK9")
report([p for p in pairs if p[4]], "(6) ENV-MATCHED pairs only, dK9")
report(pairs, "(5) CONTROL — all pairs, dBB9 (should be far weaker)", dv=1, dvname="dBB9")

print("\n(2) opposing hitter field per format (Avoid K vR, eligible by value window):")
for k in sorted(opp, key=lambda k: opp[k]["mu"]):
    o = opp[k]
    print(f"   {k:<17} n={o['n']:<5} mean {o['mu']:6.2f}  sd {o['sd']:5.2f}  {o['era']}/{o['park']}"
          + (f"   EXTRA RULE NOT APPLIED: {o['note']}" if o["note"] else ""))
