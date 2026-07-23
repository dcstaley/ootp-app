// COHORT × CHANNEL vs REALIZED OPPOSITION — the generalized (c) report (Fable directive, 2026-07-23).
//   run: node tools/cohort-channel-groundtruth.ts > fixtures/cohort-channel-groundtruth-2026-07-23.txt
//
// MEASUREMENT ONLY. Read-only; nothing fitted, nothing wired. The cohort-event STOP proved that a
// single-cohort single-channel-mean coordinate cannot be data-fixed AND per-channel identifiable at
// once (the whole-vector z-sum broke K's kRat ordering; model-woba's kRat ordering was itself a
// coincidence of wOBA weighting). So the question is no longer "which cohort rule" but, per
// POOL × CHANNEL, WHICH CONSTRUCTION BEST TRACKS THE REALIZED OPPOSITION — the field a card actually
// faced. That realized field is the GROUND TRUTH the frame's opposing-channel mean is trying to
// estimate, and this report measures every candidate against it.
//
// THE GROUND TRUTH: the usage(PA/BF)-weighted mean of a channel over the cards ACTUALLY PLAYED in the
// pool (from the capture corpus — Rec.sample is opponents-faced, the correct weight). This is the
// opposition a card in the pool met, by construction.
//
// THE CANDIDATES (each a top-FIELD_N cohort of the eligible pool, unweighted channel mean):
//   · model-woba       — top-N by the model's predicted wOBA (the shipped rule; kRat-ordered by luck)
//   · zsum-catalog      — top-N by the model-free whole-vector z-sum (data-fixed; kRat-UNORDERED)
//   · channel-specific  — top-N by THIS channel's own rating (the naive per-channel estimator)
//   · realized-usage    — top-N by realized usage itself (what actually got played, truncated to N)
// The realized-usage cohort is a bridge: it is selected the way the ground truth is weighted, so its
// gap to the ground truth isolates the top-N TRUNCATION from the SELECTION-metric error.
//
// OUTPUT = the composition layer's empirical foundation (which estimator tracks realized opposition,
// per channel) AND the first data for the promoted matchup-structure audit (how far the realized
// field is from any rating-cohort proxy at all).

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, cardSideWobas, buildCohortRefs, cohortZSum, FIELD_N,
  type EventForm, type RatingEnvelope, type WobaWeights, type TrainingMeans, type Coeffs,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, buildCwhitSample, isPit, n_, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { opponentSet, realizedUsage, cellKey } from "../src/eval/cwhit/realized.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp2 = (s: string, n: number) => s.padStart(n);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
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
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const refs = buildCohortRefs(baseCards, coeffs, rp, true);

// ── channels + their CSV columns (side-pooled, matching ratingStats) ──
const HIT_CH: [string, string][] = [["eye", "Eye"], ["pow", "Power"], ["kRat", "Avoid K"], ["babip", "BABIP"], ["gap", "Gap"]];
const PIT_CH: [string, string][] = [["con", "Control"], ["stu", "Stuff"], ["pbabip", "pBABIP"], ["hrr", "pHR"]];
/** Side-pooled channel values for a card (both vR and vL, 0 excluded — the ratingStats convention). */
const chVals = (c: Card, col: string): number[] => [n_(c[`${col} vR`]), n_(c[`${col} vL`])].filter((x) => x > 0);
const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
/** z-sum of a card for a role, both sides summed (the metric computeUnifiedFieldStats ranks by). */
const zsumCard = (c: Card, role: "pit" | "hit"): number => {
  const ref = role === "pit" ? refs.pit : refs.hit, chs = role === "pit" ? PIT_CH : HIT_CH;
  let z = 0;
  for (const s of ["vR", "vL"] as const) {
    const rat: Record<string, number> = {};
    for (const [k, col] of chs) rat[k] = n_(c[`${col} ${s}`]);
    z += cohortZSum(rat, ref);
  }
  return z;
};
/** model wOBA for ranking (side-summed; pitchers lower=better so negate for a uniform "higher=stronger"). */
const wobaCard = (c: Card, role: "pit" | "hit"): number => {
  const w = cardSideWobas(c as any, coeffs, rp);
  return role === "pit" ? -((w.pitVR ?? 0) + (w.pitVL ?? 0)) : (w.hitVR ?? 0) + (w.hitVL ?? 0);
};

say("################################################################################");
say("# COHORT × CHANNEL vs REALIZED OPPOSITION — the generalized (c) report.  MEASUREMENT ONLY.");
say("# tools/cohort-channel-groundtruth.ts. Nothing wired. Ground truth = usage-weighted realized field.");
say("################################################################################");
say();
say(`  model '${trained.id}'  catalog '${srcId}'  FIELD_N ${FIELD_N}  corpus = full-depth 2026-07-21`);
say();
say("  For each POOL (Quick tier) × ROLE × CHANNEL: the realized-opposition mean (usage-weighted over");
say("  cards actually played) and each candidate cohort's unweighted channel mean, as a BIAS vs truth.");
say("  |bias| smallest = best tracker. ★ marks the winner per row.");
say();

// ── build the realized sample once ──
const ref0 = (await import("../src/scoring-core/index.ts")).productionFieldStats(baseCards, coeffs, rp);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW, ref: ref0,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const sample = buildCwhitSample(deps);
const usage = realizedUsage(sample);

