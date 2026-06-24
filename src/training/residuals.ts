// M6 — "where the model misses": per-card valuation error of the wOBA model on a
// window, surfaced three ways (per the user's interest in extremes + card SHAPES,
// not external covariates):
//   • over/under-prediction LEADERBOARDS — the specific cards behind the top-N gap.
//   • named ARCHETYPE buckets — does the additive model systematically mis-value a
//     card profile (low-BABIP/high-POW slugger, high-avoid-K/low-POW contact, …)?
//   • a 2D rating-pair GRID — interaction corners an additive form can't represent.
// Valuation error = how much the model over-rates a card in VALUE (wOBA points;
// + = over-valued, − = under-valued). Bucket means are PA^0.75 / BF^0.75 weighted.

import type { TrainObs } from "./loader.ts";
import { HITTER, PITCHER, wobaHitting, wobaPitching, type RoleSpec, type BakeoffModel } from "./bakeoff.ts";

export interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number }
export interface Bucket { name: string; desc: string; n: number; meanValErrPts: number; sumW: number }
export interface ResidGrid { rowRating: string; colRating: string; bands: string[]; cells: { n: number; meanValErrPts: number; sumW: number }[][] }
export interface ResidualAnalysis {
  role: "hitter" | "pitcher"; window: number[]; n: number;
  over: CardResidual[]; under: CardResidual[]; archetypes: Bucket[]; grid: ResidGrid;
}

type Band = "L" | "M" | "H";
function terciles(vals: number[]): [number, number] {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [q(1 / 3), q(2 / 3)];
}
const band = (v: number, t: [number, number]): Band => (v <= t[0] ? "L" : v >= t[1] ? "H" : "M");
const wmean = (xs: number[], ws: number[]) => { const W = ws.reduce((s, w) => s + w, 0); return W < 1e-9 ? 0 : xs.reduce((s, x, i) => s + x * ws[i]!, 0) / W; };

// Per-role rating accessors + archetype/grid definitions. All ratings are
// higher-is-better in both roles, so band "H" = strong in that dimension.
interface RoleCfg {
  spec: RoleSpec; model: BakeoffModel;
  ratings: Record<string, (o: TrainObs) => number>;
  archetypes: { name: string; desc: string; match: (b: Record<string, Band>) => boolean }[];
  grid: { row: string; col: string };
}
const HIT_CFG: RoleCfg = {
  spec: HITTER, model: wobaHitting,
  ratings: { babip: (o) => o.ratings.hit.babip, pow: (o) => o.ratings.hit.pow, eye: (o) => o.ratings.hit.eye, k: (o) => o.ratings.hit.kRat, gap: (o) => o.ratings.hit.gap },
  archetypes: [
    { name: "Power, weak contact", desc: "high POW · low BABIP", match: (b) => b.pow === "H" && b.babip === "L" },
    { name: "Contact, no power", desc: "high BABIP · low POW", match: (b) => b.babip === "H" && b.pow === "L" },
    { name: "Three true outcomes", desc: "high POW · high EYE · low avoid-K", match: (b) => b.pow === "H" && b.eye === "H" && b.k === "L" },
    { name: "Patient, no power", desc: "high BABIP · high EYE · low POW", match: (b) => b.babip === "H" && b.eye === "H" && b.pow === "L" },
    { name: "Free swinger", desc: "low EYE · low avoid-K", match: (b) => b.eye === "L" && b.k === "L" },
    { name: "Elite all-around", desc: "high POW · high BABIP · high EYE", match: (b) => b.pow === "H" && b.babip === "H" && b.eye === "H" },
  ],
  grid: { row: "babip", col: "pow" },
};
const PIT_CFG: RoleCfg = {
  spec: PITCHER, model: wobaPitching,
  ratings: { stu: (o) => o.ratings.pitch.stu, con: (o) => o.ratings.pitch.con, pbabip: (o) => o.ratings.pitch.pbabip, hrr: (o) => o.ratings.pitch.hrr },
  archetypes: [
    { name: "Power, wild", desc: "high STU · low CON", match: (b) => b.stu === "H" && b.con === "L" },
    { name: "Finesse/control", desc: "high CON · low STU", match: (b) => b.con === "H" && b.stu === "L" },
    { name: "Contact manager", desc: "high pBABIP · low STU", match: (b) => b.pbabip === "H" && b.stu === "L" },
    { name: "HR-prone", desc: "low HR-avoid", match: (b) => b.hrr === "L" },
    { name: "Ace", desc: "high STU · high CON · high HR-avoid", match: (b) => b.stu === "H" && b.con === "H" && b.hrr === "H" },
  ],
  grid: { row: "con", col: "stu" },
};

export function analyzeResiduals(obs: TrainObs[], role: "hitter" | "pitcher", minN = 1000, topK = 12): ResidualAnalysis {
  const cfg = role === "hitter" ? HIT_CFG : PIT_CFG;
  const qual = obs.filter((o) => cfg.spec.qualifies(o, minN));
  const params = cfg.model.fit(qual);
  const pred = cfg.model.predict(params, qual);
  const w = qual.map((o) => cfg.spec.weight(o));
  const cards: CardResidual[] = qual.map((o, i) => {
    const actual = cfg.spec.actualWoba(o);
    const valErr = (cfg.spec.higherBetter ? pred[i]! - actual : actual - pred[i]!) * 1000; // + = over-valued (pts)
    return { name: o.name, cid: o.cid, variant: o.variant, side: o.side, pred: pred[i]!, actual, valErrPts: +valErr.toFixed(1), vol: Math.round(role === "hitter" ? o.hit.PA : o.pitch.BF) };
  });
  const byErr = cards.map((c, i) => ({ c, w: w[i]! })).sort((a, b) => b.c.valErrPts - a.c.valErrPts);
  const over = byErr.slice(0, topK).map((x) => x.c);
  const under = byErr.slice(-topK).reverse().map((x) => x.c);

  // Band each card on every rating (within-window terciles).
  const ratingNames = Object.keys(cfg.ratings);
  const ts: Record<string, [number, number]> = {};
  for (const r of ratingNames) ts[r] = terciles(qual.map(cfg.ratings[r]!));
  const bandsOf = qual.map((o) => { const b: Record<string, Band> = {}; for (const r of ratingNames) b[r] = band(cfg.ratings[r]!(o), ts[r]!); return b; });

  const archetypes: Bucket[] = cfg.archetypes.map((a) => {
    const idx = bandsOf.map((b, i) => (a.match(b) ? i : -1)).filter((i) => i >= 0);
    const sumW = idx.reduce((s, i) => s + w[i]!, 0);
    return { name: a.name, desc: a.desc, n: idx.length, meanValErrPts: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => w[i]!)).toFixed(1), sumW: Math.round(sumW) };
  });

  // 2D residual grid (row × col rating, terciles).
  const BANDS: Band[] = ["L", "M", "H"];
  const cells = BANDS.map((rb) => BANDS.map((cb) => {
    const idx = qual.map((_, i) => i).filter((i) => bandsOf[i]![cfg.grid.row] === rb && bandsOf[i]![cfg.grid.col] === cb);
    return { n: idx.length, meanValErrPts: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => w[i]!)).toFixed(1), sumW: Math.round(idx.reduce((s, i) => s + w[i]!, 0)) };
  }));
  const grid: ResidGrid = { rowRating: cfg.grid.row, colRating: cfg.grid.col, bands: BANDS, cells };

  return { role, window: [], n: qual.length, over, under, archetypes, grid };
}
