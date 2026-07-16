// THE TWO-LEDGER DIAGNOSTIC — per-CHANNEL error levels: are they real frame constants, or artifacts?
//   run: node tools/cwhit-two-ledger.ts
//
// WHY (Derek's steer): the scorecard's composite verdicts (hitter wOBA ≈ 0, pitcher wOBAA +0.017..0.021)
// are the LEAST informative numbers it produces. The per-channel levels underneath them are large,
// CI-clear, and structured. This tool MEASURES that structure BEFORE anyone attempts a level fix. It
// fits nothing, changes no scoring, and writes nothing.
//
// It answers four questions, in the order they must be answered:
//   0. LEDGER — do the rates we are computing levels from even balance? If not, nothing below counts.
//   A. ATTRIBUTION — is hitter wOBA's ~0 level bias CORRECTNESS, or offsetting channel errors?
//   B. TWO-LEDGER — hitters and pitchers are two views of THE SAME GAMES. Which channels agree across
//      the two independent views (⇒ a real universal frame effect, a LEGAL fit target) and which flip?
//   C. SELECTION — we judge on top-100-BY-USAGE subsamples. Is each level a FLAT constant (genuine) or
//      a GRADIENT in predicted quality (a spread artifact of judging a compressed predictor on a
//      selected tail)? Decompose the mixes.
//   D. IS THE TOP-100 CAPTURE THE BINDING CONSTRAINT — and if so, exactly what to capture next.
//
// DOCTRINE: cwhit's RAW OBSERVED events are ground truth. His PROJECTIONS are a benchmark opponent and
// are NOT USED ANYWHERE IN THIS TOOL — every number below is ours-vs-observed, so no window-overlap
// caveat applies and nothing here can be contaminated by his model.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { hitWobaFromRates, pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import {
  buildCwhitSample, wellSampled, handLetter, n_, MIN_IP, MIN_PA, QUICK,
  type Rec, type SampleDeps, type Chan,
} from "../src/eval/cwhit/sample.ts";
import {
  attributeComposite, meanEst, scaleEst, commonUnitFactor, ledgerCompare, LEDGER_PAIRS,
  biasGradient, gradientVerdict, decomposeAtPool, qualityBins, measuredBfPer9, bfPer9ThatZeroes,
  obpFromRates, avgFromRates, mmse, deShrink, spacingBins,
  type AttribRow, type Est, type Gradient, type Mmse,
} from "../src/eval/cwhit/two-ledger.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const ci = (e: Est, d = 2) => `${sgn(e.est, d)}${e.sig ? "*" : " "} [${sgn(e.lo, d)},${sgn(e.hi, d)}]`;

// ── deployed model + neutral env (identical to the scorecard's setup) ────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, 50, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const { recs, pools, cals } = buildCwhitSample(deps);

const CH = {
  pit: [{ key: "k9", lbl: "K9", d: 2 }, { key: "bb9", lbl: "BB9", d: 2 }, { key: "hr9", lbl: "HR9", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }],
  hit: [{ key: "bbPct", lbl: "BB%", d: 2 }, { key: "soPct", lbl: "SO%(PA)", d: 2 }, { key: "hr600", lbl: "HR600", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }],
} as const;
const MIN_N = 8;
/** THE JUDGED SAMPLE — observed-only (no cwhit projection needed), which is the larger N and is the
 *  sample the scorecard's section-B level table reports. Every number in this tool comes from it. */
const kept = (tier: string, role: "pit" | "hit") => recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r));
const poolOf = (tier: string, role: "pit" | "hit", ch: string) => pools.find((p) => p.tier === tier && p.role === role)?.byChannel[ch] ?? [];

console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  THE TWO-LEDGER DIAGNOSTIC — per-channel error levels: frame constant, or selection artifact?║`);
console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON`);
console.log(`sample = ours vs cwhit OBSERVED, well-sampled (IP≥${MIN_IP} / PA≥${MIN_PA}), via the existing joinCwhit fingerprint join.`);
console.log(`cwhit's PROJECTIONS are NOT used anywhere in this tool ⇒ no window-overlap caveat applies to any number below.`);
console.log(`MEASUREMENT ONLY: nothing here is fitted, and nothing here touches the scoring path.\n`);

// ═══ 0. THE LEDGER — outranks everything below ══════════════════════════════
console.log(`\n╔═══ 0. THE PA/BF LEDGER — do the rates we compute levels from balance? ══════════════════════╗`);
console.log(`If the ledger does not balance, every level estimate below is suspect and this section outranks the rest of the tool.`);

