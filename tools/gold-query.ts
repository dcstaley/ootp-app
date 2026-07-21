// ═══ THE GOLD QUERY — are gold's low-support tail, its lightly-used cards, and its NEW RELEASES
//     the same cards? ════════════════════════════════════════════════════════════════════════════
//   run: node tools/gold-query.ts
//
// WHY THIS EXISTS. Gold is currently three findings at once and nothing joins them:
//   (a) its K need FALLS 1.78 -> 1.63 when the usage floor rises BF>=600 -> BF>=1000 (N 91 -> 68),
//       while iron/bronze/silver hold  (fixtures/cwhit-battery-needs-vs-bar-2026-07-21.txt);
//   (b) ELEVEN of its 91 well-sampled pitchers sit below the LEAGUE TRAINING 5th percentile in
//       effective stuff and carry 50.8% of its predicted-K variance
//       (fixtures/cwhit-centerpiece2-step0-domain-2026-07-21.txt);
//   (c) the card-design mechanism that was supposed to explain it is REFUTED
//       (fixtures/cwhit-battery-gold-catalog-stu-2026-07-21.txt).
// Step 0 named the join as "the single sharpest next question" and did not run it. This runs it.
//
// THE NEW INPUT: RELEASE DATES. The catalog carries a `date` column on every card — the authoritative
// release field, running from the 2026-03-13 launch bulk to 2026-07-16. A card released a fortnight
// before the observation window PHYSICALLY CANNOT have accumulated a full line, so "lightly used" and
// "recently released" are two different things that a BF floor cannot tell apart. That distinction is
// what decides whether raising the bar CLEANS a selection-on-outcome artifact or CENSORS real spread.
//
// WHAT IS REUSED, NOT RE-DERIVED. The effective-stuff coordinate (applyAffine(Stuff v{R,L},
// poolTransform) blended by the platoon exposure weights — the exact argument ourPit feeds the K
// curve) and the league TRAINING-SUPPORT quantiles (loadWindow → BF>=minBF → BF^0.75 weights) are
// copied VERBATIM from tools/centerpiece2-step0-domain.ts, so the classification thresholds here are
// the same numbers that produced the 11-card finding. Tools are entry-point scripts and cannot be
// imported without executing them, which is why this is a verbatim copy and is labelled as one.
//
// NO PRIVATE JOIN. Usage and identity come from `buildCwhitSample` and `Rec.cid` (= `${Card ID}|${vlvl}`);
// cid maps back to a catalog card through `opponentSet` — the same pairing src/eval/cwhit/realized.ts
// documents. v5 rows are their own cards with their own ratings and their own usage. A v5's `date` is
// its BASE card's date; that limitation is printed next to every release number below.
//
// MEASUREMENT ONLY. Nothing fitted, no default moved, no production behaviour touched.
//
// EVIDENCE RULE, STANDING: performance evidence only. Nothing here reads, reasons about or reports
// prices, cost, market behaviour or player economy. (The catalog carries price columns; they are not
// read.)
//
// THIN RULE, PRE-REGISTERED: any cell below 15 cards carries NO verdict and is labelled THIN /
// "insufficient data" — never "noise".

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats, buildPoolTransform, applyAffine,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import {
  QUICK, inValueWindow, n_, buildCwhitSample, wellSampled, cardName, FIELD_N,
  type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import { formatByLegacySlug, captureObsPath, CAPTURE_DIR_2026_07_21 } from "../src/eval/cwhit/corpus.ts";
import { parseCwhitPit } from "../src/eval/cwhit/parse.ts";
import { loadWindow } from "../src/training/loader.ts";

const TIER = "gold";
const THIN_N = 15;
/** The bar step that moves the need: cards at 600 <= BF < 1000 are exactly what BF>=1000 removes. */
const LOW_BAR = 600, HIGH_BAR = 1000;

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
function slopeOf(p: number[], o: number[]): number {
  const mp = mean(p), mo = mean(o);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}

// ── deployed model + neutral env (the step-0 / battery setup, unchanged) ─────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon || !trained.trainingMeans) throw new Error("active model missing eventForm/wobaWeights/platoon/trainingMeans");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const res = buildCwhitSample({ ...deps, minBf: LOW_BAR });

// ── the K curve's own stamped frame (step 0's, read off the deployed artifact) ──
const K = trained.eventForm.pit.k as { mu: number; sd: number; uMin?: number; uMax?: number; curve?: { kind: string; degree: number } };
if (K.uMin === undefined || K.uMax === undefined) throw new Error("the deployed pit.k curve carries NO stored fit domain");
const zOf = (r: number) => (r - K.mu) / K.sd;

// ── the RELEASE field ────────────────────────────────────────────────────────
// `date` is the catalog's authoritative release column (3669 of 3669 cards carry one). The launch
// bulk is a single day, 2026-03-13; everything after it is a post-launch release.
const LAUNCH = "2026-03-13";
const dateOf = (c: Card): string => String(c["date"] ?? "").trim();
type RelClass = "LAUNCH" | "PRE-JUNE" | "JUNE" | "JULY";
const relClass = (d: string): RelClass =>
  d === LAUNCH ? "LAUNCH" : d >= "2026-07-01" ? "JULY" : d >= "2026-06-01" ? "JUNE" : "PRE-JUNE";
const REL_ORDER: RelClass[] = ["LAUNCH", "PRE-JUNE", "JUNE", "JULY"];

// ── the OBSERVED CAPTURE WINDOW, parsed from the fixture header (never assumed) ──
const goldFmt = formatByLegacySlug(TIER)!;
const obsPath = captureObsPath(CAPTURE_DIR_2026_07_21, goldFmt, "pit");
const obsMeta = parseCwhitPit(readFileSync(obsPath, "utf8")).meta;
const WIN_FROM = obsMeta.coverageFrom ?? "?", WIN_TO = obsMeta.coverageTo ?? "?";
const inWindow = (d: string): boolean => WIN_FROM !== "?" && d >= WIN_FROM && d <= WIN_TO;

// ── LEAGUE TRAINING SUPPORT — VERBATIM from tools/centerpiece2-step0-domain.ts ──
const root = (trained as { datasetRoot?: string }).datasetRoot ?? "League Files";
const trWin = (trained as { window?: number[] }).window;
const minBF = (trained as { minPA?: number }).minPA ?? 1000;
const loaded = loadWindow(root, trWin && trWin.length ? trWin : undefined);
const tr = loaded.observations
  .filter((o) => o.pitch.BF >= minBF && Number.isFinite(o.ratings.pitch.stu))
  .map((o) => ({ z: zOf(o.ratings.pitch.stu), w: Math.pow(o.pitch.BF, 0.75) }))
  .sort((a, b) => a.z - b.z);
const wTot = tr.reduce((a, x) => a + x.w, 0);
const wq = (p: number) => { let acc = 0; for (const x of tr) { acc += x.w; if (acc >= p * wTot) return x.z; } return tr[tr.length - 1]?.z ?? NaN; };
const wBelow = (z: number) => tr.reduce((a, x) => a + (x.z < z ? x.w : 0), 0) / (wTot || 1);
const T05 = wq(0.05), T10 = wq(0.10);

// ── the gold tier's pool transform + cid → card map (the builder's own construction) ──
const win = QUICK.find((w) => w.tier === TIER)!;
const basePool = baseCards.filter((c) => inValueWindow(c, win));
const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), deps.envelope);
const byCid = new Map(opponentSet(baseCards, win, "pit").map((o) => [o.cid, o]));

