"""BATTERY ITEM 5 — WITHIN-TIER HETEROGENEITY.

Is each tier's K need a whole-pool property, or driven by a sub-population?
Gold is the anomaly: need 1.78 at gap 15.9, nearly iron's 1.82 at gap 23.6.

OBSERVED DATA ONLY. No model output. Descriptive.
"""
import os, math
from collections import defaultdict

ROOT = r"C:\dev\ootp-app"
CAP = os.path.join(ROOT, "fixtures", "cwhit-capture-2026-07-21")
IP_FLOOR = 600.0 / 4.3           # BF >= 600
TIERS = [("iron", "ironquick", 1.82), ("bronze", "bronzequick", 1.62), ("silver", "silverquick", 1.48),
         ("gold", "goldquick", 1.78), ("diamond", "diamondquick", 1.04)]

def num(s):
    try: return float(s)
    except Exception: return float("nan")

def load(key):
    fn = next(f for f in os.listdir(CAP) if f.startswith("cap__" + key + "__") and f.endswith("pit.txt"))
    L = [l for l in open(os.path.join(CAP, fn), encoding="utf-8").read().split("\n") if l.strip()]
    cols = L[1].split("\t"); j = {c: i for i, c in enumerate(cols)}
    seen = defaultdict(list)
    for line in L[2:]:
        p = line.split("\t")
        k = (p[j["Name"]].strip(), p[j["VAL"]].strip(), p[j["VLvl"]].strip(), p[j["Hand"]].strip())
        seen[k].append(p)
    out = []
    dropped = 0
    for k, ps in seen.items():
        if len(ps) > 1: dropped += len(ps); continue      # colliding key -> excluded
        p = ps[0]
        ip = num(p[j["IP"]])
        if not (ip >= IP_FLOOR): continue
        out.append(dict(key=k, ip=ip, k9=num(p[j["K9"]]), gs=num(p[j["GSper"]]), ipg=num(p[j["IPpergame"]])))
    return out, dropped

def stats(xs):
    xs = sorted(xs); n = len(xs)
    if n == 0: return None
    m = sum(xs)/n
    sd = math.sqrt(sum((x-m)**2 for x in xs)/(n-1)) if n > 1 else 0.0
    q = lambda p: xs[min(n-1, max(0, int(round(p*(n-1)))))]
    return dict(n=n, mean=m, sd=sd, mn=xs[0], p10=q(.10), p25=q(.25), med=q(.50), p75=q(.75), p90=q(.90), mx=xs[-1])

data = {}
print("=== (1) WELL-SAMPLED PITCHER SET PER TIER (BF>=600, colliding keys excluded) ===")
print(f"{'tier':9}{'need':>6}{'N':>5}{'meanK9':>8}{'sdK9':>7}{'min':>6}{'p10':>6}{'p25':>6}{'med':>6}{'p75':>6}{'p90':>6}{'max':>6}   dropped")
for name, key, need in TIERS:
    rows, dropped = load(key); data[name] = rows
    s = stats([r["k9"] for r in rows])
    print(f"{name:9}{need:6.2f}{s['n']:5d}{s['mean']:8.2f}{s['sd']:7.2f}{s['mn']:6.2f}{s['p10']:6.2f}"
          f"{s['p25']:6.2f}{s['med']:6.2f}{s['p75']:6.2f}{s['p90']:6.2f}{s['mx']:6.2f}   {dropped}")

print("\n=== (2) TERCILES OF THE CARD'S OWN OBSERVED K9 ===")
print(f"{'tier':9}{'tercile':9}{'N':>5}{'meanK9':>8}{'sdK9':>7}{'meanIP':>9}")
for name, key, need in TIERS:
    rows = sorted(data[name], key=lambda r: r["k9"]); t = len(rows)//3
    for lbl, g in (("low", rows[:t]), ("mid", rows[t:2*t]), ("high", rows[-t:])):
        if not g: continue
        s = stats([r["k9"] for r in g])
        print(f"{name:9}{lbl:9}{s['n']:5d}{s['mean']:8.2f}{s['sd']:7.2f}{sum(r['ip'] for r in g)/len(g):9.1f}")

print("\n=== (4) STARTER vs RELIEVER (GSper >= 0.5 = starter) ===")
print(f"{'tier':9}{'group':10}{'N':>5}{'meanK9':>8}{'sdK9':>7}{'meanIP':>9}{'totIP':>10}")
comp = {}
for name, key, need in TIERS:
    rows = data[name]
    st = [r for r in rows if r["gs"] >= 0.5]; rp = [r for r in rows if r["gs"] < 0.5]
    comp[name] = (st, rp)
    for lbl, g in (("starter", st), ("reliever", rp)):
        if not g:
            print(f"{name:9}{lbl:10}{0:5d}   (none)"); continue
        s = stats([r["k9"] for r in g])
        print(f"{name:9}{lbl:10}{s['n']:5d}{s['mean']:8.2f}{s['sd']:7.2f}{sum(r['ip'] for r in g)/len(g):9.1f}{sum(r['ip'] for r in g):10.0f}")

print("\n=== (5) COMPOSITION — does GOLD stand out? ===")
print(f"{'tier':9}{'need':>6}{'startN%':>9}{'startIP%':>10}{'K9 st':>8}{'K9 rp':>8}{'st-rp':>8}")
for name, key, need in TIERS:
    st, rp = comp[name]; rows = data[name]
    nsh = 100.0*len(st)/len(rows)
    ish = 100.0*sum(r["ip"] for r in st)/sum(r["ip"] for r in rows)
    ks = sum(r["k9"] for r in st)/len(st) if st else float("nan")
    kr = sum(r["k9"] for r in rp)/len(rp) if rp else float("nan")
    print(f"{name:9}{need:6.2f}{nsh:9.1f}{ish:10.1f}{ks:8.2f}{kr:8.2f}{ks-kr:8.2f}")

print("\n=== (3) SHAPE — largest gap between consecutive K9 in the middle 80% ===")
for name, key, need in TIERS:
    xs = sorted(r["k9"] for r in data[name]); n = len(xs)
    lo, hi = int(.10*n), int(.90*n)
    mid = xs[lo:hi]
    gaps = [(mid[i+1]-mid[i], mid[i], mid[i+1]) for i in range(len(mid)-1)]
    g = max(gaps) if gaps else (float("nan"),)*3
    s = stats(xs)
    print(f"  {name:9} N={n:4d}  range {xs[0]:.2f}-{xs[-1]:.2f}  largest mid-80% gap {g[0]:.3f} at [{g[1]:.2f},{g[2]:.2f}]  (sd {s['sd']:.2f})")

print("\n=== (6) NESTING — well-sampled cards shared with the tier BELOW ===")
prev = None
for name, key, need in TIERS:
    ks = set(r["key"] for r in data[name])
    if prev is not None:
        pn, pk = prev
        print(f"  {name:9} N={len(ks):4d}   shared with {pn}: {len(ks & pk):4d}  ({100.0*len(ks & pk)/len(ks):.0f}% of {name})")
    prev = (name, ks)
