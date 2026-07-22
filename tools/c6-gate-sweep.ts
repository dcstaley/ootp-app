// C6 — THE FULL GATE SWEEP ON EVERYTHING SHIPPING. Evaluation only; fits nothing.
//   run: node tools/c6-gate-sweep.ts > fixtures/cwhit-c6-gate-sweep-2026-07-22.txt
//
// ── WHY THIS TOOL EXISTS RATHER THAN A RE-RUN OF THE FIT TOOLS ──────────────────────────────────
// The 2026-07-21 sweep was "run fit-kspread-pit.ts and fit-pitspread-hrbab.ts and read their gates".
// That is no longer a valid instrument for this event, for two independent reasons:
//
//   1. fit-kspread-pit.ts fits the SATURATING family, which this event RETIRES as falsified. Its
//      gates would score a refit of a dead form, not the constant that ships.
//   2. BOTH fit tools gate THEIR OWN REFIT. A refit passing its gates at the new coordinate is
//      evidence about the coordinate; it is NOT evidence that the SHIPPED constant passes. Those
//      are two different claims and the second is the one C6 has to make.
//
// So this tool fits NOTHING. It reads the shipped constants out of src/model/pool-transform.ts,
// applies them exactly as production applies them, and measures the gates. A FAIL here is a STOP.
//
// ── WHY THE HR RAMP IS IN SCOPE EVEN THOUGH THIS EVENT DID NOT TOUCH IT ─────────────────────────
// Intent-contract clause 4: a rule inherited across a coordinate change is a defect until
// re-derived. PIT_SPREAD_HR's gate record was established at the PRE-C1/C2' coordinate AND on the
// PRE-C3 K-spread baseline. C1/C2' moved the coordinate; C3 replaced the K ramp. Both move the
// ground the HR gates were measured on, so the HR gates are re-measured here rather than assumed to
// have survived. This is the same audit that found the section-9 domain defect.
//
// ── ONE COPY ───────────────────────────────────────────────────────────────────────────────────
// Every quantity comes from the shared path: formats from the corpus REGISTRY by tournamentId (never
// the optional legacySlug — the b4dc2ed defect), fields from productionFieldStats(), the judged
// sample from the ONE buildCwhitSample(), slopes from mmse(), noise from per9NoiseVar(). Nothing is
// reconstructed locally.
//
// GRAIN: observed statistics at ROW grain = (card × variant level). Pool constants at CARD grain
// over the presence mixture. N counts are ROWS.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, FIELD_N,
  kSpreadPitRamp, K_SPREAD_PIT, pitSpreadHrRamp, PIT_SPREAD_HR,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { presenceMixture, PRESENCE_P, PRESENCE_M } from "../src/data/variants.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar } from "../src/eval/cwhit/scorecard.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, wellSampled, inValueWindow, MIN_BF, n_,
  type Rec, type SampleDeps, type ValueWindow, type KSpreadPit,
} from "../src/eval/cwhit/sample.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
const lbl = (s: string) => s.replace(/\s*\(from .*\)$/, "");

// ── setup: the deployed model, exactly as the fit tool composed it ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const depsBase = {
  baseCards, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
const ci = (xs: number[]) => ({ lo: pct(xs, 0.025), hi: pct(xs, 0.975) });
function slopeOf(p: number[], o: number[]): number {
  const mp = mean(p), mo = mean(o);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}
function corrOf(x: number[], y: number[]): number {
  const mx = mean(x), my = mean(y);
  let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { cv += (x[i]! - mx) * (y[i]! - my); vx += (x[i]! - mx) ** 2; vy += (y[i]! - my) ** 2; }
  return vx > 0 && vy > 0 ? cv / Math.sqrt(vx * vy) : NaN;
}
const B = 2000, SEED = 20260722;
/** N below which a cell carries NO verdict. "Insufficient data" is never "noise" and never a pass. */
const THIN_N = 15;

// ═══════════════════════════════════════════════════════════════════════════════
// THE SWEEP — every format in the corpus registry, under its OWN resolved config
// ═══════════════════════════════════════════════════════════════════════════════
/** Stratum, per amendment A1.3. A defect attributes to the stratum where it FIRST appears. */
const STRATUM: Record<string, string> = {
  "iron-quick": "A", "bronze-quick": "A", "silver-quick": "A", "gold-quick": "A", "diamond-quick": "A",
  "live-open-daily": "A*",
  "early-gold": "B", "bronze-heart": "B", "late-bronze": "B", "diamond-heart": "B",
  "bronze-cap-weekly": "C", "gold-slots": "C",
  "gold-cap": "B+C", "diamond-cap-daily": "B+C",
};