/** Effective stuff — VERBATIM from step 0: per side through applyAffine (the exact argument ourPit
 *  feeds the curve), blended by the SAME platoon weights ourPit blends with. */
const effStu = (c: Card): number => {
  const hand = n_(c["Throws"]) === 2 ? "L" : n_(c["Throws"]) === 3 ? "S" : "R";
  const { wR, wL } = deps.pitExp.get(hand) ?? { wR: 0.5, wL: 0.5 };
  return wR * applyAffine(n_(c["Stuff vR"]), pt.pit.vR?.stu) + wL * applyAffine(n_(c["Stuff vL"]), pt.pit.vL?.stu);
};

// ── THE 91: gold's well-sampled pitchers, tagged three ways ─────────────────
interface G {
  rec: Rec; name: string; vlvl: number; bf: number;
  predK: number; obsK: number; predWoba: number; obsWoba: number; ra9: number;
  z: number; trainPctile: number;
  weak: boolean;            // below the league training p05 in effective stuff
  weak10: boolean;          // below p10 — the wider support class, reported alongside
  light: boolean;           // 600 <= BF < 1000 — the cards the higher bar removes
  date: string; rel: RelClass; inWin: boolean;
}
const gs: G[] = [];
for (const r of res.recs) {
  if (r.tier !== TIER || r.role !== "pit" || !wellSampled(r)) continue;
  const o = byCid.get(r.cid); if (!o) continue;
  if (!Number.isFinite(r.ours.k9) || !Number.isFinite(r.obs.k9!)) continue;
  const z = zOf(effStu(o.card));
  // A v5's release date is its BASE card's date — the variant is not separately dated in the catalog.
  const base = o.vlvl === 0 ? o.card : baseCards.find((b) => b["Card ID"] === o.cid.split("|")[0])!;
  const d = dateOf(base);
  gs.push({
    rec: r, name: cardName(o.card), vlvl: o.vlvl, bf: r.sample,
    predK: r.ours.k9!, obsK: r.obs.k9!, predWoba: r.ours.woba!, obsWoba: r.obs.woba!, ra9: r.raw.ra9 ?? NaN,
    z, trainPctile: 100 * wBelow(z), weak: z < T05, weak10: z < T10,
    light: r.sample < HIGH_BAR, date: d, rel: relClass(d), inWin: inWindow(d),
  });
}
gs.sort((a, b) => a.bf - b.bf);

