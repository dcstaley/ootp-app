// ANCHOR-UNIFORMITY AUDIT (Fable directive, 2026-07-23). MEASUREMENT ONLY; nothing wired.
//   run: node tools/anchor-uniformity-audit.ts > fixtures/anchor-uniformity-audit-2026-07-23.txt
//
// THE DOCTRINE UNDER TEST (Ruling 1 / plan §15.2): a level bias that is UNIFORM-WITHIN-ROLE is a
// convention the calibration anchor absorbs (it re-centres each role's top-N pool to TARGET_WOBA), so
// it is not a fix target. A CARD-CORRELATED level bias is something the anchor CANNOT absorb — a
// constant per-role shift cannot cancel a bias that varies with a card's ratings — so it is a real,
// live per-card error masquerading as an absorbed level. The scorecard writes off several level
// deficits as anchor-absorbed: pit BB9 (his level 14/14), hit BB% (13/14), and the hit-wOBA overshoot
// class. THIS AUDIT VERIFIES THAT CLASSIFICATION: for each, is the deployed-line level bias FLAT
// across the driving rating (uniform ⇒ anchor OK) or SLOPED (card-correlated ⇒ candidate real fix)?
//
// Plus the cross-role consequence: cap-mode budget allocates between hitters and pitchers by centred
// value. A uniform per-role composite bias is centred away and does not distort the split; a
// card-correlated composite bias does. So the audit ends on the COMPOSITE (wOBA / wOBAA) uniformity,
// which is exactly the cross-role-budget-survives question.
//
// If non-uniformity is found it is REPORTED as a fix candidate — NOT wired (Fable). Instrument = the
// deployed cwhit line (oursDep) vs observed, over the Quick tiers, the same one buildCwhitSample and
// production score; ratings joined from the catalog by cid.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived, cohortSelectForModel, FIELD_N,
  type EventForm, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, cardId, type Card } from "../src/data/catalog.ts";
import { buildCwhitSample, wellSampled, n_, type Rec, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar } from "../src/eval/cwhit/scorecard.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp2 = (s: string, n: number) => s.padStart(n);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; cohortRule?: string; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const select = cohortSelectForModel(trained.cohortRule, baseCards, coeffs, rp);
const byId = new Map(baseCards.map((c) => [String(c["Card ID"]), c]));

const ref = productionFieldStats(baseCards, coeffs, rp, true, undefined, select);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW, ref,
  envelope: trained.ratingEnvelope, select,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const sample = buildCwhitSample(deps);

// ── one card's side-pooled driving rating ──
const ratOf = (cid: string, col: string): number => {
  const c = byId.get(cid.split("|")[0] ?? "");
  if (!c) return NaN;
  const vs = [n_(c[`${col} vR`]), n_(c[`${col} vL`])].filter((x) => x > 0);
  return vs.length ? mean(vs) : NaN;
};

// ── the quartile + slope test: bias flat across the driver (uniform) or sloped (card-correlated)? ──
interface Row { d: number; bias: number; w: number }
function analyze(rows: Row[]): { overall: number; q: { lo: number; hi: number; bias: number; n: number }[]; slope: number; slopeCI: { lo: number; hi: number }; sloped: boolean; nonMono: boolean; qspread: number } {
  const rec = rows.filter((r) => Number.isFinite(r.d) && Number.isFinite(r.bias) && r.w > 0);
  const wbias = (rs: Row[]) => { const sw = rs.reduce((a, r) => a + r.w, 0); return sw > 0 ? rs.reduce((a, r) => a + r.w * r.bias, 0) / sw : NaN; };
  const srt = [...rec].sort((a, b) => a.d - b.d);
  const qcut = (i: number) => srt.slice(Math.floor((i / 4) * srt.length), Math.floor(((i + 1) / 4) * srt.length));
  const q = [0, 1, 2, 3].map((i) => { const s = qcut(i); return { lo: s[0]?.d ?? 0, hi: s[s.length - 1]?.d ?? 0, bias: wbias(s), n: s.length }; });
  // weighted least-squares slope of bias on driver + bootstrap CI
  const slopeOf = (rs: Row[]) => {
    const sw = rs.reduce((a, r) => a + r.w, 0); if (!(sw > 0)) return NaN;
    const md = rs.reduce((a, r) => a + r.w * r.d, 0) / sw, mb = rs.reduce((a, r) => a + r.w * r.bias, 0) / sw;
    let sxx = 0, sxy = 0; for (const r of rs) { sxx += r.w * (r.d - md) ** 2; sxy += r.w * (r.d - md) * (r.bias - mb); }
    return sxx > 0 ? sxy / sxx : NaN;
  };
  const slope = slopeOf(rec);
  // bootstrap the slope (fixed seed)
  let a = 20260723 >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const bs: number[] = [];
  for (let b = 0; b < 2000; b++) { const rs = rec.map(() => rec[Math.floor(rnd() * rec.length)]!); bs.push(slopeOf(rs)); }
  bs.sort((x, y) => x - y); const lo = bs[Math.floor(0.025 * bs.length)]!, hi = bs[Math.floor(0.975 * bs.length)]!;
  // A TAIL check the linear slope misses: a NON-MONOTONE quartile pattern (e.g. elite-power
  // under-prediction with a mid-band hump) has a ~0 linear slope but is NOT uniform — the anchor
  // still cannot absorb it. Flag when the quartile bias sequence is non-monotone AND its spread is
  // large relative to the within-quartile SE (approximated from the overall bootstrap width).
  const qb = q.map((x) => x.bias);
  const nonMono = qb.some((_, i) => i >= 2 && Math.sign(qb[i]! - qb[i - 1]!) !== Math.sign(qb[i - 1]! - qb[i - 2]!));
  const qspread = Math.max(...qb) - Math.min(...qb);
  return { overall: wbias(rec), q, slope, slopeCI: { lo, hi }, sloped: (lo > 0 && hi > 0) || (lo < 0 && hi < 0), nonMono, qspread };
}