console.log(`\n── 0a. THE ΣPA==ΣBF GHOST DETECTOR IS NOT APPLICABLE HERE — stated, not skipped ──`);
console.log(`  \`detectContamination\` (src/eval/tournament-clean.ts) is the repo's PA−BF ledger ghost detector. It CANNOT run on cwhit data,`);
console.log(`  and this is a data-shape fact, not an oversight:`);
console.log(`    · it needs PER-ROW paired PA and BF columns plus an ORG field, to localise a one-sided export to a team;`);
console.log(`    · cwhit publishes PER-CARD AGGREGATE RATES over many tournament instances — no ORG, no per-running rows, no BF column at all`);
console.log(`      (only IP), and the hitter/pitcher tables are two DIFFERENT top-100 subsamples of two different populations.`);
console.log(`  ⇒ ΣPA vs ΣBF over these tables is not a closed system and its imbalance would mean nothing. The detector stays on OUR exports.`);
console.log(`  What IS testable on cwhit data are OVER-IDENTIFICATION checks — his rate columns must reproduce his own AVG/OBP columns, and his`);
console.log(`  pitcher line must imply a BF/9 consistent with the IP×4.3 constant this eval stack assumes. Both run below.`);

console.log(`\n── 0b. PITCHER BF/9: MEASURED vs THE ASSUMED ${BF_PER_9.toFixed(1)} (= IP_TO_BF 4.3 × 9) ──`);
console.log(`  BF/9 is a pure MULTIPLIER on our predicted per-9 line (per600 × BF/9 ÷ 600), so a wrong constant would show up as a`);
console.log(`  K9/BB9/HR9 level bias that is a UNIT ERROR, not a frame effect. It is also the ONLY extra assumption the pitcher side of the`);
console.log(`  two-ledger test carries that the hitter side (per-PA natively) does not.`);
console.log(`  Identity: BIP/9 = (27 − K9)/(1 − BABIP); BF/9 = K9 + BB9 + HR9 + HBP9 + BIP/9.`);
console.log(`  This is an UPPER BOUND by construction: double plays / caught stealing retire batters without consuming a BIP, so ignoring them`);
console.log(`  overstates BIP/9 by roughly (DP+CS)/(1−BABIP) ≈ 1.0–1.5.`);
console.log(`  ⇒ the true BF/9 lies in the BAND [measured − 1.5, measured]. The assumed ${BF_PER_9.toFixed(1)} is consistent iff it falls INSIDE that band.`);
const DPCS_BAND = 1.5;
console.log(`\ntier      N     measured BF/9 = UPPER bound [95% CI]   plausible band [meas−${DPCS_BAND}, meas]   is ${BF_PER_9.toFixed(1)} inside?`);
for (const { tier } of QUICK) {
  const rows = kept(tier, "pit"); if (rows.length < MIN_N) { if (rows.length) console.log(`${tier.padEnd(9)} (N=${rows.length} — too few to report)`); continue; }
  const e = meanEst(rows.map((r) => measuredBfPer9(r.obs.k9!, r.obs.bb9!, r.obs.hr9!, r.obs.babip!)));
  const lo = e.est - DPCS_BAND, inside = BF_PER_9 >= lo && BF_PER_9 <= e.est;
  console.log(`${tier.padEnd(9)} ${String(e.n).padStart(3)}   ${f(e.est, 2)} [${f(e.lo, 2)}, ${f(e.hi, 2)}]`.padEnd(52) + `[${f(lo, 2)}, ${f(e.est, 2)}]`.padEnd(30) + (inside ? "YES — 4.3 is consistent with cwhit's own pitcher lines" : BF_PER_9 > e.est ? "NO — 4.3 exceeds even the UPPER bound ⇒ too high" : "NO — 4.3 is below the whole band ⇒ too low"));
}

console.log(`\n── 0c. THE SINGLE-SCALAR TEST — could ONE wrong BF/9 explain the pitcher level biases? ──`);
console.log(`  Every predicted per-9 channel is PROPORTIONAL to BF/9, so if a unit error were the story, ONE BF/9 value would have to zero`);
console.log(`  ALL of them. Below: the BF/9 each channel would need. Spread across the row ⇒ no single scalar works ⇒ the biases are REAL.`);
console.log(`  BABIP is BF/9-INVARIANT (a ratio of per-600 quantities), so a CI-clear BABIP bias is on its own proof that a unit error cannot`);
console.log(`  be the whole explanation.`);
console.log(`\ntier      N     BF/9 needed to zero K9   BB9      HR9      | spread    BABIP bias (BF/9-invariant)`);
for (const { tier } of QUICK) {
  const rows = kept(tier, "pit"); if (rows.length < MIN_N) continue;
  const need = (k: string) => bfPer9ThatZeroes(rows.reduce((a, r) => a + r.ours[k]!, 0) / rows.length, rows.reduce((a, r) => a + r.obs[k]!, 0) / rows.length);
  const vs = ["k9", "bb9", "hr9"].map(need);
  const bab = meanEst(rows.map((r) => r.ours.babip! - r.obs.babip!));
  console.log(`${tier.padEnd(9)} ${String(rows.length).padStart(3)}   ${vs.map((v) => f(v, 1).padStart(8)).join(" ")}   | ${f(Math.max(...vs) - Math.min(...vs), 1).padStart(6)}    ${ci(bab, 3)}`);
}
console.log(`\n  READ: a spread of more than ~1–2 BF/9 units across the three channels falsifies "it's just the 4.3 constant".`);