/** Variance share: a calibration slope is variance-weighted, so a card's influence on the tier's
 *  slope goes as (pred - mean)^2. Computed on PREDICTED K9 about the 91-card mean — step 0's quantity. */
const mkAll = mean(gs.map((g) => g.predK));
const varOf = (g: G) => (g.predK - mkAll) ** 2;
const varTot = gs.reduce((a, g) => a + varOf(g), 0);
const vShare = (set: G[]) => 100 * set.reduce((a, g) => a + varOf(g), 0) / (varTot || 1);

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔═══ THE GOLD QUERY — low-support weak tail vs NEW RELEASES vs other ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | corpus ${res.source.kind === "capture" ? res.source.dir : "legacy"} | floor BF>=${res.floors.minBf}`);
console.log(`observed capture window (parsed from ${obsPath}): ${WIN_FROM}..${WIN_TO}`);
console.log(`catalog release field: \`date\`, launch bulk ${LAUNCH}; classes LAUNCH / PRE-JUNE (03-14..05-31) / JUNE / JULY`);
console.log(`support classes from the LEAGUE TRAINING weight (root '${root}', window ${JSON.stringify(trWin)}, BF>=${minBF}, weights BF^0.75, N obs ${tr.length}):`);
console.log(`  train p05 z = ${f(T05)}   train p10 z = ${f(T10)}   (effective stuff, own-gap applied, exposure-blended — step 0's coordinate)`);
console.log(`gold well-sampled pitchers at BF>=${LOW_BAR}: N = ${gs.length}   |  at BF>=${HIGH_BAR}: N = ${gs.filter((g) => !g.light).length}   |  drop-outs: ${gs.filter((g) => g.light).length}`);
console.log(`THIN RULE: any cell with N < ${THIN_N} carries NO verdict — "insufficient data", never "noise".`);
console.log(`v5 CAVEAT: a v5 row is its own card with its own ratings and usage, but its \`date\` is its BASE card's date.`);
console.log(`PERFORMANCE EVIDENCE ONLY — no price, cost, market or economy quantity is read anywhere in this tool.`);