interface Row {
  key: string; label: string; tid: string; stratum: string;
  poolN: number; joined: number; judged: number;
  gapK: number; gapHr: number; sK: number; sHr: number; clamped: boolean;
  kPre: number; kPost: number; kCI: { lo: number; hi: number };
  hrPre: number; hrPost: number; hrCI: { lo: number; hi: number };
  corrPre: number; corrPost: number; dCorrCI: { lo: number; hi: number };
  kLvPre: number; kLvPost: number; hrLvPre: number; hrLvPost: number;
  hitIdentical: boolean; hitN: number; hitMaxAbs: number;
  notices: string[];
}
const rows: Row[] = [];

const skipped: string[] = [];
for (const [fi, fm] of CWHIT_CORPUS.entries()) {
  // A registry entry with no tournamentId cannot be scored under "its own resolved config", which is
  // the whole premise of this sweep. Reported by name, never silently absent from the denominator.
  const tid = fm.tournamentId;
  if (!tid) { skipped.push(`${fm.key}: registry entry carries NO tournamentId — cannot resolve a config`); continue; }
  const t = tournaments.find((x) => x.id === tid);
  if (!t) { skipped.push(`${fm.key}: no tournament config for tournamentId '${tid}'`); continue; }
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) { skipped.push(`${fm.key}: era '${t.eraId}' or park '${t.parkId}' missing`); continue; }

  const coeffsF = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffsF, trained.wobaWeights!);
  const derivedF = computeDerived(coeffsF, true);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  if (!basePool.length) { skipped.push(`${fm.key}: empty eligible pool`); continue; }

  const refF = productionFieldStats(baseCards, coeffsF, rp);
  const poolF = productionFieldStats(basePool, coeffsF, rp);
  const pt = buildPoolTransform(refF, poolF, depsBase.envelope);
  const shift = buildFrameShift(TM, poolF);
  const gapK = shift.pit.vR.stu ?? 0;
  const gapHr = shift.pit.vR.hrr ?? 0;
  const pm = poolPitMeansOwn(presenceMixture(basePool), coeffsF, rp, pt, FIELD_N * PRESENCE_M);

  // THE SHIPPED CONSTANTS, read straight out of production. Nothing is fitted here.
  const sK = kSpreadPitRamp(gapK);
  const sHr = pitSpreadHrRamp(gapHr);

  const win: ValueWindow = {
    tier: fm.key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Infinity,
    eligible: (c: Record<string, unknown>) => rowEligible(c as unknown as Card, t),
  };
  const depsF: SampleDeps = { ...depsBase, coeffs: coeffsF, derived: derivedF, ref: refF, formats: [win] };
  const pre = buildCwhitSample(depsF);
  const post = buildCwhitSample({
    ...depsF,
    kSpreadPit: new Map<string, KSpreadPit>([[fm.key, { s: sK, mean: pm.k, sHr, meanHr: pm.hr }]]),
  });

  const postPit = new Map(post.recs.filter((r: Rec) => r.role === "pit").map((r: Rec) => [`${r.title}|${r.vlvl}`, r]));
  const paired = pre.recs
    .filter((r: Rec) => r.role === "pit" && wellSampled(r) && postPit.has(`${r.title}|${r.vlvl}`))
    .map((r: Rec) => ({ pre: r.oursDep, post: postPit.get(`${r.title}|${r.vlvl}`)!.oursDep, obs: r.obs, bf: r.sample }));

  // HITTER BIT-IDENTITY. C3 and the HR ramp are PITCHER-ONLY. If any hitter line moves, a pitcher
  // correction has leaked across roles — which is a STOP regardless of what the pitcher gates say.
  const postHit = new Map(post.recs.filter((r: Rec) => r.role === "hit").map((r: Rec) => [`${r.title}|${r.vlvl}`, r]));
  let hitN = 0, hitMaxAbs = 0;
  for (const r of pre.recs.filter((x: Rec) => x.role === "hit")) {
    const q = postHit.get(`${r.title}|${r.vlvl}`); if (!q) continue;
    hitN++;
    for (const k of ["hr600", "bbPct", "babip", "soPctPerPa", "woba"] as const) {
      const a = (r.oursDep as Record<string, number | undefined>)[k], b = (q.oursDep as Record<string, number | undefined>)[k];
      if (Number.isFinite(a) && Number.isFinite(b)) hitMaxAbs = Math.max(hitMaxAbs, Math.abs((a as number) - (b as number)));
    }
  }

  const kRows = paired.filter((p) => Number.isFinite(p.pre.k9) && Number.isFinite(p.obs.k9!));
  const hrRows = paired.filter((p) => Number.isFinite(p.pre.hr9) && Number.isFinite(p.obs.hr9!));
  const wRows = paired.filter((p) => Number.isFinite(p.pre.woba) && Number.isFinite(p.obs.woba!));

  const slopeCI = (get: (x: typeof paired[0]) => { p: number; o: number }, set: typeof paired, seed: number) => {
    const r2 = rng(seed); const out: number[] = [];
    const P = set.map((x) => get(x).p), O = set.map((x) => get(x).o);
    for (let b = 0; b < B; b++) {
      const idx = set.map(() => Math.floor(r2() * set.length));
      out.push(slopeOf(idx.map((i) => P[i]!), idx.map((i) => O[i]!)));
    }
    return ci(out.filter(Number.isFinite));
  };

  const kPre = kRows.length ? mmse(kRows.map((r) => r.pre.k9!), kRows.map((r) => r.obs.k9!), kRows.map((r) => per9NoiseVar(r.obs.k9!, r.bf))).slope.est : NaN;
  const kPost = kRows.length ? mmse(kRows.map((r) => r.post.k9!), kRows.map((r) => r.obs.k9!), kRows.map((r) => per9NoiseVar(r.obs.k9!, r.bf))).slope.est : NaN;
  const hrPre = hrRows.length ? mmse(hrRows.map((r) => r.pre.hr9!), hrRows.map((r) => r.obs.hr9!), hrRows.map((r) => per9NoiseVar(r.obs.hr9!, r.bf))).slope.est : NaN;
  const hrPost = hrRows.length ? mmse(hrRows.map((r) => r.post.hr9!), hrRows.map((r) => r.obs.hr9!), hrRows.map((r) => per9NoiseVar(r.obs.hr9!, r.bf))).slope.est : NaN;

  // G2 — the COMPOSITE ORDERING gate. A spread correction must never cost ordering; BUILD-1 shipped
  // with a gold-quick G2 failure under an overrule, so this is re-measured on the new ramp rather
  // than inherited. The CI is on the PAIRED difference, which shares the observed series and so
  // cancels its sampling noise — the standing convention for a corr delta.
  const corrPre = wRows.length > 3 ? corrOf(wRows.map((r) => r.pre.woba!), wRows.map((r) => r.obs.woba!)) : NaN;
  const corrPost = wRows.length > 3 ? corrOf(wRows.map((r) => r.post.woba!), wRows.map((r) => r.obs.woba!)) : NaN;
  let dCorrCI = { lo: NaN, hi: NaN };
  if (wRows.length > 3) {
    const r4 = rng(SEED + 500 + fi); const d: number[] = [];
    const A_ = wRows.map((r) => r.pre.woba!), Bv = wRows.map((r) => r.post.woba!), O = wRows.map((r) => r.obs.woba!);
    for (let b = 0; b < B; b++) {
      const idx = wRows.map(() => Math.floor(r4() * wRows.length));
      d.push(corrOf(idx.map((i) => Bv[i]!), idx.map((i) => O[i]!)) - corrOf(idx.map((i) => A_[i]!), idx.map((i) => O[i]!)));
    }
    dCorrCI = ci(d.filter(Number.isFinite));
  }

  rows.push({
    key: fm.key, label: fm.label, tid, stratum: STRATUM[tid] ?? "?",
    poolN: basePool.length, joined: pre.recs.filter((r: Rec) => r.role === "pit").length, judged: kRows.length,
    gapK, gapHr, sK, sHr, clamped: gapK > K_SPREAD_PIT.gMax,
    kPre, kPost, kCI: kRows.length > 3 ? slopeCI((x) => ({ p: x.post.k9!, o: x.obs.k9! }), kRows, SEED + fi) : { lo: NaN, hi: NaN },
    hrPre, hrPost, hrCI: hrRows.length > 3 ? slopeCI((x) => ({ p: x.post.hr9!, o: x.obs.hr9! }), hrRows, SEED + 200 + fi) : { lo: NaN, hi: NaN },
    corrPre, corrPost, dCorrCI,
    kLvPre: kRows.length ? mean(kRows.map((r) => r.pre.k9! - r.obs.k9!)) : NaN,
    kLvPost: kRows.length ? mean(kRows.map((r) => r.post.k9! - r.obs.k9!)) : NaN,
    hrLvPre: hrRows.length ? mean(hrRows.map((r) => r.pre.hr9! - r.obs.hr9!)) : NaN,
    hrLvPost: hrRows.length ? mean(hrRows.map((r) => r.post.hr9! - r.obs.hr9!)) : NaN,
    hitIdentical: hitMaxAbs === 0, hitN, hitMaxAbs,
    notices: [...pre.notices, ...post.notices].filter((n) => !n.includes("projection join")),
  });
}