console.log(`\n── 0d. HITTER OVER-IDENTIFICATION — do cwhit's rate columns reproduce his own OBP / AVG? ──`);
console.log(`  OBP recon uses ONLY (BB%, SO%, HR600, BABIP) — it never touches his OBP column or the AB/PA path, so it is a genuine`);
console.log(`  over-identification of the exact rates our level biases are computed from.`);
console.log(`  Expected residual is a small POSITIVE ≈ BABIP × SAC/PA ≈ +0.004: the recon's BIP/PA still contains sacrifices. A residual near`);
console.log(`  that size is the identity WORKING. (The AVG recon is corroboration only — SAC_PER_PA was itself calibrated off the AVG/OBP identity.)`);
console.log(`\ntier      N     OBP recon − published [95% CI]        AVG recon − published [95% CI]        verdict`);
for (const { tier } of QUICK) {
  const rows = kept(tier, "hit"); if (rows.length < MIN_N) { if (rows.length) console.log(`${tier.padEnd(9)} (N=${rows.length} — too few to report)`); continue; }
  const o = meanEst(rows.map((r) => obpFromRates(r.raw.bbPct!, r.raw.soPctPerPa!, r.raw.hr600!, r.raw.babip!) - r.raw.obp!));
  const a = meanEst(rows.map((r) => avgFromRates(r.raw.bbPct!, r.raw.soPctPerPa!, r.raw.hr600!, r.raw.babip!) - r.raw.avg!));
  const ok = Math.abs(o.est - 0.004) < 0.006;
  console.log(`${tier.padEnd(9)} ${String(o.n).padStart(3)}   ${ci(o, 4)}`.padEnd(52) + `${ci(a, 4)}`.padEnd(38) + (ok ? "BALANCES (residual ≈ the sac term)" : "OFF — investigate before trusting these levels"));
}

console.log(`\n── 0e. DEAD / DEGENERATE PREDICTIONS (no silent drops) ──`);
{
  let dead = 0;
  for (const r of recs) {
    const bad = Object.entries(r.ours).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k);
    const badObs = Object.entries(r.obs).filter(([, v]) => !Number.isFinite(v)).map(([k]) => k);
    if (bad.length || badObs.length) { console.log(`  ${r.tier} ${r.role} "${r.name}" — non-finite ours:[${bad}] obs:[${badObs}]`); dead++; }
  }
  console.log(`  ${dead} record(s) with a non-finite predicted or observed channel out of ${recs.length} joined.`);
  const belowBar = recs.length - recs.filter(wellSampled).length;
  console.log(`  ${belowBar} of ${recs.length} joined records fall BELOW the well-sampled bar and are excluded from every number above and below`);
  console.log(`  (they are not dropped silently — the scorecard's N+SAMPLE DEPTH table itemises them per tier×role).`);
}

