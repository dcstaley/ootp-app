// REALIZED DEPTH-OF-PLAY — does a SALARY-CAPPED format's realized playing population sit deeper
// and weaker in the Card Value distribution than a matched UNCAPPED format's?
//
// THE HYPOTHESIS. Our own-gap / spread machinery is built from a TOP-N-OF-ELIGIBLE frame
// (`computeUnifiedFieldStats(pool, …, FIELD_N)`). Salary caps force rosters to carry cheap cards, so
// the cards that ACTUALLY PLAY in a capped format may reach far below that frame. If so, "cap
// tightness" (tools/cap-tightness.ts) is only an EX-ANTE PROXY for the thing that matters, which is
// realized depth — and this tool measures the realized side directly, from observed tables we hold.
//
// WHY gold-cap vs gold-quick IS A CLEAN PAIR HERE (and nowhere else). That pair is park-confounded
// (park-156 vs park-1) and is therefore useless for HR-channel work. But realized composition is
// about WHICH CARDS PLAY, and a park cannot affect that. Same era (2010), same eligibility window
// (≤89), cap 1580 vs uncapped ⇒ the budget is the only structural difference that bears on who plays.
//
// FALSIFICATION ARM. Two UNCAPPED-vs-UNCAPPED controls (early-gold vs gold-quick; bronze-heart vs
// bronze-quick). Both sides of each control are budget-free, so any depth difference there is NOT
// budget-driven and rescales the cap contrast accordingly.
//
// ════════ THE CRITICAL LIMITATION — READ BEFORE ANY NUMBER BELOW ════════
// Every cwhit capture is TRUNCATED to the "top 100 by IP" (pitchers) / "top 100 by PA" (hitters).
// The DEEP TAIL — precisely what "how deep does realized play reach" asks about — IS CUT OFF BY THE
// CAPTURE. Total realized depth is NOT measurable from these files, and this tool does not claim to
// measure it. What IS measurable is the VALUE COMPOSITION WITHIN the top-100-by-usage. Because
// truncation removes the weakest tail, it biases AGAINST the hypothesis: any capped-format skew
// toward lower Card Value that survives here is a LOWER BOUND on the true effect.
// ════════════════════════════════════════════════════════════════════════
//
// NO SCORING MATH IS WRITTEN HERE (CLAUDE.md, one scoring core). Sections 1–3 are pure VAL/usage
// arithmetic and touch no model at all. Section 4 (frame coverage) needs a card RANKING, and takes
// it from the scoring core's own exported `cardSideWobas` — documented there as "the env-free field-
// SELECTION basis (same raw wOBA the field stats rank by)".
//
// Usage:  node tools/realized-depth.ts [--json]

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { makeRawPolyModel, cardSideWobas, type EventForm } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { makeVariant } from "../src/data/variants.ts";
import { parseCwhitPit, parseCwhitHit, type CwhitMeta } from "../src/eval/cwhit/parse.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/join.ts";
import { FIELD_N, inValueWindow, isPit, n_, cardName, type ValueWindow } from "../src/eval/cwhit/sample.ts";

const JSON_OUT = process.argv.includes("--json");
const B = 2000;                 // bootstrap reps
const SEED = 20260720;
const OBS_DIR = "fixtures/cwhit";

