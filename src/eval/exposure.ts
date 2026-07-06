// Pool-derived platoon EXPOSURE baseline (ratings-only) + trained DEPLOYMENT shift.
// See docs/REBUILD_PLATOON_EXPOSURE_PLAN.md Part A.
//
//   effective = baseline(target pool) + deployment(source model)
//
// • BASELINE — usage-weighted handedness counts over the role-agnostic top-X field
//   (see the pool-role-agnostic-topx principle: top-N BY RATING, role NEVER gates). Under
//   NEUTRAL matchups every hitter faces the pitcher-hand population and every pitcher faces
//   the batter-hand population, so all the splits fall out of two field compositions.
// • DEPLOYMENT — the managed-platooning shift = realized − baseline (both measured on the
//   SAME pool), carried in LOGIT space so it stays bounded and transfers to other pools.

const EPS = 1e-6;
const clamp01 = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
/** logit / inverse-logit (numerically stable). */
export const logit = (p: number) => { const q = clamp01(p); return Math.log(q / (1 - q)); };
export const expit = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** One card scored on both sides + its usage proxies. bats/throws: 1=R 2=L (bats 3=S). */
export interface FieldMember {
  bats: number;
  throws: number;
  hitVR: number; hitVL: number; // hitter value per side (higher = better)
  pitVal: number;               // pitcher OVR value (higher = better)
  hitWeight?: number;           // PA proxy for the hitter field (default 1 = flat lineup PA)
  pitWeight?: number;           // BF proxy for the pitcher field (default 1; stamina is the usual proxy)
}

/** Baseline splits (no deployment). Pitch splits are role-agnostic here — a neutral batter
 *  population is the same for SP and RP; the SP/RP difference is a deployment effect. */
export interface ExposureBaseline {
  platoonVR: number; platoonVL: number;
  r_hit_split: number; l_hit_split: number; s_hit_split: number;
  r_pitch_split: number; l_pitch_split: number;
}

/** Realized (outcome-measured) splits — the shape of the trained PlatoonExposure artifact. */
export interface RealizedSplits {
  teamVR: number;
  r_hit_split: number; l_hit_split: number; s_hit_split: number;
  r_pitch_split_sp: number; l_pitch_split_sp: number;
  r_pitch_split_rp: number; l_pitch_split_rp: number;
}

/** Logit-space deltas (realized − baseline). Pitch is role-conditional (SP/RP) off the one
 *  role-agnostic baseline pitch split. */
export interface DeploymentShift {
  team: number;
  r_hit: number; l_hit: number; s_hit: number;
  r_pitch_sp: number; l_pitch_sp: number; r_pitch_rp: number; l_pitch_rp: number;
}

/** Fully-resolved exposure ready for rosterOptions / resolvePitchSplit. */
export interface EffectiveExposure {
  platoonVR: number; platoonVL: number;
  r_hit_split: number; l_hit_split: number; s_hit_split: number;
  r_pitch_split_sp: number; l_pitch_split_sp: number;
  r_pitch_split_rp: number; l_pitch_split_rp: number;
  r_pitch_split: number; l_pitch_split: number; // sp/rp mean, for role-agnostic callers
}

/**
 * Pool exposure baseline = usage-weighted handedness of the top-X field. Hitter field = union
 * of the top-X by each platoon side; pitcher field = top-X by OVR (role-agnostic — a card is a
 * "pitcher" iff it ranks, never by a role flag). Switch hitters bat OPPOSITE the pitcher, so
 * from a RHP's view they are LHB and from a LHP's view they are RHB — i.e. never the pitcher's
 * same-hand batter — so pure-RH/pure-LH fractions ARE the pitcher batter-hand exposures.
 */