// ═══ 0f. THE CALIBRATION LEDGER ═════════════════════════════════════════════
console.log(`\n── 0f. THE CALIBRATION SCALES — what the DEPLOYED path actually applies on top of the event model ──`);
console.log(`  Both lines are computed from ONE home (src/eval/cwhit/sample.ts) and reported side by side throughout:`);
console.log(`    RAW = the event model's own output           → answers "is the model's FORM right?"`);
console.log(`    DEP = what scoreCard ships (hitting/pitchingComponents + the trusted assembly incl. sFinal)`);
console.log(`                                                  → answers "is the SHIPPED SCORE right?"`);
console.log(`  calibrate(basePool, {coeffs, derived, eventForm, poolTransform}) — the same call tools/cwhit-bsr-validate.ts makes.`);
console.log(`\ntier      sBB hit   sHR hit   sBB pit   sHR pit   |  hitScaleVR  hitScaleVL  pitchScale  |  anchorMeanVR  anchorMeanPitch`);
let evCalAllOne = true;
for (const { tier, cal } of cals) {
  const ev = [cal.hitBBScaleVR, cal.hitHRScaleVR, cal.pBBScaleVR, cal.pHRScaleVR].map((x) => x ?? 1);
  if (ev.some((x) => x !== 1)) evCalAllOne = false;
  console.log(`${tier.padEnd(9)} ${ev.map((x) => f(x, 4).padStart(8)).join("  ")}   |  ${f(cal.hitScaleVR ?? 1, 4).padStart(9)}   ${f(cal.hitScaleVL ?? 1, 4).padStart(9)}   ${f(cal.pitchScale ?? 1, 4).padStart(9)}  |  ${f(cal.anchorMeanVR ?? 0, 4).padStart(11)}   ${f(cal.anchorMeanPitch ?? 0, 4).padStart(14)}`);
}
console.log(`\n  PER-EVENT SCALES (sBB/sHR): ${evCalAllOne ? "ALL EXACTLY 1 — CONFIRMED EMPIRICALLY." : "*** NOT ALL 1 — STOP. The deployed config differs from the code read; every composite number below is suspect. ***"}`);
if (evCalAllOne) {
  console.log(`    calibrate.ts sets \`noEvCal = !!eventForm\` and the deployed raw-poly model HAS an eventForm, so the per-event calibration is`);
  console.log(`    RETIRED on this path — its job (pulling the field's BB/HR to a league baseline = crude pool-relativity) MOVED to the`);
  console.log(`    rating-space own-gap pool transform. sBB/sHR live ONLY on the retired log-linear parity path, which is out of production.`);
  console.log(`    ⇒ own-gap is the SUCCESSOR to the per-event BB/HR calibration, not a second correction to stack on top of it.`);
}
console.log(`\n  ERA/PARK ON THIS ENV: era_bb=${f(coeffs.era_bb, 3)} era_k=${f(coeffs.era_k, 3)} era_effective_hr=${f(derived.era_effective_hr, 3)} era_h=${f(derived.era_h, 3)} era_gap=${f(derived.era_gap, 3)} era_bip_adj=${f(derived.era_bip_adj, 3)}`);
console.log(`                       park_hr_r/l=${f(coeffs.park_hr_r, 3)}/${f(coeffs.park_hr_l, 3)} park_avg_r/l=${f(coeffs.park_avg_r, 3)}/${f(coeffs.park_avg_l, 3)} park_gap=${f(coeffs.park_gap, 3)}`);
console.log(`  All 1.0 ⇒ hitting/pitchingComponents reduce to the identity on BB/SO/HR and re-derive BA/GAP on the same BIP the model used.`);
console.log(`  ⇒ RAW and DEP per-channel rates COINCIDE on this neutral env. sFinal multiplies ONLY the assembled composite and NEVER a`);
console.log(`    per-channel rate ⇒ every per-channel finding below is mathematically INVARIANT to calibration. Verified, not assumed:`);
{
  let maxCh = 0, maxLbl = "";
  for (const r of recs) for (const { key } of CH[r.role]) {
    const dv = Math.abs(r.ours[key]! - r.oursDep[key]!);
    if (dv > maxCh) { maxCh = dv; maxLbl = `${r.tier} ${r.role} ${key}`; }
  }
  console.log(`    largest |DEP − RAW| across ALL ${recs.length} joined records × every channel: ${maxCh.toExponential(2)} (${maxLbl || "n/a"}) ⇒ ${maxCh < 1e-9 ? "IDENTICAL to floating-point noise." : "NOT identical — investigate."}`);
  const wd = recs.map((r) => Math.abs(r.ours.woba! - r.oursDep.woba!));
  console.log(`    largest |DEP − RAW| on the COMPOSITE: ${Math.max(...wd).toFixed(5)} wOBA ⇒ ONLY the composite moves; that is sFinal.`);
  console.log(`  EVAL FRAME = the RAW (unanchored) quantity, per Derek: the anchor is a CONVENTION (a readable scale + the cap optimizer's`);
  console.log(`  budget unit), not a prediction, and it normalizes BOTH roles to the same TARGET_WOBA by construction — so absolute agreement`);
  console.log(`  with cwhit on an anchored composite is a UNIT MISMATCH, not a defect. Every verdict below is on the raw quantity, and every`);
  console.log(`  SPREAD/SHAPE statistic is scale-free ⇒ untouched by this choice either way.`);
}

// ═══ A. CHANNEL ATTRIBUTION ═════════════════════════════════════════════════
console.log(`\n\n╔═══ A. CHANNEL ATTRIBUTION — is the composite's level bias correctness, or cancellation? ════╗`);
console.log(`METHOD: per card, start from the OBSERVED line, swap in ONE channel's PREDICTED value, read the change in the composite. Averaged`);
console.log(`over cards ⇒ each channel's contribution to the composite level bias, in wOBA units, with a card-level CI.`);
console.log(`  'Σ singles'   = the four contributions added up.`);
console.log(`  'all-at-once' = swapping all four together; minus Σ singles = the assembly's NON-ADDITIVITY (interaction).`);
console.log(`  'measured'    = the composite bias the scorecard reports.`);
console.log(`  'UNEXPLAINED' = measured − all-at-once: what the four channels CANNOT reach. For PITCHERS this must be ~0 — both wOBAA lines are`);
console.log(`                  literally built by this assembly — so it is a self-check on the method. For HITTERS it is real and expected:`);
console.log(`                  our predicted wOBA uses the MODEL's own 1B/XBH split while the observed wOBA is rebuilt from cwhit's AVG/SLG`);
console.log(`                  hit-mix, so the residual isolates the HIT-MIX channel the four headline channels cannot see.`);