// ── the formats ──────────────────────────────────────────────────────────────
// `tourneyId` supplies the eligibility WINDOW + rule group. `null` ⇒ we have no config for it, so
// its window is UNKNOWN and it is reported DESCRIPTIVELY ONLY — never paired, never inferred.
interface Fmt { slug: string; label: string; tourneyId: string | null }
const FORMATS: Fmt[] = [
  { slug: "goldcapdaily", label: "Gold Cap Daily", tourneyId: "gold-cap" },
  { slug: "gold", label: "Gold Quick", tourneyId: "gold-quick" },
  { slug: "earlygolddaily", label: "Early Gold Daily", tourneyId: "early-gold" },
  { slug: "bronzeheartdaily", label: "Bronze Heart Daily", tourneyId: "bronze-heart" },
  { slug: "bronze", label: "Bronze Quick", tourneyId: "bronze-quick" },
  { slug: "diamondcapdaily", label: "Diamond Cap Daily", tourneyId: null },
];
interface Pair { kind: "CAP TEST" | "CONTROL"; a: string; b: string; note: string }
const PAIRS: Pair[] = [
  { kind: "CAP TEST", a: "goldcapdaily", b: "gold", note: "CAP 1580 vs UNCAPPED; same era-2010, same ≤89 window. Park differs (156 vs 1) — irrelevant to WHICH CARDS PLAY, which is all this tool measures." },
  { kind: "CONTROL", a: "earlygolddaily", b: "gold", note: "BOTH UNCAPPED (≤89). Era differs (1920 vs 2010). Any depth gap here is NOT budget-driven." },
  { kind: "CONTROL", a: "bronzeheartdaily", b: "bronze", note: "BOTH UNCAPPED (≤69). Era differs (1939 vs 2010) AND bronze-heart carries a Year 1930–1989 eligibility rule the comparator lacks — a real pool confound, flagged not resolved." },
];

// ── small pure stats (no domain logic) ───────────────────────────────────────
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const wMean = (xs: number[], ws: number[]) => { const w = sum(ws); return w > 0 ? sum(xs.map((x, i) => x * ws[i]!)) / w : NaN; };
/** Weighted quantile by the step (inverse-CDF) definition — no interpolation, so it stays a value
 *  the population actually takes (Card Value is integer-valued). */
function wQuantile(xs: number[], ws: number[], q: number): number {
  const ix = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const tot = sum(ws);
  if (!(tot > 0)) return NaN;
  let c = 0;
  for (const i of ix) { c += ws[i]!; if (c >= q * tot) return xs[i]!; }
  return xs[ix[ix.length - 1]!]!;
}
const deciles = (xs: number[], ws: number[]) => Array.from({ length: 9 }, (_, i) => wQuantile(xs, ws, (i + 1) / 10));
/** Share of `sortedAsc` at or below x — a percentile RANK, the cross-format-comparable unit. */
function pctRank(sortedAsc: number[], x: number): number {
  if (!sortedAsc.length || !Number.isFinite(x)) return NaN;
  let lo = 0, hi = sortedAsc.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedAsc[m]! <= x) lo = m + 1; else hi = m; }
  return lo / sortedAsc.length;
}
/** Deterministic RNG — mulberry32, the same convention as `duel`/`noiseShareCiUpper`
 *  (src/eval/cwhit/scorecard.ts). Not exported there, and it is a generic PRNG, not domain logic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pctl = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]! : NaN);

// ── deployed model + a NEUTRAL env (env-free field selection) ─────────────────
// The frame ranking uses `cardSideWobas(..., sspFree=true)`, which is the raw pre-environment wOBA
// the field stats rank by. Coeffs come from bronze-quick (era-2010 / park-1, all factors 1.0) exactly
// as tools/cwhit-scorecard.ts does, so nothing environmental enters the ranking.
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
const trained = (await repo.loadAll<{ id: string; eventForm?: EventForm }>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model missing eventForm");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tourneys = await repo.loadAll<Tournament>("tournaments");
const bq = tourneys.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

// ── per format × role ────────────────────────────────────────────────────────
type Role = "pit" | "hit";
interface ObsRow { name: string; val: number; vlvl: number; hand: string; usage: number }

interface Cell {
  slug: string; label: string; role: Role; tourneyId: string | null;
  meta: CwhitMeta;
  n: number; usageTotal: number;
  windowKnown: boolean; window: string;
  /** eligible pool = value window (via `inValueWindow`) ∧ `rowEligible` (Year/CardType rules + variants gate) */
  poolN: number; poolWindowOnlyN: number; ruleGated: boolean;
  poolMeanVal: number; poolMedianVal: number; poolMaxVal: number;
  wMeanVal: number; wMedianVal: number; wDeciles: number[];
  uMeanVal: number; uMedianVal: number; uDeciles: number[];
  /** THE HEADLINE: where the realized (usage-weighted) VAL sits as a percentile of THIS format's own
   *  eligible pool. Cross-format comparable even when the windows differ. */
  realizedPct: number; realizedMedianPct: number; unweightedPct: number;
  /** FRAME COVERAGE (§4) */
  joinedUsagePct: number; unjoinedRows: number; droppedRows: number;
  inFrameUsagePct: number; outFrameBaseUsagePct: number; variantUsagePct: number;
  frameN: number;
  warnings: string[];
}

