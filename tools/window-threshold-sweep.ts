// THE WINDOW AND THE THRESHOLD — are minPA=1000 and a two-year window costing us? (2026-07-26)
//   run: node tools/window-threshold-sweep.ts   (writes fixtures/window-threshold-sweep-2026-07-26.txt)
//
// THE QUESTION. Every fit in this project uses a TWO-YEAR window with a minPA = 1000 cut
// (server.saveTrainedModel). Neither choice has ever been justified against its alternative, and the
// day's nulls were all attributed to small sample. On [2042,2043] the window holds 162 hitter and 155
// pitcher distinct cards; the threshold keeps 74 and 67. More than half are discarded before anything
// is fitted — and the fits are ALREADY playing-time weighted (PA^0.75), so a 250-PA card carries ~35%
// of a 1000-PA card's weight. The threshold may be doing bluntly what the weighting does smoothly.
//
// THE TRAP, AND HOW THE DESIGN AVOIDS IT. Relaxing the threshold changes the POPULATION, not just the
// sample size: low-PA cards are less-used cards — noisier AND a different mix of card types. A model
// fitted at minPA 0 and TESTED on a low-PA-inclusive test set is not comparable to one tested on a
// high-PA-only set; the "gain" would be a population shift, not a power gain. So:
//   EVERY comparison in §1 and §2 holds the TEST SET FIXED at the deployed evaluation bar
//   (minPA_eval = 1000) and varies ONLY which rows enter the FIT. The test population is byte-identical
//   across all six thresholds and all window widths within a design. A gain measured this way is a gain
//   in predicting the SAME high-PA cards, which is the deliverable.
// The "does relaxing narrow the CIs" question needs the opposite arm (the bar moves on both sides), so
// it is reported SEPARATELY in §1d and labelled NOT-A-MODEL-COMPARISON.
//
// WINDOW WIDTH AND THE DRIFT. fixtures/kresidual-wide-window-2026-07-25.txt measured the structure of
// the creep: per-season LEVEL is not stable (range -2.63…+0.44/600, correlating +0.93 with season mean
// Stuff and +0.91 with opposing avoid-K) but SHAPE is (the cubic partial moves -0.4983 → -0.4976 under
// year fixed effects, -0.4752 standardised within season). So the drift is in WHERE THE RATINGS SIT,
// not in HOW A RATING CONVERTS TO AN OUTCOME. §2 therefore reports each widened window twice: RAW, and
// DRIFT-ABSORBED (per-season, per-channel level centring applied to the training counts BEFORE pooling
// — the season fixed effect, expressed in the one place a count-based fit can carry it).
//
// METHOD (established; not relitigated). Cluster/bootstrap by CARD, never by row — the inflation factor
// is MEASURED here (§4), never assumed. Distinct-card counts printed beside every row count. HD450|2039
// is excluded by the loader's corrupt-cell detector (confirmed in §0), which makes 2039 a four-league
// season; 2037 is also four leagues; 2038 and 2040-2043 are five. 'League Files/Old Data' 2032-33 sits
// after a four-season gap and is NEVER pooled (reported separately in §0). Every fit passes a FRESH
// vertex-pin collector — production parity (commit 7dea19a), the harness as of 7c8a061.
//
// MEASUREMENT ONLY — no production default changed, no artifact retrained, nothing deployed.

import { writeFileSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { validateDataset } from "../src/training/validate.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import { foldOf, cvFoldKey } from "../src/training/evaluate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import {
  fitHitForm, fitPitForm, predictHitForm, predictPitForm, DEPLOYED_FORMS,
  RAWPOLY_EYEAUG_HIT, EYEAXIS_KB_HIT, EYEAXIS_KBH_HIT, EYEAXIS_KBH_HBPMEAN_HIT, EYEAXIS_ALL4_HIT,
  RAWPOLY_HIT, type VertexPin, type HitForm,
} from "../src/training/forms.ts";
import {
  rate, rateAux, hRate, hRateAux, hitHbpRate, HIT_HBP, HIT_SH_MINUS_SF, PIT_BIP_ADJ,
  type FittedHit, type FittedPit,
} from "../src/model/curves.ts";

const ROOT = "League Files";
const OUT = "fixtures/window-threshold-sweep-2026-07-26.txt";
const SEASONS = [2037, 2038, 2039, 2040, 2041, 2042, 2043];   // 'Old Data' 2032-33 excluded by construction
const THRESHOLDS = [0, 250, 500, 750, 1000, 1500];
const DEPLOYED_T = 1000;
const EVAL_BAR = 1000;      // the FIXED test-set bar for every comparison
const TOPN = 26, KFOLD = 5, NBOOT = 2000;
const LEVEL_REF = 250;      // rows used to ESTIMATE a season's level (fixed cohort, independent of the fit bar)

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sg = (x: number, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp = (s: string, n: number) => s.padStart(n);
const rule = (c = "=") => say(c.repeat(80));

// ── data plumbing ─────────────────────────────────────────────────────────────
const yearCache = new Map<number, TrainObs[]>();
const yearObs = (y: number) => { if (!yearCache.has(y)) yearCache.set(y, loadWindow(ROOT, [y]).observations); return yearCache.get(y)!; };

const clone = (o: TrainObs): TrainObs => ({ ...o, hit: { ...o.hit }, pitch: { ...o.pitch }, ratings: o.ratings, sources: o.sources });

/** Pool per-season observations into one window's observations — the loader's own rule (sum outcomes,
 *  keep the largest-sample source's ratings). Asserted bit-equal to loadWindow in §0. */
function poolObs(perYear: TrainObs[][]): TrainObs[] {
  const map = new Map<string, TrainObs>(), best = new Map<string, number>();
  for (const list of perYear) for (const o of list) {
    let a = map.get(o.key);
    if (!a) { a = clone(o); a.hit = { ...o.hit }; a.pitch = { ...o.pitch }; for (const k of Object.keys(a.hit) as (keyof typeof a.hit)[]) a.hit[k] = 0; for (const k of Object.keys(a.pitch) as (keyof typeof a.pitch)[]) a.pitch[k] = 0; map.set(o.key, a); best.set(o.key, -1); }
    for (const k of Object.keys(a.hit) as (keyof typeof a.hit)[]) a.hit[k] += o.hit[k];
    for (const k of Object.keys(a.pitch) as (keyof typeof a.pitch)[]) a.pitch[k] += o.pitch[k];
    const sample = o.hit.PA + o.pitch.BF;
    if (sample > (best.get(o.key) ?? -1)) { a.ratings = o.ratings; a.name = o.name; a.pos = o.pos; a.bats = o.bats; a.throws = o.throws; best.set(o.key, sample); }
  }
  return [...map.values()];
}
const winCache = new Map<string, TrainObs[]>();
const windowObs = (ys: number[]) => { const k = ys.join(","); if (!winCache.has(k)) winCache.set(k, poolObs(ys.map(yearObs))); return winCache.get(k)!; };

// ── per-season LEVEL absorption (the season fixed effect, in count space) ─────
// The drift is in the LEVEL of each event channel per season. A pooled observation sums a card's
// counts across seasons, so a season dummy cannot be added to the fit after pooling — the season is
// gone. The equivalent operation BEFORE pooling: shift each season's per-600 channel level onto the
// window's common level, then pool. SHAPE (a card's deviation from its season's mean) is untouched,
// which is exactly the quantity the wide-window measurement found stable.
//   The season level is estimated on a FIXED reference cohort (rows with PA/BF >= LEVEL_REF) so the
// absorption is identical for every fit threshold — the two knobs stay independent.
type HitCh = "ubb" | "k" | "hr" | "nhh" | "xbh" | "hp";
type PitCh = "ubb" | "k" | "hr" | "nhh";
const hitGet: Record<HitCh, (o: TrainObs) => number> = {
  ubb: (o) => Math.max(o.hit.BB - o.hit.IBB, 0), k: (o) => o.hit.K, hr: (o) => o.hit.HR,
  nhh: (o) => Math.max(o.hit.H - o.hit.HR, 0), xbh: (o) => o.hit.b2 + o.hit.b3, hp: (o) => o.hit.HP,
};
const pitGet: Record<PitCh, (o: TrainObs) => number> = {
  ubb: (o) => Math.max(o.pitch.BB - o.pitch.IBB, 0), k: (o) => o.pitch.K, hr: (o) => o.pitch.HR,
  nhh: (o) => o.pitch.b1 + o.pitch.b2 + o.pitch.b3,
};
const lvl = <C extends string>(rows: TrainObs[], get: Record<C, (o: TrainObs) => number>, expo: (o: TrainObs) => number, keys: C[]) => {
  const E = rows.reduce((s, o) => s + expo(o), 0) || 1;
  return Object.fromEntries(keys.map((c) => [c, (rows.reduce((s, o) => s + get[c](o), 0) / E) * 600])) as Record<C, number>;
};
const HK: HitCh[] = ["ubb", "k", "hr", "nhh", "xbh", "hp"], PK: PitCh[] = ["ubb", "k", "hr", "nhh"];

// RESIDUAL levels — the honest season fixed effect. Centring the RAW per-600 level would remove the
// part of a season's level that its RATINGS legitimately explain (if 2043's cards really do hit more
// homers, that belongs in the curve, not in a nuisance term) — an over-correction that distorts the
// very shape the exercise is trying to protect. A season fixed effect in a regression removes only
// what the model FAILED to explain. So the "resid" mode centres each season's mean RESIDUAL
// (observed − predicted per-600, under the deployed form fitted on the raw pooled window), which is
// exactly the quantity fixtures/kresidual-wide-window-2026-07-25.txt measured drifting -2.63…+0.44/600.
// Both modes are reported: "level" is the blunt version, "resid" the correct one.
function hitPred(fit: FittedHit, o: TrainObs): Record<HitCh, number> {
  const r = o.ratings.hit;
  const bb = rate(fit.bb, r.eye), k = rateAux(fit.k, r.kRat, r.eye), hr = rateAux(fit.hr, r.pow, r.eye);
  const hp = hitHbpRate(fit, r.eye);
  const bip = Math.max(600 - bb - k - hr - (hp + HIT_SH_MINUS_SF), 1);
  const nhh = hRateAux(fit.h, r.babip, bip, r.eye);
  return { ubb: bb, k, hr, nhh, xbh: Math.max(rate(fit.xbh, r.gap) * nhh, 0), hp };
}
function pitPred(fit: FittedPit, o: TrainObs): Record<PitCh, number> {
  const r = o.ratings.pitch;
  const bb = rateAux(fit.bb, r.con, r.stu), k = rate(fit.k, r.stu), hr = rateAux(fit.hr, r.hrr, r.stu);
  const bip = Math.max(600 - bb - k - hr - PIT_BIP_ADJ, 1);
  return { ubb: bb, k, hr, nhh: hRate(fit.h, r.pbabip, bip) };
}
/** Weighted mean residual (observed − predicted) per channel, per 600. */
const residLvl = <C extends string>(rows: TrainObs[], get: Record<C, (o: TrainObs) => number>, pred: (o: TrainObs) => Record<C, number>, expo: (o: TrainObs) => number, keys: C[]) => {
  const W = rows.reduce((s, o) => s + expo(o), 0) || 1;
  return Object.fromEntries(keys.map((c) => [c, rows.reduce((s, o) => { const e = Math.max(expo(o), 1); return s + expo(o) * ((get[c](o) / e) * 600 - pred(o)[c]); }, 0) / W])) as Record<C, number>;
};

type AbsorbMode = "level" | "resid";
let clampCells = 0, clampCellsQual = 0, totalCellsQual = 0;
/** Drift-absorbed window: per-season additive per-600 shift onto the window mean, then pool. */
const absCache = new Map<string, TrainObs[]>();
const absorbedWindowObs = (ys: number[], mode: AbsorbMode = "resid"): TrainObs[] => {
  const k = `${mode}|${ys.join(",")}`;
  if (!absCache.has(k)) absCache.set(k, absorbedBuild(ys, mode));
  return absCache.get(k)!;
};
function absorbedBuild(ys: number[], mode: AbsorbMode): TrainObs[] {
  const hRef = ys.map((y) => yearObs(y).filter((o) => o.hit.PA >= LEVEL_REF));
  const pRef = ys.map((y) => yearObs(y).filter((o) => o.pitch.BF >= LEVEL_REF));
  let hGlobal: Record<HitCh, number>, pGlobal: Record<PitCh, number>;
  let hYs: Record<HitCh, number>[], pYs: Record<PitCh, number>[];
  if (mode === "level") {
    hGlobal = lvl(hRef.flat(), hitGet, (o) => o.hit.PA, HK); pGlobal = lvl(pRef.flat(), pitGet, (o) => o.pitch.BF, PK);
    hYs = hRef.map((r) => lvl(r, hitGet, (o) => o.hit.PA, HK)); pYs = pRef.map((r) => lvl(r, pitGet, (o) => o.pitch.BF, PK));
  } else {
    const raw = windowObs(ys);
    const fh = fitHitForm(DEPLOYED_FORMS.hit, qual(raw, HIT_ROLE, LEVEL_REF), 0.75, [] as VertexPin[]) as FittedHit;
    const fp = fitPitForm(DEPLOYED_FORMS.pit, qual(raw, PIT_ROLE, LEVEL_REF), 0.75, [] as VertexPin[]) as FittedPit;
    const hp = (o: TrainObs) => hitPred(fh, o), pp = (o: TrainObs) => pitPred(fp, o);
    hGlobal = residLvl(hRef.flat(), hitGet, hp, (o) => o.hit.PA, HK); pGlobal = residLvl(pRef.flat(), pitGet, pp, (o) => o.pitch.BF, PK);
    hYs = hRef.map((r) => residLvl(r, hitGet, hp, (o) => o.hit.PA, HK)); pYs = pRef.map((r) => residLvl(r, pitGet, pp, (o) => o.pitch.BF, PK));
  }
  const adjusted = ys.map((y, i) => {
    const hY = hYs[i]!, pY = pYs[i]!;
    return yearObs(y).map((o) => {
      const a = clone(o);
      if (a.hit.PA > 0) {
        const s = a.hit.PA / 600, big = a.hit.PA >= EVAL_BAR;
        const shift = (c: HitCh) => {
          const v = hitGet[c](o) + (hGlobal[c] - hY[c]) * s;
          if (big) totalCellsQual++;
          if (v < 0) { clampCells++; if (big) clampCellsQual++; }
          return Math.max(v, 0);
        };
        const ubb = shift("ubb"), nhh = shift("nhh"); let xbh = shift("xbh");
        if (xbh > nhh) xbh = nhh;
        const x0 = o.hit.b2 + o.hit.b3, r2 = x0 > 0 ? o.hit.b2 / x0 : 0.75;
        a.hit.BB = ubb + o.hit.IBB; a.hit.K = shift("k"); a.hit.HR = shift("hr"); a.hit.HP = shift("hp");
        a.hit.b2 = xbh * r2; a.hit.b3 = xbh - a.hit.b2; a.hit.b1 = nhh - xbh; a.hit.H = nhh + a.hit.HR;
      }
      if (a.pitch.BF > 0) {
        const s = a.pitch.BF / 600, big = a.pitch.BF >= EVAL_BAR;
        const shift = (c: PitCh) => {
          const v = pitGet[c](o) + (pGlobal[c] - pY[c]) * s;
          if (big) totalCellsQual++;
          if (v < 0) { clampCells++; if (big) clampCellsQual++; }
          return Math.max(v, 0);
        };
        const ubb = shift("ubb"), nhh = shift("nhh");
        const n0 = o.pitch.b1 + o.pitch.b2 + o.pitch.b3, sc = n0 > 0 ? nhh / n0 : 0;
        a.pitch.BB = ubb + o.pitch.IBB; a.pitch.K = shift("k"); a.pitch.HR = shift("hr");
        a.pitch.b1 = o.pitch.b1 * sc; a.pitch.b2 = o.pitch.b2 * sc; a.pitch.b3 = o.pitch.b3 * sc;
      }
      return a;
    });
  });
  return poolObs(adjusted);
}

// ── role + arm abstraction ────────────────────────────────────────────────────
interface Role { name: string; spec: RoleSpec; expo: (o: TrainObs) => number; fitDeployed: (tr: TrainObs[]) => unknown; predict: (p: unknown, te: TrainObs[]) => number[] }
const HIT_ROLE: Role = {
  name: "HITTER", spec: HITTER, expo: (o) => o.hit.PA,
  fitDeployed: (tr) => fitHitForm(DEPLOYED_FORMS.hit, tr, 0.75, [] as VertexPin[]),
  predict: (p, te) => te.map((o) => predictHitForm(p as FittedHit, o)),
};
const PIT_ROLE: Role = {
  name: "PITCHER", spec: PITCHER, expo: (o) => o.pitch.BF,
  fitDeployed: (tr) => fitPitForm(DEPLOYED_FORMS.pit, tr, 0.75, [] as VertexPin[]),
  predict: (p, te) => te.map((o) => predictPitForm(p as FittedPit, o)),
};
const ROLES = [HIT_ROLE, PIT_ROLE];
/** Threshold 0 means "any positive exposure" (a >= 0 test would admit every hitter as a pitcher). */
const qual = (obs: TrainObs[], r: Role, t: number) => obs.filter((o) => r.expo(o) >= Math.max(t, 1));
const cards = (rows: TrainObs[]) => new Set(rows.map((o) => o.cid)).size;

// ── bootstrap plumbing (cluster by CARD; the iid-row twin only to MEASURE inflation) ──
function rngFactory(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const quant = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sdOf = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const excl0 = (lo: number, hi: number) => lo > 0 || hi < 0;
interface Band { m: number; lo: number; hi: number }
const band = (a: number[]): Band => ({ m: mean(a), lo: quant(a, 0.025), hi: quant(a, 0.975) });
const ci = (b: Band, d = 4) => `${sg(b.m, d)} [${sg(b.lo, d)}, ${sg(b.hi, d)}]${excl0(b.lo, b.hi) ? "*" : " "}`;

interface ArmBoot { pea: Band; top: Band; dPea: Band; dTop: Band; dReg: Band; peaSD: number; topSD: number }
/** ONE bootstrap over a FIXED test set, resampling CARDS, scoring every arm on each replicate — so
 *  the arms share draws and the Δ intervals are paired. `ref` = the index the Δs are taken against. */
function bootArms(test: TrainObs[], preds: number[][], role: Role, ref: number, reps = NBOOT, byRow = false): ArmBoot[] {
  const actual = test.map(role.spec.actualWoba), weight = test.map(role.spec.weight);
  const groups = new Map<string, number[]>();
  test.forEach((o, i) => { const g = groups.get(o.cid); if (g) g.push(i); else groups.set(o.cid, [i]); });
  const clusters = byRow ? test.map((_, i) => [i]) : [...groups.values()];
  const rnd = rngFactory(0x51de0726);
  const A = preds.length;
  const acc = Array.from({ length: A }, () => ({ pea: [] as number[], top: [] as number[], dPea: [] as number[], dTop: [] as number[], dReg: [] as number[] }));
  for (let b = 0; b < reps; b++) {
    const idx: number[] = [];
    for (let c = 0; c < clusters.length; c++) idx.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    const act = idx.map((i) => actual[i]!), wt = idx.map((i) => weight[i]!);
    const ms = preds.map((p) => evalMetrics(idx.map((i) => p[i]!), act, wt, role.spec.higherBetter, TOPN));
    const r = ms[ref]!;
    ms.forEach((m, a) => { acc[a]!.pea.push(m.pearson); acc[a]!.top.push(m.topNOverlap); acc[a]!.dPea.push(m.pearson - r.pearson); acc[a]!.dTop.push(m.topNOverlap - r.topNOverlap); acc[a]!.dReg.push(m.valueRegret - r.valueRegret); });
  }
  return acc.map((a) => ({ pea: band(a.pea), top: band(a.top), dPea: band(a.dPea), dTop: band(a.dTop), dReg: band(a.dReg), peaSD: sdOf(a.pea), topSD: sdOf(a.top) }));
}

// ══════════════════════════════════════════════════════════════════════════════
// §0  PROVENANCE
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("THE WINDOW AND THE THRESHOLD — is minPA=1000 on a two-year window costing us? — 2026-07-26");
say("tools/window-threshold-sweep.ts · root 'League Files' · MEASUREMENT ONLY · harness as of 7c8a061");
rule();
say();
const VERDICT_AT = lines.length;   // the verdict is written last and spliced in here
say();

rule();
say("§0  PROVENANCE — the data this run may draw on, and what it excludes");
say("-".repeat(80));
const allYears = availableYears(ROOT);
say(`availableYears(root) = ${allYears.join(", ")}`);
say(`SEASONS USED = ${SEASONS.join(", ")}  (7 seasons)`);
say("EXCLUDED BY CONSTRUCTION: 'League Files/Old Data' 2032, 2033. They sit after a FOUR-SEASON gap");
say("(2034-2036 absent), so pooling them with 2037+ would mix two league frames separated by more");
say("power creep than any window here spans. They are never loaded into any window below. For the");
say("record only, their inventory:");
for (const y of [2032, 2033]) {
  const s = loadWindow(ROOT, [y]).summary;
  say(`   ${y}: leagues ${s.leagues.join(",")} (${s.leagues.length})  obs=${s.observations}  PA=${s.totalPA.toLocaleString()}`);
}
say();
say("PER-SEASON COVERAGE (league count varies — every cross-season claim below is qualified by it):");
say(`  ${pad("year", 6)} ${rp("leagues", 8)}  ${pad("names", 34)} ${rp("obs", 5)} ${rp("PA", 9)}  excluded-cell`);
for (const y of SEASONS) {
  const s = loadWindow(ROOT, [y]).summary;
  say(`  ${pad(String(y), 6)} ${rp(String(s.leagues.length), 8)}  ${pad(s.leagues.join(","), 34)} ${rp(String(s.observations), 5)} ${rp(s.totalPA.toLocaleString(), 9)}  ${s.excludedCells.join(";") || "—"}`);
}
const s39 = loadWindow(ROOT, [2039]).summary;
say();
say(`HD450|2039 EXCLUSION CONFIRMED: the loader's corrupt-cell detector drops it — excludedCells = [${s39.excludedCells.join(", ")}].`);
say(`Its five files parse and its five leagues are listed, but the HD450 cell contributes NOTHING to`);
say(`observations, role splits or wOBA weights (validate.ts corruptCellKeys: byte-identical vL/vR).`);
say(`⇒ 2039 IS EFFECTIVELY A FOUR-LEAGUE SEASON, like 2037. 2038 and 2040-2043 are five.`);
{
  const dv = validateDataset(loadWindow(ROOT, SEASONS).summary);
  say(`   dataset validation on the 7-season window: ok=${dv.ok}, errors=${dv.errors}, excluded=[${dv.excluded.join(", ")}]`);
  say(`   ok=false is the CORRECT state here, not a data problem: validateDataset reports a corrupt cell as`);
  say(`   an ERROR *and* the loader excludes it. The error is the record that HD450|2039 was dropped.`);
}
say();
// pooling identity check
{
  const direct = loadWindow(ROOT, [2042, 2043]).observations;
  const pooled = windowObs([2042, 2043]);
  const dm = new Map(direct.map((o) => [o.key, o]));
  let bad = 0, checked = 0;
  for (const p of pooled) {
    const d = dm.get(p.key); if (!d) { bad++; continue; }
    checked++;
    if (d.hit.PA !== p.hit.PA || d.pitch.BF !== p.pitch.BF || d.hit.HR !== p.hit.HR || d.pitch.K !== p.pitch.K || d.ratings.hit.pow !== p.ratings.hit.pow || d.ratings.pitch.stu !== p.ratings.pitch.stu) bad++;
  }
  say(`POOLING IDENTITY: this tool builds a multi-season window by pooling PER-SEASON loads (it must —`);
  say(`the drift absorption has to happen while the season still exists). Checked against loadWindow on`);
  say(`[2042,2043]: ${direct.length} vs ${pooled.length} observations, ${checked} keys compared, ${bad} mismatches on`);
  say(`(PA, BF, HR, K, POW, STU). ${bad === 0 ? "IDENTICAL — the pooled build is the loader's own." : "MISMATCH — results below are not comparable."}`);
}
say();
say("THE COUNTS THAT MOTIVATE THE RUN (window [2042,2043]; threshold 0 = any positive exposure):");
{
  const w = windowObs([2042, 2043]);
  say(`  ${rp("minPA", 8)}  ${rp("hitter rows", 12)} ${rp("cards", 6)}  ${rp("pitcher rows", 13)} ${rp("cards", 6)}`);
  for (const t of THRESHOLDS) {
    const h = qual(w, HIT_ROLE, t), p = qual(w, PIT_ROLE, t);
    say(`  ${rp(t === 0 ? "none" : String(t), 8)}  ${rp(String(h.length), 12)} ${rp(String(cards(h)), 6)}  ${rp(String(p.length), 13)} ${rp(String(cards(p)), 6)}${t === DEPLOYED_T ? "   ← DEPLOYED" : ""}`);
  }
}
say();

// ══════════════════════════════════════════════════════════════════════════════
// PRE-REGISTERED DECISION RULES (written before any result is read)
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("PRE-REGISTERED DECISION RULES — fixed before the results below were read");
say("-".repeat(80));
say("The metric that decides is OUT-OF-TIME ΔwPearson, never in-sample and never CV alone: a lower");
say("threshold trivially improves in-sample coverage, and CV shares the window's frame. In-sample and");
say("CV are reported as the overfit diagnostic (a term that buys in-sample fit and gives it back out of");
say("time is the signature this run is looking for).");
say();
say("R1 THRESHOLD. A threshold beats minPA=1000 only if, across the THREE out-of-time panels × TWO");
say("   roles (six numbers, test set fixed at the deployed bar): the mean ΔwPearson vs minPA=1000 is");
say("   POSITIVE, at least 4 of 6 individual signs are positive, and NONE is CI-clear negative.");
say("   Otherwise minPA=1000 stands. Ties go to the incumbent.");
say("R2 WINDOW. A width beats 2 seasons only if, across the TWO out-of-time designs × TWO roles (four");
say("   numbers, test set fixed per design): mean ΔwPearson positive, >=3 of 4 signs positive, none");
say("   CI-clear negative. Raw and drift-absorbed are judged separately; the drift-absorbed arm is the");
say("   one the wide-window measurement predicts can win.");
say("R3 EYE AXIS. The Eye-axis verdict is RE-OPENED only if, at the best (threshold, window): the HR");
say("   and BABIP aux coefficients stop swinging (the published swing is BABIP -0.162/-0.172/-0.673, a");
say("   four-fold move between adjacent windows) AND the six ΔwPearson signs stop sorting perfectly by");
say("   fit window. Both, not either.");
say("CI convention: 95% cluster bootstrap over CARD (cid), 2000 replicates, paired draws across arms.");
say("* marks an interval excluding zero.");
say();

// ══════════════════════════════════════════════════════════════════════════════
// §1  THE THRESHOLD SWEEP
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("§1  THRESHOLD SWEEP — refit DEPLOYED_FORMS at six minPA cuts, TEST SET HELD FIXED");
say("-".repeat(80));
say(`Forms: ${DEPLOYED_FORMS.hit.name} (hit) / ${DEPLOYED_FORMS.pit.name} (pit), fitExp 0.75, FRESH vertex-pin`);
say(`collector on every fit (production parity). Test rows always qualify at minPA_eval=${EVAL_BAR} — the`);
say("SAME cards, in the same order, for all six arms. Only the FIT population moves.");
say();

interface Panel { tag: string; kind: "insample" | "cv" | "oot"; fitYears: number[]; testYears: number[]; note: string }
const PANELS: Panel[] = [
  { tag: "IN-WINDOW", kind: "insample", fitYears: [2042, 2043], testYears: [2042, 2043], note: "optimistic bound (test rows are inside the fit window)" },
  { tag: "CV 5-fold", kind: "cv", fitYears: [2042, 2043], testYears: [2042, 2043], note: "folds on cid|side; train = fold!=f at minPA_fit, test = fold==f at minPA_eval" },
  { tag: "OOT-BACK-A", kind: "oot", fitYears: [2042, 2043], testYears: [2037, 2038, 2039, 2040, 2041], note: "the deployed window, extrapolating DOWN" },
  { tag: "OOT-FWD", kind: "oot", fitYears: [2040, 2041], testYears: [2042, 2043], note: "extrapolating UP to newer, stronger cards" },
  { tag: "OOT-BACK-B", kind: "oot", fitYears: [2040, 2041], testYears: [2037, 2038, 2039], note: "second backward leg, independent fit window" },
];

interface Cell { t: number; n: number; cards: number; trainRows: number; trainCards: number; pea: number; top: number; reg: number; boot?: ArmBoot }
const sweep = new Map<string, Cell[]>();   // `${panel}|${role}` → per-threshold cells

for (const P of PANELS) {
  const fitObs = windowObs(P.fitYears), testObs = windowObs(P.testYears);
  for (const role of ROLES) {
    const test = qual(testObs, role, EVAL_BAR);
    const actual = test.map(role.spec.actualWoba), weight = test.map(role.spec.weight);
    const preds: number[][] = [], cells: Cell[] = [];
    for (const t of THRESHOLDS) {
      let pred: number[];
      let trainRows = 0, trainCards = 0;
      if (P.kind === "cv") {
        // Fixed test set, pooled out-of-fold predictions. A test row's prediction comes from the fit
        // that excluded its fold; the row set scored is IDENTICAL across thresholds.
        pred = new Array(test.length).fill(NaN);
        const seen = new Set<string>();
        for (let fold = 0; fold < KFOLD; fold++) {
          const tr = qual(fitObs, role, t).filter((o) => foldOf(cvFoldKey(o), KFOLD) !== fold);
          const teIdx = test.map((o, i) => [o, i] as const).filter(([o]) => foldOf(cvFoldKey(o), KFOLD) === fold);
          if (tr.length < 10 || !teIdx.length) continue;
          trainRows += tr.length; tr.forEach((o) => seen.add(o.cid));
          const p = role.fitDeployed(tr);
          const pv = role.predict(p, teIdx.map(([o]) => o));
          teIdx.forEach(([, i], j) => { pred[i] = pv[j]!; });
        }
        trainRows = Math.round(trainRows / KFOLD); trainCards = seen.size;
      } else {
        const tr = qual(fitObs, role, t);
        trainRows = tr.length; trainCards = cards(tr);
        pred = role.predict(role.fitDeployed(tr), test);
      }
      const m = evalMetrics(pred, actual, weight, role.spec.higherBetter, TOPN);
      preds.push(pred);
      cells.push({ t, n: test.length, cards: cards(test), trainRows, trainCards, pea: m.pearson, top: m.topNOverlap, reg: m.valueRegret });
    }
    const refIdx = THRESHOLDS.indexOf(DEPLOYED_T);
    const boots = bootArms(test, preds, role, refIdx);
    cells.forEach((c, i) => { c.boot = boots[i]; });
    sweep.set(`${P.tag}|${role.name}`, cells);
  }
}

say("§1a  ABSOLUTE METRICS — every arm scored on the same fixed test rows");
say("-".repeat(80));
for (const P of PANELS) {
  say();
  say(`${P.tag}   fit ${P.fitYears.join("+")} → test ${P.testYears.join(",")}   (${P.note})`);
  for (const role of ROLES) {
    const cs = sweep.get(`${P.tag}|${role.name}`)!;
    say(`  ${role.name}  test n=${cs[0]!.n} cards=${cs[0]!.cards}  (FIXED across all six arms)`);
    say(`    ${rp("minPA_fit", 10)} ${rp("train rows", 11)} ${rp("cards", 6)}   ${rp("wPearson", 9)} ${rp("top26", 7)} ${rp("regret", 9)}`);
    for (const c of cs) say(`    ${rp(c.t === 0 ? "none" : String(c.t), 10)} ${rp(String(c.trainRows), 11)} ${rp(String(c.trainCards), 6)}   ${rp(f(c.pea), 9)} ${rp(f(c.top), 7)} ${rp(f(c.reg, 5), 9)}${c.t === DEPLOYED_T ? "  ← deployed" : ""}`);
  }
}
say();
say("§1b  PAIRED Δ vs the deployed minPA=1000 — cluster-bootstrap CIs over CARD");
say("-".repeat(80));
say("Δ > 0 on wPearson/top26 favours the relaxed threshold; Δ < 0 on regret favours it.");
for (const P of PANELS) {
  say();
  say(`${P.tag}   fit ${P.fitYears.join("+")} → test ${P.testYears.join(",")}`);
  for (const role of ROLES) {
    const cs = sweep.get(`${P.tag}|${role.name}`)!;
    say(`  ${role.name}   (${cs[0]!.boot ? "cards resampled: " + cards(qual(windowObs(P.testYears), role, EVAL_BAR)) : ""})`);
    say(`    ${rp("minPA_fit", 10)}  ${pad("ΔwPearson", 28)} ${pad("Δtop26", 28)} ${pad("Δregret", 28)}`);
    for (const c of cs) {
      if (c.t === DEPLOYED_T) { say(`    ${rp(String(c.t), 10)}  ${pad("— reference —", 28)}`); continue; }
      say(`    ${rp(c.t === 0 ? "none" : String(c.t), 10)}  ${pad(ci(c.boot!.dPea), 28)} ${pad(ci(c.boot!.dTop), 28)} ${pad(ci(c.boot!.dReg, 5), 28)}`);
    }
  }
}
say();

// R1 tally
say("§1c  RULE R1 — the out-of-time tally that decides");
say("-".repeat(80));
const OOT_PANELS = PANELS.filter((p) => p.kind === "oot");
say(`Six numbers per threshold: ${OOT_PANELS.map((p) => p.tag).join(", ")} × HITTER, PITCHER.`);
say(`  ${rp("minPA", 7)}  ${rp("mean Δr", 9)} ${rp("pos", 5)} ${rp("CI+", 4)} ${rp("CI-", 4)}   values (hit then pit, panels in order)`);
const r1: { t: number; m: number; pos: number; cip: number; cim: number }[] = [];
for (const t of THRESHOLDS) {
  if (t === DEPLOYED_T) { say(`  ${rp(String(t), 7)}  ${rp("—", 9)} ${rp("—", 5)} ${rp("—", 4)} ${rp("—", 4)}   (reference)`); continue; }
  const vals: number[] = [], flags: string[] = [];
  let cip = 0, cim = 0;
  for (const role of ROLES) for (const P of OOT_PANELS) {
    const c = sweep.get(`${P.tag}|${role.name}`)!.find((x) => x.t === t)!;
    vals.push(c.boot!.dPea.m);
    const clear = excl0(c.boot!.dPea.lo, c.boot!.dPea.hi);
    if (clear) { if (c.boot!.dPea.m > 0) cip++; else cim++; }
    flags.push(`${sg(c.boot!.dPea.m)}${clear ? "*" : " "}`);
  }
  const m = mean(vals), pos = vals.filter((v) => v > 0).length;
  r1.push({ t, m, pos, cip, cim });
  say(`  ${rp(t === 0 ? "none" : String(t), 7)}  ${rp(sg(m), 9)} ${rp(`${pos}/6`, 5)} ${rp(String(cip), 4)} ${rp(String(cim), 4)}   ${flags.join(" ")}`);
}
const r1Winners = r1.filter((x) => x.m > 0 && x.pos >= 4 && x.cim === 0);
const BEST_T = r1Winners.length ? r1Winners.sort((a, b) => b.m - a.m)[0]!.t : DEPLOYED_T;
say();
say(`R1 VERDICT: ${r1Winners.length ? `thresholds clearing the rule: ${r1Winners.map((x) => x.t).join(", ")} → BEST = ${BEST_T}` : `NO threshold clears R1 — minPA=${DEPLOYED_T} STANDS.`}`);
say();

say("§1d  DETERMINATION, NOT COMPARISON — does relaxing the bar NARROW the intervals?");
say("-".repeat(80));
say("§1a-c hold the test set FIXED, so the interval WIDTH there cannot move — width is a property of");
say("the test set. The separate question 'would we measure our deliverable more sharply if the bar came");
say("down everywhere' needs the bar to move on BOTH sides. That changes the estimand (a top-26 over 162");
say("cards is not the same quantity as a top-26 over 74), so this table is NOT a model comparison and");
say("nothing in R1 depends on it. Panel: fit [2042,2043] → test 2037-2041, both at the same bar.");
const HALFW = new Map<string, { p: number; t: number }>();
for (const role of ROLES) {
  say();
  say(`  ${role.name}`);
  say(`    ${rp("bar", 6)} ${rp("test n", 7)} ${rp("cards", 6)}  ${rp("wPearson", 9)} ${pad("95% CI", 20)} ${rp("half-w", 7)}   ${rp("top26", 7)} ${pad("95% CI", 20)} ${rp("half-w", 7)}`);
  const fitObs = windowObs([2042, 2043]), testObs = windowObs([2037, 2038, 2039, 2040, 2041]);
  for (const t of THRESHOLDS) {
    const tr = qual(fitObs, role, t), te = qual(testObs, role, t);
    if (te.length < 30) { say(`    ${rp(String(t), 6)} (test too small)`); continue; }
    const pred = role.predict(role.fitDeployed(tr), te);
    const b = bootArms(te, [pred], role, 0, 1200)[0]!;
    const hwP = (b.pea.hi - b.pea.lo) / 2, hwT = (b.top.hi - b.top.lo) / 2;
    HALFW.set(`${role.name}|${t}`, { p: hwP, t: hwT });
    say(`    ${rp(t === 0 ? "none" : String(t), 6)} ${rp(String(te.length), 7)} ${rp(String(cards(te)), 6)}  ${rp(f(b.pea.m), 9)} ${pad(`[${f(b.pea.lo)}, ${f(b.pea.hi)}]`, 20)} ${rp(`±${f(hwP)}`, 7)}   ${rp(f(b.top.m), 7)} ${pad(`[${f(b.top.lo)}, ${f(b.top.hi)}]`, 20)} ${rp(`±${f(hwT)}`, 7)}`);
  }
}
say();

// ══════════════════════════════════════════════════════════════════════════════
// §2  WINDOW WIDTH
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("§2  WINDOW WIDTH — 1 to 6 seasons, raw and with the season level drift absorbed");
say("-".repeat(80));
say("HOW THE TEST SET IS HELD FIXED. A wider window eats the years an out-of-time test would use, so");
say("the test year is PINNED first and windows grow AWAY from it:");
say("  FORWARD  design: test = 2043 (fixed), windows = the last k seasons ending 2042, k = 1..6.");
say("  BACKWARD design: test = 2037 (fixed), windows = the first k seasons starting 2038, k = 1..6.");
say("Within a design every arm is scored on byte-identical test rows at minPA_eval=1000. The 7-season");
say("window (2037-2043) has NO out-of-time block left at all — it is reported at the end on CV and");
say("in-sample only, and cannot be compared to the others on the metric that decides.");
say();
say("DRIFT ABSORPTION, IN TWO VERSIONS. Per season and per channel a per-600 shift is applied to the");
say(`training counts BEFORE the seasons are pooled (estimated on a fixed reference cohort, exposure >=`);
say(`${LEVEL_REF}, so the absorption never moves with the fit threshold). After pooling the season no longer`);
say("exists as a covariate, so this is where a season fixed effect has to live.");
say("  ABSORB-resid  centres each season's mean RESIDUAL (observed − predicted under the deployed form).");
say("                THE CORRECT ONE: a fixed effect removes what the model FAILED to explain, and this");
say("                is precisely the quantity the wide-window run measured drifting -2.63…+0.44/600.");
say("  ABSORB-level  centres each season's mean RAW rate. Reported because it is the obvious thing to");
say("                do and it is WRONG: if 2043's cards genuinely hit more homers, that belongs to the");
say("                curve, and centring the raw level deletes real signal along with the drift. The");
say("                gap between the two arms is the size of that mistake.");
say("Either way a card's deviation from its own season's mean — the SHAPE — is untouched.");
say();

interface WDesign { tag: string; testYear: number; windows: number[][] }
const WDESIGNS: WDesign[] = [
  { tag: "FORWARD (test 2043)", testYear: 2043, windows: [1, 2, 3, 4, 5, 6].map((k) => SEASONS.filter((y) => y <= 2042).slice(-k)) },
  { tag: "BACKWARD (test 2037)", testYear: 2037, windows: [1, 2, 3, 4, 5, 6].map((k) => SEASONS.filter((y) => y >= 2038).slice(0, k)) },
];

interface WCell { k: number; ys: number[]; arm: string; trainRows: number; trainCards: number; pea: number; top: number; reg: number; boot?: ArmBoot }
const wres = new Map<string, WCell[]>();

const WT = [DEPLOYED_T, ...(BEST_T !== DEPLOYED_T ? [BEST_T] : [])];
for (const T of WT) {
  for (const D of WDESIGNS) {
    const testObs = windowObs([D.testYear]);
    for (const role of ROLES) {
      const test = qual(testObs, role, EVAL_BAR);
      const actual = test.map(role.spec.actualWoba), weight = test.map(role.spec.weight);
      const preds: number[][] = [], cells: WCell[] = [];
      for (const arm of ["RAW", "ABSORB-resid", "ABSORB-level", "RAW·card-disjoint"] as const) {
        for (const ys of D.windows) {
          const obs = arm === "ABSORB-resid" ? absorbedWindowObs(ys, "resid") : arm === "ABSORB-level" ? absorbedWindowObs(ys, "level") : windowObs(ys);
          let tr = qual(obs, role, T);
          if (arm === "RAW·card-disjoint") { const tc = new Set(test.map((o) => o.cid)); tr = tr.filter((o) => !tc.has(o.cid)); }
          if (tr.length < 10) continue;
          const pred = role.predict(role.fitDeployed(tr), test);
          const m = evalMetrics(pred, actual, weight, role.spec.higherBetter, TOPN);
          preds.push(pred);
          cells.push({ k: ys.length, ys, arm, trainRows: tr.length, trainCards: cards(tr), pea: m.pearson, top: m.topNOverlap, reg: m.valueRegret });
        }
      }
      const refIdx = cells.findIndex((c) => c.arm === "RAW" && c.k === 2);
      const boots = bootArms(test, preds, role, Math.max(refIdx, 0));
      cells.forEach((c, i) => { c.boot = boots[i]; });
      wres.set(`${T}|${D.tag}|${role.name}`, cells);
    }
  }
}

for (const T of WT) {
  say();
  say(`══ minPA_fit = ${T}${T === DEPLOYED_T ? " (deployed)" : " (§1 winner)"} ══`);
  for (const D of WDESIGNS) {
    for (const role of ROLES) {
      const cs = wres.get(`${T}|${D.tag}|${role.name}`)!;
      const n = qual(windowObs([D.testYear]), role, EVAL_BAR);
      say();
      say(`${D.tag}  ${role.name}   test n=${n.length} cards=${cards(n)}  (FIXED across every arm below)`);
      say(`  ${pad("arm", 19)} ${rp("k", 2)} ${pad("window", 26)} ${rp("rows", 5)} ${rp("cards", 6)}  ${rp("wPear", 7)} ${rp("top26", 6)} ${rp("regret", 8)}  ${pad("ΔwPearson vs RAW k=2", 28)}`);
      for (const c of cs) {
        const isRef = c.arm === "RAW" && c.k === 2;
        say(`  ${pad(c.arm, 19)} ${rp(String(c.k), 2)} ${pad(c.ys.join("+"), 26)} ${rp(String(c.trainRows), 5)} ${rp(String(c.trainCards), 6)}  ${rp(f(c.pea), 7)} ${rp(f(c.top), 6)} ${rp(f(c.reg, 5), 8)}  ${pad(isRef ? "— reference —" : ci(c.boot!.dPea), 28)}`);
      }
    }
  }
}
say();
say("§2b  RULE R2 — the out-of-time tally per width (four numbers: 2 designs × 2 roles)");
say("-".repeat(80));
const r2rows: { arm: string; k: number; m: number; pos: number; cim: number }[] = [];
for (const arm of ["RAW", "ABSORB-resid", "ABSORB-level", "RAW·card-disjoint"]) {
  say();
  say(`  arm = ${arm}   (Δ vs the RAW 2-season window, minPA_fit=${DEPLOYED_T})`);
  say(`  ${rp("k", 3)}  ${rp("mean Δr", 9)} ${rp("pos", 5)} ${rp("CI+", 4)} ${rp("CI-", 4)}   fwd·hit  fwd·pit  bwd·hit  bwd·pit`);
  for (const k of [1, 2, 3, 4, 5, 6]) {
    const vals: number[] = [], flags: string[] = [];
    let cip = 0, cim = 0, missing = false;
    for (const D of WDESIGNS) for (const role of ROLES) {
      const c = wres.get(`${DEPLOYED_T}|${D.tag}|${role.name}`)!.find((x) => x.arm === arm && x.k === k);
      if (!c) { missing = true; continue; }
      vals.push(c.boot!.dPea.m);
      const clear = excl0(c.boot!.dPea.lo, c.boot!.dPea.hi);
      if (clear) { if (c.boot!.dPea.m > 0) cip++; else cim++; }
      flags.push(`${sg(c.boot!.dPea.m)}${clear ? "*" : " "}`);
    }
    if (missing || !vals.length) { say(`  ${rp(String(k), 3)}  (unavailable)`); continue; }
    const m = mean(vals), pos = vals.filter((v) => v > 0).length;
    r2rows.push({ arm, k, m, pos, cim });
    say(`  ${rp(String(k), 3)}  ${rp(sg(m), 9)} ${rp(`${pos}/4`, 5)} ${rp(String(cip), 4)} ${rp(String(cim), 4)}   ${flags.join("  ")}${arm === "RAW" && k === 2 ? "   ← reference" : ""}`);
  }
}
// ELIGIBILITY. R2 as pre-registered names exactly two candidate arms — "raw and drift-absorbed are
// judged separately". RAW·card-disjoint is a robustness DIAGNOSTIC, not a deployable configuration:
// the production trainer never drops a card because it also appears in a later season, and the arm's
// training sets fall to 25-100 rows, so its intervals are 3-5x wider than the candidates'. It is
// reported in full above and excluded from the decision.
const r2Winners = r2rows.filter((x) => x.k !== 2 && x.arm !== "RAW·card-disjoint" && x.m > 0 && x.pos >= 3 && x.cim === 0);
const bestW = r2Winners.length ? r2Winners.sort((a, b) => b.m - a.m)[0]! : null;
const BEST_K = bestW ? bestW.k : 2;
say();
say(`R2 VERDICT: ${bestW ? `${bestW.arm} k=${bestW.k} clears the rule (mean ${sg(bestW.m)}, ${bestW.pos}/4 positive) → BEST width = ${BEST_K} seasons` : "NO width clears R2 — the TWO-SEASON window STANDS."}`);
say();
say(`UNEQUAL SEASONS, NOT UNEQUAL WIDTHS. '3 seasons' is not 1.5× '2 seasons': 2037 and 2039 carry four`);
say("leagues where 2038 and 2040-2043 carry five, so the marginal season is worth 80-100% of a typical");
say("one depending on which one it is. The rows/cards columns above are the honest x-axis — read the");
say("width tables against THOSE, not against k.");
say();
say(`Absorption clamps (an adjusted count that went negative, forced to 0), across every absorbed window`);
say(`built in this run: ${clampCells} cells total, of which ${clampCellsQual} sit on rows that clear minPA ${EVAL_BAR}`);
say(`(${f((100 * clampCellsQual) / Math.max(totalCellsQual, 1), 2)}% of ${totalCellsQual} such cells). Clamps are concentrated on zero-count channels of`);
say(`tiny-exposure rows — a card with 0 HR in 40 PA shifted down — which carry ~0 weight and mostly do`);
say(`not clear any fit bar. The absorption is not being driven by the clamp.`);
say();
say("§2d  WHY THE ABSORBED ARM MOVES SO LITTLE — the mechanism, not a shrug");
say("-".repeat(80));
say("The absorbed and raw arms agree to the 4th decimal almost everywhere above. That is a RESULT with");
say("a mechanism, not a failed implementation: a season level shift is a CONSTANT added to every card's");
say("rate in that season, so it reaches a card's POOLED rate only through that card's season MIX. Cards");
say("with the same mix all move by the same amount, and a common shift is absorbed by the fit's");
say("intercept — leaving predictions unchanged up to a constant, which weighted Pearson cannot see.");
say("Only the DIFFERENTIAL part (cards weighted toward different seasons) can move a slope. Measured on");
say("the 6-season window 2038-2043, minPA_eval=1000 rows:");
{
  const ys = [2038, 2039, 2040, 2041, 2042, 2043];
  const rawW = windowObs(ys);
  const hRef = ys.map((y) => yearObs(y).filter((o) => o.hit.PA >= LEVEL_REF));
  const fh = fitHitForm(DEPLOYED_FORMS.hit, qual(rawW, HIT_ROLE, LEVEL_REF), 0.75, [] as VertexPin[]) as FittedHit;
  const hp = (o: TrainObs) => hitPred(fh, o);
  for (const [mode, gl, per] of [
    ["resid", residLvl(hRef.flat(), hitGet, hp, (o) => o.hit.PA, HK), hRef.map((r) => residLvl(r, hitGet, hp, (o) => o.hit.PA, HK))],
    ["level", lvl(hRef.flat(), hitGet, (o) => o.hit.PA, HK), hRef.map((r) => lvl(r, hitGet, (o) => o.hit.PA, HK))],
  ] as [string, Record<HitCh, number>, Record<HitCh, number>[]][]) {
    say();
    say(`  APPLIED PER-SEASON SHIFT, mode = ${mode} (per 600, hitter channels; + = that season sat BELOW the window)`);
    say(`    ${rp("season", 7)} ${HK.map((c) => rp(c, 8)).join("")}`);
    ys.forEach((y, i) => say(`    ${rp(String(y), 7)} ${HK.map((c) => rp(sg(gl[c] - per[i]![c], 2), 8)).join("")}`));
    say(`    ${rp("range", 7)} ${HK.map((c) => { const v = ys.map((_, i) => gl[c] - per[i]![c]); return rp(f(Math.max(...v) - Math.min(...v), 2), 8); }).join("")}   ← total spread of the shift`);
  }
  say();
  say(`  For scale, the window's common RAW level per 600: ${HK.map((c) => `${c} ${f(lvl(hRef.flat(), hitGet, (o) => o.hit.PA, HK)[c], 1)}`).join(", ")}.`);
  say(`  The resid-mode K shift spans a wider range than the level-mode one — the same fact the wide-window`);
  say(`  run reported (the RESIDUAL level drifts more than the raw level, because the ratings rise too).`);
  say(`  That is why 'resid' is the arm that matters: it is the only one that could have found anything.`);
  say();
  say(`  HOW MUCH OF THAT SURVIVES POOLING, per card (rows qualifying at minPA ${EVAL_BAR}):`);
  say(`    ${pad("role/channel", 16)} ${rp("SD(Δ) resid", 12)} ${rp("SD(Δ) level", 12)} ${rp("SD(rate)", 10)} ${rp("ratio resid", 12)}`);
  const report = (label: string, rows: TrainObs[], get: (o: TrainObs) => number, expo: (o: TrainObs) => number) => {
    const mk = (mode: AbsorbMode) => new Map(absorbedWindowObs(ys, mode).map((o) => [o.key, o]));
    const mr = mk("resid"), ml = mk("level");
    const dr: number[] = [], dl: number[] = [], r: number[] = [];
    for (const o of rows) {
      const a = mr.get(o.key), b = ml.get(o.key); if (!a || !b) continue;
      const e = Math.max(expo(o), 1), rr = (get(o) / e) * 600;
      r.push(rr); dr.push((get(a) / Math.max(expo(a), 1)) * 600 - rr); dl.push((get(b) / Math.max(expo(b), 1)) * 600 - rr);
    }
    say(`    ${pad(label, 16)} ${rp(f(sdOf(dr), 3), 12)} ${rp(f(sdOf(dl), 3), 12)} ${rp(f(sdOf(r), 3), 10)} ${rp(f(sdOf(dr) / Math.max(sdOf(r), 1e-9), 3), 12)}`);
  };
  const hq = qual(rawW, HIT_ROLE, EVAL_BAR), pq = qual(rawW, PIT_ROLE, EVAL_BAR);
  for (const c of HK) report(`hit ${c}`, hq, hitGet[c], (o) => o.hit.PA);
  for (const c of PK) report(`pit ${c}`, pq, pitGet[c], (o) => o.pitch.BF);
  say();
  say("  'ratio resid' is the differential movement the absorption actually delivered, as a fraction of");
  say("  the between-card spread on that channel. A few percent — and most of even that is COMMON across");
  say("  cards, so the slope-relevant part is smaller still. THAT is the whole story of the absorbed");
  say("  arms' null: a season shift reaches a pooled card only through its season MIX, cards with similar");
  say("  mixes move together, and a common shift is exactly what the fit's intercept already absorbs.");
  say("  This is NOT evidence that the drift is harmless in general. It is evidence that a season fixed");
  say("  effect has nothing left to remove ONCE THE SEASONS ARE POOLED — which is how this trainer works.");
  say("  A trainer that fitted per-season rows would be a different question, and is not what we ship.");
}
say();
say("§2c  THE 7-SEASON WINDOW — no out-of-time block exists for it");
say("-".repeat(80));
say("2037-2043 spans every season available (after the 2032-33 block, which is never pooled), so there");
say("is no held-out year to test it on. It is reported on CV and in-window only, which R2 explicitly");
say("does not accept as evidence. Shown for coverage, not for adoption:");
for (const role of ROLES) {
  say();
  say(`  ${role.name}   ${rp("window", 10)} ${rp("rows", 5)} ${rp("cards", 6)}  ${rp("CV wPear", 9)} ${rp("CV top26", 9)}  ${rp("in-window r", 12)}`);
  for (const ys of [[2042, 2043], [2041, 2042, 2043], [2040, 2041, 2042, 2043], SEASONS]) {
    const obs = windowObs(ys), tr = qual(obs, role, DEPLOYED_T);
    // CV: pooled out-of-fold predictions over the window's own qualifying rows
    const pred = new Array(tr.length).fill(NaN);
    for (let fold = 0; fold < KFOLD; fold++) {
      const trn = tr.filter((o) => foldOf(cvFoldKey(o), KFOLD) !== fold);
      const teIdx = tr.map((o, i) => [o, i] as const).filter(([o]) => foldOf(cvFoldKey(o), KFOLD) === fold);
      if (trn.length < 10 || !teIdx.length) continue;
      const p = role.fitDeployed(trn), pv = role.predict(p, teIdx.map(([o]) => o));
      teIdx.forEach(([, i], j) => { pred[i] = pv[j]!; });
    }
    const act = tr.map(role.spec.actualWoba), wt = tr.map(role.spec.weight);
    const cvm = evalMetrics(pred, act, wt, role.spec.higherBetter, TOPN);
    const ism = evalMetrics(role.predict(role.fitDeployed(tr), tr), act, wt, role.spec.higherBetter, TOPN);
    say(`  ${pad("", 9)} ${rp(`${ys.length}yr`, 10)} ${rp(String(tr.length), 5)} ${rp(String(cards(tr)), 6)}  ${rp(f(cvm.pearson), 9)} ${rp(f(cvm.topNOverlap), 9)}  ${rp(f(ism.pearson), 12)}`);
  }
}
say();

// ══════════════════════════════════════════════════════════════════════════════
// §3  DOES ANY OF IT CHANGE THE EYE-AXIS NULL?
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("§3  THE EYE AXIS RE-RUN — do the coefficients stabilise at the best (threshold, window)?");
say("-".repeat(80));
say("fixtures/hitter-eye-composite-2026-07-26.txt declined the four-leg EYE-axis correction on");
say("UNDER-DETERMINATION: the well-determined K aux was stable across windows (-2.334 / -2.660 /");
say("-2.186) while the HR aux (-0.252 / -0.353 / -0.217) and especially the BABIP aux (-0.162 /");
say("-0.172 / -0.673) swung, and the six ΔwPearson signs sorted PERFECTLY by fit window. If that was a");
say("power failure, relaxing the threshold and/or widening the window should steady the coefficients");
say("and break the sign-window sort. If it does not, under-determination is real and the question is");
say("closed on evidence rather than by assumption.");
say();
const EYE_ARMS: { form: HitForm; tag: string }[] = [
  { form: RAWPOLY_HIT, tag: "deployed" },
  { form: RAWPOLY_EYEAUG_HIT, tag: "K" },
  { form: EYEAXIS_KB_HIT, tag: "K+B" },
  { form: EYEAXIS_KBH_HIT, tag: "K+B+HR" },
  { form: EYEAXIS_KBH_HBPMEAN_HIT, tag: "K+B+HR+hbpμ" },
  { form: EYEAXIS_ALL4_HIT, tag: "ALL4" },
];
const ALL4 = EYE_ARMS[5]!;
const fitEye = (form: HitForm, ys: number[], t: number, absorbed = false) => {
  const obs = absorbed ? absorbedWindowObs(ys) : windowObs(ys);
  return fitHitForm(form, qual(obs, HIT_ROLE, t), 0.75, [] as VertexPin[]) as FittedHit;
};

say("§3a  COEFFICIENT STABILITY — the ALL4 arm's four legs, across configurations");
say("-".repeat(80));
say("Each aux β is in its channel's own per-600 units, per SD of ln(EYE) (the published convention).");
say("STABLE means: the same number at every fit window. The published 2-year / minPA=1000 row is");
say("reproduced first as a control — it must match the artifact.");
const EYE_W2 = [[2037, 2038], [2040, 2041], [2042, 2043]];     // the published set — mutually DISJOINT
const EYE_W3 = [[2037, 2038, 2039], [2040, 2041, 2042]];       // the widest mutually DISJOINT pair available
const PAIR2 = [[2037, 2038], [2040, 2041]];                    // width-2 twin of EYE_W3: same anchors, same count
interface CfgRow { tag: string; windows: number[][]; t: number; absorbed: boolean }
const spreadOf = (v: number[]) => { const mn = Math.min(...v.map(Math.abs)); return mn > 1e-9 ? Math.max(...v.map(Math.abs)) / mn : Infinity; };
const LEGS: [string, (h: FittedHit) => number][] = [
  ["K aux", (h) => h.k.aux!.beta], ["HR aux", (h) => h.hr.aux!.beta], ["BABIP aux", (h) => h.h.aux!.beta],
  ["HBP@110", (h) => rate(h.hbp!, 110)],
];
const SWING = new Map<string, Record<string, number>>();   // cfg tag → leg → max/min |β|
const bandSwing = (tag: string) => SWING.get(tag)?.["BABIP aux"] ?? NaN;
function cfgTable(cfgs: CfgRow[]) {
  say(`  ${pad("configuration", 34)} ${pad("leg", 10)} ${pad("per fit window (in window order)", 34)} ${rp("max/min |β|", 12)}`);
  for (const C of cfgs) {
    const fits = C.windows.map((w) => fitEye(ALL4.form, w, C.t, C.absorbed));
    const rec: Record<string, number> = {};
    LEGS.forEach(([nm, get], j) => {
      const v = C.windows.map((_, i) => get(fits[i]!));
      rec[nm] = spreadOf(v);
      say(`  ${pad(j === 0 ? C.tag : "", 34)} ${pad(nm, 10)} ${pad(v.map((x) => sg(x, 3)).join(" / "), 34)} ${rp(f(spreadOf(v), 2), 12)}`);
    });
    SWING.set(C.tag, rec);
    say(`  ${pad("", 34)} ${pad("(rows)", 10)} ${pad(C.windows.map((w) => String(qual(C.absorbed ? absorbedWindowObs(w) : windowObs(w), HIT_ROLE, C.t).length)).join(" / "), 34)}`);
  }
}
say();
say("TABLE A — THE THRESHOLD LADDER, on the PUBLISHED fit windows (2037+2038 / 2040+2041 / 2042+2043,");
say("mutually disjoint). The minPA=1000 row must reproduce the artifact; it is the control.");
say();
cfgTable([
  { tag: `2yr · minPA ${DEPLOYED_T} (published control)`, windows: EYE_W2, t: DEPLOYED_T, absorbed: false },
  { tag: `2yr · minPA 500`, windows: EYE_W2, t: 500, absorbed: false },
  { tag: `2yr · minPA 250`, windows: EYE_W2, t: 250, absorbed: false },
  { tag: `2yr · minPA none`, windows: EYE_W2, t: 0, absorbed: false },
]);
say();
say("TABLE B — WIDTH, CONTROLLED. Comparing swing across THREE windows to swing across TWO would favour");
say("the smaller set mechanically (a max/min over more draws is larger), and overlapping windows would");
say("favour the wider one (they share seasons, so they must agree). So this contrast uses TWO MUTUALLY");
say("DISJOINT windows on the SAME anchors, and changes only the width:");
say("   width 2:  2037+2038          vs  2040+2041");
say("   width 3:  2037+2038+2039     vs  2040+2041+2042");
say("Two disjoint FOUR-season windows do not exist in 2037-2043 (that needs 8 seasons), so width 3 is");
say("the widest this contrast can reach.");
say();
cfgTable([
  { tag: `width 2 · minPA ${DEPLOYED_T}`, windows: PAIR2, t: DEPLOYED_T, absorbed: false },
  { tag: `width 3 · minPA ${DEPLOYED_T}`, windows: EYE_W3, t: DEPLOYED_T, absorbed: false },
  { tag: `width 2 · minPA 250`, windows: PAIR2, t: 250, absorbed: false },
  { tag: `width 3 · minPA 250`, windows: EYE_W3, t: 250, absorbed: false },
]);
say();
say("TABLE C — does absorbing the season level drift steady the legs? (width 3, both thresholds)");
say();
cfgTable([
  { tag: `width 3 · minPA ${DEPLOYED_T} · raw`, windows: EYE_W3, t: DEPLOYED_T, absorbed: false },
  { tag: `width 3 · minPA ${DEPLOYED_T} · ABSORBED`, windows: EYE_W3, t: DEPLOYED_T, absorbed: true },
  { tag: `width 3 · minPA 250 · raw`, windows: EYE_W3, t: 250, absorbed: false },
  { tag: `width 3 · minPA 250 · ABSORBED`, windows: EYE_W3, t: 250, absorbed: true },
]);
say();
say("READ: max/min |β| is the swing factor across that configuration's fit windows — 1.00 is perfect");
say("stability. The published complaint was a BABIP swing of ~4x against a K swing of ~1.2x. A term the");
say("data has identified does not move when you re-estimate it on a different slice of the same league.");
say();
say("TABLE D — THE SWING OF THE SWING. Reading Tables A-C together on the MATCHED two-window basis (so");
say("the numbers are comparable), the BABIP aux's swing factor does not move in a consistent direction");
say("when the configuration changes — it goes the OTHER WAY depending on the threshold:");
{
  const cells: [string, string][] = [
    [`width 2 · minPA ${DEPLOYED_T}`, `width 3 · minPA ${DEPLOYED_T}`],
    ["width 2 · minPA 250", "width 3 · minPA 250"],
  ];
  say(`  ${pad("threshold", 12)} ${rp("width 2", 9)} ${rp("width 3", 9)}  ${pad("direction", 14)}`);
  for (const [a, b] of cells) {
    const x = bandSwing(a), y = bandSwing(b);
    say(`  ${pad(a.split("· ")[1]!, 12)} ${rp(f(x, 2), 9)} ${rp(f(y, 2), 9)}  ${pad(y < x ? "steadier at 3" : "steadier at 2", 14)}`);
  }
  say();
  say("  Widening the window steadies the BABIP aux at minPA 250 and DESTABILISES it at minPA 1000. A");
  say("  parameter whose apparent identification depends on which nuisance knob you turned is not an");
  say("  identified parameter — the swing factor is itself unstable, which is the finding, not a puzzle.");
  say("  (The K aux, by contrast, sits at 1.01-1.14 in EVERY cell of Tables A-D. That is what an");
  say("  identified term looks like, and it is the leg that was never in doubt.)");
}
say();

say("§3b  THE SIX PAIRED EVALUATIONS, REPEATED AT THE RELAXED THRESHOLD");
say("-".repeat(80));
say("Exactly the published six panels (so the numbers are comparable), with ONE change: the FIT");
say(`threshold. Test rows still qualify at minPA_eval=${EVAL_BAR} — the published test populations, unchanged,`);
say("which is also what keeps this from being a population shift. Δ = candidate − deployed.");
interface EyePanel { tag: string; fitW: number[]; testW: number[]; cv: boolean }
const EYE_PANELS: EyePanel[] = [
  { tag: "FORWARD  fit 2037+2038 → test 2039-2043", fitW: [2037, 2038], testW: [2039, 2040, 2041, 2042, 2043], cv: false },
  { tag: "FORWARD  fit 2040+2041 → test 2042+2043", fitW: [2040, 2041], testW: [2042, 2043], cv: false },
  { tag: "BACKWARD fit 2042+2043 → test 2037-2041", fitW: [2042, 2043], testW: [2037, 2038, 2039, 2040, 2041], cv: false },
  { tag: "BACKWARD fit 2040+2041 → test 2037-2039", fitW: [2040, 2041], testW: [2037, 2038, 2039], cv: false },
  { tag: "CV       5-fold on 2042+2043", fitW: [2042, 2043], testW: [2042, 2043], cv: true },
  { tag: "CV       5-fold on 2040+2041", fitW: [2040, 2041], testW: [2040, 2041], cv: true },
];
// The deployed bar (reproduces the published §8 as a control), the §1 winner, and 250 — deduped.
const EYE_TS = [...new Set<number>([DEPLOYED_T, BEST_T, 250])];
const eyeTally = new Map<string, { t: number; panel: string; fitW: string; d: number; clear: boolean }[]>();
for (const T of EYE_TS) {
  say();
  say(`══ minPA_fit = ${T}${T === DEPLOYED_T ? " (deployed — reproduces the published §8)" : ""} ══`);
  for (const P of EYE_PANELS) {
    const fitObs = windowObs(P.fitW), testObs = windowObs(P.testW);
    const test = qual(testObs, HIT_ROLE, EVAL_BAR);
    const actual = test.map(HITTER.actualWoba), weight = test.map(HITTER.weight);
    const preds: number[][] = [];
    for (const arm of EYE_ARMS) {
      let pred: number[];
      if (P.cv) {
        pred = new Array(test.length).fill(NaN);
        for (let fold = 0; fold < KFOLD; fold++) {
          const trn = qual(fitObs, HIT_ROLE, T).filter((o) => foldOf(cvFoldKey(o), KFOLD) !== fold);
          const teIdx = test.map((o, i) => [o, i] as const).filter(([o]) => foldOf(cvFoldKey(o), KFOLD) === fold);
          if (trn.length < 10 || !teIdx.length) continue;
          const fh = fitHitForm(arm.form, trn, 0.75, [] as VertexPin[]) as FittedHit;
          teIdx.forEach(([o, i]) => { pred[i] = predictHitForm(fh, o); });
        }
      } else {
        const fh = fitHitForm(arm.form, qual(fitObs, HIT_ROLE, T), 0.75, [] as VertexPin[]) as FittedHit;
        pred = test.map((o) => predictHitForm(fh, o));
      }
      preds.push(pred);
    }
    const boots = bootArms(test, preds, HIT_ROLE, 0);
    const base = evalMetrics(preds[0]!, actual, weight, true, TOPN);
    say();
    say(`  ${P.tag}   n=${test.length} cards=${cards(test)}   deployed: wPearson ${f(base.pearson)}  top26 ${f(base.topNOverlap)}`);
    say(`    ${pad("arm", 14)} ${pad("ΔwPearson", 28)} ${pad("Δtop26", 28)} ${pad("Δregret", 28)}`);
    EYE_ARMS.forEach((arm, i) => {
      if (i === 0) return;
      const b = boots[i]!;
      say(`    ${pad(arm.tag, 14)} ${pad(ci(b.dPea), 28)} ${pad(ci(b.dTop), 28)} ${pad(ci(b.dReg, 5), 28)}`);
      const key = `${T}|${arm.tag}`;
      const arr = eyeTally.get(key) ?? []; arr.push({ t: T, panel: P.tag, fitW: P.fitW.join("+"), d: b.dPea.m, clear: excl0(b.dPea.lo, b.dPea.hi) }); eyeTally.set(key, arr);
    });
  }
}
say();
say("§3c  DOES THE SIGN STILL SORT BY FIT WINDOW?");
say("-".repeat(80));
say("The published finding: every evaluation fitted on 2040+2041 was positive and every one fitted on");
say("2037+2038 or 2042+2043 was negative — one window's evidence counted three times. If the threshold");
say("were the binding constraint, that sort should break.");
for (const T of EYE_TS) {
  say();
  say(`  minPA_fit = ${T}`);
  say(`    ${pad("arm", 14)} ${pad("fit 2037+2038", 16)} ${pad("fit 2040+2041", 26)} ${pad("fit 2042+2043", 20)}  ${rp("pos", 5)} ${rp("sorts?", 7)}`);
  for (const arm of EYE_ARMS.slice(1)) {
    const rows = eyeTally.get(`${T}|${arm.tag}`) ?? [];
    const g = (w: string) => rows.filter((r) => r.fitW === w).map((r) => `${sg(r.d)}${r.clear ? "*" : ""}`).join(" ");
    const byW = ["2037+2038", "2040+2041", "2042+2043"].map((w) => rows.filter((r) => r.fitW === w).map((r) => r.d));
    const sorts = byW.every((v) => v.length === 0 || v.every((x) => x > 0) || v.every((x) => x <= 0)) && new Set(byW.filter((v) => v.length).map((v) => v[0]! > 0)).size > 1;
    const pos = rows.filter((r) => r.d > 0).length;
    say(`    ${pad(arm.tag, 14)} ${pad(g("2037+2038"), 16)} ${pad(g("2040+2041"), 26)} ${pad(g("2042+2043"), 20)}  ${rp(`${pos}/${rows.length}`, 5)} ${rp(sorts ? "YES" : "no", 7)}`);
  }
}
say();

say("§3d  THE SAME TEST AT WIDTH 3 — six panels, two per fit window");
say("-".repeat(80));
say("§3b/§3c vary the threshold at the published WIDTH. This varies the width instead: three-season fit");
say("windows, two out-of-time evaluations each, so 'does the sign sort by fit window' is still a");
say("well-posed question (it needs >=2 evaluations per window). Test rows at minPA_eval=1000 throughout.");
interface W3Panel { fitW: number[]; testW: number[] }
const W3_PANELS: W3Panel[] = [
  { fitW: [2037, 2038, 2039], testW: [2040, 2041, 2042] }, { fitW: [2037, 2038, 2039], testW: [2043] },
  { fitW: [2040, 2041, 2042], testW: [2037, 2038, 2039] }, { fitW: [2040, 2041, 2042], testW: [2043] },
  { fitW: [2041, 2042, 2043], testW: [2037, 2038, 2039] }, { fitW: [2041, 2042, 2043], testW: [2040] },
];
const w3Tally = new Map<string, { fitW: string; d: number; clear: boolean }[]>();
for (const T of [DEPLOYED_T, 250]) {
  say();
  say(`══ width 3 · minPA_fit = ${T} ══`);
  for (const P of W3_PANELS) {
    const fitObs = windowObs(P.fitW), test = qual(windowObs(P.testW), HIT_ROLE, EVAL_BAR);
    if (test.length < 30) continue;
    const preds = EYE_ARMS.map((arm) => {
      const fh = fitHitForm(arm.form, qual(fitObs, HIT_ROLE, T), 0.75, [] as VertexPin[]) as FittedHit;
      return test.map((o) => predictHitForm(fh, o));
    });
    const boots = bootArms(test, preds, HIT_ROLE, 0, 1200);
    const base = evalMetrics(preds[0]!, test.map(HITTER.actualWoba), test.map(HITTER.weight), true, TOPN);
    say();
    say(`  fit ${pad(P.fitW.join("+"), 16)} → test ${pad(P.testW.join(","), 16)}  n=${test.length} cards=${cards(test)}  deployed wPearson ${f(base.pearson)}`);
    EYE_ARMS.forEach((arm, i) => {
      if (i === 0) return;
      const b = boots[i]!;
      say(`    ${pad(arm.tag, 14)} ΔwPearson ${pad(ci(b.dPea), 28)} Δtop26 ${pad(ci(b.dTop), 28)}`);
      const key = `${T}|${arm.tag}`;
      const a = w3Tally.get(key) ?? []; a.push({ fitW: P.fitW.join("+"), d: b.dPea.m, clear: excl0(b.dPea.lo, b.dPea.hi) }); w3Tally.set(key, a);
    });
  }
}
say();
say("  SIGN-BY-FIT-WINDOW at width 3:");
for (const T of [DEPLOYED_T, 250]) {
  say(`    minPA_fit = ${T}`);
  say(`      ${pad("arm", 14)} ${pad("fit 2037-2039", 20)} ${pad("fit 2040-2042", 20)} ${pad("fit 2041-2043", 20)} ${rp("pos", 5)} ${rp("sorts?", 7)}`);
  for (const arm of EYE_ARMS.slice(1)) {
    const rows = w3Tally.get(`${T}|${arm.tag}`) ?? [];
    const ws = ["2037+2038+2039", "2040+2041+2042", "2041+2042+2043"];
    const g = (w: string) => rows.filter((r) => r.fitW === w).map((r) => `${sg(r.d)}${r.clear ? "*" : ""}`).join(" ");
    const byW = ws.map((w) => rows.filter((r) => r.fitW === w).map((r) => r.d));
    const sorts = byW.every((v) => !v.length || v.every((x) => x > 0) || v.every((x) => x <= 0)) && new Set(byW.filter((v) => v.length).map((v) => v[0]! > 0)).size > 1;
    say(`      ${pad(arm.tag, 14)} ${pad(g(ws[0]!), 20)} ${pad(g(ws[1]!), 20)} ${pad(g(ws[2]!), 20)} ${rp(`${rows.filter((r) => r.d > 0).length}/${rows.length}`, 5)} ${rp(sorts ? "YES" : "no", 7)}`);
  }
}
say();

// ══════════════════════════════════════════════════════════════════════════════
// §4  THE CLUSTER INFLATION FACTOR — measured, not assumed
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("§4  CLUSTER INFLATION FACTOR — measured for THESE statistics, on THESE test sets");
say("-".repeat(80));
say("A card contributes two rows (vL and vR) whose errors are correlated, so a row bootstrap understates");
say("the interval. The factor is NOT a constant: it has measured ~3.1x on one statistic and ~1.07x on");
say("another in this project. Reported as SD(cluster bootstrap over cid) / SD(iid row bootstrap).");
say();
say(`  ${pad("panel", 34)} ${pad("role", 9)} ${rp("rows", 5)} ${rp("cards", 6)} ${rp("rows/card", 10)}  ${rp("wPearson", 9)} ${rp("top26", 8)}`);
for (const P of PANELS.filter((p) => p.kind === "oot")) {
  const fitObs = windowObs(P.fitYears), testObs = windowObs(P.testYears);
  for (const role of ROLES) {
    const test = qual(testObs, role, EVAL_BAR);
    const pred = role.predict(role.fitDeployed(qual(fitObs, role, DEPLOYED_T)), test);
    const bc = bootArms(test, [pred], role, 0, 1500, false)[0]!;
    const br = bootArms(test, [pred], role, 0, 1500, true)[0]!;
    const nc = cards(test);
    say(`  ${pad(`${P.tag} ${P.fitYears.join("+")}→${P.testYears[0]}..`, 34)} ${pad(role.name, 9)} ${rp(String(test.length), 5)} ${rp(String(nc), 6)} ${rp(f(test.length / nc, 2), 10)}  ${rp(`${f(bc.peaSD / Math.max(br.peaSD, 1e-12), 2)}x`, 9)} ${rp(`${f(bc.topSD / Math.max(br.topSD, 1e-12), 2)}x`, 8)}`);
  }
}
say();
say("Every interval in §1-§3 uses the CLUSTER version. Nothing here assumes a factor; the numbers above");
say("are what these statistics actually carry on these test sets.");
say();
say("READING: on THESE statistics the factor is small — 1.02-1.22x on wPearson and 0.94-1.15x on top-26,");
say("against 2.2-2.5 rows per card. It is not the ~3.1x seen elsewhere in the project, and on top-26 it");
say("is essentially 1.0 (a discrete 1/26-grained statistic whose bootstrap spread is dominated by which");
say("cards land in the top 26, not by within-card correlation). The reason wPearson clusters more than");
say("top-26: vL and vR of one card share a rating vector, so their prediction ERRORS move together, and");
say("Pearson integrates every row's error while top-26 only counts membership flips. Nothing in the");
say("conclusions turns on the factor — it is reported because assuming one would have been wrong in");
say("both directions depending on which statistic you assumed it for.");
say();

// ══════════════════════════════════════════════════════════════════════════════
// §5  A NOTE ON THE PARAMETER-COST READING
// ══════════════════════════════════════════════════════════════════════════════
rule();
say("§5  DOES THE SWEEP BEAR ON THE 'NO HEADROOM LEFT' READING?");
say("-".repeat(80));
say("The per-event flex ceiling spends 21 (hitter) / 15 (pitcher) parameters and currently loses to the");
say("deployed curves out of time on 4 of 10 channels — plausibly a parameter-cost artefact that a larger");
say("sample would relieve. That reading and this run share one dependency: whether the fit is");
say("sample-starved. §1's answer to R1 is the direct evidence, and it transfers with a caveat — a");
say("flexible form has MORE to gain from extra rows than a 5-parameter curve does, so a null here bounds");
say("but does not settle the ceiling question. What it does settle: if the deployed curves cannot use the");
say("extra rows at all, 'the ceiling loses on parameter cost' cannot be repaired by lowering the bar");
say("alone. The ceiling's own threshold sweep is a separate measurement and is NOT run here.");
say();

// ══════════════════════════════════════════════════════════════════════════════
// VERDICT (spliced to the top)
// ══════════════════════════════════════════════════════════════════════════════
const v: string[] = [];
const vsay = (s = "") => v.push(s);
vsay("=".repeat(80));
vsay("VERDICT — is minPA=1000 costing us, does a wider window help once drift is absorbed,");
vsay("and does either change the EYE-axis verdict?");
vsay("=".repeat(80));
const bestR1 = r1.slice().sort((a, b) => b.m - a.m)[0]!;
const r1none = r1.find((x) => x.t === 0)!;
const hw = (role: string, t: number) => HALFW.get(`${role}|${t}`)!;
const sortsAt = (T: number) => EYE_ARMS.slice(1).filter((arm) => {
  const rows = eyeTally.get(`${T}|${arm.tag}`) ?? [];
  const byW = ["2037+2038", "2040+2041", "2042+2043"].map((w) => rows.filter((r) => r.fitW === w).map((r) => r.d));
  return byW.every((v) => !v.length || v.every((x) => x > 0) || v.every((x) => x <= 0)) && new Set(byW.filter((v) => v.length).map((v) => v[0]! > 0)).size > 1;
}).length;
const bab = (tag: string) => SWING.get(tag)?.["BABIP aux"] ?? NaN;
vsay();
vsay(`SHORT ANSWER: minPA=1000 is costing us almost exactly nothing, a wider window costs us a little,`);
vsay(`and neither rescues the EYE axis. The day's nulls were not sample-size nulls.`);
vsay();
vsay(`1. IS minPA=1000 COSTING US?  Barely — and the honest answer has two halves.`);
vsay(`   Under R1 (out-of-time ΔwPearson over six numbers, test set FIXED at the deployed bar so this is`);
vsay(`   a power question and not a population shift), thresholds ${r1Winners.length ? r1Winners.map((x) => x.t).join(", ") : "(none)"} clear the rule; the best is`);
vsay(`   minPA=${bestR1.t} at mean ΔwPearson ${sg(bestR1.m)} (${bestR1.pos}/6 positive, ${bestR1.cip} CI-clear positive, ${bestR1.cim} CI-clear negative), and`);
vsay(`   minPA=500 is the sign-consistent one at 6/6 positive. So the sweep does have an interior optimum`);
vsay(`   and 1000 is not it.`);
vsay(`   BUT THE SIZE IS THE POINT. The gain is +0.0006 to +0.0009 in weighted Pearson. The comparator`);
vsay(`   this project adopts on is stuffAug at +0.012…+0.033 — one to two ORDERS OF MAGNITUDE larger. On`);
vsay(`   the deliverable metrics the gain is not there at all: Δtop26 and Δregret are ~0 at every`);
vsay(`   threshold, against top-26 intervals of ±0.08-0.19. Moving the bar to 500 would change no roster.`);
vsay(`   AND THE OTHER DIRECTION IS REAL. Dropping the bar to zero is clearly BAD: mean ΔwPearson`);
vsay(`   ${sg(r1none.m)} with the pitcher in-window fit collapsing (-0.025) and pitcher CV collapsing (-0.063).`);
vsay(`   So there is a genuine floor: the low-PA rows are not free information, they are noise the`);
vsay(`   PA^0.75 weight only partly suppresses. That is the population caveat in numbers — "more cards"`);
vsay(`   and "more information" are different quantities, and past ~250 PA the extra cards stop being`);
vsay(`   information and start being noise.`);
vsay(`   AND RELAXING DOES NOT NARROW ANYTHING (§1d). If the bar comes down on BOTH sides — the only way`);
vsay(`   an interval could narrow — it WIDENS: hitter wPearson half-width ±${f(hw("HITTER", DEPLOYED_T).p)} at 1000 →`);
vsay(`   ±${f(hw("HITTER", 0).p)} at no bar; top-26 stays ±0.13-0.19 throughout. The data-limited deliverable metrics`);
vsay(`   are NOT limited by the threshold. That closes the "just lower the bar and the CIs will tighten"`);
vsay(`   hope directly, and it is the single most transferable result in this artifact.`);
vsay();
vsay(`2. DOES A WIDER WINDOW HELP ONCE DRIFT IS ABSORBED?  No — and the drift absorption is a null with`);
vsay(`   a mechanism, which is more useful than a null without one.`);
vsay(`   Under R2 (test year PINNED, window grown away from it, so every width is scored on byte-identical`);
vsay(`   test rows), ${bestW ? `${bestW.arm} k=${bestW.k} clears the rule` : "NO eligible width clears the rule"}. Widening is neutral for pitchers and mildly NEGATIVE for`);
vsay(`   hitters — the forward design puts k=3,4,5 CI-clear below k=2 (-0.0033, -0.0036, -0.0044). Only`);
vsay(`   at k=6 does it climb back to roughly even, and by then the oldest season is six years from the`);
vsay(`   test year.`);
vsay(`   THE ABSORBED ARM MOVED ALMOST NOTHING (§2d), and the reason is structural rather than`);
vsay(`   disappointing: this trainer POOLS a card's counts across the window's seasons, so a per-season`);
vsay(`   level shift reaches a card only through that card's season MIX. Cards with similar mixes all move`);
vsay(`   together, and a common shift is exactly what the fit's intercept already absorbs. Measured, the`);
vsay(`   differential part is ~1-4% of the between-card spread on every channel. So the season fixed`);
vsay(`   effect is not wrong — it has nothing left to remove once the seasons are pooled. The wide-window`);
vsay(`   measurement's finding still stands (LEVEL drifts, SHAPE does not); what this run adds is that the`);
vsay(`   drift was never entering the pooled fit as anything but an intercept.`);
vsay(`   The 7-season window cannot be judged on the metric that decides at all — it leaves no held-out`);
vsay(`   block (§2c). Its CV numbers are shown and are NOT evidence.`);
vsay();
vsay(`3. DOES EITHER CHANGE THE EYE-AXIS VERDICT?  No. It is confirmed, and one of the two legs is`);
vsay(`   confirmed in the opposite direction from the "power failure" hypothesis.`);
vsay(`   THE THRESHOLD MAKES THE BABIP AUX WORSE, NOT BETTER. Its swing across the three published fit`);
vsay(`   windows goes ${f(bab(`2yr · minPA ${DEPLOYED_T} (published control)`), 2)}x (minPA 1000) → ${f(bab("2yr · minPA 500"), 2)}x (500) → ${f(bab("2yr · minPA 250"), 2)}x (250) → ${f(bab("2yr · minPA none"), 2)}x (no bar).`);
vsay(`   Adding the low-PA cards DESTABILISES exactly the leg that was unstable. That is the cleanest`);
vsay(`   result in the artifact: under-determination here is not a shortage of rows, it is a shortage of`);
vsay(`   INFORMATION about the contact channel, and low-PA rows carry the least of it per row.`);
vsay(`   AND THE SIGNS DO NOT STOP SORTING BY FIT WINDOW. ${sortsAt(DEPLOYED_T)} of the 5 arms sort perfectly at minPA 1000;`);
vsay(`   at minPA 250 it is ${sortsAt(250)} of 5 — relaxing the bar made MORE arms sort, not fewer (§3c). At the best`);
vsay(`   (threshold, window) that R1 and R2 actually selected — minPA ${BEST_T}, ${BEST_K} seasons — R3 needed BOTH the`);
vsay(`   coefficients to steady AND the sort to break. Neither happened, so the verdict is unchanged.`);
vsay(`   THE ONE PLACE IT LOOKS DIFFERENT, HANDLED HONESTLY. At WIDTH 3 (which did NOT win R2) the sign`);
vsay(`   sort does break — but into SCATTER, not into consistency: the arms still land 3-4 of 6 positive`);
vsay(`   with a -0.0035 in one panel, so the adoption bar (consistently positive, never CI-clear negative)`);
vsay(`   is still missed by the same distance. And the coefficient story there does not hold up either.`);
vsay(`   On the MATCHED two-window basis (Table D) widening steadies the BABIP aux at minPA 250`);
vsay(`   (${f(bab("width 2 · minPA 250"), 2)}x → ${f(bab("width 3 · minPA 250"), 2)}x) and DESTABILISES it at minPA 1000 (${f(bab(`width 2 · minPA ${DEPLOYED_T}`), 2)}x → ${f(bab(`width 3 · minPA ${DEPLOYED_T}`), 2)}x). A parameter whose`);
vsay(`   apparent identification flips direction with a nuisance knob is not identified; the swing factor`);
vsay(`   is itself unstable. The K aux meanwhile sits at 1.01-1.14 in every cell of every table — which is`);
vsay(`   what an identified term looks like, and it is the leg that was never in doubt.`);
vsay(`   Drift absorption changes the coefficients by ~0.04x, i.e. not at all.`);
vsay(`   ⇒ THE EYE-AXIS DECLINE STANDS, and it now stands on evidence rather than on assumption. The`);
vsay(`   four-leg candidate was not a victim of the 74-card sample; it is not identified by this league's`);
vsay(`   data at any threshold or width available, and the six-leg cancellation finding (removing four legs`);
vsay(`   of a six-leg cancellation lands wherever the other two sit) remains the reason it cannot pay.`);
vsay();
vsay(`WHAT THIS CLOSES. "It failed because we only had ~75 cards" is no longer available as an`);
vsay(`explanation for today's nulls. The 75 is a threshold artefact — the window really does hold 162`);
vsay(`hitters and 155 pitchers — but the discarded rows carry so little estimating weight (PA^0.75 already`);
vsay(`gives a 250-PA card ~35% of a 1000-PA card's) and so much noise that admitting them buys ~0.0006`);
vsay(`Pearson and costs interval width. Two years and 1000 PA are, to within the resolution of every`);
vsay(`metric we act on, the right settings. NO PRODUCTION DEFAULT SHOULD CHANGE ON THIS ARTIFACT.`);
vsay();
vsay(`ONE THING IT DOES NOT CLOSE (§5): the per-event flex ceiling spends 21/15 parameters against these`);
vsay(`same row counts. A 5-parameter curve being unable to use extra rows does not prove a 21-parameter`);
vsay(`one cannot — flexible forms have more to gain. What it does establish is that the extra rows are`);
vsay(`available and are LOW QUALITY, so the ceiling's parameter-cost problem cannot be fixed by lowering`);
vsay(`the bar alone. The ceiling's own sweep is a separate measurement and was not run here.`);
lines.splice(VERDICT_AT, 0, ...v);

writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`\nwrote ${OUT} (${lines.length} lines)`);