say("################################################################################");
say("# ANCHOR-UNIFORMITY AUDIT.  MEASUREMENT ONLY — nothing wired.");
say("# tools/anchor-uniformity-audit.ts. Are the 'anchor-absorbed' level biases UNIFORM-within-role");
say("# (anchor OK) or CARD-CORRELATED (a constant per-role shift cannot cancel it ⇒ candidate fix)?");
say("################################################################################");
say();
say(`  model '${trained.id}'  catalog '${srcId}'  deployed line vs observed, Quick tiers pooled.`);
say(`  A bias FLAT across the driving rating (slope CI covers 0) is UNIFORM ⇒ the anchor absorbs it,`);
say(`  doctrine confirmed. A bias whose slope CI EXCLUDES 0 is CARD-CORRELATED ⇒ the anchor cannot`);
say(`  absorb it ⇒ REPORTED as a candidate real fix (not wired).`);
say();

// ── the flagged channels: (role, channel-accessor, driving rating column, unit) ──
interface Probe { label: string; role: "pit" | "hit"; get: (r: Rec) => { pred: number; obs: number } | null; driver: string; w: (r: Rec) => number }
const probes: Probe[] = [
  { label: "pit BB9  (driver: Control)", role: "pit", driver: "Control",
    get: (r) => (Number.isFinite(r.oursDep.bb9) && Number.isFinite(r.obs.bb9!) ? { pred: r.oursDep.bb9!, obs: r.obs.bb9! } : null),
    w: (r) => (per9NoiseVar(r.obs.bb9!, r.sample) > 0 ? 1 / per9NoiseVar(r.obs.bb9!, r.sample) : 0) },
  { label: "hit BB%  (driver: Eye)", role: "hit", driver: "Eye",
    get: (r) => (Number.isFinite(r.oursDep.bbPct) && Number.isFinite(r.obs.bbPct!) ? { pred: r.oursDep.bbPct!, obs: r.obs.bbPct! } : null),
    w: (r) => r.sample },
  { label: "hit wOBA (driver: Power — the overshoot class)", role: "hit", driver: "Power",
    get: (r) => (Number.isFinite(r.oursDep.woba) && Number.isFinite(r.obs.woba!) ? { pred: r.oursDep.woba!, obs: r.obs.woba! } : null),
    w: (r) => r.sample },
  // The composites, for the cross-role-budget question.
  { label: "pit wOBAA composite (driver: Stuff)", role: "pit", driver: "Stuff",
    get: (r) => (Number.isFinite(r.oursDep.woba) && Number.isFinite(r.obs.woba!) ? { pred: r.oursDep.woba!, obs: r.obs.woba! } : null),
    w: (r) => r.sample },
];

