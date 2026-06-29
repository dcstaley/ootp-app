// M6 — "where the model misses": per-card valuation error of the wOBA model on a
// window, surfaced four ways (per the user's methodology review):
//   • DISTRIBUTION per rating — the pool's spread + tier counts + tercile cuts, so
//     we can judge whether the bands are placed sensibly (and whether to re-bin).
//   • over/under-prediction LEADERBOARDS — the specific cards behind the top-N gap.
//   • SIGNATURE buckets — FULL band combinations across the signature ratings (e.g.
//     BABIP·H POW·L EYE·M K·M), not 2-rating partials, so every card in a bucket
//     shares its whole profile. Populated buckets only, sorted by volume.
//   • a 2D rating-pair GRID for every rating pair (the UI picks the axes).
// Valuation error = how much the model over-rates a card in VALUE (wOBA points;
// + = over-valued). Bucket/cell/dist means are PA^0.75/BF^0.75-weighted (toggle).

import type { TrainObs } from "./loader.ts";
import { HITTER, PITCHER, type RoleSpec, type BakeoffModel } from "./bakeoff.ts";
// Residuals score the DEPLOYED #2 model (raw-poly curve-form), not the retired
// log-linear baseline — so "where the model misses" reflects what users actually see.
// Tracks the deployed forms by reference: change RAWPOLY_PIT and this follows.
import { hitFormModel, pitFormModel, RAWPOLY_HIT, LOG_PIT } from "./forms.ts";

export interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number; ratings: Record<string, number> }
// grid cells carry both the RAW mean error and the INTERACTION residual (raw minus
// the additive row+col marginals) — the latter isolates true 2-way interactions.
export interface ResidGrid { row: string; col: string; cells: { n: number; meanValErrPts: number; interErrPts: number; sumVol: number }[][] }
export interface RatingDist { rating: string; min: number; max: number; median: number; terciles: [number, number]; tierCounts: { L: number; M: number; H: number }; hist: number[] }
export interface SignatureBucket { sig: Record<string, "L" | "M" | "H">; n: number; sumVol: number; meanValErrPts: number; stdValErrPts: number; members: CardResidual[] }
export interface MarginalTier { band: string; n: number; sumVol: number; meanErr: number }
export interface RatingMarginal { rating: string; bands3: MarginalTier[]; bands5: MarginalTier[] }
// App-fitted residual model: regress valuation error on z-scored ratings with
// quadratic + pairwise-interaction terms (ridge-stabilised, vol-weighted). Reports
// the SYSTEMATIC structure of the model's misses — and what fraction (r²) is
// systematic vs noise — using ALL cards jointly (no sparse-cell problem).
export interface ResidualModel {
  n: number; r2: number; weighted: boolean; intercept: number;
  perRating: { rating: string; linear: number; quad: number }[]; // points per ±1 SD
  interactions: { a: string; b: string; coef: number }[];        // sorted by |coef|
}
export interface ResidualAnalysis {
  role: "hitter" | "pitcher"; window: number[]; n: number; minN: number; includeVariants: boolean; weighted: boolean;
  ratings: string[]; sigRatings: string[]; bands: string[]; thresholds: Record<string, [number, number]>;
  distributions: RatingDist[]; marginals: RatingMarginal[]; residualModel: ResidualModel;
  over: CardResidual[]; under: CardResidual[]; signatures: SignatureBucket[]; grids: ResidGrid[];
}