export function computeBaseline(members: FieldMember[], topX: number): ExposureBaseline {
  const topBy = (key: (m: FieldMember) => number) => [...members].sort((a, b) => key(b) - key(a)).slice(0, topX);
  const hitField = new Set<FieldMember>([...topBy((m) => m.hitVR), ...topBy((m) => m.hitVL)]);
  const pitField = topBy((m) => m.pitVal);

  // Pitcher field → team hitter exposure (BF-weighted RHP share).
  let pR = 0, pTot = 0;
  for (const m of pitField) { const w = m.pitWeight ?? 1; pTot += w; if (m.throws === 1) pR += w; }
  const platoonVR = pTot > 0 ? pR / pTot : 0.5;

  // Hitter field → pitcher batter-hand exposure (PA-weighted pure-hand fractions).
  let hR = 0, hL = 0, hTot = 0;
  for (const m of hitField) { const w = m.hitWeight ?? 1; hTot += w; if (m.bats === 1) hR += w; else if (m.bats === 2) hL += w; }
  const fRHB = hTot > 0 ? hR / hTot : 0.5;
  const fLHB = hTot > 0 ? hL / hTot : 0.5;

  return {
    platoonVR, platoonVL: 1 - platoonVR,
    r_hit_split: platoonVR,       // RHB faces RHP at the population rate
    l_hit_split: 1 - platoonVR,   // LHB faces LHP at the population rate
    s_hit_split: platoonVR,       // SHB faces RHP at the population rate
    r_pitch_split: fRHB,
    l_pitch_split: fLHB,
  };
}

/** Deployment = realized − baseline, in logit space. Applying it back to the SAME baseline
 *  reconstructs the realized splits exactly (logit round-trip). */
export function deploymentFrom(realized: RealizedSplits, base: ExposureBaseline): DeploymentShift {
  return {
    team: logit(realized.teamVR) - logit(base.platoonVR),
    r_hit: logit(realized.r_hit_split) - logit(base.r_hit_split),
    l_hit: logit(realized.l_hit_split) - logit(base.l_hit_split),
    s_hit: logit(realized.s_hit_split) - logit(base.s_hit_split),
    r_pitch_sp: logit(realized.r_pitch_split_sp) - logit(base.r_pitch_split),
    l_pitch_sp: logit(realized.l_pitch_split_sp) - logit(base.l_pitch_split),
    r_pitch_rp: logit(realized.r_pitch_split_rp) - logit(base.r_pitch_split),
    l_pitch_rp: logit(realized.l_pitch_split_rp) - logit(base.l_pitch_split),
  };
}

/** effective = logistic(logit(baseline) + deployment). A null shift ⇒ baseline as-is. */
export function applyDeployment(base: ExposureBaseline, d: DeploymentShift | null): EffectiveExposure {
  const z = d ?? { team: 0, r_hit: 0, l_hit: 0, s_hit: 0, r_pitch_sp: 0, l_pitch_sp: 0, r_pitch_rp: 0, l_pitch_rp: 0 };
  const vr = expit(logit(base.platoonVR) + z.team);
  const r_sp = expit(logit(base.r_pitch_split) + z.r_pitch_sp);
  const l_sp = expit(logit(base.l_pitch_split) + z.l_pitch_sp);
  const r_rp = expit(logit(base.r_pitch_split) + z.r_pitch_rp);
  const l_rp = expit(logit(base.l_pitch_split) + z.l_pitch_rp);
  return {
    platoonVR: vr, platoonVL: 1 - vr,
    r_hit_split: expit(logit(base.r_hit_split) + z.r_hit),
    l_hit_split: expit(logit(base.l_hit_split) + z.l_hit),
    s_hit_split: expit(logit(base.s_hit_split) + z.s_hit),
    r_pitch_split_sp: r_sp, l_pitch_split_sp: l_sp,
    r_pitch_split_rp: r_rp, l_pitch_split_rp: l_rp,
    r_pitch_split: (r_sp + r_rp) / 2, l_pitch_split: (l_sp + l_rp) / 2,
  };
}
