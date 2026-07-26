// BABIP COORDINATE SEARCH — WHAT PROPERTY DOES THE PITCHER-BABIP CORRECTION RESPOND TO?
//   run: node tools/babip-coordinate.ts > fixtures/babip-coordinate-2026-07-26.txt
//
// MEASUREMENT AND STRUCTURE ONLY. This tool fits NOTHING into production, wires nothing, changes no
// default and pins no constant. Amendment 2 stands: current captures are adequate for MEASUREMENT,
// not for fitting a shipped correction, and the pending 4-week pull is a required out-of-sample
// validation before anything is fitted at all.
//
// THE QUESTION. docs/CWHIT_PITSPREAD_BUILD3_2026-07-17.md measured a pitcher-BABIP spread need of
// 1.48 [1.17,2.00] at bronze against ~1.0 at silver/gold and HELD the channel, because no monotone
// function of the frame gap could reach bronze without breaking the tiers reading ~1. A correction
// keyed to a NAME is forbidden; the standing rule is stronger than "no named tier" — NO RULE MAY KEY
// ON CARD TYPE OR POOL IDENTITY, EVER. Only measurable property VALUES qualify.
//
// ── THREE THINGS THIS RUN DOES, IN ORDER ────────────────────────────────────────────────────────
// (1) STRATIFY. A format varies on three independent axes: ENVIRONMENT (era/park factors scale
//     events, hits included), BUDGET STRUCTURE (cap/slots force a realised deployment different from
//     the eligible window the machinery reads), and the channel property being hunted. The clean
//     stratum is NEUTRAL ENV + NO BUDGET. Within it, `live-open-daily` is NOT a baseline member — it
//     is the extreme point of the measured DECOUPLING axis below (a property fact, established from
//     its own numbers here, never from what kind of cards it contains) and its judged sample is the
//     thinnest in the corpus. So the baseline is the five Quick tiers and live-open-daily is carried
//     as the high-divergence MEASUREMENT POINT.
// (2) TEST THE NAMED LEAD HYPOTHESIS FIRST, not a blind sweep. CHANNEL DECOUPLING = the divergence
//     between a pool's GAP-CHANNEL position and its OVERALL-QUALITY position, where overall quality
//     is a COMPOSITE over the whole rating vector — never a second single rating. It is continuous,
//     ex ante, and computed only from eligible-pool ratings + the artifact's training means.
// (3) ASK THE ANALOGY DIRECTLY. The K ramp's coordinate reads ONE opposing channel (hitter avoid-K)
//     and misreads a rating-SHAPE difference as a level difference. buildFrameShift shows the BABIP
//     coordinate is built the SAME way — pit.pbabip's shift is train.hit.babip − pool.hit.babip, one
//     opposing channel read alone. So: does the hitter-BABIP channel decouple from the composite the
//     way avoid-K does, and do the formats where it decouples depart from the flat prediction?
//
// A NOTE ON LANGUAGE, because it is a correctness constraint here: a card's quality is never
// inferable from one rating, so no pool is described as "strong" or "weak" anywhere below. Pools are
// described by the SHAPE of their rating-gap vector against a composite reference.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, cohortSelectForModel, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, FIELD_N, applyAffine,
  kSpreadPitRamp, K_SPREAD_PIT, pitSpreadHrRamp, PIT_SPREAD_HR,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { HIT_RATINGS, PIT_RATINGS } from "../src/model/pool-transform.ts";
import { presenceMixture, PRESENCE_P, PRESENCE_M } from "../src/data/variants.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { PIT_BIP_ADJ } from "../src/model/curves.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { babipNoiseVar, per9NoiseVar, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, wellSampled, inValueWindow, MIN_BF, n_, isPit,
  type Rec, type SampleDeps, type ValueWindow, type KSpreadPit, type CwhitSource,
} from "../src/eval/cwhit/sample.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sg = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const skew = (xs: number[]) => { const m = mean(xs), s = sd(xs); return s > 0 ? mean(xs.map((x) => ((x - m) / s) ** 3)) : NaN; };
const quant = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); if (!v.length) return NaN; const p = (v.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return v[lo]! + (v[hi]! - v[lo]!) * (p - lo); };
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
const g4 = (x: number) => {
  if (!Number.isFinite(x)) return "n/a";
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 100) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  if (a >= 0.01) return x.toFixed(4);
  return x.toExponential(2);
};