// Ridge-regularised weighted least squares (self-scaled λ; intercept unpenalised).
// Used for the residual meta-model, where z and z² + interactions are collinear.
function ridgeWls(X: number[][], y: number[], w: number[], frac: number): number[] {
  const n = X.length, p = X[0]!.length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) { const wi = w[i]!; for (let j = 0; j < p; j++) { b[j] += wi * X[i]![j]! * y[i]!; for (let k = 0; k < p; k++) A[j]![k] += wi * X[i]![j]! * X[i]![k]!; } }
  let md = 0; for (let j = 1; j < p; j++) md += A[j]![j]!; md /= Math.max(1, p - 1);
  const lam = frac * md; for (let j = 1; j < p; j++) A[j]![j] += lam;
  const aug = A.map((r, i) => [...r, b[i]]);
  for (let col = 0; col < p; col++) {
    let mr = col; for (let r = col + 1; r < p; r++) if (Math.abs(aug[r]![col]!) > Math.abs(aug[mr]![col]!)) mr = r;
    [aug[col], aug[mr]] = [aug[mr]!, aug[col]!];
    const piv = aug[col]![col]!; if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < p; r++) { if (r === col) continue; const f = aug[r]![col]! / piv; for (let k = col; k <= p; k++) aug[r]![k] -= f * aug[col]![k]!; }
  }
  return aug.map((r, i) => Math.abs(r[i]!) < 1e-12 ? 0 : r[p]! / r[i]!);
}

type Band = "L" | "M" | "H";
const BANDS: Band[] = ["L", "M", "H"];
const HIST_BINS = 12;
function terciles(vals: number[]): [number, number] {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [q(1 / 3), q(2 / 3)];
}
const band = (v: number, t: [number, number]): Band => (v <= t[0] ? "L" : v >= t[1] ? "H" : "M");
const wmean = (xs: number[], ws: number[]) => { const W = ws.reduce((s, w) => s + w, 0); return W < 1e-9 ? 0 : xs.reduce((s, x, i) => s + x * ws[i]!, 0) / W; };
const wstd = (xs: number[], ws: number[]) => {
  if (xs.length < 2) return 0;
  const m = wmean(xs, ws), W = ws.reduce((s, w) => s + w, 0);
  return W < 1e-9 ? 0 : Math.sqrt(xs.reduce((s, x, i) => s + ws[i]! * (x - m) ** 2, 0) / W);
};

// Per-role rating accessors. `ratings` = the FULL display/dist/grid set (incl gap
// for hitters); `sig` = the subset that defines the signature buckets.
interface RoleCfg { spec: RoleSpec; model: BakeoffModel; ratings: Record<string, (o: TrainObs) => number>; sig: string[] }
const HIT_CFG: RoleCfg = {
  spec: HITTER, model: hitFormModel(RAWPOLY_HIT),
  ratings: { babip: (o) => o.ratings.hit.babip, pow: (o) => o.ratings.hit.pow, eye: (o) => o.ratings.hit.eye, k: (o) => o.ratings.hit.kRat, gap: (o) => o.ratings.hit.gap },
  sig: ["babip", "pow", "eye", "k"],
};
const PIT_CFG: RoleCfg = {
  spec: PITCHER, model: pitFormModel(LOG_PIT),
  ratings: { stu: (o) => o.ratings.pitch.stu, con: (o) => o.ratings.pitch.con, pbabip: (o) => o.ratings.pitch.pbabip, hrr: (o) => o.ratings.pitch.hrr },
  sig: ["stu", "con", "pbabip", "hrr"],
};

