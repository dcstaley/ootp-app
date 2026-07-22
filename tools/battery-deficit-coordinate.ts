// ═══ PROPERTY BATTERY — ITEM 1: THE COMPUTED-DEFICIT COORDINATE ══════════════
//
// PER-OPPONENT INTEGRATION (Fable ruling, 2026-07-21). For each card i the model's one-sided
// prediction is evaluated once PER OPPOSING CARD j, with each channel shifted by that opponent's
// OWN rating instead of by the pool mean:
//
//     shift(channel of i) = mu_train_opp(paired channel) − r_j(paired channel)
//
// using buildFrameShift's channel map (pit.con←hit.eye, pit.stu←hit.kRat, pit.hrr←hit.pow,
// pit.pbabip←hit.babip; mirrored for hitters, with hit.gap also ←pit.pbabip). The card's line is the
// average over opponents; the pool's predicted spread is the SD across cards of those
// opponent-averaged lines.
//
// WHY THIS IS NOT THE EXISTING MACHINERY. The scalar path shifts by (mu_train_opp − mu_pool_opp) —
// it collapses the opponents to their MEAN before predicting. Since mean_j(shift) = mu_train_opp −
// mu_pool_opp exactly, this is a strict GENERALISATION: evaluating at the mean shift reproduces the
// scalar path, and the gap between the two is the curvature term over the opponent distribution.
// That degenerate identity is pinned in tests/battery-deficit.test.ts — if it ever breaks, this tool
// is measuring something other than what it claims.
//
// NO TWO-SIDED MODEL is used or implied; there is no interaction term anywhere in the core, so this
// construction carries curvature-mediated heterogeneous response, NOT matchup structure.
//
// POOLS ARE COMPLETE ENVIRONMENTS: every eligible card of the opposing role is an opponent.
// Weighting is EX-ANTE (eligible-pool uniform) — the production candidate per ruling 3. A realized-
// usage weighting is a separate run; a usage proxy would become a named dependency only if
// validation demanded it.
//
// MEASUREMENT ONLY. Nothing here fits, ships, or proposes a form.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived, computeUnifiedFieldStats,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, isPit, n_, buildCwhitSample, FIELD_N, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { opponentSet, realizedUsage, coverage, weightsFor, cellKey, type Opponent } from "../src/eval/cwhit/realized.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
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

// ── REALIZED-USAGE WEIGHTING (opt-in: `--realized`) ──────────────────────────
//
// DEFAULT (no flag) IS UNCHANGED AND BIT-IDENTICAL to the pre-flag tool: every eligible opposing card
// is an opponent, weighted UNIFORMLY (the ex-ante production candidate, ruling 3).
//
// WITH `--realized` the average over opponents becomes a WEIGHTED average whose weight is that
// opponent's REALIZED USAGE — observed PA (hitter opponents) / IP (pitcher opponents) in the same five
// Quick tiers' capture tables. An eligible card with no observed row carries weight 0: it did not play.
// This exists because the realized opposing field was measured to differ from the eligible-pool field
// by 0.18–1.36 pool-SD, so uniform weighting may be integrating over the wrong opponent distribution.
//
// EXACTLY ONE THING MOVES. The crossed-channel shift, the frame-conditions baseline, the SCALAR CONTROL
// and the ratio definition are untouched. Note the consequence for the scalar column: it collapses
// opponents to their UNIFORM mean, so it is IDENTICAL in both runs by construction — and therefore the
// degenerate identity documented at the top of this file (scalar == integration evaluated at the mean
// shift) relates the scalar to the UNIFORM integration only, not to the realized one. That is a
// reporting caveat, not a defect: the control is deliberately held fixed across the two weightings.
//
// VARIANTS ARE IN (fixed 2026-07-21 — this is the blocking battery correction). The first version of
// this flag read the capture tables with a private parse restricted to observed `VLvl == 0`, which
// discarded 25.5% of all observed play, concentrated in the best cards: the "realized field" it
// integrated over was itself materially wrong. Weights now come from `src/eval/cwhit/realized.ts`,
// which reads them off the BUILDER's join (`Rec.cid`) — so base and v5 are separate opponents with
// their own ratings and their own usage, exactly as they are on the field. See that file's header for
// why the ELIGIBLE side is deliberately left non-variant (it mirrors production's `basePool`).
const REALIZED = process.argv.includes("--realized");