// ═══ 1. THE 2x2 ══════════════════════════════════════════════════════════════
console.log(`\n╔═══ 1. THE 2x2 — {below training p05 vs not} x {lightly used 600<=BF<1000 vs heavily used BF>=1000} ═══╗`);
console.log(`  Card counts AND the share of gold's predicted-K VARIANCE each cell carries. A slope is`);
console.log(`  variance-weighted, so counts alone under-read a cell's influence on the need.`);
const cell = (weak: boolean, light: boolean) => gs.filter((g) => g.weak === weak && g.light === light);
console.log(`\n                      │  LIGHT 600<=BF<1000   │  HEAVY BF>=1000       │  row total`);
console.log(`  ────────────────────┼───────────────────────┼───────────────────────┼──────────────────`);
for (const weak of [true, false]) {
  const L = cell(weak, true), H = cell(weak, false), R = [...L, ...H];
  const cellStr = (s: G[]) => `n=${String(s.length).padStart(2)}  var ${f(vShare(s), 1).padStart(5)}%`;
  console.log(`  ${(weak ? "BELOW train p05" : "AT/ABOVE p05").padEnd(19)} │  ${cellStr(L).padEnd(21)}│  ${cellStr(H).padEnd(21)}│  ${cellStr(R)}`);
}
{
  const L = gs.filter((g) => g.light), H = gs.filter((g) => !g.light);
  console.log(`  ────────────────────┼───────────────────────┼───────────────────────┼──────────────────`);
  console.log(`  ${"col total".padEnd(19)} │  n=${String(L.length).padStart(2)}  var ${f(vShare(L), 1).padStart(5)}%    │  n=${String(H.length).padStart(2)}  var ${f(vShare(H), 1).padStart(5)}%    │  n=${gs.length}  var 100.0%`);
}
console.log(`\n  PER-CELL DETAIL (mean/median over the cell; THIN cells flagged)`);
console.log(`  cell                        n   var%    med BF   mean predK9  mean obsK9   mean z   med train pctile`);
for (const weak of [true, false]) for (const light of [true, false]) {
  const s = cell(weak, light);
  const lab = `${weak ? "sub-p05" : "supported"} x ${light ? "LIGHT" : "HEAVY"}`;
  if (!s.length) { console.log(`  ${lab.padEnd(26)} ${String(s.length).padStart(2)}   — empty cell`); continue; }
  console.log(`  ${lab.padEnd(26)} ${String(s.length).padStart(2)}  ${f(vShare(s), 1).padStart(5)}%  ${f(med(s.map((g) => g.bf)), 0).padStart(7)}  ${f(mean(s.map((g) => g.predK)), 2).padStart(10)}  ${f(mean(s.map((g) => g.obsK)), 2).padStart(10)}  ${f(mean(s.map((g) => g.z)), 2).padStart(7)}  ${f(med(s.map((g) => g.trainPctile)), 1).padStart(14)}%${s.length < THIN_N ? "  THIN" : ""}`);
}
console.log(`\n  THE POSED QUESTION, ANSWERED DIRECTLY: of the ${gs.filter((g) => g.weak).length} sub-p05 cards, ${cell(true, true).length} are lightly used and ${cell(true, false).length} are heavily used.`);
console.log(`  Of the ${gs.filter((g) => g.light).length} lightly-used cards, ${cell(true, true).length} are sub-p05 and ${cell(false, true).length} are not.`);
{
  // Independence check on the 2x2 — is the overlap more than the marginals alone predict?
  const a = cell(true, true).length, b = cell(true, false).length, c = cell(false, true).length, d2 = cell(false, false).length;
  const expect = (a + b) * (a + c) / (gs.length || 1);
  console.log(`  Expected sub-p05 & LIGHT under independence of the two margins: ${f(expect, 1)} vs observed ${a}.`);
  console.log(`  (2x2 = [${a}, ${b}; ${c}, ${d2}]; odds ratio ${f((a * d2) / ((b * c) || NaN), 2)} — descriptive, no test claimed at these counts.)`);
}
console.log(`\n  ALSO AT THE WIDER p10 SUPPORT BAR (step 0 reports both): sub-p10 n=${gs.filter((g) => g.weak10).length}, var ${f(vShare(gs.filter((g) => g.weak10)), 1)}%;`);
console.log(`  of those, ${gs.filter((g) => g.weak10 && g.light).length} lightly used / ${gs.filter((g) => g.weak10 && !g.light).length} heavily used.`);

