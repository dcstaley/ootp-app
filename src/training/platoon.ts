// M6 — realized platoon EXPOSURE from training outcomes. Two products:
//   • OVR-blend splits (score-card convention) — per batter/pitcher hand, the weight on
//     the SAME-letter side: r_hit_split = RHB's PA share vs RHP, l_hit_split = LHB's share
//     vs LHP, s_hit_split = SHB's share vs RHP; r_pitch_split = RHP's BF share vs RHB,
//     l_pitch_split = LHP's share vs LHB. These seed a NEW tournament's OVR weighting.
//   • teamVR/VL — overall offense PA share vs RHP/LHP (the optimizer's team exposure).
// Plus the raw per-hand shares (+ volumes) for the Model-Training display.
//
// Pure aggregation over (bats/throws hand × pitcher/batter side faced). `side` in the
// data = the OPPONENT hand faced (hitter side=R ⇒ vs RHP; pitcher side=R ⇒ vs RHB).

import type { TrainObs } from "./loader.ts";

export interface PlatoonHit { hand: "R" | "L" | "S"; vsRHP: number; vsLHP: number; pa: number }
export interface PlatoonPit { hand: "R" | "L"; vsRHB: number; vsLHB: number; bf: number }
export interface PlatoonExposure {
  r_hit_split: number; l_hit_split: number; s_hit_split: number;
  r_pitch_split: number; l_pitch_split: number;
  teamVR: number; teamVL: number;
  hit: PlatoonHit[]; pit: PlatoonPit[];
}

const share = (a: number, b: number, fallback: number) => (a + b > 1e-9 ? a / (a + b) : fallback);

export function computePlatoon(obs: TrainObs[]): PlatoonExposure {
  const hAcc: Record<number, { R: number; L: number }> = {};
  const pAcc: Record<number, { R: number; L: number }> = {};
  for (const o of obs) {
    if (o.hit.PA > 0) (hAcc[o.bats] ??= { R: 0, L: 0 })[o.side] += o.hit.PA;
    if (o.pitch.BF > 0) (pAcc[o.throws] ??= { R: 0, L: 0 })[o.side] += o.pitch.BF;
  }
  const h = (c: number) => hAcc[c] ?? { R: 0, L: 0 };
  const p = (c: number) => pAcc[c] ?? { R: 0, L: 0 };
  const R = h(1), L = h(2), S = h(3), PR = p(1), PL = p(2);
  const allR = R.R + L.R + S.R, allL = R.L + L.L + S.L;
  return {
    r_hit_split: share(R.R, R.L, 0.5),   // RHB vs RHP
    l_hit_split: share(L.L, L.R, 0.5),   // LHB vs LHP
    s_hit_split: share(S.R, S.L, 0.5),   // SHB vs RHP
    r_pitch_split: share(PR.R, PR.L, 0.5), // RHP vs RHB
    l_pitch_split: share(PL.L, PL.R, 0.5), // LHP vs LHB
    teamVR: share(allR, allL, 0.5),
    teamVL: share(allL, allR, 0.5),
    hit: ([["R", R], ["L", L], ["S", S]] as const).map(([hand, v]) => ({ hand, vsRHP: share(v.R, v.L, 0), vsLHP: share(v.L, v.R, 0), pa: Math.round(v.R + v.L) })),
    pit: ([["R", PR], ["L", PL]] as const).map(([hand, v]) => ({ hand, vsRHB: share(v.R, v.L, 0), vsLHB: share(v.L, v.R, 0), bf: Math.round(v.R + v.L) })),
  };
}