/** The observed rows, normalized to (identity, usage). */
function readObs(slug: string, role: Role): { meta: CwhitMeta; rows: ObsRow[] } | null {
  const path = `${OBS_DIR}/cwhit-${slug}-${role}.tsv`;
  let tsv: string;
  try { tsv = readFileSync(path, "utf8"); } catch { return null; }
  if (role === "pit") {
    const { meta, rows } = parseCwhitPit(tsv);
    return { meta, rows: rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, usage: r.ip })) };
  }
  const { meta, rows } = parseCwhitHit(tsv);
  return { meta, rows: rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, usage: r.pa })) };
}

/** The top-FIELD_N our machinery would SEE, as a set of base Card IDs. Mirrors
 *  `computeUnifiedFieldStats`'s selection rule on the SAME window pool: pitchers = top-N by combined
 *  allowed wOBA (lower better); hitters = the union of the per-side top-N cohorts (higher better).
 *  The wOBA itself is the scoring core's `cardSideWobas` — no scoring assembled here. */
function frameIds(pool: Card[], role: Role): Set<string> {
  const recs = pool.map((c) => ({ id: String(c["Card ID"]), w: cardSideWobas(c, coeffs, rp, true) }));
  if (role === "pit") {
    return new Set([...recs].sort((a, b) => (a.w.pitVR + a.w.pitVL) - (b.w.pitVR + b.w.pitVL)).slice(0, FIELD_N).map((r) => r.id));
  }
  const vR = [...recs].sort((a, b) => b.w.hitVR - a.w.hitVR).slice(0, FIELD_N).map((r) => r.id);
  const vL = [...recs].sort((a, b) => b.w.hitVL - a.w.hitVL).slice(0, FIELD_N).map((r) => r.id);
  return new Set([...vR, ...vL]);
}

/** Per-row frame bucket, resolved once so the bootstrap can resample rows cheaply. */
type Bucket = "inFrame" | "outFrameBase" | "variant" | "unjoined";