// `model` overrides the role's default (deployed) model — lets callers analyze a
// CANDIDATE model's misses (e.g. compare Poisson vs the deployed raw-poly) without
// touching the live endpoint, which never passes it.
export interface ResidOpts { includeVariants?: boolean; topK?: number; weighted?: boolean; minBucket?: number; model?: BakeoffModel }
export function analyzeResiduals(obs: TrainObs[], role: "hitter" | "pitcher", minN = 1000, opts: ResidOpts = {}): ResidualAnalysis {
  const { includeVariants = true, topK = 12, weighted = true, minBucket = 2 } = opts;
  const cfg = role === "hitter" ? HIT_CFG : PIT_CFG;
  const model = opts.model ?? cfg.model;
  const ratingNames = Object.keys(cfg.ratings);
  const qual = obs.filter((o) => cfg.spec.qualifies(o, minN) && (includeVariants || !o.variant));
  const params = model.fit(qual);
  const pred = model.predict(params, qual);
  const ew = qual.map((o) => (weighted ? cfg.spec.weight(o) : 1));
  const cards: CardResidual[] = qual.map((o, i) => {
    const actual = cfg.spec.actualWoba(o);
    const valErr = (cfg.spec.higherBetter ? pred[i]! - actual : actual - pred[i]!) * 1000;
    return { name: o.name, cid: o.cid, variant: o.variant, side: o.side, pred: pred[i]!, actual, valErrPts: +valErr.toFixed(1), vol: Math.round(role === "hitter" ? o.hit.PA : o.pitch.BF), ratings: Object.fromEntries(ratingNames.map((r) => [r, Math.round(cfg.ratings[r]!(o))])) };
  });
  const byErr = [...cards.keys()].sort((a, b) => cards[b]!.valErrPts - cards[a]!.valErrPts);
  const over = byErr.slice(0, topK).map((i) => cards[i]!);
  const under = byErr.slice(-topK).reverse().map((i) => cards[i]!);

  // Terciles + bands per rating; plus a histogram of the pool to judge the cuts.
  const thresholds: Record<string, [number, number]> = {};
  const vals: Record<string, number[]> = {};
  for (const r of ratingNames) { vals[r] = qual.map(cfg.ratings[r]!); const [lo, hi] = terciles(vals[r]!); thresholds[r] = [Math.round(lo), Math.round(hi)]; }
  const bandsOf = qual.map((o) => { const b: Record<string, Band> = {}; for (const r of ratingNames) b[r] = band(cfg.ratings[r]!(o), thresholds[r]!); return b; });

  const distributions: RatingDist[] = ratingNames.map((r) => {
    const v = vals[r]!, sorted = [...v].sort((a, b) => a - b);
    const min = sorted[0] ?? 0, max = sorted[sorted.length - 1] ?? 0, span = max - min || 1;
    const hist = new Array(HIST_BINS).fill(0);
    for (const x of v) hist[Math.min(HIST_BINS - 1, Math.floor(((x - min) / span) * HIST_BINS))]++;
    const tc = { L: 0, M: 0, H: 0 };
    for (const b of bandsOf) tc[b[r]!]++;
    return { rating: r, min: Math.round(min), max: Math.round(max), median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), terciles: thresholds[r]!, tierCounts: tc, hist };
  });

  // 1-D MARGINALS: vol-weighted mean valuation error per rating tier — 3-band
  // (terciles) + 5-band (extremes). The reliable per-rating "main effect".
  const tierMeans = (r: string, ps: number[], labels: string[]): MarginalTier[] => {
    const s = [...vals[r]!].sort((a, b) => a - b);
    const cs = ps.map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
    const tierIdx = (v: number) => { let i = 0; while (i < cs.length && v > cs[i]!) i++; return i; };
    return labels.map((bandLabel, ti) => {
      const idx = qual.map((_, i) => i).filter((i) => tierIdx(vals[r]![i]!) === ti);
      return { band: bandLabel, n: idx.length, sumVol: idx.reduce((acc, i) => acc + cards[i]!.vol, 0), meanErr: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => ew[i]!)).toFixed(1) };
    });
  };
  const marginals: RatingMarginal[] = ratingNames.map((r) => ({ rating: r, bands3: tierMeans(r, [1 / 3, 2 / 3], ["L", "M", "H"]), bands5: tierMeans(r, [0.1, 0.3, 0.7, 0.9], ["XL", "L", "M", "H", "XH"]) }));

  // RESIDUAL META-MODEL: regress valErr on z-scored ratings + quadratics + pairwise
  // interactions (ridge-stabilised, weighted). r² = fraction of the mis-valuation
  // that is SYSTEMATIC (ratings-explainable) vs noise — using all cards jointly.
  const mean: Record<string, number> = {}, std: Record<string, number> = {};
  for (const r of ratingNames) { mean[r] = wmean(vals[r]!, ew); std[r] = Math.max(wstd(vals[r]!, ew), 1e-6); }
  const pN = ratingNames.length;
  const Xr = qual.map((_, i) => {
    const z = ratingNames.map((r) => (vals[r]![i]! - mean[r]!) / std[r]!);
    const row = [1, ...z, ...z.map((v) => v * v)];
    for (let aI = 0; aI < pN; aI++) for (let bI = aI + 1; bI < pN; bI++) row.push(z[aI]! * z[bI]!);
    return row;
  });
  const yv = cards.map((c) => c.valErrPts);
  const beta = ridgeWls(Xr, yv, ew, 0.15);
  const predY = Xr.map((row) => row.reduce((s, x, j) => s + x * beta[j]!, 0));
  const yMean = wmean(yv, ew);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < yv.length; i++) { ssRes += ew[i]! * (yv[i]! - predY[i]!) ** 2; ssTot += ew[i]! * (yv[i]! - yMean) ** 2; }
  const interactions: { a: string; b: string; coef: number }[] = [];
  { let k = 1 + 2 * pN; for (let aI = 0; aI < pN; aI++) for (let bI = aI + 1; bI < pN; bI++) { interactions.push({ a: ratingNames[aI]!, b: ratingNames[bI]!, coef: +beta[k]!.toFixed(2) }); k++; } }
  interactions.sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));
  const residualModel: ResidualModel = {
    n: qual.length, r2: ssTot < 1e-9 ? 0 : +(1 - ssRes / ssTot).toFixed(3), weighted, intercept: +beta[0]!.toFixed(2),
    perRating: ratingNames.map((r, i) => ({ rating: r, linear: +beta[1 + i]!.toFixed(2), quad: +beta[1 + pN + i]!.toFixed(2) })),
    interactions,
  };

  // FULL-signature buckets over the signature ratings (every observed L/M/H combo).
  const groups = new Map<string, number[]>();
  qual.forEach((_, i) => { const key = cfg.sig.map((r) => bandsOf[i]![r]).join(""); (groups.get(key) ?? groups.set(key, []).get(key)!).push(i); });
  const signatures: SignatureBucket[] = [...groups.entries()]
    .filter(([, idx]) => idx.length >= minBucket)
    .map(([key, idx]) => {
      const sig: Record<string, Band> = {}; cfg.sig.forEach((r, j) => { sig[r] = key[j] as Band; });
      const errs = idx.map((i) => cards[i]!.valErrPts), ws = idx.map((i) => ew[i]!);
      return { sig, n: idx.length, sumVol: idx.reduce((s, i) => s + cards[i]!.vol, 0), meanValErrPts: +wmean(errs, ws).toFixed(1), stdValErrPts: +wstd(errs, ws).toFixed(1), members: idx.map((i) => cards[i]!).sort((x, y) => y.valErrPts - x.valErrPts) };
    })
    .sort((a, b) => b.sumVol - a.sumVol);

  // A 3×3 residual grid for every pair of ratings. Each cell carries the RAW mean
  // AND the interaction residual = raw − (row marginal + col marginal − overall),
  // which strips the additive 1-D effects so only true 2-way interactions remain.
  const overall = wmean(cards.map((c) => c.valErrPts), ew);
  const margFor = (r: string) => { const m: Record<string, number> = {}; for (const bnd of BANDS) { const idx = qual.map((_, i) => i).filter((i) => bandsOf[i]![r] === bnd); m[bnd] = wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => ew[i]!)); } return m; };
  const grids: ResidGrid[] = [];
  for (let a = 0; a < ratingNames.length; a++) for (let b = a + 1; b < ratingNames.length; b++) {
    const row = ratingNames[a]!, col = ratingNames[b]!;
    const rowM = margFor(row), colM = margFor(col);
    const cells = BANDS.map((rb) => BANDS.map((cb) => {
      const idx = qual.map((_, i) => i).filter((i) => bandsOf[i]![row] === rb && bandsOf[i]![col] === cb);
      const m = idx.length ? wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => ew[i]!)) : 0;
      const inter = idx.length ? m - rowM[rb]! - colM[cb]! + overall : 0;
      return { n: idx.length, meanValErrPts: +m.toFixed(1), interErrPts: +inter.toFixed(1), sumVol: idx.reduce((s, i) => s + cards[i]!.vol, 0) };
    }));
    grids.push({ row, col, cells });
  }

  return { role, window: [], n: qual.length, minN, includeVariants, weighted, ratings: ratingNames, sigRatings: cfg.sig, bands: BANDS, thresholds, distributions, marginals, residualModel, over, under, signatures, grids };
}