// Built ONLY under --realized, so the default path does no extra work and stays bit-identical.
// `buildCwhitSample` is the program's one sample builder: it joins base and v5 separately on the
// event-space fingerprint (from the UNCORRECTED line, ruling B) and hands back `Rec.cid` identities.
let usage: Map<string, Map<string, number>> | null = null;
const oppSets = new Map<string, Opponent[]>();
if (REALIZED) {
  if (!trained.platoon) throw new Error("active model has no platoon exposures — buildCwhitSample cannot run");
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp);
  const deps: SampleDeps = {
    baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
    envelope: trained.ratingEnvelope,
    pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
    hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
  };
  const res = buildCwhitSample(deps);
  for (const n of res.notices) console.log(`  [builder] ${n}`);
  usage = realizedUsage(res);
  for (const win of QUICK) for (const role of ["pit", "hit"] as const)
    oppSets.set(cellKey(win.tier, role), opponentSet(baseCards, win, role));
}

console.log(`\n╔═══ BATTERY ITEM 1 — COMPUTED-DEFICIT COORDINATE (per-opponent integration) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | ${REALIZED ? "REALIZED-USAGE weighting (--realized): opponents weighted by observed PA/IP" : "eligible-pool UNIFORM weighting (the ex-ante production candidate)"}`);
console.log(REALIZED
  ? `opponent field = the REALIZED one: eligible cards with no observed VLvl-0 row carry weight 0.`
  : `pools are COMPLETE ENVIRONMENTS: every eligible card of the opposing role is an opponent.`);

const HIT_COL = { eye: "Eye vR", pow: "Power vR", kRat: "Avoid K vR", babip: "BABIP vR", gap: "Gap vR" } as const;
const PIT_COL = { con: "Control vR", stu: "Stuff vR", hrr: "pHR vR", pbabip: "pBABIP vR" } as const;
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};

interface Cell { tier: string; role: "pit" | "hit"; n: number; nOpp: number; ratio: Record<string, number>; scalar?: Record<string, number> }
const cells: Cell[] = [];