// ── verdicts ──────────────────────────────────────────────────────────────────
const thin = (r: Row) => r.judged < THIN_N;
const g1k = (r: Row) => (thin(r) ? "THIN" : r.kCI.lo <= 1 && 1 <= r.kCI.hi ? "PASS" : "FAIL");
const g1hr = (r: Row) => (thin(r) ? "THIN" : r.hrCI.lo <= 1 && 1 <= r.hrCI.hi ? "PASS" : "FAIL");
/** G2 passes if the correlation does not drop CI-CLEARLY. A drop whose CI covers 0 is noise. */
const g2 = (r: Row) => (thin(r) ? "THIN" : !Number.isFinite(r.dCorrCI.lo) ? "n/a" : r.corrPost >= r.corrPre || (r.dCorrCI.lo <= 0 && 0 <= r.dCorrCI.hi) ? "PASS" : "FAIL");
const roleLeak = rows.filter((r) => !r.hitIdentical);

const stratumOf = (s: string) => rows.filter((r) => r.stratum === s);
const failsIn = (s: string, g: (r: Row) => string) => stratumOf(s).filter((r) => g(r) === "FAIL");

// THE BLOCKING SET. Stratum A is the CORE and its failures block. B and C carry layers that are not
// built (era, composition), so a failure there localises to that layer — it is reported in full and
// is NOT a ship blocker, exactly as amendment A1.3 and A2.4 require. G2 and role-leak block
// EVERYWHERE: an ordering loss or a pitcher correction reaching hitters is a defect in any stratum.
const blocking: string[] = [];
for (const r of stratumOf("A")) {
  if (g1k(r) === "FAIL") blocking.push(`G1-K FAIL in stratum A: ${lbl(r.label)} post ${f(r.kPost, 2)} [${f(r.kCI.lo, 2)},${f(r.kCI.hi, 2)}]`);
  if (g1hr(r) === "FAIL") blocking.push(`G1-HR FAIL in stratum A: ${lbl(r.label)} post ${f(r.hrPost, 2)} [${f(r.hrCI.lo, 2)},${f(r.hrCI.hi, 2)}]`);
}
for (const r of rows) if (g2(r) === "FAIL") blocking.push(`G2 ORDERING FAIL: ${lbl(r.label)} corr ${f(r.corrPre, 4)} → ${f(r.corrPost, 4)} (Δ CI ${sgn(r.dCorrCI.lo, 4)},${sgn(r.dCorrCI.hi, 4)})`);
for (const r of roleLeak) blocking.push(`ROLE LEAK: ${lbl(r.label)} hitter lines moved by up to ${r.hitMaxAbs.toExponential(1)} under a PITCHER-only correction`);