// ═══ 2. THE DROP-OUT SET — the headline ══════════════════════════════════════
const drop = gs.filter((g) => g.light), keep = gs.filter((g) => !g.light);
console.log(`\n╔═══ 2. THE DROP-OUT SET — the ${drop.length} cards present at BF>=${LOW_BAR} and ABSENT at BF>=${HIGH_BAR} ═══╗`);
console.log(`  These cards, and only these, are what moves gold's need 1.78 -> 1.63. Everything about them.`);
console.log(`\n  #   card                              vlvl     BF   obsK9  predK9   resid   effStu z  trainPct  support   release     class     inWindow`);
drop.forEach((g, i) => {
  console.log(`  ${String(i + 1).padStart(2)}  ${g.name.slice(0, 30).padEnd(30)}  v${g.vlvl}  ${f(g.bf, 0).padStart(5)}  ${f(g.obsK, 2).padStart(6)}  ${f(g.predK, 2).padStart(6)}  ${f(g.predK - g.obsK, 2).padStart(6)}  ${f(g.z, 2).padStart(8)}  ${f(g.trainPctile, 1).padStart(6)}%  ${(g.weak ? "SUB-p05" : g.weak10 ? "sub-p10" : "ok").padEnd(8)}  ${g.date.padEnd(10)}  ${g.rel.padEnd(9)}  ${g.inWin ? "YES" : "-"}`);
});
console.log(`\n  DROP-OUT COMPOSITION`);
console.log(`    by RELEASE class : ${REL_ORDER.map((k) => `${k} ${drop.filter((g) => g.rel === k).length}`).join("  |  ")}`);
console.log(`    by SUPPORT class : sub-p05 ${drop.filter((g) => g.weak).length}  |  sub-p10 (incl p05) ${drop.filter((g) => g.weak10).length}  |  supported ${drop.filter((g) => !g.weak10).length}`);
console.log(`    released INSIDE the observation window ${WIN_FROM}..${WIN_TO}: ${drop.filter((g) => g.inWin).length}`);
console.log(`    variant split    : base v0 ${drop.filter((g) => g.vlvl === 0).length}  |  v5 ${drop.filter((g) => g.vlvl === 5).length}`);
console.log(`\n  DROP-OUTS vs RETAINED — the contrast that has to explain a 0.15 slope move`);
const cmp = (lab: string, fn: (g: G) => number) =>
  console.log(`    ${lab.padEnd(22)} drop-outs ${f(mean(drop.map(fn)), 2).padStart(8)} (SD ${f(sd(drop.map(fn)), 2)})   retained ${f(mean(keep.map(fn)), 2).padStart(8)} (SD ${f(sd(keep.map(fn)), 2)})`);
cmp("BF", (g) => g.bf); cmp("observed K9", (g) => g.obsK); cmp("predicted K9", (g) => g.predK);
cmp("residual pred-obs", (g) => g.predK - g.obsK); cmp("effective stuff z", (g) => g.z);
console.log(`    ${"K9 slope obs~pred".padEnd(22)} drop-outs ${f(slopeOf(drop.map((g) => g.predK), drop.map((g) => g.obsK)), 2).padStart(8)} (n=${drop.length})            retained ${f(slopeOf(keep.map((g) => g.predK), keep.map((g) => g.obsK)), 2).padStart(8)} (n=${keep.length})`);
console.log(`    ${"all 91".padEnd(22)} ${f(slopeOf(gs.map((g) => g.predK), gs.map((g) => g.obsK)), 2)}   (OLS on the same rows; the committed needs use mmse with a noise term, so these are close but not identical)`);
console.log(`\n  WHAT THE DROP-OUT SET CARRIES: ${f(vShare(drop), 1)}% of gold's predicted-K variance on ${drop.length} of ${gs.length} cards.`);
console.log(`  Within the drop-out set, its ${drop.filter((g) => g.weak).length} sub-p05 cards hold ${f(100 * vShare(drop.filter((g) => g.weak)) / (vShare(drop) || 1), 1)}% of that.`);