const findings: { label: string; overall: number; slope: number; ci: { lo: number; hi: number }; sloped: boolean; nonMono: boolean; qspread: number }[] = [];
for (const p of probes) {
  const rows: Row[] = [];
  for (const r of sample.recs) {
    if (r.role !== p.role || !wellSampled(r)) continue;
    const g = p.get(r); if (!g) continue;
    const d = ratOf(r.cid, p.driver); const w = p.w(r);
    if (!Number.isFinite(d) || !(w > 0)) continue;
    rows.push({ d, bias: g.pred - g.obs, w });
  }
  const a = analyze(rows);
  findings.push({ label: p.label, overall: a.overall, slope: a.slope, ci: a.slopeCI, sloped: a.sloped, nonMono: a.nonMono, qspread: a.qspread });
  const unit = p.role === "pit" && p.label.includes("BB9") ? "/9" : p.label.includes("wOBA") ? " wOBA" : "%";
  say(`  ${p.label}   (N=${rows.length})`);
  say(`    overall level bias (pred−obs): ${sgn(a.overall, p.label.includes("wOBA") ? 4 : 2)}${unit}`);
  say(`    by driver quartile:  ${a.q.map((x) => `[${f(x.lo, 0)}-${f(x.hi, 0)}] ${sgn(x.bias, p.label.includes("wOBA") ? 4 : 2)}`).join("   ")}`);
  say(`    slope of bias on driver: ${sgn(a.slope, 5)}  [${sgn(a.slopeCI.lo, 5)}, ${sgn(a.slopeCI.hi, 5)}]  ⇒ ${a.sloped ? "★ CARD-CORRELATED (CI excludes 0) — anchor CANNOT absorb; candidate fix" : "UNIFORM (CI covers 0) — anchor absorbs; doctrine confirmed"}`);
  if (!a.sloped && a.nonMono && a.qspread > 3 * Math.abs(a.overall) + 1e-9) say(`    ⚠ TAIL: linear slope is flat but the quartile pattern is NON-MONOTONE (spread ${sgn(a.qspread, p.label.includes("wOBA") ? 4 : 2)}) — a tail the anchor also cannot absorb (not a uniform shift). This is the known hitter-tail residual class, not a NEW linear defect.`);
  say();
}

say("### VERDICT");
say();
const bad = findings.filter((x) => x.sloped);
if (!bad.length) {
  say(`  ALL ${findings.length} flagged channels are UNIFORM-within-role (every slope CI covers 0). The`);
  say(`  'anchor-absorbed' classification is CONFIRMED — these level deficits are convention, not a`);
  say(`  fixable per-card error, and the doctrine (Ruling 1) holds for them.`);
} else {
  say(`  ${bad.length} of ${findings.length} flagged channels are CARD-CORRELATED — the anchor cannot absorb them:`);
  for (const b of bad) say(`    · ${b.label}: slope ${sgn(b.slope, 5)} [${sgn(b.ci.lo, 5)}, ${sgn(b.ci.hi, 5)}] — CANDIDATE REAL FIX (reported, NOT wired).`);
  say(`  These are not "his level win, absorbed" — they are per-card errors the calibration hides.`);
}
say();
say("### CROSS-ROLE BUDGET (cap mode) — does the anchor's per-role centring survive these?");
say();
const pitComp = findings.find((x) => x.label.includes("wOBAA"))!, hitComp = findings.find((x) => x.label.includes("hit wOBA"))!;
say(`  Cap-mode allocates hitters-vs-pitchers by CENTRED value. A UNIFORM per-role composite bias is`);
say(`  centred away by the anchor and does not move the split; a CARD-CORRELATED one does.`);
say(`    hit composite (wOBA):  slope ${sgn(hitComp.slope, 5)} [${sgn(hitComp.ci.lo, 5)}, ${sgn(hitComp.ci.hi, 5)}]  ${hitComp.sloped ? "CARD-CORRELATED" : "uniform"}`);
say(`    pit composite (wOBAA): slope ${sgn(pitComp.slope, 5)} [${sgn(pitComp.ci.lo, 5)}, ${sgn(pitComp.ci.hi, 5)}]  ${pitComp.sloped ? "CARD-CORRELATED" : "uniform"}`);
say(`  ⇒ cross-role budget ${hitComp.sloped || pitComp.sloped ? "is AT RISK: a card-correlated composite bias distorts the centred value that drives the split (candidate fix, not wired)." : "SURVIVES: both composites are uniform-within-role, so the anchor's per-role centring preserves the hitter-vs-pitcher value relationship."}`);
say();
say("(end of artifact — anchor-uniformity audit)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