const VERDICT = blocking.length ? `STOP — ${blocking.length} blocking failure(s)` : "PASS — no blocking failure in the shipping state";

say("################################################################################");
say(`# C6 — FULL GATE SWEEP ON EVERYTHING SHIPPING.  VERDICT: ${VERDICT}`);
say("# Tool: tools/c6-gate-sweep.ts. EVALUATION ONLY — fits nothing, wires nothing, changes no");
say("# constant. It reads the SHIPPED constants and measures whether THEY pass.");
say("################################################################################");
say();
say("### WHAT IS BEING GATED, AND WHAT IS NOT");
say();
say(`  SHIPPED, and under test here:`);
say(`    K_SPREAD_PIT   { A: ${K_SPREAD_PIT.A}, q: ${K_SPREAD_PIT.q}, G0: ${K_SPREAD_PIT.G0}, gMax: ${K_SPREAD_PIT.gMax} }   s(g>gMax) = ${f(kSpreadPitRamp(K_SPREAD_PIT.gMax), 4)} (flat hold)`);
say(`    PIT_SPREAD_HR  { A: ${PIT_SPREAD_HR.A}, G: ${PIT_SPREAD_HR.G} }   — UNCHANGED by this event, but re-gated:`);
say(`      its gate record was established at the PRE-C1/C2' coordinate and on the PRE-C3 K baseline.`);
say(`      C1/C2' moved the coordinate; C3 replaced the K ramp. A rule inherited across a coordinate`);
say(`      change is a defect until re-derived (intent contract clause 4), so it is re-derived here.`);
say(`    fit provenance   fitN ${K_SPREAD_PIT.fitN} · fitP ${K_SPREAD_PIT.fitP} — asserted at scoring-core load against`);
say(`      FIELD_N = ${FIELD_N} and PRESENCE_P = ${PRESENCE_P}. This run imported the scoring core, so that assertion PASSED.`);
say();
say(`  NOT under test: the BABIP scalar (never set in production — held at the bronze G1 fail) and`);
say(`  the BUILD-2 hitter tail (dormant behind Tournament.hitTailCorrection, no default flip).`);
say();
say("### HEADER");
say(`  date        2026-07-22`);
say(`  model       '${trained.id}'`);
say(`  catalog     '${srcId}'   (${baseCards.length} base cards)`);
say(`  formats     ${rows.length} of ${CWHIT_CORPUS.length} in the corpus REGISTRY, resolved by tournamentId — never by the`);
say(`              optional legacySlug, which is what made 5 of 14 formats unreachable until b4dc2ed`);
if (skipped.length) { say(`  NOT REACHED (${skipped.length}), named rather than left out of the denominator:`); for (const sk of skipped) say(`              · ${sk}`); }
else say(`              every registry format was reached — the coverage claim and the reach agree`);
say(`  bars        BF ≥ ${MIN_BF};  THIN_N = ${THIN_N} (a thin cell carries NO verdict, and that is not a pass)`);
say(`  bootstrap   B = ${B}, SEED = ${SEED}`);
say(`  grain       observed at ROW grain = (card × variant level); pool constants at CARD grain`);
say();
say("### THE GATES");
say();
say("  G1-K    post-correction K9 calibration slope CI must cover 1.");
say("  G1-HR   post-correction HR9 calibration slope CI must cover 1.");
say("  G2      composite wOBAA ORDERING must not drop CI-clearly. A spread correction that buys");
say("          calibration with ordering is not an improvement. BUILD-1 shipped with a gold-quick G2");
say("          failure under an overrule; the ramp has since been replaced, so it is re-measured, not");
say("          inherited. The CI is on the PAIRED difference — the observed series is shared and its");
say("          sampling noise cancels.");
say("  LEAK    hitter lines must be BIT-IDENTICAL pre vs post. Both corrections are pitcher-only, so");
say("          any hitter movement is a correction crossing roles — a STOP whatever the pitcher gates say.");
say();
say("  BLOCKING vs REPORTED, decided in advance by the stratification (A1.3 / A2.4), not after the");
say("  numbers: stratum A is the CORE and its G1 failures BLOCK. Strata B and C carry the era and");
say("  composition layers, which are NOT BUILT (tasks 1 and 2) — a failure there localises to the");
say("  missing layer and is reported in full without blocking. G2 and LEAK block in EVERY stratum.");
say();