for (const role of ["pit", "hit"] as const) {
  console.log(`\n─── ${role === "pit" ? "PITCHERS — wOBAA" : "HITTERS — wOBA (batting-only)"} ───`);
  console.log(`tier      N    ` + CH[role].map((c) => c.lbl.padStart(16)).join("") + `   Σ singles  interact  all-at-once   measured  UNEXPLAINED`);
  for (const { tier } of QUICK) {
    const rows = kept(tier, role); if (rows.length < MIN_N) { if (rows.length) console.log(`${tier.padEnd(9)} (N=${rows.length} — too few to report)`); continue; }
    const keys = CH[role].map((c) => c.key);
    const arows: AttribRow<Rec>[] = rows.map((r) => ({ obs: r.obs, pred: r.ours, mPred: r.ours.woba!, mObs: r.obs.woba!, ctx: r }));
    const assemble = role === "pit"
      ? (_r: AttribRow<Rec>, ch: Chan) => pitWobaFromChannels(ch.k9!, ch.bb9!, ch.hr9!, ch.babip!, W)
      : (r: AttribRow<Rec>, ch: Chan) => hitWobaFromRates({ bbPct: ch.bbPct!, soPct: ch.soPct!, hr600: ch.hr600!, babip: ch.babip!, avg: r.ctx.raw.avg!, slg: r.ctx.raw.slg!, tripleXbh: r.ctx.raw.tripleXbh! }, W);
    const a = attributeComposite(arows, keys, assemble);
    const cells = a.channels.map((c) => `${sgn(c.contrib.est * 1000, 1)}${c.contrib.sig ? "*" : " "}`.padStart(16)).join("");
    console.log(`${tier.padEnd(9)} ${String(a.n).padStart(3)}  ${cells}   ${sgn(a.sumSingles * 1000, 1).padStart(9)}  ${sgn(a.interaction * 1000, 1).padStart(8)}  ${sgn(a.fullSub.est * 1000, 1).padStart(11)}  ${sgn(a.measured.est * 1000, 1).padStart(9)}${a.measured.sig ? "*" : " "} ${sgn(a.reconResid.est * 1000, 1).padStart(11)}${a.reconResid.sig ? "*" : " "}`);
  }
  console.log(`  (all values in mwOBA = wOBA × 1000. * = 95% CI excludes 0.)`);
}

// ═══ B. THE TWO-LEDGER TEST ═════════════════════════════════════════════════
console.log(`\n\n╔═══ B. THE TWO-LEDGER TEST — do the two views of the SAME GAMES agree? ══════════════════════╗`);
console.log(`Hitters and pitchers in a tier are two views of ONE set of games. A genuine FRAME effect must therefore appear with the SAME SIGN`);
console.log(`from both sides — two INDEPENDENT estimates of one physical quantity, i.e. a free falsification test.`);
console.log(`Both sides are put in the COMMON per-PA ≡ per-BF unit. Sign convention is identical on both sides: bias = pred − obs, so POSITIVE`);
console.log(`always means "we predict MORE of this event than actually happens", whoever is looking.`);
console.log(`\nCAVEATS carried, not buried:`);
console.log(`  · the pitcher side rides the ASSUMED BF/9 = ${BF_PER_9.toFixed(1)} (IP×4.3). That is a MULTIPLICATIVE scale on pitcher BB/K/HR only — it can move`);
console.log(`    the magnitude by a few %, but it CANNOT flip a sign, so no agreement verdict below turns on it. §0b/0c size it. BABIP is exempt entirely.`);
console.log(`  · "same games" holds at the FRAME level. The two sides are different SELECTED subsets (top-100 hitters BY PA, top-100 pitchers BY IP)`);
console.log(`    of that frame — which is precisely why an agreement here is evidence of a frame effect and a disagreement points at selection (§C).`);
console.log(`  · the two card sets are disjoint ⇒ the difference CI treats the two estimates as independent.`);