// ── 2b. LEAVE-OUT DECOMPOSITION — which drop-outs actually move the need? ────
// The 1.78 -> 1.63 move is caused by removing 23 cards at once. Removing them one TAG at a time says
// which tag carries the move, and does it WITHOUT resting on a single cell's count: each leave-out
// slope is computed over 73-91 cards. Slopes are OLS on (pred, obs) — the same rows the committed
// mmse needs are measured over, so the endpoints reproduce (all-91 1.78, heavy-only 1.63).
console.log(`\n╔═══ 2b. LEAVE-OUT DECOMPOSITION — which tag inside the drop-out set moves 1.78 -> 1.63? ═══╗`);
console.log(`  Each row REMOVES one tagged subset from the ${gs.length} and re-reads the slope. The tag that`);
console.log(`  reproduces the BF>=${HIGH_BAR} slope on its own is the tag that caused the move.`);
console.log(`\n  removed subset                              n removed   N left   slope   Δ vs 1.78 baseline`);
const base91 = slopeOf(gs.map((g) => g.predK), gs.map((g) => g.obsK));
const leaveOut = (lab: string, pred: (g: G) => boolean) => {
  const left = gs.filter((g) => !pred(g)), rm = gs.length - left.length;
  const s = slopeOf(left.map((g) => g.predK), left.map((g) => g.obsK));
  console.log(`  ${lab.padEnd(42)} ${String(rm).padStart(8)}   ${String(left.length).padStart(6)}   ${f(s, 2).padStart(5)}   ${f(s - base91, 2).padStart(6)}${rm < THIN_N ? "   (removed cell is THIN — read the Δ, not the cell)" : ""}`);
};
console.log(`  ${"(baseline: nothing removed)".padEnd(42)} ${String(0).padStart(8)}   ${String(gs.length).padStart(6)}   ${f(base91, 2).padStart(5)}   ${f(0, 2).padStart(6)}`);
leaveOut("ALL lightly used (the BF>=1000 bar)", (g) => g.light);
leaveOut("lightly used AND sub-p05", (g) => g.light && g.weak);
leaveOut("lightly used AND supported (>=p05)", (g) => g.light && !g.weak);
leaveOut("sub-p05, BOTH usage levels", (g) => g.weak);
leaveOut("all JULY-released", (g) => g.rel === "JULY");
leaveOut("all post-launch (PRE-JUNE/JUNE/JULY)", (g) => g.rel !== "LAUNCH");
leaveOut("released INSIDE the capture window", (g) => g.inWin);
leaveOut("lightly used AND post-launch", (g) => g.light && g.rel !== "LAUNCH");
leaveOut("lightly used AND LAUNCH-bulk", (g) => g.light && g.rel === "LAUNCH");
// The two tags are CORRELATED inside this small set, so the orthogonal contrasts are printed too:
// "post-launch with the weak tail taken out" isolates the RELEASE channel on its own.
leaveOut("lightly used, post-launch, SUPPORTED", (g) => g.light && g.rel !== "LAUNCH" && !g.weak);
leaveOut("lightly used, LAUNCH-bulk, sub-p05", (g) => g.light && g.rel === "LAUNCH" && g.weak);
console.log(`\n  TAG OVERLAP inside the drop-out set (why the orthogonal rows are needed):`);
console.log(`    lightly-used sub-p05 cards (${drop.filter((g) => g.weak).length}): ${drop.filter((g) => g.weak && g.rel !== "LAUNCH").length} post-launch / ${drop.filter((g) => g.weak && g.rel === "LAUNCH").length} launch-bulk`);
console.log(`    post-launch drop-outs (${drop.filter((g) => g.rel !== "LAUNCH").length}): ${drop.filter((g) => g.rel !== "LAUNCH" && g.weak).length} sub-p05 / ${drop.filter((g) => g.rel !== "LAUNCH" && !g.weak).length} supported`);