say("### 1. THE SWEEP");
say();
say(`  format                 str  poolN  joined  judged   gapK   s_K     gapHR  s_HR    G1-K                    G1-HR                   G2`);
for (const r of rows) {
  say(`  ${pad(lbl(r.label), 22)} ${pad(r.stratum, 4)} ${rpad(String(r.poolN), 5)}  ${rpad(String(r.joined), 6)}  ${rpad(String(r.judged), 6)}  ${rpad(f(r.gapK, 1), 5)}  ${rpad(f(r.sK, 3), 6)}${r.clamped ? "*" : " "} ${rpad(f(r.gapHr, 1), 5)}  ${rpad(f(r.sHr, 3), 6)}  ${pad(`${f(r.kPre, 2)}→${f(r.kPost, 2)} [${f(r.kCI.lo, 2)},${f(r.kCI.hi, 2)}] ${g1k(r)}`, 23)} ${pad(`${f(r.hrPre, 2)}→${f(r.hrPost, 2)} [${f(r.hrCI.lo, 2)},${f(r.hrCI.hi, 2)}] ${g1hr(r)}`, 23)} ${g2(r)}`);
}
say(`  * = the gap exceeds gMax = ${K_SPREAD_PIT.gMax} and the DOMAIN RULE binds: s is held flat at ${f(kSpreadPitRamp(K_SPREAD_PIT.gMax), 3)}.`);
say();
say(`  G2 detail (composite wOBAA ordering — the gate a spread correction is most likely to cost):`);
say(`  format                 corr pre → post      Δ [95% CI]                verdict`);
for (const r of rows) {
  say(`  ${pad(lbl(r.label), 22)} ${f(r.corrPre, 4)} → ${f(r.corrPost, 4)}     ${pad(`${sgn(r.corrPost - r.corrPre, 4)} [${sgn(r.dCorrCI.lo, 4)},${sgn(r.dCorrCI.hi, 4)}]`, 24)}  ${g2(r)}`);
}
say();
say(`  LEVELS (pred − obs), pre → post. REPORTED, NOT GATED: both corrections are centred scalars, so`);
say(`  they move spread and leave the level to the anchor layer — which is ruling (z)'s whole point.`);
say(`  format                 K9 level            HR9 level`);
for (const r of rows) say(`  ${pad(lbl(r.label), 22)} ${pad(`${sgn(r.kLvPre, 2)} → ${sgn(r.kLvPost, 2)}`, 19)} ${sgn(r.hrLvPre, 3)} → ${sgn(r.hrLvPost, 3)}`);
say();
say(`  ROLE-LEAK CHECK — hitter lines under a pitcher-only correction:`);
say(`    ${rows.length} formats, ${rows.reduce((a, r) => a + r.hitN, 0)} hitter rows compared across five channels (HR600, BB%, BABIP, SO%, wOBA).`);
say(`    max |Δ| over ALL of them: ${Math.max(...rows.map((r) => r.hitMaxAbs)).toExponential(1)}   ⇒ ${roleLeak.length === 0 ? "BIT-IDENTICAL ✓ — no correction crossed roles" : `✗ ${roleLeak.length} FORMAT(S) LEAKED`}`);
say();