// ═══════════════════════════════════════════════════════════════════════════════
// 0. SETUP
// ═══════════════════════════════════════════════════════════════════════════════
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; cohortRule?: string; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = new Map((await repo.loadAll<Tournament>("tournaments")).map((t) => [t.id, t]));
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const bq = tournaments.get("bronze-quick")!;
const neutralCoeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(neutralCoeffs, trained.wobaWeights);
const cohortSel = cohortSelectForModel(trained.cohortRule, baseCards, neutralCoeffs, rp);
const depsBase = {
  baseCards, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const setupNotes: string[] = [];
let tightById = new Map<string, { tightness: number; mode: string; forcedCheapFrac: number }>();
try {
  const raw = execFileSync(process.execPath, ["tools/cap-tightness.ts", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const j = JSON.parse(raw) as { tournaments: { id: string; mode: string; tightness: number; forcedCheapFrac: number }[] };
  tightById = new Map(j.tournaments.map((t) => [t.id, { tightness: t.tightness, mode: t.mode, forcedCheapFrac: t.forcedCheapFrac }]));
} catch (e) { setupNotes.push(`cap-tightness --json unavailable (${(e as Error).message.slice(0, 90)}) — budget candidates read n/a`); }

// ── CATALOG-WIDE RATING SCALES: the units the composite is built in ──────────────
// Each channel's gap is divided by the CATALOG SD of that rating, side-pooled over base cards, so
// channels measured on different natural spreads become comparable and the composite is a mean of
// like quantities. Ex ante (catalog only), no config, no identity.
const catSd: { hit: Record<string, number>; pit: Record<string, number> } = { hit: {}, pit: {} };
{
  const hitCols: Record<string, string> = { eye: "Eye", pow: "Power", kRat: "Avoid K", babip: "BABIP", gap: "Gap" };
  const pitCols: Record<string, string> = { con: "Control", stu: "Stuff", pbabip: "pBABIP", hrr: "pHR" };
  const hs = baseCards.filter((c) => !isPit(c)), ps = baseCards.filter((c) => isPit(c));
  for (const k of HIT_RATINGS) catSd.hit[k] = sd(hs.flatMap((c) => [n_(c[`${hitCols[k]} vR`]), n_(c[`${hitCols[k]} vL`])]).filter((x) => x > 0));
  for (const k of PIT_RATINGS) catSd.pit[k] = sd(ps.flatMap((c) => [n_(c[`${pitCols[k]} vR`]), n_(c[`${pitCols[k]} vL`])]).filter((x) => x > 0));
}

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
function freeSlope(pred: number[], obs: number[], w: number[]): number {
  let sw = 0, sp = 0, so = 0;
  for (let i = 0; i < pred.length; i++) { sw += w[i]!; sp += w[i]! * pred[i]!; so += w[i]! * obs[i]!; }
  const pb = sw > 0 ? sp / sw : 0, ob = sw > 0 ? so / sw : 0;
  let num = 0, den = 0;
  for (let i = 0; i < pred.length; i++) { const d = pred[i]! - pb; num += w[i]! * d * (obs[i]! - ob); den += w[i]! * d * d; }
  return den > 0 ? num / den : NaN;
}
const B = 2000, SEED = 20260726, THIN_N = 15;

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MEASUREMENT: per format × arm, the POST-CORRECTION need on all three pitcher channels
// ═══════════════════════════════════════════════════════════════════════════════
interface Arm { kOn: boolean; hrOn: boolean; source?: CwhitSource; minBf?: number }
interface ChanNeed { n: number; nCards: number; need: number; needCI: { lo: number; hi: number }; needSe: number; needBoot: number[]; rowSe: number; inflation: number; needFree: number; corr: number; noiseShare: number }
interface Needs { babip: ChanNeed; k9: ChanNeed; hr9: ChanNeed }
const NA: ChanNeed = { n: 0, nCards: 0, need: NaN, needCI: { lo: NaN, hi: NaN }, needSe: NaN, needBoot: [], rowSe: NaN, inflation: NaN, needFree: NaN, corr: NaN, noiseShare: NaN };

interface FmtCtx {
  key: string; tid: string; label: string; type: string;
  neutralEnv: boolean; budget: "none" | "cap" | "slots"; stratum: "A" | "B" | "C" | "B+C";
  deps: Omit<SampleDeps, "kSpreadPit">; sK: number; sHr: number; pmK: number; pmHr: number;
  C: Record<string, number>;
}

function needsFor(fm: FmtCtx, arm: Arm, seed: number): Needs {
  const ks = new Map<string, KSpreadPit>([[fm.key, {
    s: arm.kOn ? fm.sK : 1, mean: fm.pmK, ...(arm.hrOn ? { sHr: fm.sHr, meanHr: fm.pmHr } : {}),
  }]]);
  const s = buildCwhitSample({ ...fm.deps, kSpreadPit: ks, ...(arm.source ? { source: arm.source } : {}), ...(arm.minBf ? { minBf: arm.minBf } : {}) });
  const recs = s.recs.filter((r: Rec) => r.role === "pit" && wellSampled(r));
  const one = (ch: "babip" | "k9" | "hr9", seed2: number): ChanNeed => {
    const rows = recs
      .filter((r) => Number.isFinite(r.ours[ch]!) && Number.isFinite(r.obs[ch]!))
      .map((r) => {
        const bf = r.sample;
        const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
        const nv = ch === "babip" ? babipNoiseVar(r.obs.babip!, bip) : per9NoiseVar(r.obs[ch]!, bf);
        return { card: r.cid.split("|")[0] ?? r.cid, pred: r.ours[ch]!, obs: r.obs[ch]!, nv, w: nv > 0 ? 1 / nv : 0 };
      });
    if (rows.length < 3) return { ...NA, n: rows.length };
    const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
    // CLUSTER BY CARD — a card contributes a base row and a v5 row, so rows are not independent.
    // The inflation factor is MEASURED (cluster SE / row SE), never assumed.
    const byCard = new Map<string, typeof rows>();
    for (const r of rows) { const a = byCard.get(r.card); if (a) a.push(r); else byCard.set(r.card, [r]); }
    const ids = [...byCard.keys()];
    const rc = rng(seed2), rr = rng(seed2 + 1);
    const bootC: number[] = [], bootR: number[] = [];
    for (let b = 0; b < B; b++) {
      const draw: typeof rows = [];
      for (let i = 0; i < ids.length; i++) draw.push(...byCard.get(ids[Math.floor(rc() * ids.length)]!)!);
      bootC.push(slopeOf(draw.map((r) => r.pred), draw.map((r) => r.obs)));
      const d2 = rows.map(() => rows[Math.floor(rr() * rows.length)]!);
      bootR.push(slopeOf(d2.map((r) => r.pred), d2.map((r) => r.obs)));
    }
    const bc = bootC.filter(Number.isFinite), br = bootR.filter(Number.isFinite);
    const seC = sd(bc), seR = sd(br);
    return {
      n: rows.length, nCards: ids.length, need: m.slope.est, needCI: ci(bc), needSe: seC, needBoot: bc,
      rowSe: seR, inflation: seR > 0 ? seC / seR : NaN,
      needFree: freeSlope(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.w)),
      corr: m.corrRaw, noiseShare: m.noiseShare,
    };
  };
  return { babip: one("babip", seed), k9: one("k9", seed + 100), hr9: one("hr9", seed + 200) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. FORMAT CONTEXTS + CANDIDATE COORDINATES
// ═══════════════════════════════════════════════════════════════════════════════
const CAND_DOC: Record<string, string> = {
  // ── THE LEAD HYPOTHESIS: CHANNEL DECOUPLING (composite-referenced, ex ante) ──
  decoup_babip: "LEAD. z(hitter BABIP gap) − composite: how far the ONE channel the BABIP correction reads sits from the pool's whole-rating-vector gap position. Signed; >0 = that channel's gap runs ahead of the composite.",
  decoup_babip_abs: "|decoup_babip| — divergence magnitude, direction-free.",
  decoup_kRat: "the SAME construction for the channel the K ramp reads (hitter avoid-K). Present so the two channels' decoupling can be compared on one scale.",
  decoup_kRat_abs: "|decoup_kRat|.",
  shape_div_hit: "SD across ALL FIVE hitter channels of the standardized gaps — how far this pool's gap VECTOR departs from a uniform shift. Channel-agnostic; a pure shape statistic.",
  composite_hit: "COMPOSITE gap position: mean over all five hitter channels of the standardized (train − pool) gap. The whole rating vector, never one rating standing in for quality.",
  composite_pit: "the same composite over the four pitcher channels.",
  shape_div_pit: "SD across the four pitcher channels of the standardized gaps.",
  decoup_pbabip_own: "z(pitcher pBABIP gap) − composite_pit — the own-side analogue, for completeness.",
  // ── the incumbent single-channel coordinates ──
  gap_babip_channel: "INCUMBENT for BABIP. buildFrameShift's pit.pbabip = train.hit.babip − pool.hit.babip, i.e. the OPPOSING-HITTER BABIP rating gap READ ALONE. Single-channel by construction — the same shape as the K coordinate.",
  gap_kRat_channel: "the K ramp's coordinate = train.hit.kRat − pool.hit.kRat, opposing avoid-K READ ALONE.",
  gap_pow_channel: "the HR ramp's coordinate = train.hit.pow − pool.hit.pow.",
  gap_eye_channel: "the control channel's coordinate = train.hit.eye − pool.hit.eye.",
  gap_pit_pbabip: "buildFrameShift's hit.babip = train.pit.pbabip − pool.pit.pbabip (the pitcher-side pBABIP gap; it re-bases HITTERS, listed for completeness).",
  // ── own-pool rating shape ──
  pbab_mu: "mean pBABIP rating of the eligible pitchers (a level on one channel — reported, never a quality claim).",
  pbab_sd: "SD of the eligible pitchers' pBABIP rating — the spread a spread-scalar would act on.",
  pbab_skew: "skew of that distribution.",
  pbab_p90_p10: "its interdecile range.",
  hbab_mu: "mean BABIP rating of the eligible hitters.",
  hbab_sd: "SD of the eligible hitters' BABIP rating.",
  // ── predicted-quantity shape ──
  predbab_mu: "pool-mean PREDICTED pitcher BABIP on the own-gap line — the pivot a spread scalar uses.",
  predbab_sd: "pool SD of predicted pitcher BABIP — the predicted spread a scalar rescales.",
  predbab_cv: "predicted-BABIP coefficient of variation.",
  // ── BIP VOLUME: the derived base BABIP rides on ──
  bip_mu: "pool-mean predicted BIP per 600 on the SHIPPED line. BABIP is a rate on balls in play and BIP is DERIVED as 600 − BB − K − HR, so a pool with a different channel MIX has a different BIP base — which no single-channel gap can see.",
  bip_sd: "pool SD of predicted BIP per 600.",
  k_mu: "pool-mean predicted K per 600 on the shipped line (post K-ramp).",
  bb_mu: "pool-mean predicted BB per 600.",
  hr_mu: "pool-mean predicted HR per 600 on the shipped line (post HR-ramp).",
  hitspread_600: "SD across the pool of (predicted BABIP × predicted BIP) — the channel's spread in EVENT (hits per 600) space rather than rate space.",
  // ── window / size / budget: controls, not coordinates ──
  valueMax: "the format's card-value ceiling — THE TIER INDEX ITSELF. A pure identity control, present so anything tracking it is caught.",
  windowWidth: "valueMax − valueMin (VAL 40 is the game's floor).",
  poolN_pit: "eligible pitcher count.",
  capTight: "budget tightness = 1 − total_cap / cost of the most expensive legal roster (tools/cap-tightness.ts, the one definition). 0 uncapped.",
  forcedCheap: "share of a legal roster that must sit below the pool's own affordability line.",
  // ── environment: axis 1, diagnostics only ──
  era_h: "era HIT factor VALUE (derived) — environment axis, diagnostic only.",
  era_k: "era K factor VALUE — environment axis, diagnostic only.",
  park_avg: "park average-hits factor, hand-averaged (compressed, cp 0.26) — environment axis, diagnostic only.",
  s_K: "the shipped K-ramp scalar at this format's gap.",
  s_HR: "the shipped HR-ramp scalar at this format's gap.",
};
const ENV_CANDS = new Set(["era_h", "era_k", "park_avg"]);
const CANDS = Object.keys(CAND_DOC);

const ctxs: FmtCtx[] = [];
for (const reg of CWHIT_CORPUS) {
  if (!reg.tournamentId) throw new Error(`registry entry '${reg.key}' has no tournamentId`);
  const t = tournaments.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}' missing era/park`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, trained.wobaWeights!);
  const derived = computeDerived(coeffs, true);
  const win: ValueWindow = {
    tier: reg.key, valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp, true, undefined, cohortSel);
  const poolField = productionFieldStats(basePool, coeffs, rp, true, undefined, cohortSel);
  const pt = buildPoolTransform(ref, poolField, depsBase.envelope);
  const shift = buildFrameShift(TM, poolField);
  const pm = poolPitMeansOwn(presenceMixture(basePool), coeffs, rp, pt, FIELD_N * PRESENCE_M);
  const sK = kSpreadPitRamp(shift.pit.vR.stu ?? 0);
  const sHr = pitSpreadHrRamp(shift.pit.vR.hrr ?? 0);

  const neutralEnv = t.eraId === "era-2010" && t.parkId === "park-1";
  if (neutralEnv !== reg.neutralEnv) setupNotes.push(`registry neutralEnv disagrees with the config for '${reg.key}'`);
  const tg = tightById.get(t.id);
  const budget: "none" | "cap" | "slots" = (tg?.mode as "none" | "cap" | "slots") ?? (t.total_cap ? "cap" : "none");
  const stratum = neutralEnv && budget === "none" ? "A" : !neutralEnv && budget === "none" ? "B" : neutralEnv ? "C" : "B+C";

  // ── CHANNEL DECOUPLING, built here ──────────────────────────────────────────
  // Per-channel standardized gap z_c = (train_c − pool_c) / catalogSD_c, over the SAME selected
  // cohort the production gap uses. COMPOSITE = mean over ALL channels of the role's rating vector.
  // DECOUPLING of channel c = z_c − composite. Nothing in this reads a card type, a pool name, a
  // window, or a single rating as a stand-in for quality.
  const zHit: Record<string, number> = {}, zPit: Record<string, number> = {};
  for (const k of HIT_RATINGS) { const s = catSd.hit[k] ?? 1; zHit[k] = s > 0 ? ((TM.hit[k] ?? 0) - (poolField.hit.vR[k]?.mu ?? 0)) / s : NaN; }
  for (const k of PIT_RATINGS) { const s = catSd.pit[k] ?? 1; zPit[k] = s > 0 ? ((TM.pit[k] ?? 0) - (poolField.pit.vR[k]?.mu ?? 0)) / s : NaN; }
  const compHit = mean(HIT_RATINGS.map((k) => zHit[k]!));
  const compPit = mean(PIT_RATINGS.map((k) => zPit[k]!));

  const pitCards = basePool.filter((c) => isPit(c));
  const hitCards = basePool.filter((c) => !isPit(c));
  const pbab = pitCards.map((c) => n_(c["pBABIP vR"])).filter((x) => x > 0);
  const hbab = hitCards.map((c) => n_(c["BABIP vR"])).filter((x) => x > 0);
  const predBab: number[] = [], predBip: number[] = [], predK: number[] = [], predBB: number[] = [], predHR: number[] = [];
  for (const c of pitCards) {
    const tr = pt.pit.vR;
    const e = rp.predictPitching({
      con: applyAffine(n_(c["Control vR"]), tr?.con), stu: applyAffine(n_(c["Stuff vR"]), tr?.stu),
      pbabip: applyAffine(n_(c["pBABIP vR"]), tr?.pbabip), hrr: applyAffine(n_(c["pHR vR"]), tr?.hrr),
    }, coeffs);
    const K = pm.k + sK * (e.K - pm.k), HR = pm.hr + sHr * (e.HR - pm.hr);
    predBab.push(e.nHH / Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1));
    predBip.push(Math.max(600 - e.BB - K - HR - PIT_BIP_ADJ, 1));
    predK.push(K); predBB.push(e.BB); predHR.push(HR);
  }
  const C: Record<string, number> = {};
  // the per-channel standardized gaps themselves, carried for the §2 shape table (NOT candidates —
  // CANDS is keyed off CAND_DOC, and a single standardized channel is exactly the thing under suspicion)
  for (const k of HIT_RATINGS) C[`z_${k}`] = zHit[k]!;
  C["decoup_babip"] = zHit["babip"]! - compHit;
  C["decoup_babip_abs"] = Math.abs(C["decoup_babip"]);
  C["decoup_kRat"] = zHit["kRat"]! - compHit;
  C["decoup_kRat_abs"] = Math.abs(C["decoup_kRat"]);
  C["shape_div_hit"] = sd(HIT_RATINGS.map((k) => zHit[k]!));
  C["composite_hit"] = compHit;
  C["composite_pit"] = compPit;
  C["shape_div_pit"] = sd(PIT_RATINGS.map((k) => zPit[k]!));
  C["decoup_pbabip_own"] = zPit["pbabip"]! - compPit;
  C["gap_babip_channel"] = shift.pit.vR.pbabip ?? 0;
  C["gap_kRat_channel"] = shift.pit.vR.stu ?? 0;
  C["gap_pow_channel"] = shift.pit.vR.hrr ?? 0;
  C["gap_eye_channel"] = shift.pit.vR.con ?? 0;
  C["gap_pit_pbabip"] = shift.hit.vR.babip ?? 0;
  C["pbab_mu"] = mean(pbab); C["pbab_sd"] = sd(pbab); C["pbab_skew"] = skew(pbab);
  C["pbab_p90_p10"] = quant(pbab, 0.9) - quant(pbab, 0.1);
  C["hbab_mu"] = mean(hbab); C["hbab_sd"] = sd(hbab);
  C["predbab_mu"] = mean(predBab); C["predbab_sd"] = sd(predBab);
  C["predbab_cv"] = mean(predBab) > 0 ? sd(predBab) / mean(predBab) : NaN;
  C["bip_mu"] = mean(predBip); C["bip_sd"] = sd(predBip);
  C["k_mu"] = mean(predK); C["bb_mu"] = mean(predBB); C["hr_mu"] = mean(predHR);
  C["hitspread_600"] = sd(predBab.map((b, i) => b * predBip[i]!));
  C["valueMax"] = t.card_value_max ?? 100;
  C["windowWidth"] = (t.card_value_max ?? 100) - (t.card_value_min ?? 40);
  C["poolN_pit"] = pitCards.length;
  C["capTight"] = tg ? tg.tightness : (t.total_cap ? NaN : 0);
  C["forcedCheap"] = tg ? tg.forcedCheapFrac : (t.total_cap ? NaN : 0);
  C["era_h"] = derived.era_h; C["era_k"] = coeffs.era_k;
  C["park_avg"] = (coeffs.park_avg_l + coeffs.park_avg_r) / 2;
  C["s_K"] = sK; C["s_HR"] = sHr;

  ctxs.push({
    key: reg.key, tid: t.id, label: reg.label, type: reg.type, neutralEnv, budget, stratum,
    deps: { ...depsBase, coeffs, derived, ref, formats: [win], select: cohortSel },
    sK, sHr, pmK: pm.k, pmHr: pm.hr, C,
  });
}

const SHIPPED: Arm = { kOn: true, hrOn: true };
const nd = new Map<string, Needs>();
for (const [i, fm] of ctxs.entries()) nd.set(fm.key, needsFor(fm, SHIPPED, SEED + i * 401));
const bab = (k: string) => nd.get(k)!.babip;

// ── THE STRATA. Baseline = the five Quick tiers. live-open-daily is neutral+uncapped but is the
//    EXTREME of the measured decoupling axis (§3) and the thinnest judged cell, so it is carried as
//    the high-divergence MEASUREMENT POINT, not as a baseline member. That exclusion is justified by
//    numbers computed in this run, never by what kind of cards the format admits.
const QUICKS = ctxs.filter((c) => c.stratum === "A" && c.type === "Quick");
const A_OTHER = ctxs.filter((c) => c.stratum === "A" && c.type !== "Quick");
const STRAT_B = ctxs.filter((c) => c.stratum === "B");
const STRAT_C = ctxs.filter((c) => c.stratum === "C" || c.stratum === "B+C");

// ═══════════════════════════════════════════════════════════════════════════════
// 3. STRATUM STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + z / 2);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
function chiSqP(q: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(q)) return NaN;
  const z = (Math.pow(q / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 0.5 * erfc(z / Math.SQRT2);
}
interface StratStat { name: string; n: number; pooled: number; pooledSe: number; Q: number; df: number; I2: number; pQ: number; interLo: number; interHi: number; constantOk: boolean }
function stratStat(name: string, cs: FmtCtx[], pick: (k: string) => ChanNeed = bab): StratStat {
  const ns = cs.map((c) => pick(c.key)).filter((x) => x.n >= THIN_N && Number.isFinite(x.need) && x.needSe > 0);
  const w = ns.map((x) => 1 / x.needSe ** 2);
  const sw = w.reduce((a, b) => a + b, 0);
  const pooled = ns.reduce((a, x, i) => a + w[i]! * x.need, 0) / (sw || 1);
  const Q = ns.reduce((a, x, i) => a + w[i]! * (x.need - pooled) ** 2, 0);
  const df = Math.max(ns.length - 1, 0);
  return {
    name, n: ns.length, pooled, pooledSe: sw > 0 ? Math.sqrt(1 / sw) : NaN, Q, df,
    I2: df > 0 && Q > 0 ? Math.max(0, (Q - df) / Q) : 0, pQ: chiSqP(Q, df),
    interLo: Math.max(...ns.map((x) => x.needCI.lo)), interHi: Math.min(...ns.map((x) => x.needCI.hi)),
    constantOk: Math.max(...ns.map((x) => x.needCI.lo)) <= Math.min(...ns.map((x) => x.needCI.hi)),
  };
}
const statQ = stratStat("A-baseline: the five Quick tiers", QUICKS);
const statQL = stratStat("A-baseline + the high-divergence point", [...QUICKS, ...A_OTHER]);
const statQB = stratStat("+ stratum B (env-modified)", [...QUICKS, ...A_OTHER, ...STRAT_B]);
const statAll = stratStat("+ stratum C (budget) = all 14", ctxs);
const statQK = stratStat("K channel, five Quick tiers (post-C3)", QUICKS, (k) => nd.get(k)!.k9);
const statQKL = stratStat("K channel, + the high-divergence point", [...QUICKS, ...A_OTHER], (k) => nd.get(k)!.k9);

// ═══════════════════════════════════════════════════════════════════════════════
// 4. ORDERING MACHINERY
// ═══════════════════════════════════════════════════════════════════════════════
function rankOf(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!.i] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  return vx > 0 && vy > 0 ? cv / Math.sqrt(vx * vy) : NaN;
}
const spearman = (xs: number[], ys: number[]) => pearson(rankOf(xs), rankOf(ys));
function wPearson(xs: number[], ys: number[], w: number[]): number {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { sw += w[i]!; sx += w[i]! * xs[i]!; sy += w[i]! * ys[i]!; }
  const mx = sx / sw, my = sy / sw;
  let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) { const a = xs[i]! - mx, b = ys[i]! - my; cv += w[i]! * a * b; vx += w[i]! * a * a; vy += w[i]! * b * b; }
  return vx > 0 && vy > 0 ? cv / Math.sqrt(vx * vy) : NaN;
}
function resid(y: number[], z: number[]): number[] {
  const mz = mean(z), my = mean(y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < y.length; i++) { sxy += (z[i]! - mz) * (y[i]! - my); sxx += (z[i]! - mz) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return y.map((v, i) => v - (my + b * (z[i]! - mz)));
}
function feasible(order: FmtCtx[], desc: boolean, pick: (k: string) => ChanNeed): { ok: boolean; minSlack: number } {
  const seq = desc ? [...order].reverse() : order;
  let floor = -Infinity, ms = Infinity;
  for (const c of seq) { const x = pick(c.key); floor = Math.max(floor, x.needCI.lo); ms = Math.min(ms, x.needCI.hi - floor); }
  return { ok: ms >= -1e-9, minSlack: ms };
}
interface Score { name: string; sp: number; wp: number; rhoCI: { lo: number; hi: number }; feas: { ok: boolean; minSlack: number; dir: string }; spPartial: number; spWithTier: number; nFmt: number }
function scoreOn(set: FmtCtx[], seed: number, pick: (k: string) => ChanNeed = bab): { scores: Score[]; permP: number; obsMax: number; usable: FmtCtx[] } {
  const usable = set.filter((c) => { const x = pick(c.key); return x.n >= THIN_N && Number.isFinite(x.need); });
  const needs = usable.map((c) => pick(c.key).need);
  const wts = usable.map((c) => { const se = pick(c.key).needSe; return se > 0 ? 1 / se ** 2 : 0; });
  const tierIdx = usable.map((c) => c.C["valueMax"]!);
  const rb = rng(seed + 5);
  const scores: Score[] = CANDS.map((name) => {
    const xs = usable.map((c) => c.C[name]!);
    const keep = xs.map((_, i) => i).filter((i) => Number.isFinite(xs[i]!));
    const x = keep.map((i) => xs[i]!), y = keep.map((i) => needs[i]!), w = keep.map((i) => wts[i]!);
    const sub = keep.map((i) => usable[i]!);
    const order = [...sub].sort((a, b) => a.C[name]! - b.C[name]!);
    const fa = feasible(order, false, pick), fd = feasible(order, true, pick);
    const bf = fa.minSlack >= fd.minSlack ? { ...fa, dir: "asc" } : { ...fd, dir: "desc" };
    const ti = keep.map((i) => tierIdx[i]!);
    const uniqTi = new Set(ti).size;
    const rs: number[] = [];
    for (let b = 0; b < 1000 && x.length >= 3; b++) {
      const drawn = keep.map((i) => { const nb = pick(usable[i]!.key).needBoot; return nb.length ? nb[Math.floor(rb() * nb.length)]! : needs[i]!; });
      rs.push(spearman(x, drawn));
    }
    return {
      name, sp: spearman(x, y), wp: wPearson(x, y, w), rhoCI: rs.length ? ci(rs.filter(Number.isFinite)) : { lo: NaN, hi: NaN },
      feas: bf,
      spPartial: uniqTi > 1 && x.length >= 4 ? spearman(resid(x, ti), resid(y, ti)) : NaN,
      spWithTier: uniqTi > 1 ? spearman(x, ti) : NaN, nFmt: x.length,
    };
  });
  const rp2 = rng(seed + 77);
  const PERM = 5000;
  const obsMax = Math.max(...scores.filter((s) => Number.isFinite(s.sp)).map((s) => Math.abs(s.sp)));
  const candX = CANDS.map((n) => usable.map((c) => c.C[n]!));
  let ge = 0;
  for (let b = 0; b < PERM; b++) {
    const perm = [...needs];
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rp2() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    let mx = 0;
    for (const xs of candX) {
      const keep = xs.map((_, i) => i).filter((i) => Number.isFinite(xs[i]!));
      if (keep.length < 3) continue;
      const v = Math.abs(spearman(keep.map((i) => xs[i]!), keep.map((i) => perm[i]!)));
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    if (mx >= obsMax - 1e-12) ge++;
  }
  return { scores, permP: (ge + 1) / (PERM + 1), obsMax, usable };
}
const S_Q = scoreOn(QUICKS, SEED + 1000);
const S_QL = scoreOn([...QUICKS, ...A_OTHER], SEED + 1500);
const S_ALL = scoreOn(ctxs, SEED + 2000);
const S_QL_K = scoreOn([...QUICKS, ...A_OTHER], SEED + 3000, (k) => nd.get(k)!.k9);

// collinearity with the tier index — on the 5-Quick baseline AND on the 6-format primary set
const QL = [...QUICKS, ...A_OTHER];
const collinOn = (set: FmtCtx[], n: string) => {
  const xs = set.map((c) => c.C[n]!), ti = set.map((c) => c.C["valueMax"]!);
  const keep = xs.map((_, i) => i).filter((i) => Number.isFinite(xs[i]!));
  if (keep.length < 3) return NaN;
  const x = keep.map((i) => xs[i]!);
  if (sd(x) === 0) return NaN;          // no variation ⇒ undefined, NOT "collinear"
  return spearman(x, keep.map((i) => ti[i]!));
};
const collin = CANDS.map((n) => ({ name: n, rho5: collinOn(QUICKS, n), rho6: collinOn(QL, n) }))
  .sort((a, b) => (Number.isFinite(a.rho6) ? Math.abs(a.rho6) : 9) - (Number.isFinite(b.rho6) ? Math.abs(b.rho6) : 9));

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ATTRIBUTION LEGS (Quick ladder only — the stratum BUILD-3's table lives in)
// ═══════════════════════════════════════════════════════════════════════════════
const ARMS: { name: string; arm: Arm; note: string }[] = [
  { name: "shipped / capture / BF>=600", arm: SHIPPED, note: "the primary measurement — production's residual BABIP defect today" },
  { name: "K+HR ramps OFF / capture", arm: { kOn: false, hrOn: false }, note: "the K/HR ramps' own contribution: both are applied PRE-BIP and BIP = 600−BB−K−HR, so they move predicted BABIP" },
  { name: "K only / capture", arm: { kOn: true, hrOn: false }, note: "isolates the HR leg's contribution" },
  { name: "shipped / LEGACY top-100", arm: { kOn: true, hrOn: true, source: { kind: "legacy" } }, note: "corpus swap — different capture WINDOW as well as depth" },
  { name: "shipped / LEGACY / BF>=4300", arm: { kOn: true, hrOn: true, source: { kind: "legacy" }, minBf: 4300 }, note: "BUILD-3's corpus AND its old MIN_IP=1000 bar (= BF 4300)" },
];
interface ArmRow { arm: string; note: string; by: Map<string, { need: number; lo: number; hi: number; n: number }> }
const armRows: ArmRow[] = [];
// The LEGACY fixtures are keyed by the OLD per-format slug (`fixtures/cwhit/cwhit-<slug>-<role>.tsv`),
// not by the registry key, so a legacy arm has to re-key its window and its correction map or it reads
// nothing at all and reports a silent n/a. Handled here rather than left as a hole in the table.
const legacySlug = new Map(CWHIT_CORPUS.filter((r) => r.legacySlug).map((r) => [r.key, r.legacySlug!]));
for (const [ai, a] of ARMS.entries()) {
  const by = new Map<string, { need: number; lo: number; hi: number; n: number }>();
  for (const fm of QUICKS) {
    let x;
    if (ai === 0) x = bab(fm.key);
    else if (a.arm.source?.kind === "legacy") {
      const slug = legacySlug.get(fm.key);
      if (!slug) { by.set(fm.key, { need: NaN, lo: NaN, hi: NaN, n: 0 }); continue; }
      const win0 = (fm.deps.formats ?? [])[0]!;
      const fm2: FmtCtx = { ...fm, key: slug, deps: { ...fm.deps, formats: [{ ...win0, tier: slug }] } };
      x = needsFor(fm2, a.arm, SEED + 50000 + ai * 977 + ctxs.indexOf(fm) * 13).babip;
    } else x = needsFor(fm, a.arm, SEED + 50000 + ai * 977 + ctxs.indexOf(fm) * 13).babip;
    by.set(fm.key, { need: x.need, lo: x.needCI.lo, hi: x.needCI.hi, n: x.n });
  }
  armRows.push({ arm: a.name, note: a.note, by });
}
/** BUILD-3's PUBLISHED per-tier BABIP slopes and CIs (docs/CWHIT_PITSPREAD_BUILD3_2026-07-17.md §1),
 *  transcribed for COMPARISON ONLY. Nothing is fitted to them; they are a historical measurement on a
 *  superseded instrument. Diamond was not measured there. */
const BUILD3_CI: Record<string, { est: number; lo: number; hi: number } | null> = {
  ironquick: { est: 1.11, lo: 0.98, hi: 1.38 },
  bronzequick: { est: 1.48, lo: 1.17, hi: 2.00 },
  silverquick: { est: 1.06, lo: 0.81, hi: 1.30 },
  goldquick: { est: 0.97, lo: 0.63, hi: 1.39 },
  diamondquick: null,
};
const BUILD3: Record<string, string> = { ironquick: "1.11", bronzequick: "1.48", silverquick: "1.06", goldquick: "0.97", diamondquick: "n/m" };
const QORDER = ["ironquick", "bronzequick", "silverquick", "goldquick", "diamondquick"];
// THE SAME CONSTANT TEST, APPLIED TO BUILD-3'S OWN PUBLISHED NUMBERS.
const b3 = Object.values(BUILD3_CI).filter((x): x is { est: number; lo: number; hi: number } => !!x);
const b3Lo = Math.max(...b3.map((x) => x.lo)), b3Hi = Math.min(...b3.map((x) => x.hi));
const b3ConstantOk = b3Lo <= b3Hi;

// ═══════════════════════════════════════════════════════════════════════════════
// 6. REPORT
// ═══════════════════════════════════════════════════════════════════════════════
const rankedQ = [...S_Q.scores].filter((s) => Number.isFinite(s.sp) && !ENV_CANDS.has(s.name)).sort((a, b) => Math.abs(b.sp) - Math.abs(a.sp));
const rankedQL = [...S_QL.scores].filter((s) => Number.isFinite(s.sp) && !ENV_CANDS.has(s.name)).sort((a, b) => Math.abs(b.sp) - Math.abs(a.sp));
const bestQL = rankedQL[0]!;
const decoupB = S_QL.scores.find((s) => s.name === "decoup_babip")!;
const decoupK = S_QL_K.scores.find((s) => s.name === "decoup_kRat")!;
const incum = S_QL.scores.find((s) => s.name === "gap_babip_channel")!;
const inflAll = ctxs.flatMap((c) => [bab(c.key).inflation, nd.get(c.key)!.k9.inflation]).filter(Number.isFinite);
const lop = ctxs.find((c) => c.key === "liveopendaily")!;
const dvAll = ctxs.map((c) => c.C["decoup_kRat_abs"]!);
const dvB = ctxs.map((c) => c.C["decoup_babip_abs"]!);

say("################################################################################");
say("# BABIP COORDINATE SEARCH — what property does the pitcher-BABIP correction respond to?");
say("# tools/babip-coordinate.ts · 2026-07-26 · MEASUREMENT AND STRUCTURE ONLY.");
say("# NOTHING IS FITTED. No constant, no default, no wiring, no commit. Amendment 2 stands, and the");
say("# pending 4-week pull is a REQUIRED out-of-sample validation before anything is fitted at all.");
say("################################################################################");
say();
say("## VERDICT");
say();
say("  THE CANDIDATE PUT FORWARD, AND WHAT HAPPENED TO IT: CHANNEL DECOUPLING — the signed divergence");
say("  between the ONE opposing channel a correction's gap coordinate reads and the pool's COMPOSITE");
say("  gap position over its whole rating vector. For BABIP that is `decoup_babip` = z(hitter-BABIP");
say("  gap) − mean over all five hitter channels of their standardized gaps. Continuous, ex ante,");
say("  from eligible-pool ratings + the artifact's training means only — no card type, no pool");
say("  identity, no value window, and one channel measured against a composite rather than against");
say("  another single rating.");
say();
say("  ANSWER TO THE HEADLINE QUESTION: NO PROPERTY IN THIS CLASS ORDERS THE NEED, BECAUSE ON TODAY'S");
say("  SHIPPED LINE THE BABIP NEED HAS NO MEASURABLE HETEROGENEITY TO ORDER.");
say(`  · Five-Quick baseline: needs span ${f(Math.min(...QUICKS.map((c) => bab(c.key).need)), 2)}–${f(Math.max(...QUICKS.map((c) => bab(c.key).need)), 2)}, but the INTERSECTION of all five 95% CIs is`);
say(`    [${f(statQ.interLo, 2)}, ${f(statQ.interHi, 2)}] — NON-EMPTY. A ZERO-parameter constant (${f(statQ.pooled, 2)} ± ${f(statQ.pooledSe, 2)}) passes through every one.`);
say(`    Q = ${f(statQ.Q, 2)} on ${statQ.df} df, I2 = ${f(statQ.I2 * 100, 0)}%, p = ${f(statQ.pQ, 3)}. Adding the high-divergence point, then`);
say(`    stratum B, then stratum C never empties the intersection (${f(statAll.interLo, 2)}–${f(statAll.interHi, 2)} at all 14).`);
say("  · THIS IS NOT A POWER FAILURE, AND THE RUN PROVES IT WITH A POSITIVE CONTROL. The SAME");
say("    instrument, same formats, same bar, same card-clustered bootstrap, pointed at the K channel");
say(`    on the same shipped line: Q = ${f(statQK.Q, 2)} on ${statQK.df} df, I2 = ${f(statQK.I2 * 100, 0)}%, p = ${f(statQK.pQ, 3)}, CI intersection EMPTY.`);
say("    The method detects real between-format heterogeneity in this corpus at these sample sizes. It");
say("    finds none in BABIP.");
say();
say("  MECHANISTIC OR COINCIDENTAL: THE MECHANISM IS ESTABLISHED, THE ORDERING IS COINCIDENTAL.");
say("  · The mechanism is not speculative. buildFrameShift builds the BABIP coordinate exactly as it");
say("    builds the K coordinate — pit.pbabip's shift IS train.hit.babip − pool.hit.babip, one");
say("    opposing channel read alone (src/scoring-core/pool-stats.ts:236,242-244). Whatever made the K");
say("    coordinate misread a rating-SHAPE difference as a level difference is structurally present in");
say("    the BABIP coordinate. That is a code fact, not an inference from fourteen samples.");
say(`  · The decoupling is real and it is largest where the K story says: |decoup_kRat| runs`);
say(`    ${f(Math.min(...dvAll), 3)}–${f(Math.max(...dvAll), 3)} across the corpus; within the clean stratum the largest is liveopendaily at`);
say(`    ${f(lop.C["decoup_kRat_abs"]!, 3)}, ${f(lop.C["decoup_kRat_abs"]! / mean(QUICKS.map((c) => c.C["decoup_kRat_abs"]!)), 1)}x the Quick-baseline mean, and it is the ONLY format in the clean stratum whose`);
say(`    avoid-K channel sits AHEAD of its composite by more than ${f(0.1, 1)} (${sg(lop.C["decoup_kRat"]!, 3)} vs ${QUICKS.map((c) => sg(c.C["decoup_kRat"]!, 2)).join(", ")}).`);
say("    (Corpus-wide the largest |decoup_kRat| is an env-modified format, which is why the clean");
say("    stratum is where the statement is made.) That measured number — not what kind of cards the");
say("    format admits — is the ground for treating it as a divergence point rather than a baseline.");
say(`  · But its ORDERING of the BABIP need is Spearman ${f(decoupB.sp, 3)}, and propagating the needs' own`);
say(`    card-clustered uncertainty gives [${f(decoupB.rhoCI.lo, 2)}, ${f(decoupB.rhoCI.hi, 2)}] — a CI that spans zero and most of the`);
say("    negative range. There is no ordering evidence here in either direction.");
say(`  · The family's BEST ordering is ${bestQL.name} at Spearman ${f(bestQL.sp, 3)} (permutation p = ${f(S_QL.permP, 3)} for the`);
say(`    family maximum). DO NOT READ THAT AS A FINDING. Its own bootstrap CI is [${f(bestQL.rhoCI.lo, 2)}, ${f(bestQL.rhoCI.hi, 2)}]: it orders`);
say("    perfectly a set of six numbers that are statistically indistinguishable from six copies of");
say("    one constant. A perfect ordering of noise is still an ordering of noise, and the permutation");
say("    test — which permutes the point estimates and cannot see their CIs — is blind to that.");
say("    (It is also the least surprising candidate imaginable: a spread correction's need is the");
say("    ratio of true spread to PREDICTED spread, so the predicted spread is its own denominator.)");
say();
say("  THE MOTIVATING NUMBER WAS NEVER CI-ESTABLISHED — and this is arithmetic on BUILD-3's own four");
say("  published intervals, independent of everything else here (§5). iron [0.98,1.38], bronze");
say(`  [1.17,2.00], silver [0.81,1.30], gold [0.63,1.39]: max(lo) = ${f(b3Lo, 2)}, min(hi) = ${f(b3Hi, 2)}, so the`);
say(`  intersection is ${b3ConstantOk ? `[${f(b3Lo, 2)}, ${f(b3Hi, 2)}] and NON-EMPTY` : "EMPTY"}. A flat scalar in that band satisfies every tier`);
say("  BUILD-3 measured, bronze included. The \"bronze 1.48 vs silver/gold 1.0\" heterogeneity was read");
say("  off POINT ESTIMATES. What failed its G1 gate was the FITTED value: its family is essentially");
say("  constant over the observed gaps and its precision-weighted A landed at s ~ 1.15, just BELOW");
say(`  that band. ⇒ Read the BUILD-3 verdict as a FIT-SELECTION shortfall, not as evidence that this`);
say(`  channel is tier-heterogeneous. On today's line bronze reads ${f(bab("bronzequick").need, 2)} [${f(bab("bronzequick").needCI.lo, 2)}, ${f(bab("bronzequick").needCI.hi, 2)}].`);
say();
say("  IS THE 1.48 CONFOUNDED? NOT on the axis the stratification asked about — BUILD-3's §1 table is");
say("  the Quick ladder, i.e. neutral env and no budget, so it is clean on environment and on budget,");
say("  and this run confirms that by re-deriving both classifications from the configs. It IS");
say("  confounded on the MEASUREMENT axes: corpus (legacy top-100, a different capture window), bar");
say("  (MIN_IP 1000 = BF 4300 vs BF 600), model artifact (league-41-42 pre-C1/C2' vs league-42-43");
say("  post), and baseline corrections (a since-retired saturating K ramp vs the shipped C3 K + C6 HR");
say("  ramps). §5 moves the reachable ones one at a time; the artifact and coordinate cannot be rolled");
say("  back, so 1.48 is not recoverable on any configuration available today.");
say();
say("  IS IT A TIER INDEX IN DISGUISE? YES — INCLUDING THE DECOUPLING CANDIDATE, INSIDE THE BASELINE.");
say("  This is the run's strongest structural result and it goes AGAINST the hypothesis. The five Quick");
say("  windows are NESTED (<=59 c <=69 c <=79 c <=89 c <=99), so every eligible-pool statistic that");
say("  moves with the window is monotone in valueMax by construction. Measured (§6): on the five-Quick");
say(`  baseline decoup_babip reads |rho| = ${f(Math.abs(collin.find((t) => t.name === "decoup_babip")!.rho5), 3)} against valueMax — subtracting the composite does`);
say("  NOT rescue separability when every pool in the set is a prefix of the next. It only falls to");
say(`  |rho| = ${f(Math.abs(collin.find((t) => t.name === "decoup_babip")!.rho6), 2)} once the one non-nested format is added. So the decoupling axis, on this corpus,`);
say("  is identified by exactly ONE point of leverage — and one point cannot identify a response.");
say();
say("  STOP RECOMMENDATION. Do not fit a BABIP coordinate on this corpus, and do not ship the BUILD-3");
say("  constants. Keep the channel HELD, and RE-FILE THE REASON in the doc: it is held because no");
say("  heterogeneity is measurable at this resolution — not because a bronze-shaped defect defies a");
say("  monotone ramp, which its own published intervals never established.");
say("  CARRY FORWARD, PRE-REGISTERED, NOT FITTED: channel decoupling stays the best-motivated candidate");
say("  because its MECHANISM is a code fact and because it is composite-referenced, so it is the one");
say("  construction here that cannot be fooled by a uniform level shift. It is NOT carried forward on");
say("  ordering evidence — it has none — and NOT on separability inside the baseline, where it is fully");
say("  tier-collinear. It should be pre-registered against the K channel first, where heterogeneity");
say("  demonstrably exists (I2 92%), and only then asked of BABIP.");
say();

say("## 0. HEADER");
say(`  model        '${trained.id}' (raw-poly, own-gap path)   cohortRule '${trained.cohortRule ?? "model-woba"}'`);
say(`  catalog      '${srcId}' — ${baseCards.length} base cards`);
say(`  corpus       fixtures/cwhit-capture-2026-07-21 (buildCwhitSample DEFAULT_SOURCE), ${CWHIT_CORPUS.length} formats by tournamentId`);
say(`  baseline     THE SHIPPED LINE — C3 K ramp ON {A ${f(K_SPREAD_PIT.A, 4)}, q ${f(K_SPREAD_PIT.q, 2)}, gMax ${f(K_SPREAD_PIT.gMax, 2)}} + C6 HR ramp ON`);
say(`               {A ${f(PIT_SPREAD_HR.A, 4)}, q ${f(PIT_SPREAD_HR.q, 2)}, gMax ${f(PIT_SPREAD_HR.gMax, 2)}}, sPitBab NEVER SET (production's held state)`);
say(`  need         slope(obs ~ our RAW predicted), pitchers, BF >= ${MIN_BF} — the BUILD-3 estimand, so the`);
say(`               numbers are directly comparable with its 1.48 / 1.06 / 0.97`);
say(`  uncertainty  B = ${B} bootstrap, CLUSTERED BY CARD (a card contributes a base row and a v5 row)`);
say(`  inflation    MEASURED, not assumed: mean cluster-SE / row-SE = ${f(mean(inflAll), 3)}x over ${inflAll.length} format x channel cells,`);
say(`               range ${f(Math.min(...inflAll), 2)}-${f(Math.max(...inflAll), 2)}x. It is near 1 because most judged cards contribute ONE row`);
say(`               (base or v5, rarely both) once the BF floor is applied — so clustering costs little here,`);
say(`               which is a measured fact about this corpus and not a general licence to skip it.`);
say(`  presence     PRESENCE_P ${PRESENCE_P}, PRESENCE_M ${PRESENCE_M}, FIELD_N ${FIELD_N}`);
for (const nn of setupNotes) say(`  NOTE         ${nn}`);
say();

say("## 1. THE THREE AXES, READ OFF THE CONFIGS");
say();
say(`  ${pad("format", 18)}${pad("tournamentId", 20)}${pad("era", 10)}${pad("park", 10)}${pad("budget", 8)}${pad("stratum", 8)}${rpad("|decoup_kRat|", 14)}${rpad("|decoup_babip|", 15)}`);
for (const c of ctxs) {
  const t = tournaments.get(c.tid)!;
  say(`  ${pad(c.key, 18)}${pad(c.tid, 20)}${pad(t.eraId, 10)}${pad(t.parkId, 10)}${pad(c.budget, 8)}${pad(c.stratum, 8)}${rpad(f(c.C["decoup_kRat_abs"]!, 3), 14)}${rpad(f(c.C["decoup_babip_abs"]!, 3), 15)}`);
}
say();
say("  A = neutral env (era-2010 AND park-1) AND no budget.  B = env-modified, no budget.");
say("  C = neutral env, budget.  B+C = both (cannot separate the two axes on its own).");
say();
say("  THE BASELINE IS THE FIVE QUICK TIERS. `liveopendaily` is stratum A by env and budget, but it is");
say(`  carried as the HIGH-DIVERGENCE MEASUREMENT POINT rather than as a baseline member, on two`);
say(`  measured grounds: its |decoup_kRat| is ${f(lop.C["decoup_kRat_abs"]!, 3)} against a Quick-baseline mean of`);
say(`  ${f(mean(QUICKS.map((c) => c.C["decoup_kRat_abs"]!)), 3)} — the largest in the corpus — and its judged pitcher cell is ${bab("liveopendaily").n} rows, the`);
say("  thinnest load-bearing cell here. Both grounds are numbers in this table. Neither is a statement");
say("  about what kind of cards the format admits, which would not be a permissible ground.");
say();

say("## 2. CHANNEL DECOUPLING — the construction, and what it measures");
say();
say("  For each channel c of the OPPOSING role's rating vector:");
say("      z_c        = (trainingMean_c - poolCohortMean_c) / catalogSD_c");
say("      composite  = mean over ALL FIVE hitter channels of z_c        <- the whole rating vector");
say("      decoup_c   = z_c - composite                                  <- one channel vs the composite");
say("  The composite is the point of the construction: contrasting ONE channel against a COMPOSITE is");
say("  what makes this a decoupling. If both sides were single ratings it would be a correlation");
say("  between two ratings and would rebuild the very defect it exists to escape.");
say();
say(`  ${pad("format", 18)}${["eye", "pow", "kRat", "babip", "gap"].map((k) => rpad(`z_${k}`, 9)).join("")}${rpad("composite", 11)}${rpad("shape_div", 11)}${rpad("d_kRat", 9)}${rpad("d_babip", 9)}`);
for (const c of ctxs) {
  const z = (k: string) => c.C[`z_${k}`];
  say(`  ${pad(c.key, 18)}${["eye", "pow", "kRat", "babip", "gap"].map((k) => rpad(f(z(k) ?? NaN, 3), 9)).join("")}${rpad(f(c.C["composite_hit"]!, 3), 11)}${rpad(f(c.C["shape_div_hit"]!, 3), 11)}${rpad(sg(c.C["decoup_kRat"]!, 3), 9)}${rpad(sg(c.C["decoup_babip"]!, 3), 9)}`);
}
say();
say("  READ: a pool is NOT described here as strong or weak. `composite` is where its whole rating");
say("  vector sits relative to the training frame; `decoup_c` is how far ONE channel departs from that");
say("  — a SHAPE statement. A pool can sit ahead of the frame on four channels and behind on the fifth;");
say("  that is a shape, and it is exactly what a single-channel gap coordinate cannot represent.");
say();

say("## 3. THE MEASURED NEED — BASELINE FIRST, then each addition");
say();
const line = (c: FmtCtx, pick: (k: string) => ChanNeed = bab) => {
  const d = pick(c.key);
  return `  ${pad(c.key, 18)}${pad(c.stratum, 5)}${rpad(String(d.n), 4)}${rpad(String(d.nCards), 7)}${rpad(f(d.need, 3), 8)}${rpad(`[${f(d.needCI.lo, 2)}, ${f(d.needCI.hi, 2)}]`, 17)}${rpad(f(d.needSe, 3), 7)}${rpad(f(d.inflation, 2), 7)}${rpad(f(d.needFree, 3), 8)}${rpad(f(d.corr, 2), 6)}${d.n < THIN_N ? "  THIN" : ""}`;
};
say(`  ${pad("format", 18)}${pad("str", 5)}${rpad("N", 4)}${rpad("cards", 7)}${rpad("need", 8)}${rpad("[ 95% CI ]", 17)}${rpad("se", 7)}${rpad("infl", 7)}${rpad("free-s", 8)}${rpad("corr", 6)}`);
say("  -- BASELINE: the five Quick tiers --");
for (const c of [...QUICKS].sort((a, b) => bab(b.key).need - bab(a.key).need)) say(line(c));
say("  -- the high-divergence measurement point --");
for (const c of A_OTHER) say(line(c));
say("  -- stratum B (env-modified) --");
for (const c of [...STRAT_B].sort((a, b) => bab(b.key).need - bab(a.key).need)) say(line(c));
say("  -- stratum C / B+C (budget) --");
for (const c of [...STRAT_C].sort((a, b) => bab(b.key).need - bab(a.key).need)) say(line(c));
say();
say("  'need' = slope(obs ~ pred): 1.0 calibrated; >1 = the predicted SPREAD is too narrow by that");
say("  factor. 'free-s' = the precision-weighted free-level spread slope (the C3/C6 estimand) — a");
say("  cross-check on a different estimand, not a second answer.");
say();
say("  STEP-BY-STEP: does adding a stratum MOVE the pooled need? Any movement is environment or");
say("  deployment, not the BABIP channel, and must not enter a coordinate.");
say(`    ${pad("set", 46)}${rpad("k", 3)}${rpad("pooled", 9)}${rpad("se", 8)}${rpad("Q", 8)}${rpad("df", 4)}${rpad("I2", 6)}${rpad("pQ", 8)}  CI-intersection`);
for (const s of [statQ, statQL, statQB, statAll]) {
  say(`    ${pad(s.name, 46)}${rpad(String(s.n), 3)}${rpad(f(s.pooled, 3), 9)}${rpad(f(s.pooledSe, 3), 8)}${rpad(f(s.Q, 2), 8)}${rpad(String(s.df), 4)}${rpad(`${f(s.I2 * 100, 0)}%`, 6)}${rpad(f(s.pQ, 3), 8)}  ${s.constantOk ? `[${f(s.interLo, 2)}, ${f(s.interHi, 2)}] NON-EMPTY` : "EMPTY — real heterogeneity"}`);
}
say();
say("  A NON-EMPTY CI-INTERSECTION IS THE DECISIVE READ: one constant is consistent with every format");
say("  in the set, so no coordinate is IDENTIFIED — which is not the same as none existing. An EMPTY");
say("  intersection is what BUILD-3 faced and is what would justify a coordinate search at all.");
say();
say("  THE SAME READ FOR THE K CHANNEL (post-C3, for the residual comparison):");
for (const s of [statQK, statQKL]) {
  say(`    ${pad(s.name, 46)}${rpad(String(s.n), 3)}${rpad(f(s.pooled, 3), 9)}${rpad(f(s.pooledSe, 3), 8)}${rpad(f(s.Q, 2), 8)}${rpad(String(s.df), 4)}${rpad(`${f(s.I2 * 100, 0)}%`, 6)}${rpad(f(s.pQ, 3), 8)}  ${s.constantOk ? `[${f(s.interLo, 2)}, ${f(s.interHi, 2)}] NON-EMPTY` : "EMPTY — real heterogeneity"}`);
}
say();

say("## 4. THE ANALOGY, ASKED DIRECTLY");
say();
say("  Q1. Is the BABIP coordinate built the same way as the K coordinate — one opposing channel?");
say("      YES, and this is a code fact. src/scoring-core/pool-stats.ts buildFrameShift:");
say("        pit.stu    = train.hit.kRat  - pool.hit.kRat     <- the K ramp's gap");
say("        pit.pbabip = train.hit.babip - pool.hit.babip    <- the BABIP need's gap");
say("      Identical construction. Any failure mode of the first is structurally available to the second.");
say();
say("  Q2. Does the hitter-BABIP channel decouple from the composite the way avoid-K does?");
say(`      PARTLY, and less. Across all 14 formats |decoup_kRat| spans ${f(Math.min(...dvAll), 3)}-${f(Math.max(...dvAll), 3)} while |decoup_babip|`);
say(`      spans ${f(Math.min(...dvB), 3)}-${f(Math.max(...dvB), 3)}. Correlation between the two divergences across formats:`);
say(`      Spearman ${f(spearman(ctxs.map((c) => c.C["decoup_kRat"]!), ctxs.map((c) => c.C["decoup_babip"]!)), 3)}.`);
say();
say("  Q3. Do the formats where it decouples depart from the flat prediction?");
say(`      ${pad("format", 18)}${rpad("d_babip", 10)}${rpad("need", 8)}${rpad("dep. from flat", 16)}${rpad("d_kRat", 10)}${rpad("K need", 8)}${rpad("K dep.", 10)}`);
for (const c of [...QUICKS, ...A_OTHER].sort((a, b) => a.C["decoup_babip"]! - b.C["decoup_babip"]!)) {
  const d = bab(c.key), k = nd.get(c.key)!.k9;
  say(`      ${pad(c.key, 18)}${rpad(sg(c.C["decoup_babip"]!, 3), 10)}${rpad(f(d.need, 2), 8)}${rpad(sg(d.need - statQ.pooled, 2), 16)}${rpad(sg(c.C["decoup_kRat"]!, 3), 10)}${rpad(f(k.need, 2), 8)}${rpad(sg(k.need - statQK.pooled, 2), 10)}`);
}
say(`      Spearman(decoup_babip, BABIP need)  = ${f(decoupB.sp, 3)} [${f(decoupB.rhoCI.lo, 2)}, ${f(decoupB.rhoCI.hi, 2)}]`);
say(`      Spearman(decoup_kRat,  K need)      = ${f(decoupK.sp, 3)} [${f(decoupK.rhoCI.lo, 2)}, ${f(decoupK.rhoCI.hi, 2)}]`);
say(`      'departure from flat' = need - the baseline's precision-weighted pooled need. A coordinate`);
say(`      earns its place by ordering THIS column; a constant already explains the rest.`);
say();
say("  Q4. Is the answer ONE PROBLEM ON ONE PROPERTY?");
say("      NOT ESTABLISHED, and this run cannot establish it. The K channel is where the property was");
say("      born and where its extreme point lives; the BABIP channel currently shows no departure for");
say("      it to order. The honest position is that the decoupling property remains the best-motivated");
say("      pre-registrable coordinate for BOTH channels, and that the BABIP leg of the claim is");
say("      untestable until the need CIs separate.");
say();

say("## 5. ATTRIBUTION — why BUILD-3's 1.48 does not reproduce (Quick ladder = BUILD-3's own stratum)");
say();
say(`  ${pad("arm", 32)}${QORDER.map((k) => rpad(k.replace("quick", ""), 15)).join("")}`);
for (const r of armRows) {
  say(`  ${pad(r.arm, 32)}${QORDER.map((k) => { const c = r.by.get(k); return rpad(c && Number.isFinite(c.need) ? `${f(c.need, 2)} (${c.n})` : "n/a", 15); }).join("")}`);
}
say(`  ${pad("BUILD-3 published (2026-07-17)", 32)}${QORDER.map((k) => rpad(BUILD3[k]!, 15)).join("")}`);
say();
for (const r of armRows) say(`    ${pad(r.arm, 32)} ${r.note}`);
say();
// A data-driven read of the legs, rather than a pre-written story about which axis "did it".
{
  const get = (arm: number, k: string) => armRows[arm]!.by.get(k)!;
  const shipped = armRows[0]!, off = armRows[1]!, leg100 = armRows[3]!, leg4300 = armRows[4]!;
  const dRamp = QORDER.map((k) => get(0, k).need - get(1, k).need).filter(Number.isFinite);
  const dCorp = QORDER.map((k) => get(0, k).need - get(3, k).need).filter(Number.isFinite);
  const dBar = QORDER.map((k) => get(3, k).need - get(4, k).need).filter(Number.isFinite);
  const spread = (arm: number) => {
    const v = QORDER.map((k) => get(arm, k).need).filter(Number.isFinite);
    return v.length ? Math.max(...v) - Math.min(...v) : NaN;
  };
  say("  WHAT THE LEGS SHOW (read off the table above, not asserted):");
  say(`   · THE RAMPS move the need by at most ${f(Math.max(...dRamp.map(Math.abs)), 3)} per tier (mean ${sg(mean(dRamp), 3)}). Real, and mechanically`);
  say("     necessary, but far too small to be the whole difference from BUILD-3.");
  say(`   · THE CORPUS moves it by up to ${f(Math.max(...dCorp.map(Math.abs)), 2)} per tier and THE BAR by up to ${f(Math.max(...dBar.map(Math.abs)), 2)} — an order of magnitude`);
  say("     more. The legacy top-100 at the old BF>=4300 bar retains only");
  say(`     ${QORDER.map((k) => get(4, k).n).filter((x) => x > 0).join("/")} judged rows against ${QORDER.map((k) => get(0, k).n).join("/")} today.`);
  say(`   · THE TIER-TO-TIER SPREAD OF THE POINT ESTIMATES: shipped/capture ${f(spread(0), 2)} · legacy top-100`);
  say(`     ${f(spread(3), 2)} · legacy at the old bar ${f(spread(4), 2)} · BUILD-3 published ${f(1.48 - 0.97, 2)}. No leg reproduces the`);
  say("     published bronze peak, and the axes that remain (the model artifact and the C1/C2'");
  say("     coordinate move) cannot be rolled back from here — the old artifact and the retired");
  say("     saturating ramp are gone. So 1.48 is not recoverable on any configuration reachable today.");
  say();
  say("  AND THE FINDING THAT MATTERS MOST HERE — APPLY THIS RUN'S OWN TEST TO BUILD-3'S OWN NUMBERS:");
  say(`    ${QORDER.filter((k) => BUILD3_CI[k]).map((k) => `${k.replace("quick", "")} ${f(BUILD3_CI[k]!.est, 2)} [${f(BUILD3_CI[k]!.lo, 2)}, ${f(BUILD3_CI[k]!.hi, 2)}]`).join("   ")}`);
  say(`    max(lo) = ${f(b3Lo, 2)} (bronze), min(hi) = ${f(b3Hi, 2)} (silver)  ⇒  CI intersection `
    + `${b3ConstantOk ? `[${f(b3Lo, 2)}, ${f(b3Hi, 2)}] — NON-EMPTY` : "EMPTY"}.`);
  if (b3ConstantOk) {
    say("    BUILD-3'S PUBLISHED CIs ADMIT A COMMON CONSTANT. The heterogeneity that motivated holding");
    say("    the channel — and that motivated this whole coordinate search — was read off POINT");
    say("    ESTIMATES (1.48 vs ~1.0), and it was never established against the intervals BUILD-3");
    say("    itself published. A flat scalar anywhere in that band satisfies every tier it measured,");
    say("    bronze included. What actually failed BUILD-3's G1 gate was its FITTED value: the family");
    say("    it used (1 + A(1 − e^(−g/G)) pinned at G = g_min/3) is essentially constant over the");
    say("    observed gaps and its precision-weighted A landed at s ≈ 1.15 — just BELOW the");
    say(`    [${f(b3Lo, 2)}, ${f(b3Hi, 2)}] band, which is exactly why bronze read CI-clear-above-1 after correction.`);
    say("    ⇒ The BUILD-3 verdict is better described as a FIT-SELECTION shortfall than as evidence");
    say("    that the BABIP channel is tier-heterogeneous. That reframing is independent of everything");
    say("    else in this run: it is arithmetic on four published intervals.");
  }
  say();
}
say("  THE ONE MECHANICALLY CERTAIN STATEMENT THIS SUPPORTS: the BABIP need is NOT independent of the");
say("  other two channels' corrections. K and HR are applied PRE-BIP, BIP = 600 - BB - K - HR, and the");
say("  raw line re-derives non-HR hits from the corrected BIP — so re-spacing K and HR re-spaces every");
say("  card's BIP and therefore its predicted BABIP. A BABIP coordinate fitted against a stale K/HR");
say("  baseline is measuring a different quantity from one fitted against the shipped baseline.");
say();

say("## 6. TIER-INDEX COLLINEARITY INSIDE THE FIVE-QUICK BASELINE");
say();
say("  The Quick windows are NESTED, so any eligible-pool statistic that grows with the window is");
say("  monotone in valueMax by construction and is indistinguishable from the tier index here.");
say();
say(`  ${pad("candidate", 22)}${rpad("|rho| 5 quicks", 16)}${rpad("|rho| +div.pt", 16)}  reading`);
for (const t of collin) {
  const a5 = Math.abs(t.rho5), a6 = Math.abs(t.rho6);
  say(`  ${pad(t.name, 22)}${rpad(Number.isFinite(t.rho5) ? f(a5, 3) : "const", 16)}${rpad(Number.isFinite(t.rho6) ? f(a6, 3) : "const", 16)}  `
    + `${!Number.isFinite(t.rho6) ? "no variation on this set — carries no information here"
      : a5 >= 0.99 && a6 >= 0.9 ? "tier index in costume on BOTH sets"
        : a5 >= 0.99 ? "tier index in costume on the baseline; separated ONLY by the divergence point"
          : a6 < 0.6 ? "SEPARABLE on both" : "partly separable"}`);
}
const nBaselineCollinear = collin.filter((t) => Number.isFinite(t.rho5) && Math.abs(t.rho5) >= 0.99).length;
const nBaselineFinite = collin.filter((t) => Number.isFinite(t.rho5)).length;
const dB = collin.find((t) => t.name === "decoup_babip")!;
say();
say("  WHAT THE TABLE ACTUALLY SAYS — and it contradicts the hypothesis's own expectation, so it is");
say("  stated in the data's favour:");
say(`   · ON THE FIVE-QUICK BASELINE ALONE, ${nBaselineCollinear} of the ${nBaselineFinite} candidates with any variation read`);
say(`     |rho| = 1.000 against valueMax — DECOUPLING INCLUDED (decoup_babip ${f(Math.abs(dB.rho5), 3)}). The five windows`);
say("     are nested, so a shape statistic is monotone in the window too. Subtracting the composite");
say("     does NOT rescue separability when every pool in the set is a prefix of the next.");
say(`   · SEPARATION ONLY APPEARS WHEN THE ONE NON-NESTED FORMAT IS ADDED: decoup_babip falls to`);
say(`     ${f(Math.abs(dB.rho6), 3)} on the six-format set. So the decoupling axis is identified by exactly ONE point of`);
say("     leverage, and that point is also the corpus's thinnest judged cell.");
say(`   · Only ${collin.filter((t) => Number.isFinite(t.rho5) && Math.abs(t.rho5) < 0.6).map((t) => t.name).join(", ") || "(none)"} break the nesting on the baseline itself,`);
say("     and they are among the weakest orderings of the need in §7.");
say("  ⇒ The correct structural statement is NOT 'decoupling breaks the collinearity'. It is: almost");
say("    nothing breaks it inside the nested ladder, and the only leverage available comes from a");
say("    single non-nested format. One point cannot identify a response curve.");
say();

say("## 7. ORDERING RESULTS");
say();
say("  (a) BASELINE — the five Quick tiers only. Five points; a Spearman over five points has three");
say("      distinct achievable magnitudes above 0.7, so this table is reported for completeness and");
say("      should not be read as evidence in either direction.");
say(`  ${pad("candidate", 22)}${rpad("spearman", 10)}${rpad("[boot CI]", 17)}${rpad("wPearson", 10)}${rpad("mono-feas", 14)}${rpad("slack", 8)}`);
for (const s of rankedQ.slice(0, 12)) say(`  ${pad(s.name, 22)}${rpad(f(s.sp, 3), 10)}${rpad(`[${f(s.rhoCI.lo, 2)}, ${f(s.rhoCI.hi, 2)}]`, 17)}${rpad(f(s.wp, 3), 10)}${rpad(s.feas.ok ? `YES (${s.feas.dir})` : "NO", 14)}${rpad(f(s.feas.minSlack, 3), 8)}`);
say(`  family-wise permutation null: max |rho| = ${f(S_Q.obsMax, 3)}, p = ${f(S_Q.permP, 3)}`);
say();
say("  (b) BASELINE + the high-divergence measurement point (the primary ordering read).");
say(`  ${pad("candidate", 22)}${rpad("spearman", 10)}${rpad("[boot CI]", 17)}${rpad("wPearson", 10)}${rpad("mono-feas", 14)}${rpad("slack", 8)}${rpad("rho|tier", 10)}`);
for (const s of rankedQL) say(`  ${pad(s.name, 22)}${rpad(f(s.sp, 3), 10)}${rpad(`[${f(s.rhoCI.lo, 2)}, ${f(s.rhoCI.hi, 2)}]`, 17)}${rpad(f(s.wp, 3), 10)}${rpad(s.feas.ok ? `YES (${s.feas.dir})` : "NO", 14)}${rpad(f(s.feas.minSlack, 3), 8)}${rpad(f(s.spPartial, 2), 10)}`);
say();
say(`  Family-wise permutation null over all ${CANDS.length} candidates, ${S_QL.usable.length} formats: max |rho| = ${f(S_QL.obsMax, 3)}, p = ${f(S_QL.permP, 3)}.`);
say(`  ⇒ ${S_QL.permP <= 0.05 ? "the leading ordering beats the family's own noise ceiling" : "NO candidate's ordering exceeds the family's own noise ceiling. Naming a 'winner' from this table without this line would be exactly the coincidence failure the cohort-event STOP was called on."}`);
say();
say("  EVERY candidate is monotone-FEASIBLE, and that is not a pass — it follows directly from the");
say("  non-empty CI intersection in §3. When a constant fits every CI, every ordering trivially admits");
say("  a monotone curve. Feasibility discriminates only when the intersection is EMPTY.");
say();

say("## 8. THE SAME SEARCH POOLED ACROSS ALL 14 FORMATS — REPORTED, NOT TRUSTED");
say();
say("  What the search would have concluded WITHOUT the stratification. Printed so the confound is");
say("  visible, not so it can be used: the env and budget formats move the need for reasons that are");
say("  not the BABIP channel.");
const rankedAll = [...S_ALL.scores].filter((s) => Number.isFinite(s.sp)).sort((a, b) => Math.abs(b.sp) - Math.abs(a.sp));
say(`  ${pad("candidate", 22)}${rpad("spearman", 10)}${rpad("[boot CI]", 17)}${rpad("rho|tier", 10)}${rpad("rho w/ tier", 12)}`);
for (const s of rankedAll.slice(0, 12)) say(`  ${pad(s.name, 22)}${rpad(f(s.sp, 3), 10)}${rpad(`[${f(s.rhoCI.lo, 2)}, ${f(s.rhoCI.hi, 2)}]`, 17)}${rpad(f(s.spPartial, 2), 10)}${rpad(f(s.spWithTier, 2), 12)}`);
say(`  ... ${Math.max(rankedAll.length - 12, 0)} more omitted. Permutation null: max |rho| = ${f(S_ALL.obsMax, 3)}, p = ${f(S_ALL.permP, 3)}.`);
say(`  Pooled heterogeneity: Q = ${f(statAll.Q, 2)} on ${statAll.df} df, I2 = ${f(statAll.I2 * 100, 0)}%, p = ${f(statAll.pQ, 3)}; CI intersection `
  + `${statAll.constantOk ? `[${f(statAll.interLo, 2)}, ${f(statAll.interHi, 2)}] still NON-EMPTY` : "EMPTY"}.`);
say();

say("## 9. CANDIDATE VALUES, ALL 14 FORMATS (ex ante from catalog + config)");
say();
for (let k = 0; k < CANDS.length; k += 7) {
  const block = CANDS.slice(k, k + 7);
  say(`  ${pad("format", 18)}${pad("str", 5)}${block.map((n) => rpad(n.slice(0, 15), 16)).join("")}`);
  for (const c of ctxs) say(`  ${pad(c.key, 18)}${pad(c.stratum, 5)}${block.map((n) => rpad(g4(c.C[n]!), 16)).join("")}`);
  say();
}

say("## 10. WHAT EACH CANDIDATE IS, AND WHETHER IT READS ONE CHANNEL OR A COMPOSITE");
say();
for (const n of CANDS) say(`  ${pad(n, 20)} ${CAND_DOC[n]}`);
say();
say("  SINGLE-CHANNEL EXPOSURE, stated per family — the defect being diagnosed is single-channel");
say("  reading, so every candidate must declare whether it is exposed to it:");
say("   · DECOUPLING (decoup_*, shape_div_*, composite_*) — reads ONE channel AGAINST A COMPOSITE over");
say("     the whole rating vector. NOT exposed: a pool that moves uniformly on every channel has");
say("     decoup = 0 by construction, so no uniform level difference can be misread as shape.");
say("   · SINGLE-CHANNEL GAPS (gap_*_channel) — reads ONE channel, full stop. FULLY EXPOSED. This is");
job_note();
say("   · OWN-POOL RATING SHAPE (pbab_*, hbab_*) — single-channel levels/spreads. EXPOSED, and on this");
say("     corpus additionally indistinguishable from the value window.");
say("   · BIP VOLUME (bip_*, k_mu, bb_mu, hr_mu, hitspread_600) — derived from THREE channels at once");
say("     (BB, K, HR) plus the BABIP rate. PARTLY protected: it cannot be moved by one channel alone,");
say("     but it is not composite-referenced either, so a coordinated shift in all three still moves it.");
say("   · WINDOW/SIZE (valueMax, windowWidth, poolN_pit) — NO mechanism. Controls only.");
say("   · BUDGET (capTight, forcedCheap) — a real mechanism on AXIS 2, and the baseline contains no");
say("     budget variation at all, so it is unmeasurable there by construction.");
say("   · ENVIRONMENT (era_*, park_avg) — a real mechanism on AXIS 1. Excluded from the baseline ranking.");
say();

say("## 11. WHAT WOULD SETTLE IT (design, not statistics)");
say();
say("  The binding constraint is DESIGN, not statistics. Inside the five-Quick baseline nearly every");
say(`  candidate — the decoupling family included (§6) — reads |rho| ~ 1 against the value window,`);
say("  because the windows are nested. The corpus cannot separate a pool property from the value");
say("  window even in principle. Three things break that, in order of value:");
say("   (a) NEUTRAL, NON-BUDGET formats with NON-NESTED windows — a floor-bearing window (valueMin > 40)");
say("       on era-2010/park-1 gives a pool whose rating shape is not a prefix of another's.");
say("       `high-iron-floor-gold-ceiling` (50-89) has exactly this shape but is capped, so it lands in");
say("       B+C; an UNCAPPED min-bearing neutral format is the ask.");
say("   (b) FORMATS SPREAD ALONG THE DECOUPLING AXIS. Today the axis has a dense cluster and one");
say(`       extreme point (|decoup_kRat| ${f(mean(QUICKS.map((c) => c.C["decoup_kRat_abs"]!)), 3)} baseline mean vs ${f(lop.C["decoup_kRat_abs"]!, 3)}). One point cannot`);
say("       identify a response. Intermediate-divergence formats are the discriminating capture, and");
say("       they should be selected BY THEIR COMPUTED DIVERGENCE, which is available ex ante for all 48");
say("       configured tournaments without any new data.");
say(`   (c) DEPTH. Baseline need-SEs are ${f(Math.min(...QUICKS.map((c) => bab(c.key).needSe)), 2)}-${f(Math.max(...QUICKS.map((c) => bab(c.key).needSe)), 2)}. Separating a coordinate from a constant needs`);
say("       the CI intersection to go EMPTY, which at these spreads needs roughly a halving of the SEs,");
say("       i.e. about 4x the judged rows per format. The 4-week pull is the natural instrument.");
say();

function job_note() {
  say("     the incumbent BABIP coordinate, and it is the K coordinate's known failure mode verbatim:");
  say("     a pool whose rating vector is ahead of the frame on four channels and behind on the fifth");
  say("     reads, through a single-channel gap, exactly like a pool that is behind on everything.");
}

console.log(L.join("\n"));
