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
import { HITTER, PITCHER, wobaHitting, wobaPitching, type RoleSpec, type BakeoffModel } from "./bakeoff.ts";

export interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number; ratings: Record<string, number> }
export interface ResidGrid { row: string; col: string; cells: { n: number; meanValErrPts: number; sumVol: number }[][] }
export interface RatingDist { rating: string; min: number; max: number; median: number; terciles: [number, number]; tierCounts: { L: number; M: number; H: number }; hist: number[] }
export interface SignatureBucket { sig: Record<string, "L" | "M" | "H">; n: number; sumVol: number; meanValErrPts: number; stdValErrPts: number; members: CardResidual[] }
export interface ResidualAnalysis {
  role: "hitter" | "pitcher"; window: number[]; n: number; minN: number; includeVariants: boolean; weighted: boolean;
  ratings: string[]; sigRatings: string[]; bands: string[]; thresholds: Record<string, [number, number]>;
  distributions: RatingDist[]; over: CardResidual[]; under: CardResidual[]; signatures: SignatureBucket[]; grids: ResidGrid[];
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
  spec: HITTER, model: wobaHitting,
  ratings: { babip: (o) => o.ratings.hit.babip, pow: (o) => o.ratings.hit.pow, eye: (o) => o.ratings.hit.eye, k: (o) => o.ratings.hit.kRat, gap: (o) => o.ratings.hit.gap },
  sig: ["babip", "pow", "eye", "k"],
};
const PIT_CFG: RoleCfg = {
  spec: PITCHER, model: wobaPitching,
  ratings: { stu: (o) => o.ratings.pitch.stu, con: (o) => o.ratings.pitch.con, pbabip: (o) => o.ratings.pitch.pbabip, hrr: (o) => o.ratings.pitch.hrr },
  sig: ["stu", "con", "pbabip", "hrr"],
};

export interface ResidOpts { includeVariants?: boolean; topK?: number; weighted?: boolean; minBucket?: number }
export function analyzeResiduals(obs: TrainObs[], role: "hitter" | "pitcher", minN = 1000, opts: ResidOpts = {}): ResidualAnalysis {
  const { includeVariants = true, topK = 12, weighted = true, minBucket = 2 } = opts;
  const cfg = role === "hitter" ? HIT_CFG : PIT_CFG;
  const ratingNames = Object.keys(cfg.ratings);
  const qual = obs.filter((o) => cfg.spec.qualifies(o, minN) && (includeVariants || !o.variant));
  const params = cfg.model.fit(qual);
  const pred = cfg.model.predict(params, qual);
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

  // A 3×3 residual grid for every pair of ratings (UI picks the axes).
  const grids: ResidGrid[] = [];
  for (let a = 0; a < ratingNames.length; a++) for (let b = a + 1; b < ratingNames.length; b++) {
    const row = ratingNames[a]!, col = ratingNames[b]!;
    const cells = BANDS.map((rb) => BANDS.map((cb) => {
      const idx = qual.map((_, i) => i).filter((i) => bandsOf[i]![row] === rb && bandsOf[i]![col] === cb);
      return { n: idx.length, meanValErrPts: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => ew[i]!)).toFixed(1), sumVol: idx.reduce((s, i) => s + cards[i]!.vol, 0) };
    }));
    grids.push({ row, col, cells });
  }

  return { role, window: [], n: qual.length, minN, includeVariants, weighted, ratings: ratingNames, sigRatings: cfg.sig, bands: BANDS, thresholds, distributions, over, under, signatures, grids };
}