say("### 2. THE STRATIFIED READ (A1.3) — a defect attributes to the stratum where it FIRST appears");
say();
const STRATA: [string, string][] = [
  ["A", "NEUTRAL UNCAPPED QUICKS — THE CORE. These BLOCK."],
  ["A*", "NEUTRAL UNCAPPED NON-QUICK CONTROL"],
  ["B", "ENV-BEARING DAILIES (+ the era/park layer — NOT BUILT, task 1)"],
  ["C", "BUDGET CAP/SLOTS (+ the composition layer — NOT BUILT, task 2)"],
  ["B+C", "BOTH LAYERS — never a clean read of either"],
];
for (const [s, title] of STRATA) {
  const set = stratumOf(s);
  if (!set.length) continue;
  say(`  ${s} — ${title}`);
  for (const r of set) say(`      ${pad(lbl(r.label), 22)} G1-K ${pad(g1k(r), 5)} (${f(r.kPost, 2)})   G1-HR ${pad(g1hr(r), 5)} (${f(r.hrPost, 2)})   G2 ${g2(r)}`);
  const fk = failsIn(s, g1k).length, fh = failsIn(s, g1hr).length;
  say(`      ⇒ G1-K ${set.length - fk}/${set.length} pass · G1-HR ${set.length - fh}/${set.length} pass${s === "A" ? "  (BLOCKING)" : "  (reported, not blocking)"}`);
  say();
}

say("### 3. VERDICT");
say();
if (blocking.length) {
  say(`  STOP. ${blocking.length} blocking failure(s):`);
  for (const b of blocking) say(`    · ${b}`);
  say();
  say(`  Nothing is overruled here. Overrules are Fable's or Derek's, and this tool does not make them.`);
} else {
  say(`  PASS — no blocking failure. The shipping state clears every gate that blocks:`);
  say(`    · stratum A (the core): G1-K and G1-HR pass on every non-thin cell`);
  say(`    · G2 ordering: no CI-clear drop in ANY stratum`);
  say(`    · role leak: hitter lines bit-identical under both pitcher corrections`);
  say(`  Non-blocking residuals in strata B and C are listed above in full and attribute to the era`);
  say(`  and composition layers, which are not built. They are the expected signal, not a surprise.`);
}
say();
const allNotices = [...new Set(rows.flatMap((r) => r.notices))];
if (allNotices.length) {
  say(`  BUILDER NOTICES (${allNotices.length}), reproduced rather than filtered — the presence tripwire`);
  say(`  reports here when it is anything other than in-band:`);
  for (const n of allNotices.slice(0, 25)) say(`    · ${n}`);
}
say();
say(`(end of artifact — C6 gate sweep, ${VERDICT.split(" ")[0]})`);

process.stdout.write(L.join("\n") + "\n");
process.exit(0);