// ═══ 3. RELEASE-CLASS BREAKDOWN ══════════════════════════════════════════════
console.log(`\n╔═══ 3. RELEASE CLASS — all ${gs.length}, then each 2x2 cell ═══╗`);
console.log(`  A v5's date is its base card's date (stated again because it is load-bearing here).`);
console.log(`\n  ALL ${gs.length}`);
console.log(`  class      n   share    var%    med BF   mean obsK9  mean predK9  mean z   sub-p05   LIGHT   inWindow`);
for (const k of REL_ORDER) {
  const s = gs.filter((g) => g.rel === k);
  if (!s.length) { console.log(`  ${k.padEnd(9)}  0   — none`); continue; }
  console.log(`  ${k.padEnd(9)} ${String(s.length).padStart(2)}  ${f(100 * s.length / gs.length, 1).padStart(5)}%  ${f(vShare(s), 1).padStart(5)}%  ${f(med(s.map((g) => g.bf)), 0).padStart(7)}  ${f(mean(s.map((g) => g.obsK)), 2).padStart(10)}  ${f(mean(s.map((g) => g.predK)), 2).padStart(11)}  ${f(mean(s.map((g) => g.z)), 2).padStart(6)}  ${String(s.filter((g) => g.weak).length).padStart(7)}  ${String(s.filter((g) => g.light).length).padStart(6)}  ${String(s.filter((g) => g.inWin).length).padStart(8)}${s.length < THIN_N ? "   THIN" : ""}`);
}
console.log(`\n  PER 2x2 CELL`);
console.log(`  cell                        n   ${REL_ORDER.map((k) => k.padStart(9)).join(" ")}    inWindow`);
for (const weak of [true, false]) for (const light of [true, false]) {
  const s = cell(weak, light);
  const lab = `${weak ? "sub-p05" : "supported"} x ${light ? "LIGHT" : "HEAVY"}`;
  console.log(`  ${lab.padEnd(26)} ${String(s.length).padStart(2)}   ${REL_ORDER.map((k) => String(s.filter((g) => g.rel === k).length).padStart(9)).join(" ")}    ${String(s.filter((g) => g.inWin).length).padStart(8)}${s.length < THIN_N ? "   THIN" : ""}`);
}
console.log(`\n  DOES RELEASE RECENCY TRACK USAGE? (the mechanism a new-release world needs)`);
for (const k of REL_ORDER) {
  const s = gs.filter((g) => g.rel === k);
  if (!s.length) continue;
  console.log(`    ${k.padEnd(9)} n=${String(s.length).padStart(2)}   med BF ${f(med(s.map((g) => g.bf)), 0).padStart(5)}   share LIGHT ${f(100 * s.filter((g) => g.light).length / s.length, 0).padStart(3)}%${s.length < THIN_N ? "   THIN" : ""}`);
}
{
  const post = gs.filter((g) => g.rel !== "LAUNCH");
  console.log(`    post-launch overall: n=${post.length}, med BF ${f(med(post.map((g) => g.bf)), 0)}, share LIGHT ${f(100 * post.filter((g) => g.light).length / (post.length || 1), 0)}%`);
  const launch = gs.filter((g) => g.rel === "LAUNCH");
  console.log(`    launch bulk       : n=${launch.length}, med BF ${f(med(launch.map((g) => g.bf)), 0)}, share LIGHT ${f(100 * launch.filter((g) => g.light).length / (launch.length || 1), 0)}%`);
}
console.log(`\n  RELEASED INSIDE THE OBSERVATION WINDOW ${WIN_FROM}..${WIN_TO} — the cards that PHYSICALLY`);
console.log(`  could not accumulate a full line, listed individually because that is the censoring case:`);
{
  const iw = gs.filter((g) => g.inWin).sort((a, b) => b.bf - a.bf);
  if (!iw.length) console.log(`    none`);
  for (const g of iw)
    console.log(`    ${g.name.slice(0, 28).padEnd(28)} v${g.vlvl}  BF ${f(g.bf, 0).padStart(5)}  ${g.light ? "LIGHT" : "HEAVY"}  predK9 ${f(g.predK, 2)}  obsK9 ${f(g.obsK, 2)}  z ${f(g.z, 2).padStart(6)}  ${g.date}  ${g.weak ? "SUB-p05" : "supported"}`);
  console.log(`    ⇒ ${iw.filter((g) => !g.light).length} of ${iw.length} in-window releases ALREADY clear BF>=${HIGH_BAR}, so "released inside the window" does not imply "short-lined".`);
}

console.log(`\n  THE ELITE-HIGH-K END — where a censoring story would have to live`);
console.log(`  (top decile of the ${gs.length} by PREDICTED K9; a new elite card that cannot yet have a full line is the censoring case)`);
{
  const byPred = [...gs].sort((a, b) => b.predK - a.predK);
  const topN = Math.max(1, Math.round(gs.length * 0.10));
  const top = byPred.slice(0, topN);
  console.log(`    n=${top.length}  var ${f(vShare(top), 1)}%  |  release ${REL_ORDER.map((k) => `${k} ${top.filter((g) => g.rel === k).length}`).join(" / ")}  |  LIGHT ${top.filter((g) => g.light).length}  |  inWindow ${top.filter((g) => g.inWin).length}${top.length < THIN_N ? "   THIN" : ""}`);
  for (const g of top) console.log(`      ${g.name.slice(0, 28).padEnd(28)} v${g.vlvl}  BF ${f(g.bf, 0).padStart(5)}  predK9 ${f(g.predK, 2)}  obsK9 ${f(g.obsK, 2)}  z ${f(g.z, 2).padStart(6)}  ${g.date}  ${g.rel}${g.light ? "  LIGHT" : ""}`);
}