function buildCell(fmt: Fmt, role: Role): Cell | null {
  const got = readObs(fmt.slug, role);
  if (!got) return null;
  const { meta, rows } = got;
  const warnings: string[] = [];
  if (meta.topN) warnings.push(`capture TRUNCATED to top ${meta.topN} by ${role === "pit" ? "IP" : "PA"} — the deep tail is NOT in this file`);

  const t = fmt.tourneyId ? tourneys.find((x) => x.id === fmt.tourneyId) ?? null : null;
  if (fmt.tourneyId && !t) warnings.push(`config ${fmt.tourneyId} not found`);
  const windowKnown = !!t;
  const win: ValueWindow | null = t
    ? { tier: t.id, valueMin: t.card_value_min ?? undefined, valueMax: t.card_value_max ?? 999 }
    : null;
  if (t && t.card_value_max == null) warnings.push("config has no card_value_max — window treated as open-topped");

  const usage = rows.map((r) => r.usage);
  const vals = rows.map((r) => r.val);
  const uOnes = rows.map(() => 1);

  const empty: Cell = {
    slug: fmt.slug, label: fmt.label, role, tourneyId: fmt.tourneyId, meta,
    n: rows.length, usageTotal: sum(usage),
    windowKnown, window: win ? `${win.valueMin ?? "*"}..${win.valueMax}` : "UNKNOWN (no config)",
    poolN: 0, poolWindowOnlyN: 0, ruleGated: false,
    poolMeanVal: NaN, poolMedianVal: NaN, poolMaxVal: NaN,
    wMeanVal: wMean(vals, usage), wMedianVal: wQuantile(vals, usage, 0.5), wDeciles: deciles(vals, usage),
    uMeanVal: wMean(vals, uOnes), uMedianVal: wQuantile(vals, uOnes, 0.5), uDeciles: deciles(vals, uOnes),
    realizedPct: NaN, realizedMedianPct: NaN, unweightedPct: NaN,
    joinedUsagePct: NaN, unjoinedRows: NaN, droppedRows: NaN,
    inFrameUsagePct: NaN, outFrameBaseUsagePct: NaN, variantUsagePct: NaN, frameN: 0,
    warnings,
  };
  if (!win || !t) { warnings.push("window UNKNOWN ⇒ no eligible-pool comparison, no frame coverage, NOT paired"); return empty; }

  // ── the eligible pool. `inValueWindow` is THE window test (it honours both min and max); the
  // rule group + variants gate come from the ONE `rowEligible`. Both are applied — a value-window-only
  // pool would misstate what actually competes in a rule-gated format (bronze-heart's Year rule).
  const windowOnly = baseCards.filter((c) => inValueWindow(c, win));
  const poolAll = windowOnly.filter((c) => rowEligible(c, t));
  const pool = poolAll.filter((c) => (role === "pit" ? isPit(c) : !isPit(c)));
  const poolValsAsc = pool.map((c) => n_(c["Card Value"])).sort((a, b) => a - b);
  if (poolAll.length !== windowOnly.length) warnings.push(`pool is RULE-GATED beyond the value window (${windowOnly.length} → ${poolAll.length}) — not comparable to an ungated format's pool without that caveat`);

  // ── frame: top-FIELD_N of the WINDOW pool (not role-filtered — `computeUnifiedFieldStats` ranks
  // the whole pool per role, exactly as production does).
  const frame = frameIds(poolAll, role);

  // ── join observed rows → our cards. KEY-ONLY join through the existing `joinCwhit`: candidates
  // carry EMPTY fingerprints, so unique (name|VAL|VLvl|Hand) keys join and COLLIDING keys are
  // DROPPED and reported rather than forced. Full rating-fingerprint disambiguation would need the
  // whole per-format predicted line (src/eval/cwhit/sample.ts, Quick-tier-only); the collision loss
  // is small and is reported below, so buying it was not worth a second sample assembler.
  const cands: JoinCard[] = [];
  const bucketOf = new Map<string, Bucket>();
  for (const bc of poolAll) {
    const id = String(bc["Card ID"]);
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!inValueWindow(c, win)) continue;
      if (role === "pit" ? !isPit(c) : isPit(c)) continue;
      const cid = `${id}|${vlvl}`;
      cands.push({ cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: String(c[role === "pit" ? "Throws" : "Bats"] ?? "") === "2" ? "L" : String(c[role === "pit" ? "Throws" : "Bats"] ?? "") === "3" ? "S" : "R", primary: [], validate: [] });
      bucketOf.set(cid, vlvl === 5 ? "variant" : frame.has(id) ? "inFrame" : "outFrameBase");
    }
  }
  const obsList: JoinObs<ObsRow>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [], validate: [], sample: r.usage, row: r }));
  const j = joinCwhit(obsList, cands);
  const rowBucket = new Map<ObsRow, Bucket>(rows.map((r) => [r, "unjoined" as Bucket]));
  for (const m of j.matched) rowBucket.set(m.obs.row, bucketOf.get(m.card.cid) ?? "outFrameBase");

  const tot = sum(usage);
  const share = (b: Bucket) => (tot > 0 ? sum(rows.filter((r) => rowBucket.get(r) === b).map((r) => r.usage)) / tot : NaN);
  const unjoined = share("unjoined");
  if (unjoined > 0.10) warnings.push(`${(unjoined * 100).toFixed(1)}% of usage did not join to the catalog — frame-coverage shares are conditional on the joined subset`);

  const wm = wMean(vals, usage);
  return {
    ...empty,
    poolN: pool.length, poolWindowOnlyN: windowOnly.length, ruleGated: poolAll.length !== windowOnly.length,
    poolMeanVal: poolValsAsc.length ? sum(poolValsAsc) / poolValsAsc.length : NaN,
    poolMedianVal: wQuantile(poolValsAsc, poolValsAsc.map(() => 1), 0.5),
    poolMaxVal: poolValsAsc.length ? poolValsAsc[poolValsAsc.length - 1]! : NaN,
    realizedPct: pctRank(poolValsAsc, wm),
    realizedMedianPct: pctRank(poolValsAsc, wQuantile(vals, usage, 0.5)),
    unweightedPct: pctRank(poolValsAsc, wMean(vals, uOnes)),
    joinedUsagePct: 1 - unjoined, unjoinedRows: j.stats.unmatched, droppedRows: j.stats.droppedRows,
    inFrameUsagePct: share("inFrame"), outFrameBaseUsagePct: share("outFrameBase"), variantUsagePct: share("variant"),
    frameN: frame.size, warnings,
  };
}

