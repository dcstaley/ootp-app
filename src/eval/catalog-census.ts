// Catalog-import STANDING CHECK (the card meta is non-stationary — a quad-channel spike is one release away).
// On every catalog import we census the quad channels of the active model against the incoming cards and WARN
// when a card's rating on a cap-risk QUAD channel lands OUT of the fitted domain, or within a margin of the
// curve's vertex — the zone where the tangent-linear extension / monotone cap engage (fail-safe, but a signal
// that new chase cards are pushing past the training support). Pure + deterministic; the caller logs the report.
//
// Today (cdmx) this fires on ZERO cards (max stu 187 = domain edge; vertices 242–272 sit ~55 pts higher) — it
// is a tripwire for the FUTURE (e.g. a 230-STU bronze card), not a live alarm. See tools/synthetic-recon.ts.

import type { EventForm, FittedEvent } from "../model/curves.ts";

/** One quad channel to police: its fitted event + the raw catalog column that drives it + a label. */
interface QuadChannel { label: string; col: string; e: FittedEvent }

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Vertex + fitted-domain-max of a rawpoly-2 event, in RATING units (or null if not a curving quad). */
function quadEdges(e: FittedEvent): { vertex: number; domainMax: number } | null {
  if (e.curve.kind !== "rawpoly" || e.curve.degree !== 2 || e.uMin == null || e.uMax == null) return null;
  const b1 = e.beta[1] ?? 0, b2 = e.beta[2] ?? 0;
  if (Math.abs(b2) < 1e-9) return null; // ~linear ⇒ no vertex risk
  const vertexU = -b1 / (2 * b2);
  return { vertex: e.mu + vertexU * e.sd, domainMax: e.mu + e.uMax * e.sd };
}

export interface CensusReport {
  /** Human-readable warning lines (empty ⇒ all cards sit safely inside training support). */
  warnings: string[];
  /** Per-channel counts: cards out of the fitted domain, and cards within `margin` of the vertex. */
  channels: { label: string; outOfDomain: number; nearVertex: number; vertex: number; domainMax: number; catalogMax: number }[];
}

/**
 * Census the active model's cap-risk quad channels against the incoming catalog cards. `margin` = how close a
 * rating may come to a vertex before we warn (default 15 rating pts — the tangent/cap engagement zone). Checks
 * RAW ratings (own-gap lift only pushes them HIGHER, so raw-near-vertex ⟹ lifted-near-or-past-vertex — a
 * conservative standing tripwire that needs no specific pool).
 */
export function catalogQuadCensus(cards: Record<string, unknown>[], eventForm: EventForm, margin = 15): CensusReport {
  const chans: QuadChannel[] = [
    { label: "hit HR ← Power", col: "Power vR", e: eventForm.hit.hr },
    { label: "pit K ← Stuff", col: "Stuff vR", e: eventForm.pit.k },
    { label: "pit HR ← pHR", col: "pHR vR", e: eventForm.pit.hr },
  ];
  const warnings: string[] = [];
  const channels: CensusReport["channels"] = [];
  for (const { label, col, e } of chans) {
    const edges = quadEdges(e);
    const ratings = cards.map((c) => num(c[col])).filter((r) => r > 0);
    const catalogMax = ratings.length ? Math.max(...ratings) : 0;
    if (!edges) { channels.push({ label, outOfDomain: 0, nearVertex: 0, vertex: NaN, domainMax: NaN, catalogMax }); continue; }
    const outOfDomain = ratings.filter((r) => r > edges.domainMax).length;
    const nearVertex = ratings.filter((r) => r > edges.vertex - margin).length;
    channels.push({ label, outOfDomain, nearVertex, vertex: edges.vertex, domainMax: edges.domainMax, catalogMax });
    if (outOfDomain > 0) warnings.push(`${label}: ${outOfDomain} card(s) beyond the fitted domain (max ${edges.domainMax.toFixed(0)}; catalog reaches ${catalogMax.toFixed(0)}) — now tangent-extended, verify eval coverage.`);
    if (nearVertex > 0) warnings.push(`${label}: ${nearVertex} card(s) within ${margin} of the vertex (${edges.vertex.toFixed(0)}) — cap/tangent territory; new chase cards are pushing past training support.`);
  }
  return { warnings, channels };
}