// ═══ 4. COMPANION — level residuals of the heavily-played LOW-K cards ═══════
console.log(`\n╔═══ 4. COMPANION — level residuals (predicted MINUS observed) of gold's HEAVILY-PLAYED LOW-K cards ═══╗`);
console.log(`  Revealed preference via PERFORMANCE ONLY. Heavy play is how the field votes; the residual is`);
console.log(`  whether those cards then out-perform our prediction. On K9 a NEGATIVE residual = the card`);
console.log(`  struck out MORE than we predicted. On allowed wOBA a POSITIVE residual = the card allowed`);
console.log(`  LESS than we predicted, i.e. out-performed. Nothing here reads price, cost or market data.`);
{
  const heavy = keep;
  const byPred = [...heavy].sort((a, b) => a.predK - b.predK);
  const cut = Math.max(1, Math.round(heavy.length / 3));
  const groups: [string, G[]][] = [
    [`low-K tertile by PREDICTED K9`, byPred.slice(0, cut)],
    [`mid tertile`, byPred.slice(cut, heavy.length - cut)],
    [`high-K tertile`, byPred.slice(heavy.length - cut)],
  ];
  console.log(`\n  heavily played = BF>=${HIGH_BAR} (n=${heavy.length}); tertiles on PREDICTED K9 — the model's own valuation`);
  console.log(`  group                            n   med BF   predK9  obsK9  resid K9   pred wOBAA  obs wOBAA  resid wOBAA   obs RA9`);
  for (const [lab, s] of groups) {
    console.log(`  ${lab.padEnd(30)} ${String(s.length).padStart(3)}  ${f(med(s.map((g) => g.bf)), 0).padStart(6)}  ${f(mean(s.map((g) => g.predK)), 2).padStart(7)}  ${f(mean(s.map((g) => g.obsK)), 2).padStart(5)}  ${f(mean(s.map((g) => g.predK - g.obsK)), 2).padStart(8)}  ${f(mean(s.map((g) => g.predWoba)), 4).padStart(10)}  ${f(mean(s.map((g) => g.obsWoba)), 4).padStart(9)}  ${f(mean(s.map((g) => g.predWoba - g.obsWoba)), 4).padStart(11)}  ${f(mean(s.map((g) => g.ra9)), 2).padStart(7)}${s.length < THIN_N ? "  THIN" : ""}`);
  }
  console.log(`\n  THE SAME CUT ON OBSERVED K9 (so the tertile is not defined by the quantity under test)`);
  const byObs = [...heavy].sort((a, b) => a.obsK - b.obsK);
  const g2: [string, G[]][] = [
    [`low-K tertile by OBSERVED K9`, byObs.slice(0, cut)],
    [`mid tertile`, byObs.slice(cut, heavy.length - cut)],
    [`high-K tertile`, byObs.slice(heavy.length - cut)],
  ];
  console.log(`  group                            n   med BF   predK9  obsK9  resid K9   pred wOBAA  obs wOBAA  resid wOBAA   obs RA9`);
  for (const [lab, s] of g2) {
    console.log(`  ${lab.padEnd(30)} ${String(s.length).padStart(3)}  ${f(med(s.map((g) => g.bf)), 0).padStart(6)}  ${f(mean(s.map((g) => g.predK)), 2).padStart(7)}  ${f(mean(s.map((g) => g.obsK)), 2).padStart(5)}  ${f(mean(s.map((g) => g.predK - g.obsK)), 2).padStart(8)}  ${f(mean(s.map((g) => g.predWoba)), 4).padStart(10)}  ${f(mean(s.map((g) => g.obsWoba)), 4).padStart(9)}  ${f(mean(s.map((g) => g.predWoba - g.obsWoba)), 4).padStart(11)}  ${f(mean(s.map((g) => g.ra9)), 2).padStart(7)}${s.length < THIN_N ? "  THIN" : ""}`);
  }
  console.log(`\n  THE MOST-PLAYED LOW-K CARDS INDIVIDUALLY (bottom OBSERVED-K9 tertile of the heavy set, by BF desc, top 12)`);
  console.log(`    card                          vlvl     BF   predK9  obsK9  resid   pred wOBAA  obs wOBAA  resid   obs RA9  release     class`);
  for (const g of byObs.slice(0, cut).sort((a, b) => b.bf - a.bf).slice(0, 12))
    console.log(`    ${g.name.slice(0, 28).padEnd(28)}  v${g.vlvl}  ${f(g.bf, 0).padStart(5)}  ${f(g.predK, 2).padStart(6)}  ${f(g.obsK, 2).padStart(5)}  ${f(g.predK - g.obsK, 2).padStart(6)}  ${f(g.predWoba, 4).padStart(10)}  ${f(g.obsWoba, 4).padStart(9)}  ${f(g.predWoba - g.obsWoba, 4).padStart(7)}  ${f(g.ra9, 2).padStart(7)}  ${g.date.padEnd(10)}  ${g.rel}`);
}

console.log(`\n(end of the gold query — measurement only; nothing fitted, no default moved)`);
console.log(``);
process.exit(0);