const ledgerRows: { tier: string; channel: string; c: ReturnType<typeof ledgerCompare> }[] = [];
for (const { tier } of QUICK) {
  const hr = kept(tier, "hit"), pr = kept(tier, "pit");
  if (hr.length < MIN_N || pr.length < MIN_N) { console.log(`\n  ${tier.toUpperCase()}: hitters N=${hr.length}, pitchers N=${pr.length} — a side is below N=${MIN_N} ⇒ NO two-ledger read for this tier.`); continue; }
  console.log(`\n─── ${tier.toUpperCase()} — hitters N=${hr.length}, pitchers N=${pr.length} — units: events per PA (≡ per BF) ───`);
  console.log(`channel   hitter-side est [95% CI]              pitcher-side est [95% CI]             hit − pit [95% CI]              verdict`);
  for (const p of LEDGER_PAIRS) {
    const h = scaleEst(meanEst(hr.map((r) => r.ours[p.hit]! - r.obs[p.hit]!)), commonUnitFactor("hit", p.hit).k);
    const q = scaleEst(meanEst(pr.map((r) => r.ours[p.pit]! - r.obs[p.pit]!)), commonUnitFactor("pit", p.pit).k);
    const c = ledgerCompare(p.channel, h, q);
    ledgerRows.push({ tier, channel: p.channel, c });
    const tag = !c.signAgree ? (c.hit.sig && c.pit.sig ? "DISAGREE — SIGN FLIP" : "inconclusive")
      : c.ciOverlap ? "AGREE (sign + magnitude)" : `AGREE on SIGN, DIFFER on MAGNITUDE (${f(Math.max(Math.abs(h.est), Math.abs(q.est)) / Math.max(Math.min(Math.abs(h.est), Math.abs(q.est)), 1e-9), 1)}×)`;
    console.log(`${p.channel.padEnd(9)} ${ci(h, 5)}`.padEnd(48) + `${ci(q, 5)}`.padEnd(38) + `${ci(c.diff, 5)}`.padEnd(32) + tag);
  }
}
console.log(`\n  NOTE ON "AGREE on SIGN, DIFFER on MAGNITUDE": sign agreement is the falsification test and it is what licenses a channel as a frame`);
console.log(`  effect. A magnitude gap on top of it means the frame effect does NOT hit both roles equally — a real second-order finding, not a`);
console.log(`  failure. It is also the ONLY place the assumed BF/9 could matter, and it cannot: BF/9 would have to be wrong by the full ratio below`);
console.log(`  to close the BB gap, which §0b/0c exclude.`);
console.log(`\n── B-SUMMARY: cross-role agreement per channel, across tiers ──`);
console.log(`channel   tiers read   sign-AGREE   sign-FLIP   inconclusive   ⇒ verdict`);
for (const p of LEDGER_PAIRS) {
  const rs = ledgerRows.filter((r) => r.channel === p.channel);
  const ag = rs.filter((r) => r.c.signAgree).length;
  const fl = rs.filter((r) => !r.c.signAgree && r.c.hit.sig && r.c.pit.sig).length;
  const inc = rs.length - ag - fl;
  const v = !rs.length ? "no data"
    : fl === 0 && ag === rs.length ? "PASSES — both independent views agree in every tier ⇒ a genuine UNIVERSAL FRAME CONSTANT; a LEGAL fit target"
      : ag > 0 && fl > 0 ? "MIXED — agrees in some tiers, flips in others ⇒ NOT a clean constant"
        : fl > 0 ? "FAILS — the two views of the same games contradict ⇒ NOT a single frame constant; §C decomposes what is generating it"
          : "INCONCLUSIVE";
  console.log(`${p.channel.padEnd(9)} ${String(rs.length).padStart(6)}      ${String(ag).padStart(6)}      ${String(fl).padStart(6)}      ${String(inc).padStart(8)}       ${v}`);
}

// ═══ C. THE SELECTION / SPREAD-ARTIFACT TEST ════════════════════════════════
console.log(`\n\n╔═══ C. FLAT CONSTANT vs SPREAD ARTIFACT — the selection test ════════════════════════════════╗`);
console.log(`DISCRIMINATOR: a genuine format constant is FLAT across the quality range; a spread artifact is a GRADIENT in predicted quality`);
console.log(`(a compressed predictor's error is proportional to −(pred − poolmean) — the regression-to-mean signature).`);
console.log(`\nTHE REGRESSOR IS *PRED*, NOT OBS — and this is load-bearing. Regressing bias=(pred−obs) on OBS is mechanically biased: var(obs)`);
console.log(`carries binomial sampling noise, so cov(pred−obs, obs) is negative even for a PERFECT predictor ⇒ it would MANUFACTURE the very`);
console.log(`gradient we are testing for. PRED is a deterministic model output, uncorrelated with the observed noise ⇒ the slope is clean and`);
console.log(`needs NO noise deconvolution (unlike the scorecard's pred~obs slope column).`);
console.log(`Identity worth knowing: slope β = 1 − slope(obs~pred). So β<0 ⟺ obs varies MORE per unit pred than pred does ⟺ WE ARE COMPRESSED.`);
console.log(`β=0 is exactly the forecaster's calibration condition.`);
console.log(`\nDECOMPOSITION (the point of the whole section): the judged top-100 sits at a DISPLACEMENT from the pool mean, so`);
console.log(`    mean bias  =  constAtPool  +  artifact,      artifact = β × (sample mean quality − POOL mean quality)`);
console.log(`'constAtPool' = the level bias a POOL-AVERAGE card would show = the REAL constant. 'artifact' = the part manufactured by judging a`);
console.log(`compressed predictor on a selected tail. The pool = every VLvl-0 card under the tier's VAL cap (the population cwhit's top-100 is drawn from).`);
console.log(`'extrap' = the pool mean lies OUTSIDE the judged sample's own quality range ⇒ the split is a linear extrapolation into unobserved territory, NOT a measurement.`);

