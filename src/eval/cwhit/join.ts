// cwhitstats ↔ our-catalog JOIN (Batch-1 item 4, part 2). cwhit displays only Name+VAL+VLvl+Hand —
// NOT the full card title / CID we disambiguate on — so DISTINCT cards can collide on that key
// (memory cwhitstats-external-data: measured ~3% of rows, e.g. 3× "Bob Miller 69 R" in bronze-pit).
// Strategy (Derek-ratified):
//   1. UNIQUE keys (one cwhit row, one our-card) → direct join — the ~97%.
//   2. COLLIDING keys → RATING-FINGERPRINT disambiguation: assign each cwhit row to the nearest
//      our-card on the PRIMARY axes (role/BABIP — near-orthogonal to the audited value channels),
//      and SCORE (never assign on) the VALIDATE axes (K/BB/HR) so the audit stays non-circular.
//      An assignment that doesn't clear a confidence margin is DROPPED + reported, not forced.
//   3. cwhit key with no our-card → unmatched + reported (name-normalization / catalog gaps).
// Genuine TWO-WAY cards appearing in BOTH the hit and pit tables are CORRECT — this join is
// per-table, so it never sees or dedupes across roles. Pure; the driver supplies the fingerprints.

/** Our-side candidate: identity + the fingerprint the driver computed from THIS card's ratings.
 *  `primary` = assignment axes (role signal, BABIP); `validate` = K/BB/HR (confidence only). */
export interface JoinCard {
  cid: string; name: string; val: number; vlvl: number; hand: string;
  primary: number[]; validate: number[];
}
/** A parsed cwhit observation lifted into join shape. `row` carries the original typed row through. */
export interface JoinObs<R> {
  name: string; val: number; vlvl: number; hand: string;
  primary: number[]; validate: number[];
  sample: number;   // IP (pit) or PA (hit) — reported, and available for downstream weighting
  row: R;
}
export interface Matched<R> {
  obs: JoinObs<R>; card: JoinCard;
  via: "unique" | "fingerprint";
  primaryDist: number;   // z-normalized distance on the assignment axes (0 for a lone-candidate unique match)
  validateDist: number;  // z-normalized distance on K/BB/HR — a NON-circular concordance signal
  margin: number;        // fingerprint only: best primaryDist ÷ second-best (≤ marginMax to accept); 0 for unique
}
export interface DroppedCollision<R> { key: string; obs: JoinObs<R>[]; cards: JoinCard[]; reason: string }
export interface JoinStats {
  total: number; matchedUnique: number; matchedFingerprint: number;
  unmatched: number; droppedRows: number; collisionKeys: number; collisionLossPct: number;
}
export interface JoinResult<R> {
  matched: Matched<R>[];
  unmatched: JoinObs<R>[];
  droppedCollisions: DroppedCollision<R>[];
  stats: JoinStats;
}

/** Modest name normalization: strip diacritics, collapse whitespace, lowercase. Deliberately does
 *  NOT strip suffixes/punctuation (that could merge DISTINCT cards) — mismatches surface as
 *  `unmatched` for inspection rather than being silently coerced. */
export function normalizeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export const joinKey = (name: string, val: number, vlvl: number, hand: string): string =>
  `${normalizeName(name)}|${val}|${vlvl}|${hand.trim().toUpperCase()}`;

const keyOfCard = (c: JoinCard) => joinKey(c.name, c.val, c.vlvl, c.hand);
const keyOfObs = <R>(o: JoinObs<R>) => joinKey(o.name, o.val, o.vlvl, o.hand);

/** Per-axis stdev over a set of vectors (population); guards the z-normalized distance so axes on
 *  different scales (a 0–1 BABIP vs a 6–12 K9) contribute comparably. */
function axisSd(vectors: number[][]): number[] {
  const d = vectors[0]?.length ?? 0;
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const xs = vectors.map((v) => v[j] ?? 0).filter((x) => Number.isFinite(x));
    if (!xs.length) { sd.push(0); continue; }
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    sd.push(Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length));
  }
  return sd;
}
const zDist = (a: number[], b: number[], sd: number[]): number => {
  let s = 0;
  for (let j = 0; j < Math.min(a.length, b.length); j++) {
    const sj = sd[j] ?? 0;
    if (sj > 1e-9) s += ((a[j]! - b[j]!) / sj) ** 2;
  }
  return Math.sqrt(s);
};