const cells: Cell[] = [];
for (const fmt of FORMATS) for (const role of ["pit", "hit"] as const) { const c = buildCell(fmt, role); if (c) cells.push(c); }
const cellOf = (slug: string, role: Role) => cells.find((c) => c.slug === slug && c.role === role);

// ── bootstrap on the pair CONTRASTS ──────────────────────────────────────────
// CARD-RESAMPLED (rows are cards), each format resampled independently, B reps, deterministic seed.
// The statistic is recomputed inside every rep; the CI is on the DIFFERENCE a − b, not on the levels.
// SAMPLE SIZE IS THE 100 CAPTURED ROWS. The fixture headers' "N of M tournaments" describes the
// SITE's aggregation and is NOT our N — it is deliberately not used anywhere here.
interface Contrast { stat: string; a: number; b: number; est: number; lo: number; hi: number; sig: boolean }
interface PairOut { kind: string; a: string; b: string; note: string; role: Role; nA: number; nB: number; contrasts: Contrast[]; warnings: string[] }

function rowStats(rows: ObsRow[], poolAsc: number[], bucket: Map<ObsRow, Bucket>): Record<string, number> {
  const vals = rows.map((r) => r.val), ws = rows.map((r) => r.usage);
  const tot = sum(ws);
  const sh = (b: Bucket) => (tot > 0 ? sum(rows.filter((r) => bucket.get(r) === b).map((r) => r.usage)) / tot : NaN);
  const wm = wMean(vals, ws);
  return {
    wMeanVal: wm,
    realizedPct: pctRank(poolAsc, wm),
    uMeanVal: wMean(vals, rows.map(() => 1)),
    outFrameBaseUsagePct: sh("outFrameBase"),
    offFrameUsagePct: sh("outFrameBase") + sh("variant"),
  };
}

const STATS = ["wMeanVal", "realizedPct", "uMeanVal", "outFrameBaseUsagePct", "offFrameUsagePct"] as const;

