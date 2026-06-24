// M6 — "where the model misses": per-card valuation error of the wOBA model on a
// window, surfaced three ways (per the user's interest in extremes + card SHAPES,
// not external covariates):
//   • over/under-prediction LEADERBOARDS — the specific cards behind the top-N gap.
//   • named ARCHETYPE buckets — does the additive model systematically mis-value a
//     card profile (low-BABIP/high-POW slugger, high-avoid-K/low-POW contact, …)?
//     Each bucket carries its member cards (expandable) + total volume.
//   • a 2D rating-pair GRID for EVERY pair of the role's core ratings (the UI picks
//     the axes) — interaction corners an additive form can't represent.
// Valuation error = how much the model over-rates a card in VALUE (wOBA points;
// + = over-valued, − = under-valued). Bucket/cell means are PA^0.75 / BF^0.75
// weighted. vL and vR are SEPARATE observations (per-side ratings), so a card shows
// once per side — the leaderboards label the side.

import type { TrainObs } from "./loader.ts";
import { HITTER, PITCHER, wobaHitting, wobaPitching, type RoleSpec, type BakeoffModel } from "./bakeoff.ts";

export interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number }
export interface Bucket { name: string; desc: string; n: number; meanValErrPts: number; sumVol: number; members: CardResidual[] }
export interface ResidGrid { row: string; col: string; cells: { n: number; meanValErrPts: number; sumVol: number }[][] }
export interface ResidualAnalysis {
  role: "hitter" | "pitcher"; window: number[]; n: number; minN: number; includeVariants: boolean;
  ratings: string[]; bands: string[];
  over: CardResidual[]; under: CardResidual[]; archetypes: Bucket[]; grids: ResidGrid[];
}

type Band = "L" | "M" | "H";
const BANDS: Band[] = ["L", "M", "H"];
function terciles(vals: number[]): [number, number] {
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [q(1 / 3), q(2 / 3)];
}
const band = (v: number, t: [number, number]): Band => (v <= t[0] ? "L" : v >= t[1] ? "H" : "M");
const wmean = (xs: number[], ws: number[]) => { const W = ws.reduce((s, w) => s + w, 0); return W < 1e-9 ? 0 : xs.reduce((s, x, i) => s + x * ws[i]!, 0) / W; };

interface RoleCfg {
  spec: RoleSpec; model: BakeoffModel;
  ratings: Record<string, (o: TrainObs) => number>; // the role's CORE ratings (grid axes + archetype bands)
  archetypes: { name: string; desc: string; match: (b: Record<string, Band>) => boolean }[];
}
const HIT_CFG: RoleCfg = {
  spec: HITTER, model: wobaHitting,
  ratings: { babip: (o) => o.ratings.hit.babip, pow: (o) => o.ratings.hit.pow, eye: (o) => o.ratings.hit.eye, k: (o) => o.ratings.hit.kRat },
  archetypes: [
    { name: "Power, weak contact", desc: "high POW · low BABIP", match: (b) => b.pow === "H" && b.babip === "L" },
    { name: "Contact, no power", desc: "high BABIP · low POW", match: (b) => b.babip === "H" && b.pow === "L" },
    { name: "Three true outcomes", desc: "high POW · high EYE · low avoid-K", match: (b) => b.pow === "H" && b.eye === "H" && b.k === "L" },
    { name: "Patient, no power", desc: "high BABIP · high EYE · low POW", match: (b) => b.babip === "H" && b.eye === "H" && b.pow === "L" },
    { name: "Free swinger", desc: "low EYE · low avoid-K", match: (b) => b.eye === "L" && b.k === "L" },
    { name: "Elite all-around", desc: "high POW · high BABIP · high EYE", match: (b) => b.pow === "H" && b.babip === "H" && b.eye === "H" },
  ],
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
};

export interface ResidOpts { includeVariants?: boolean; topK?: number }
export function analyzeResiduals(obs: TrainObs[], role: "hitter" | "pitcher", minN = 1000, opts: ResidOpts = {}): ResidualAnalysis {
  const { includeVariants = true, topK = 12 } = opts;
  const cfg = role === "hitter" ? HIT_CFG : PIT_CFG;
  const ratingNames = Object.keys(cfg.ratings);
  const qual = obs.filter((o) => cfg.spec.qualifies(o, minN) && (includeVariants || !o.variant));
  const params = cfg.model.fit(qual);
  const pred = cfg.model.predict(params, qual);
  const w = qual.map((o) => cfg.spec.weight(o));
  const cards: CardResidual[] = qual.map((o, i) => {
    const actual = cfg.spec.actualWoba(o);
    const valErr = (cfg.spec.higherBetter ? pred[i]! - actual : actual - pred[i]!) * 1000; // + = over-valued (pts)
    return { name: o.name, cid: o.cid, variant: o.variant, side: o.side, pred: pred[i]!, actual, valErrPts: +valErr.toFixed(1), vol: Math.round(role === "hitter" ? o.hit.PA : o.pitch.BF) };
  });
  const byErr = [...cards.keys()].sort((a, b) => cards[b]!.valErrPts - cards[a]!.valErrPts);
  const over = byErr.slice(0, topK).map((i) => cards[i]!);
  const under = byErr.slice(-topK).reverse().map((i) => cards[i]!);

  // Band each card on every core rating (within-window terciles).
  const ts: Record<string, [number, number]> = {};
  for (const r of ratingNames) ts[r] = terciles(qual.map(cfg.ratings[r]!));
  const bandsOf = qual.map((o) => { const b: Record<string, Band> = {}; for (const r of ratingNames) b[r] = band(cfg.ratings[r]!(o), ts[r]!); return b; });

  const archetypes: Bucket[] = cfg.archetypes.map((a) => {
    const idx = bandsOf.map((b, i) => (a.match(b) ? i : -1)).filter((i) => i >= 0);
    const members = idx.map((i) => cards[i]!).sort((x, y) => y.valErrPts - x.valErrPts);
    return {
      name: a.name, desc: a.desc, n: idx.length,
      meanValErrPts: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => w[i]!)).toFixed(1),
      sumVol: idx.reduce((s, i) => s + cards[i]!.vol, 0), members,
    };
  });

  // A 3×3 residual grid for EVERY pair of core ratings (UI picks the axes).
  const grids: ResidGrid[] = [];
  for (let a = 0; a < ratingNames.length; a++) for (let b = a + 1; b < ratingNames.length; b++) {
    const row = ratingNames[a]!, col = ratingNames[b]!;
    const cells = BANDS.map((rb) => BANDS.map((cb) => {
      const idx = qual.map((_, i) => i).filter((i) => bandsOf[i]![row] === rb && bandsOf[i]![col] === cb);
      return { n: idx.length, meanValErrPts: +wmean(idx.map((i) => cards[i]!.valErrPts), idx.map((i) => w[i]!)).toFixed(1), sumVol: idx.reduce((s, i) => s + cards[i]!.vol, 0) };
    }));
    grids.push({ row, col, cells });
  }

  return { role, window: [], n: qual.length, minN, includeVariants, ratings: ratingNames, bands: BANDS, over, under, archetypes, grids };
}