for (const win of QUICK) {
  const pool = baseCards.filter((c) => inValueWindow(c, win));
  const pits = pool.filter((c) => isPit(c));
  const hits = pool.filter((c) => !isPit(c));

  // ---- PITCHERS integrated over this pool's hitters ----
  {
    // THE OPPONENT LIST. Uniform: the eligible BASE pool — production's `basePool`, where variants are
    // scored but do not set the distribution. Realized: every eligible card at BOTH variant levels,
    // because a v5 that played is a distinct opponent carrying distinct (boosted) ratings.
    const oppE: Opponent[] = REALIZED
      ? oppSets.get(cellKey(win.tier, "hit"))!
      : hits.map((c) => ({ cid: "", card: c, vlvl: 0 }));
    const rateH = (h: Record<string, unknown>) => ({ eye: n_(h[HIT_COL.eye]), kRat: n_(h[HIT_COL.kRat]), pow: n_(h[HIT_COL.pow]), babip: n_(h[HIT_COL.babip]) });
    const opp = oppE.map((e) => rateH(e.card));
    // Aligned by index with `opp`. `null` ⇒ the uniform default path, which is left literally untouched
    // below so it stays bit-identical rather than "1×-identical".
    const oppW = REALIZED ? weightsFor(oppE, usage!.get(cellKey(win.tier, "hit"))) : null;
    // THE CONTROL: the SCALAR path — opponents collapsed to their mean, one prediction per card.
    // The difference between this and the per-opponent integration IS the curvature term, and it is
    // the only thing that distinguishes item 1 from machinery the program already had.
    // Computed over the BASE pool in BOTH runs: it is a control, held fixed across the weightings.
    const oppCtl = REALIZED ? hits.map(rateH) : opp;
    const mu = (k: keyof typeof opp[0]) => oppCtl.reduce((a, o) => a + o[k], 0) / (oppCtl.length || 1);
    const muO = { eye: mu("eye"), kRat: mu("kRat"), pow: mu("pow"), babip: mu("babip") };
    const poolCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    const frameCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    const scalarCh: Record<string, number[]> = { k9: [], bb9: [], hr9: [], babip: [] };
    for (const p of pits) {
      const b = { con: n_(p[PIT_COL.con]), stu: n_(p[PIT_COL.stu]), hrr: n_(p[PIT_COL.hrr]), pbabip: n_(p[PIT_COL.pbabip]) };
      let sK = 0, sB = 0, sH = 0, sBab = 0, sW = 0;
      for (let j = 0; j < opp.length; j++) {
        const o = opp[j]!;
        const wj = oppW ? oppW[j]! : 1;
        if (oppW && wj === 0) continue;   // did not play — contributes nothing
        const e = rp.predictPitching({
          con: b.con + ((TM.hit["eye"] ?? 0) - o.eye),
          stu: b.stu + ((TM.hit["kRat"] ?? 0) - o.kRat),
          hrr: b.hrr + ((TM.hit["pow"] ?? 0) - o.pow),
          pbabip: b.pbabip + ((TM.hit["babip"] ?? 0) - o.babip),
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.K - e.HR, 1);
        if (oppW) { sK += wj * e.K; sB += wj * e.BB; sH += wj * e.HR; sBab += wj * (e.nHH / bip); sW += wj; }
        else { sK += e.K; sB += e.BB; sH += e.HR; sBab += e.nHH / bip; }
      }
      const m = oppW ? sW : (opp.length || 1);
      poolCh["k9"]!.push(sK / m); poolCh["bb9"]!.push(sB / m); poolCh["hr9"]!.push(sH / m); poolCh["babip"]!.push(sBab / m);
      // FRAME conditions = the model's own training frame, i.e. no re-basing at all.
      const f = rp.predictPitching(b, coeffs);
      const fb = Math.max(600 - f.BB - f.K - f.HR, 1);
      frameCh["k9"]!.push(f.K); frameCh["bb9"]!.push(f.BB); frameCh["hr9"]!.push(f.HR); frameCh["babip"]!.push(f.nHH / fb);
      const sc = rp.predictPitching({
        con: b.con + ((TM.hit["eye"] ?? 0) - muO.eye), stu: b.stu + ((TM.hit["kRat"] ?? 0) - muO.kRat),
        hrr: b.hrr + ((TM.hit["pow"] ?? 0) - muO.pow), pbabip: b.pbabip + ((TM.hit["babip"] ?? 0) - muO.babip),
      }, coeffs);
      const scb = Math.max(600 - sc.BB - sc.K - sc.HR, 1);
      scalarCh["k9"]!.push(sc.K); scalarCh["bb9"]!.push(sc.BB); scalarCh["hr9"]!.push(sc.HR); scalarCh["babip"]!.push(sc.nHH / scb);
    }
    const ratio: Record<string, number> = {}, scalar: Record<string, number> = {};
    for (const k of Object.keys(poolCh)) {
      const pl = sd(poolCh[k]!), sc = sd(scalarCh[k]!), fr = sd(frameCh[k]!);
      ratio[k] = pl > 0 ? fr / pl : NaN; scalar[k] = sc > 0 ? fr / sc : NaN;
    }
    cells.push({ tier: win.tier, role: "pit", n: pits.length, nOpp: hits.length, ratio, scalar });
  }

  // ---- HITTERS integrated over this pool's pitchers ----
  {
    const oppE: Opponent[] = REALIZED
      ? oppSets.get(cellKey(win.tier, "pit"))!
      : pits.map((c) => ({ cid: "", card: c, vlvl: 0 }));
    const opp = oppE.map((e) => ({ con: n_(e.card[PIT_COL.con]), stu: n_(e.card[PIT_COL.stu]), hrr: n_(e.card[PIT_COL.hrr]), pbabip: n_(e.card[PIT_COL.pbabip]) }));
    const oppW = REALIZED ? weightsFor(oppE, usage!.get(cellKey(win.tier, "pit"))) : null;
    const poolCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    const frameCh: Record<string, number[]> = { so: [], bb: [], hr: [], babip: [] };
    for (const h of hits) {
      const b = {
        eye: n_(h[HIT_COL.eye]), pow: n_(h[HIT_COL.pow]), kRat: n_(h[HIT_COL.kRat]),
        babip: n_(h[HIT_COL.babip]), gap: n_(h[HIT_COL.gap]),
        speed: n_(h["Speed"]), steal: n_(h["Stealing"]), run: n_(h["Baserunning"]),
      };
      let sSO = 0, sBB = 0, sHR = 0, sBab = 0, sW = 0;
      for (let j = 0; j < opp.length; j++) {
        const o = opp[j]!;
        const wj = oppW ? oppW[j]! : 1;
        if (oppW && wj === 0) continue;   // did not play — contributes nothing
        const e = rp.predictHitting({
          eye: b.eye + ((TM.pit["con"] ?? 0) - o.con),
          kRat: b.kRat + ((TM.pit["stu"] ?? 0) - o.stu),
          pow: b.pow + ((TM.pit["hrr"] ?? 0) - o.hrr),
          babip: b.babip + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          gap: b.gap + ((TM.pit["pbabip"] ?? 0) - o.pbabip),
          speed: b.speed, steal: b.steal, run: b.run,
        }, coeffs);
        const bip = Math.max(600 - e.BB - e.SO - e.HR, 1);
        if (oppW) { sSO += wj * e.SO; sBB += wj * e.BB; sHR += wj * e.HR; sBab += wj * ((e.oneB + e.GAP) / bip); sW += wj; }
        else { sSO += e.SO; sBB += e.BB; sHR += e.HR; sBab += (e.oneB + e.GAP) / bip; }
      }
      const m = oppW ? sW : (opp.length || 1);
      poolCh["so"]!.push(sSO / m); poolCh["bb"]!.push(sBB / m); poolCh["hr"]!.push(sHR / m); poolCh["babip"]!.push(sBab / m);
      const f = rp.predictHitting(b, coeffs);
      const fb = Math.max(600 - f.BB - f.SO - f.HR, 1);
      frameCh["so"]!.push(f.SO); frameCh["bb"]!.push(f.BB); frameCh["hr"]!.push(f.HR); frameCh["babip"]!.push((f.oneB + f.GAP) / fb);
    }
    const ratio: Record<string, number> = {};
    for (const k of Object.keys(poolCh)) { const pl = sd(poolCh[k]!); ratio[k] = pl > 0 ? sd(frameCh[k]!) / pl : NaN; }
    cells.push({ tier: win.tier, role: "hit", n: hits.length, nOpp: pits.length, ratio });
  }
  console.log(`  … ${win.tier} done (${pits.length} pit × ${hits.length} hit)`);
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3).padStart(8) : "     n/a");
if (REALIZED) {
  console.log(`\n── REALIZED-WEIGHT COVERAGE (weights read off the BUILDER's join, keyed by cid = CardID|VLvl) ──`);
  console.log(`   VARIANTS ARE INCLUDED: base (VLvl 0) and v5 are SEPARATE opponents with their own ratings and`);
  console.log(`   their own usage. The previous version of this run joined observed VLvl==0 only and discarded`);
  console.log(`   the v5 share printed below — that share is the size of the error it made.`);
  console.log(`   opp = the OPPOSING role being weighted (pitchers integrate over 'hit', hitters over 'pit').`);
  console.log(`\n  tier      opp   played/eligible base   played/eligible v5      usage base       usage v5   v5 share  orphan`);
  for (const s of coverage(usage!, oppSets))
    console.log(`  ${s.tier.padEnd(9)} ${s.role}   ${String(s.playedBase).padStart(5)}/${String(s.nBase).padEnd(6)}        ${String(s.playedVar).padStart(5)}/${String(s.nVar).padEnd(6)}   ${s.usageBase.toFixed(0).padStart(13)}  ${s.usageVar.toFixed(0).padStart(13)}   ${(100 * s.varShare).toFixed(1).padStart(6)}%  ${String(s.orphanCids).padStart(6)}`);
  console.log(`\n   v5 share = fraction of this cell's REALIZED opposition usage carried by variant rows.`);
  console.log(`   orphan   = joined observed rows with no card in the opponent set (must be 0; pinned in tests/cwhit-realized.test.ts).`);
  console.log(`   NOTE ON THE SCALAR CONTROL: it is unchanged (uniform-mean collapse over the BASE pool) and is`);
  console.log(`   therefore the SAME column in both runs — a held-fixed control, not the degenerate case of this`);
  console.log(`   integration. The degenerate identity pinned in tests relates the scalar to the UNIFORM run only.`);
}
console.log(`\n── CANDIDATE NEED = SD(frame conditions) / SD(pool conditions) ──`);
console.log(`   >1 ⇒ the pool COMPRESSES predicted spread relative to the training frame, i.e. a correction is needed.`);
for (const role of ["pit", "hit"] as const) {
  const ks = role === "pit" ? ["k9", "bb9", "hr9", "babip"] : ["so", "bb", "hr", "babip"];
  console.log(`\n  ${role === "pit" ? "PITCHERS" : "HITTERS "}  cards/opp   │ ${ks.map((k) => k.padStart(8)).join(" ")}`);
  for (const c of cells.filter((x) => x.role === role))
    console.log(`  ${c.tier.padEnd(9)} ${String(c.n).padStart(4)}/${String(c.nOpp).padEnd(5)} │ ${ks.map((k) => f3(c.ratio[k]!)).join(" ")}${c.scalar ? `  │ scalar ${ks.map((k) => f3(c.scalar![k]!)).join(" ")}` : ""}`);
}

console.log(`\n── THE MEASURED NEEDS THIS MUST REPRODUCE (cwhit-battery-targets-2026-07-21.txt) ──`);
console.log(`   K      iron 1.82  bronze 1.62  silver 1.48  gold 1.78  diamond 1.04   ← non-monotone; gold is the break`);
console.log(`   HR     iron 1.17  bronze 1.13  silver 1.19  gold 1.27  diamond 1.32   ← measured gap-FLAT`);
console.log(`   BABIP  iron 1.26  bronze 1.34  silver 1.40  gold 1.01  diamond 0.91   ← rises then falls; only sub-1.0 cells`);
console.log(`\n   Validation is MULTI-CHANNEL WITH ZERO PER-CHANNEL TUNING: one construction, all three shapes, or the`);
console.log(`   miss pattern localises which curve or distribution assumption is wrong. Do not tune to fix a miss.`);
console.log(`\n(end of battery item 1 — ${REALIZED ? "REALIZED-usage weighting" : "eligible-pool uniform weighting"})`);