function pairContrast(p: Pair, role: Role): PairOut | null {
  const A = cellOf(p.a, role), Bc = cellOf(p.b, role);
  if (!A || !Bc) return null;
  const warnings = [...new Set([...A.warnings, ...Bc.warnings])];
  if (!A.windowKnown || !Bc.windowKnown) { warnings.push("a side has an UNKNOWN window ⇒ no contrast"); return { kind: p.kind, a: p.a, b: p.b, note: p.note, role, nA: A.n, nB: Bc.n, contrasts: [], warnings }; }
  if (A.window !== Bc.window) warnings.push(`windows differ (${A.window} vs ${Bc.window}) — the VAL-level contrast is not like-for-like; read realizedPct instead`);

  // Rebuild the row-level inputs for both sides (cheap; keeps the bootstrap self-contained).
  const side = (c: Cell) => {
    const got = readObs(c.slug, role)!;
    const t = tourneys.find((x) => x.id === c.tourneyId)!;
    const win: ValueWindow = { tier: t.id, valueMin: t.card_value_min ?? undefined, valueMax: t.card_value_max ?? 999 };
    const poolAll = baseCards.filter((x) => inValueWindow(x, win)).filter((x) => rowEligible(x, t));
    const poolAsc = poolAll.filter((x) => (role === "pit" ? isPit(x) : !isPit(x))).map((x) => n_(x["Card Value"])).sort((q, r) => q - r);
    const frame = frameIds(poolAll, role);
    const cands: JoinCard[] = []; const bucketOf = new Map<string, Bucket>();
    for (const bc of poolAll) {
      const id = String(bc["Card ID"]);
      for (const [vlvl, cd] of [[0, bc], [5, makeVariant(bc)]] as const) {
        if (!inValueWindow(cd, win)) continue;
        if (role === "pit" ? !isPit(cd) : isPit(cd)) continue;
        const hv = String(cd[role === "pit" ? "Throws" : "Bats"] ?? "");
        cands.push({ cid: `${id}|${vlvl}`, name: cardName(cd), val: n_(cd["Card Value"]), vlvl, hand: hv === "2" ? "L" : hv === "3" ? "S" : "R", primary: [], validate: [] });
        bucketOf.set(`${id}|${vlvl}`, vlvl === 5 ? "variant" : frame.has(id) ? "inFrame" : "outFrameBase");
      }
    }
    const obsList: JoinObs<ObsRow>[] = got.rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [], validate: [], sample: r.usage, row: r }));
    const jj = joinCwhit(obsList, cands);
    const bucket = new Map<ObsRow, Bucket>(got.rows.map((r) => [r, "unjoined" as Bucket]));
    for (const m of jj.matched) bucket.set(m.obs.row, bucketOf.get(m.card.cid) ?? "outFrameBase");
    return { rows: got.rows, poolAsc, bucket };
  };
  const sa = side(A), sb = side(Bc);

  const pt = { a: rowStats(sa.rows, sa.poolAsc, sa.bucket), b: rowStats(sb.rows, sb.poolAsc, sb.bucket) };
  const rnd = rng(SEED);
  const draws: Record<string, number[]> = Object.fromEntries(STATS.map((s) => [s, [] as number[]]));
  const resample = (rows: ObsRow[]) => rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
  for (let i = 0; i < B; i++) {
    const ra = rowStats(resample(sa.rows), sa.poolAsc, sa.bucket);
    const rb = rowStats(resample(sb.rows), sb.poolAsc, sb.bucket);
    for (const s of STATS) { const d = ra[s]! - rb[s]!; if (Number.isFinite(d)) draws[s]!.push(d); }
  }
  const contrasts: Contrast[] = STATS.map((s) => {
    const d = draws[s]!.slice().sort((x, y) => x - y);
    const lo = pctl(d, 0.025), hi = pctl(d, 0.975);
    return { stat: s, a: pt.a[s]!, b: pt.b[s]!, est: pt.a[s]! - pt.b[s]!, lo, hi, sig: Number.isFinite(lo) && Number.isFinite(hi) && lo * hi > 0 };
  });
  return { kind: p.kind, a: p.a, b: p.b, note: p.note, role, nA: sa.rows.length, nB: sb.rows.length, contrasts, warnings };
}

const pairs: PairOut[] = [];
for (const p of PAIRS) for (const role of ["pit", "hit"] as const) { const r = pairContrast(p, role); if (r) pairs.push(r); }