interface Cell { tier: string; role: "pit" | "hit"; ch: string; truth: number; woba: number; zsum: number; chan: number; real: number; nPlayed: number; winner: string }
const cells: Cell[] = [];

for (const win of QUICK) {
  for (const role of ["hit", "pit"] as const) {
    const chs = role === "pit" ? PIT_CH : HIT_CH;
    const opps = opponentSet(baseCards, win, role);
    const u = usage.get(cellKey(win.tier, role)) ?? new Map<string, number>();
    // played = opponents with realized usage > 0
    const played = opps.filter((o) => (u.get(o.cid) ?? 0) > 0);
    // candidate cohorts: top-FIELD_N of the eligible pool by each metric (distinct cids)
    const topBy = (score: (o: typeof opps[number]) => number) => [...opps].sort((a, b) => score(b) - score(a)).slice(0, FIELD_N);
    const cohWoba = topBy((o) => wobaCard(o.card, role));
    const cohZsum = topBy((o) => zsumCard(o.card, role));
    const cohReal = topBy((o) => u.get(o.cid) ?? 0);
    for (const [k, col] of chs) {
      // ground truth: usage-weighted mean of the channel over played cards
      let wsum = 0, wtot = 0;
      for (const o of played) { const w = u.get(o.cid)!; const vs = chVals(o.card, col); for (const v of vs) { wsum += w * v; wtot += w; } }
      const truth = wtot > 0 ? wsum / wtot : NaN;
      const cohMean = (coh: typeof opps) => meanOf(coh.flatMap((o) => chVals(o.card, col)));
      const chanCoh = topBy((o) => meanOf(chVals(o.card, col)));
      const woba = cohMean(cohWoba), zsum = cohMean(cohZsum), chan = cohMean(chanCoh), real = cohMean(cohReal);
      const cands: [string, number][] = [["woba", woba], ["zsum", zsum], ["chan", chan], ["real", real]];
      const winner = cands.filter(([, v]) => Number.isFinite(v)).sort((a, b) => Math.abs(a[1] - truth) - Math.abs(b[1] - truth))[0]?.[0] ?? "n/a";
      cells.push({ tier: win.tier, role, ch: k, truth, woba, zsum, chan, real, nPlayed: played.length, winner });
    }
  }
}

// ── report: per role×channel, the per-tier bias of each construction ──
for (const role of ["hit", "pit"] as const) {
  const chs = role === "pit" ? PIT_CH : HIT_CH;
  say(`### ${role.toUpperCase()} CHANNELS — the field ${role === "hit" ? "a PITCHER faces (its gap reads these)" : "a HITTER faces"}`);
  say();
  for (const [k] of chs) {
    say(`  ${role}.${k}  (bias = cohort mean − realized truth)`);
    say(`    tier      truth   woba(bias)     zsum(bias)     chan(bias)     real(bias)    best`);
    for (const win of QUICK) {
      const c = cells.find((x) => x.tier === win.tier && x.role === role && x.ch === k)!;
      const cell = (v: number) => `${rp2(f(v), 5)}(${sgn(v - c.truth)})`;
      const star = (n: string) => (c.winner === n ? "★" : " ");
      say(`    ${pad(win.tier, 8)} ${rp2(f(c.truth), 6)}  ${star("woba")}${cell(c.woba)}  ${star("zsum")}${cell(c.zsum)}  ${star("chan")}${cell(c.chan)}  ${star("real")}${cell(c.real)}   ${c.winner}`);
    }
    // cross-tier ordering: does each construction order tiers like the truth?
    const tiers = QUICK.map((w) => cells.find((x) => x.tier === w.tier && x.role === role && x.ch === k)!);
    const ord = (get: (c: Cell) => number) => tiers.map(get);
    const kendallish = (a: number[], b: number[]) => { let ok = 0, tot = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) { tot++; if (Math.sign(a[i]! - a[j]!) === Math.sign(b[i]! - b[j]!)) ok++; } return tot ? ok / tot : NaN; };
    const t = ord((c) => c.truth);
    say(`    tier-ordering agreement with truth:  woba ${f(kendallish(ord((c) => c.woba), t) * 100, 0)}%  zsum ${f(kendallish(ord((c) => c.zsum), t) * 100, 0)}%  chan ${f(kendallish(ord((c) => c.chan), t) * 100, 0)}%  real ${f(kendallish(ord((c) => c.real), t) * 100, 0)}%`);
    say();
  }
}

// ── headline: win counts + the matchup-structure signal ──
say("### HEADLINE");
say();
const winCount: Record<string, number> = { woba: 0, zsum: 0, chan: 0, real: 0 };
for (const c of cells) if (winCount[c.winner] !== undefined) winCount[c.winner]!++;
say(`  BEST-TRACKER WIN COUNTS over ${cells.length} pool×channel cells: ${Object.entries(winCount).map(([k, v]) => `${k} ${v}`).join("  ")}`);
say(`  The realized-usage cohort's residual to the truth is the top-N TRUNCATION error (same weighting,`);
say(`  N-truncated); any rating cohort beating it there is fitting noise. A rating cohort LOSING to`);
say(`  'real' by a lot is the MATCHUP-STRUCTURE signal — the realized field is not a rating-cohort proxy.`);
say(`  The K channel (hit.kRat) vs the HR channel (hit.pow) contrast is the STOP made empirical: read`);
say(`  their tier-ordering-agreement rows — pow should track, kRat should not, under woba AND zsum.`);
say();
say("(end of artifact — cohort × channel ground truth)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