export interface JoinOpts {
  /** A fingerprint assignment is accepted only if best primaryDist ≤ marginMax × second-best. Lower
   *  = stricter. Default 0.7 (best must be clearly nearer than the runner-up). No runner-up ⇒ accept. */
  marginMax?: number;
}

/**
 * Join parsed cwhit observations to our catalog candidates. Both sides must already carry matched
 * `primary`/`validate` fingerprint vectors on the SAME axes (the driver's job). Pure + deterministic.
 */
export function joinCwhit<R>(obsList: JoinObs<R>[], cards: JoinCard[], opts: JoinOpts = {}): JoinResult<R> {
  const marginMax = opts.marginMax ?? 0.7;
  const obsByKey = new Map<string, JoinObs<R>[]>();
  for (const o of obsList) { const k = keyOfObs(o); (obsByKey.get(k) ?? obsByKey.set(k, []).get(k)!).push(o); }
  const cardsByKey = new Map<string, JoinCard[]>();
  for (const c of cards) { const k = keyOfCard(c); (cardsByKey.get(k) ?? cardsByKey.set(k, []).get(k)!).push(c); }

  const matched: Matched<R>[] = [];
  const unmatched: JoinObs<R>[] = [];
  const droppedCollisions: DroppedCollision<R>[] = [];
  let collisionKeys = 0;

  for (const [key, obs] of obsByKey) {
    const cand = cardsByKey.get(key) ?? [];
    if (cand.length === 0) { unmatched.push(...obs); continue; }

    // Unique key on both sides → direct join (the common case).
    if (obs.length === 1 && cand.length === 1) {
      const sd = axisSd([obs[0]!.validate, cand[0]!.validate]);
      matched.push({ obs: obs[0]!, card: cand[0]!, via: "unique", primaryDist: 0, validateDist: zDist(obs[0]!.validate, cand[0]!.validate, sd), margin: 0 });
      continue;
    }

    // Collision → fingerprint disambiguation over this key group.
    collisionKeys++;
    const primSd = axisSd([...obs.map((o) => o.primary), ...cand.map((c) => c.primary)]);
    const valSd = axisSd([...obs.map((o) => o.validate), ...cand.map((c) => c.validate)]);
    // All (obs, card) pairs, nearest-first on the primary (assignment) axes.
    const pairs: { oi: number; ci: number; d: number }[] = [];
    obs.forEach((o, oi) => cand.forEach((c, ci) => pairs.push({ oi, ci, d: zDist(o.primary, c.primary, primSd) })));
    pairs.sort((a, b) => a.d - b.d);

    const usedO = new Set<number>(), usedC = new Set<number>();
    const dropped: JoinObs<R>[] = [];
    for (let oi = 0; oi < obs.length; oi++) {
      // This obs's candidate distances, nearest first.
      const mine = pairs.filter((p) => p.oi === oi && !usedC.has(p.ci)).sort((a, b) => a.d - b.d);
      if (usedO.has(oi) || mine.length === 0) { if (!usedO.has(oi)) dropped.push(obs[oi]!); continue; }
      const best = mine[0]!, second = mine[1];
      const margin = second ? (second.d > 1e-9 ? best.d / second.d : 1) : 0;
      if (second && margin > marginMax) { dropped.push(obs[oi]!); continue; } // ambiguous → don't force
      usedO.add(oi); usedC.add(best.ci);
      matched.push({
        obs: obs[oi]!, card: cand[best.ci]!, via: "fingerprint",
        primaryDist: best.d, validateDist: zDist(obs[oi]!.validate, cand[best.ci]!.validate, valSd), margin,
      });
    }
    if (dropped.length) droppedCollisions.push({ key, obs: dropped, cards: cand, reason: `ambiguous fingerprint (margin > ${marginMax})` });
  }

  const matchedUnique = matched.filter((m) => m.via === "unique").length;
  const matchedFingerprint = matched.length - matchedUnique;
  const droppedRows = droppedCollisions.reduce((a, d) => a + d.obs.length, 0);
  const total = obsList.length;
  return {
    matched, unmatched, droppedCollisions,
    stats: {
      total, matchedUnique, matchedFingerprint, unmatched: unmatched.length,
      droppedRows, collisionKeys,
      collisionLossPct: total ? (droppedRows / total) * 100 : 0,
    },
  };
}