// ── output ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    caveat: "TRUNCATED CAPTURES: every table is the top-100 by usage. Total realized depth is NOT measurable here; these are compositions WITHIN the top-100, a LOWER BOUND on any depth effect.",
    catalog: srcId, fieldN: FIELD_N, bootstrapReps: B, seed: SEED, cells, pairs,
  }, null, 2) + "\n");
} else {
  const f2 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
  const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—");
  const sg = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "—");

  console.log("REALIZED DEPTH-OF-PLAY — cap vs uncapped, measured from cwhit OBSERVED tables");
  console.log(`catalog=${srcId}  FIELD_N=${FIELD_N}  bootstrap B=${B} seed=${SEED}\n`);
  console.log("!! TRUNCATION CAVEAT — attaches to EVERY number below !!");
  console.log("   Each capture is the TOP 100 BY USAGE. The deep tail is cut off by the capture, so");
  console.log("   TOTAL realized depth is NOT measurable here. These are VALUE COMPOSITIONS WITHIN the");
  console.log("   top-100. Truncation removes the weakest tail ⇒ biases AGAINST the hypothesis ⇒ any");
  console.log("   capped-format skew that survives is a LOWER BOUND on the true effect.\n");

  const cols: [string, number, (c: Cell) => string][] = [
    ["format", 20, (c) => c.label],
    ["role", 5, (c) => c.role],
    ["window", 8, (c) => (c.windowKnown ? c.window : "UNKNOWN")],
    ["budget", 9, (c) => (c.tourneyId ? (tourneys.find((t) => t.id === c.tourneyId)?.total_cap ? `cap ${tourneys.find((t) => t.id === c.tourneyId)!.total_cap}` : "uncapped") : "?")],
    ["n", 4, (c) => String(c.n)],
    ["poolN", 6, (c) => String(c.poolN) + (c.ruleGated ? "*" : "")],
    ["wVAL", 6, (c) => f2(c.wMeanVal, 1)],
    ["uVAL", 6, (c) => f2(c.uMeanVal, 1)],
    ["wMed", 5, (c) => f2(c.wMedianVal, 0)],
    ["poolMean", 9, (c) => f2(c.poolMeanVal, 1)],
    ["REAL%", 7, (c) => pc(c.realizedPct)],
    ["unw%", 7, (c) => pc(c.unweightedPct)],
    ["inFrm", 7, (c) => pc(c.inFrameUsagePct)],
    ["offFrm", 7, (c) => pc(Number.isFinite(c.outFrameBaseUsagePct) ? c.outFrameBaseUsagePct + c.variantUsagePct : NaN)],
    ["unjoin", 7, (c) => pc(1 - c.joinedUsagePct)],
  ];
  const line = (cs: string[]) => cs.map((s, i) => s.padEnd(cols[i]![1])).join(" ").trimEnd();
  console.log("§1–3  PER FORMAT × ROLE");
  console.log(line(cols.map((c) => c[0])));
  console.log(cols.map((c) => "-".repeat(c[1])).join(" "));
  for (const c of cells) console.log(line(cols.map((x) => x[2](c))));
  console.log("  wVAL/uVAL = usage-weighted / unweighted mean Card Value of the top-100.");
  console.log("  REAL%  = THE HEADLINE — wVAL as a PERCENTILE of that format's OWN eligible role pool.");
  console.log("           Cross-format comparable even when windows differ. Lower = realized play sits deeper.");
  console.log("  inFrm/offFrm = share of USAGE from cards inside / outside the top-FIELD_N our machinery sees");
  console.log("           (offFrm = out-of-frame base cards + all variants; variants are never in the base frame).");
  console.log("  * poolN = the format carries eligibility rules beyond the value window.\n");

  console.log("§1 DECILES of realized Card Value (usage-weighted | unweighted)");
  for (const c of cells) {
    console.log(`  ${(c.label + " " + c.role).padEnd(26)} w=[${c.wDeciles.map((d) => d.toFixed(0)).join(",")}]  u=[${c.uDeciles.map((d) => d.toFixed(0)).join(",")}]`);
  }

  console.log("\n§5 PAIR CONTRASTS (a − b), card-resampled bootstrap, 95% percentile CI");
  for (const p of pairs) {
    console.log(`\n  [${p.kind}] ${p.a} − ${p.b}  (${p.role})  nA=${p.nA} nB=${p.nB}`);
    console.log(`    ${p.note}`);
    if (!p.contrasts.length) { console.log("    NO CONTRAST COMPUTED"); }
    for (const c of p.contrasts) {
      const unit = c.stat.endsWith("Pct") ? 100 : 1;
      const d = c.stat.endsWith("Pct") ? 1 : 2;
      console.log(`    ${c.stat.padEnd(22)} a=${f2(c.a * unit, d)} b=${f2(c.b * unit, d)}  Δ=${sg(c.est * unit, d)}  [${sg(c.lo * unit, d)}, ${sg(c.hi * unit, d)}]  ${c.sig ? "SIG" : "ns"}`);
    }
    for (const w of p.warnings) console.log(`    ! ${w}`);
  }

  console.log("\nPER-CELL FLAGS");
  for (const c of cells) for (const w of c.warnings) console.log(`  ${c.label} ${c.role}: ${w}`);

  console.log("\nHOW TO READ THE VERDICT");
  console.log("  The hypothesis predicts: CAP TEST shows a NEGATIVE realizedPct / wMeanVal contrast and a");
  console.log("  POSITIVE offFrameUsagePct contrast, while BOTH CONTROLS show neither. If the controls move");
  console.log("  as much as the cap pair, the driver is format/era, not the budget. And in EVERY case the");
  console.log("  truncation caveat above bounds the reading — this cannot settle total realized depth.");
}