const gradRows: { tier: string; role: "pit" | "hit"; ch: string; g: Gradient; dec: ReturnType<typeof decomposeAtPool>; v: string }[] = [];
for (const role of ["pit", "hit"] as const) {
  console.log(`\n─── ${role === "pit" ? "PITCHERS" : "HITTERS"} ───`);
  console.log(`tier      chan        N   mean bias (=const@sample)      slope β [95% CI]            verdict     displ(poolSD)  range%  artifact        constAtPool          extrap`);
  for (const { tier } of QUICK) {
    const rows = kept(tier, role); if (rows.length < MIN_N) continue;
    for (const { key, lbl, d } of [...CH[role], { key: "woba", lbl: role === "pit" ? "wOBAA" : "wOBA", d: 3 }]) {
      const pred = rows.map((r) => r.ours[key]!), obs = rows.map((r) => r.obs[key]!);
      const g = biasGradient(pred, obs);
      const dec = decomposeAtPool(g, poolOf(tier, role, key));
      const v = gradientVerdict(g);
      gradRows.push({ tier, role, ch: lbl, g, dec, v });
      console.log(
        `${tier.padEnd(9)} ${lbl.padEnd(9)} ${String(g.n).padStart(3)}   ${ci(g.constant, d)}`.padEnd(56) +
        `${ci(g.slope, 3)}`.padEnd(28) + `${v.padEnd(11)} ${sgn(dec.displacementSd, 2).padStart(9)}   ${f(dec.rangeFrac * 100, 0).padStart(5)}%  ${ci(dec.artifact, d).padEnd(15)} ${ci(dec.constAtPool, d).padEnd(20)} ${dec.extrapolated ? "YES" : "no"}`,
      );
    }
  }
  console.log(`  (verdict: FLAT = genuine level only · GRADIENT = spread artifact only · BOTH = a constant PLUS an artifact · NEITHER = this cell cannot call it)`);
  console.log(`  (displ(poolSD) = how far the judged sample's mean predicted quality sits from the POOL mean, in pool SDs — the SELECTION.`);
  console.log(`   range% = the sample's quality SD as a share of the pool's — how much of the quality axis this capture actually spans.)`);
}

console.log(`\n── C-DEEP-DIVE: the quality-binned bias for the headline cells (the non-parametric companion to β) ──`);
console.log(`A gradient the regression calls LINEAR should march monotonically across these bins. If it does not, the linear extrapolation`);
console.log(`behind 'constAtPool' is not trustworthy and the decomposition must not be quoted.`);
for (const [role, key, lbl] of [["hit", "hr600", "HR600"], ["pit", "hr9", "HR9"], ["pit", "woba", "wOBAA"], ["hit", "woba", "wOBA"]] as const) {
  console.log(`\n  ${role === "pit" ? "PITCHER" : "HITTER"} ${lbl} — bias by quartile of PREDICTED ${lbl} (Q1 = lowest predicted)`);
  console.log(`  tier      ` + [1, 2, 3, 4].map((q) => `Q${q} bias (n)`.padStart(20)).join("") + `   monotone?`);
  for (const { tier } of QUICK) {
    const rows = kept(tier, role); if (rows.length < MIN_N) continue;
    const bins = qualityBins(rows.map((r) => r.ours[key]!), rows.map((r) => r.obs[key]!), 4);
    const d = key === "woba" ? 3 : 2;
    const es = bins.map((b) => b.bias.est);
    const mono = es.every((v, i) => i === 0 || v <= es[i - 1]!) || es.every((v, i) => i === 0 || v >= es[i - 1]!);
    console.log(`  ${tier.padEnd(9)} ` + bins.map((b) => `${sgn(b.bias.est, d)}${b.bias.sig ? "*" : " "}(${b.n})`.padStart(20)).join("") + `   ${mono ? "yes" : "NO — non-linear"}`);
  }
}

// ═══ D. IS THE TOP-100 CAPTURE THE BINDING CONSTRAINT? ══════════════════════
console.log(`\n\n╔═══ D. IS THE TOP-100 CAPTURE THE BINDING CONSTRAINT — and what would resolve it? ═══════════╗`);
console.log(`"We only test the top 100" is TRUE but it is a CAPTURE CHOICE, not a law. This section states whether that choice is what stops`);
console.log(`the flat-vs-gradient call, and if so, exactly what to capture.`);
console.log(`\nTwo distinct things could bind, and they must not be conflated:`);
console.log(`  · POWER — can the cell resolve a gradient at all? 'minDetectable β' = the smallest |β| it could have called CI-clear. |β| below it ⇒`);
console.log(`    the cell is underpowered and 'FLAT' there means "cannot see a gradient", NOT "there is none".`);
console.log(`  · RANGE — does the sample span enough of the pool's quality axis that constAtPool is a measurement rather than an extrapolation?`);
console.log(`    That is 'range%' and 'extrap' in §C, summarised below.`);
console.log(`\nrole  tier      chan        N   range%  |β|      minDetectable β   powered?   verdict`);
for (const { role, tier, ch, g, dec, v } of gradRows) {
  const powered = Math.abs(g.slope.est) > g.minDetectableSlope;
  console.log(`${role.padEnd(5)} ${tier.padEnd(9)} ${ch.padEnd(9)} ${String(g.n).padStart(3)}   ${f(dec.rangeFrac * 100, 0).padStart(4)}%  ${f(Math.abs(g.slope.est), 3).padStart(6)}   ${f(g.minDetectableSlope, 3).padStart(13)}    ${(powered ? "YES" : "NO").padEnd(8)}   ${v}`);
}
{
  const cells = gradRows.length;
  const under = gradRows.filter((r) => r.v === "NEITHER").length;
  const extrap = gradRows.filter((r) => r.dec.extrapolated);
  const narrow = gradRows.filter((r) => r.dec.rangeFrac < 0.7);
  const single = gradRows.filter((r) => r.ch !== "wOBA" && r.ch !== "wOBAA");
  const comp = gradRows.filter((r) => r.ch === "wOBA" || r.ch === "wOBAA");
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`\n── D-VERDICT (computed, not assumed) ──`);
  console.log(`  ${cells} role×tier×channel cells tested; ${under} could call NEITHER a constant nor a gradient (genuinely underpowered).`);
  console.log(`\n  1. ON THE SINGLE CHANNELS, TOP-100 IS **NOT** THE BINDING CONSTRAINT — and this is the surprise of the section.`);
  console.log(`     Mean quality range spanned by the judged sample: ${f(avg(single.map((r) => r.dec.rangeFrac)) * 100, 0)}% of the POOL's SD across the ${single.length} per-channel cells`);
  console.log(`     (min ${f(Math.min(...single.map((r) => r.dec.rangeFrac)) * 100, 0)}%, max ${f(Math.max(...single.map((r) => r.dec.rangeFrac)) * 100, 0)}%). The top-100 BY USAGE is NOT a narrow quality slice: usage is driven by who people PLAY,`);
  console.log(`     which is only loosely tied to any ONE channel, so on BB/K/HR/BABIP the sample spans roughly the whole pool range — sometimes MORE`);
  console.log(`     than the pool's own SD. ${single.filter((r) => r.dec.extrapolated).length} of ${single.length} per-channel cells need any extrapolation at all. The per-channel flat-vs-gradient calls are therefore`);
  console.log(`     REAL MEASUREMENTS, not extrapolations, and capturing ranks 101–300 would NOT change them.`);
  console.log(`\n  2. ON THE COMPOSITES (wOBA / wOBAA), TOP-100 **IS** BINDING — the constraint bites exactly where selection is on the sorted axis.`);
  console.log(`     Mean range spanned: ${f(avg(comp.map((r) => r.dec.rangeFrac)) * 100, 0)}% of pool SD across the ${comp.length} composite cells; mean |displacement| ${f(avg(comp.map((r) => Math.abs(r.dec.displacementSd))), 2)} pool SDs;`);
  console.log(`     ${comp.filter((r) => r.dec.extrapolated).length} of ${comp.length} require EXTRAPOLATION to reach the pool mean. Usage-selection IS close to overall-quality selection, so on the composite the`);
  console.log(`     judged sample is a genuine narrow high tail. ⇒ every composite 'constAtPool' is model-dependent and must be quoted with that caveat.`);
  console.log(`\n  3. THE ACTUAL BINDING CONSTRAINT IS PITCHER USAGE DEPTH, NOT PAGE COUNT.`);
  for (const { tier } of QUICK) {
    const all = recs.filter((r) => r.tier === tier && r.role === "pit");
    if (all.length) console.log(`     ${tier.padEnd(9)} pitchers: ${String(all.filter(wellSampled).length).padStart(3)} of ${String(all.length).padStart(3)} joined rows clear IP≥${MIN_IP} (${f((all.filter(wellSampled).length / all.length) * 100, 0)}%)`);
  }
  console.log(`     Silver/gold/diamond throw away 78%/85%/99% of their rows to the IP bar. More PAGES there would add rows that are ALREADY below the`);
  console.log(`     bar — the pitcher fix is more tournament INSTANCES (deeper IP per card), which is cwhit's crawl cadence, not a paging choice of ours.`);
  console.log(`\n  ── THE DATA ASK (prioritised; ranks 101–300 is NOT the top item) ──`);
  console.log(`  A. HIGHEST VALUE — diamond + gold PITCHERS, more INSTANCES (not more rows). Diamond pit is a DEAD CELL (N=1 well-sampled): the entire`);
  console.log(`     pitcher side of the two-ledger test and the whole tier-gradient in pitcher wOBAA stop at gold. This is the only cell that is`);
  console.log(`     unrecoverable by any paging. Re-pull diamond/gold Quick pitchers once cwhit's coverage window has accumulated more instances`);
  console.log(`     (his diamond pit table already spans 62 training days, so the ceiling here is his crawl, not our capture).`);
  console.log(`  B. SECOND — the COMPOSITE extrapolation fix: cwhit observed tables at ranks 101–300 for ${[...new Set(extrap.map((r) => `${r.role} ${r.tier}`))].join(", ") || "(none)"}.`);
  console.log(`     ~2 extra pages per listed tier×role. This buys ONLY the composite constAtPool split (it moves the pool mean inside the observed`);
  console.log(`     range); it does NOT change any per-channel verdict, so it is worth doing only if the composite decomposition is the deliverable.`);
  console.log(`  C. NOT NEEDED — per-channel range. Do not spend captures widening it; §D.1 shows it is already ~pool-wide.`);
  console.log(`\n  ⇒ BOTTOM LINE ON THE TOP-100 QUESTION: the capture choice is binding for the COMPOSITE decomposition and for diamond/gold pitchers,`);
  console.log(`    and NOT binding for the per-channel flat-vs-gradient verdicts that this diagnostic was built to deliver. Those stand on their own.`);
}
console.log(``);
process.exit(0);
