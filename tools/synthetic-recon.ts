// SYNTHETIC RECON (Fable item 2, CORRECTED to the real catalog — Derek: the "diamond 180–250 ratings" band was
// invented; diamond = value 90-99, and SPIKY cards live across ALL tiers, concentrated LOW). A MAP, not evidence.
//   (c) SPIKE CENSUS — cards with one rating ≫ the card's others (intra-card spread), by role × value tier ×
//       spike channel, flagged QUAD (cap-risk) vs LOG. These format-definers sit outside all validation.
//   (a) TRANSFORM-ON-SPIKES — for the top value-relevant spiky cards in an iron/bronze pool: own-gap vs additive
//       reshaping (own lifts the lows ×k, leaves the high spike ~raw), and whether the spike's QUAD cap engages.
//   (b) QUAD CAP-ENGAGEMENT census — pool cards whose quad-channel rating sits in the cap-active zone (→ tied /
//       flattened gaps among top cards).
// Real rating ranges (base cards): eye→204, kRat→213, stu→187, con→176, pow→169; probe bands 60/90/120/150.
// STRUCTURAL: any sub-catalog pool ⊆ the full-catalog top-50 reference ⇒ k ≥ 1 always; k<1 down-scaling is
// UNREACHABLE with this catalog (needs a stronger-than-reference set) — a real gap only diamond quicks can fill.
//   run: node tools/synthetic-recon.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift } from "../src/scoring-core/index.ts";
import { applyAffine } from "../src/model/pool-transform.ts";
import { rate, rateRaw, type FittedEvent } from "../src/model/curves.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const base = cat.cards.filter(isB);
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const refField = computeUnifiedFieldStats(base, coeffs, rp, FIELD_N, true);

const V = (c: any) => Number(c["Card Value"]) || 0;
const cols: Record<string, string> = { con: "Control vR", stu: "Stuff vR", hrr: "pHR vR", pbabip: "pBABIP vR", eye: "Eye vR", pow: "Power vR", kRat: "Avoid K vR", babip: "BABIP vR", gap: "Gap vR" };
const R = (c: any, k: string) => Number(c[cols[k]!]) || 0;
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "n/a");
// shipped-form curve family per channel. CAP-RISK quad channels = those whose fitted vertex is within reach of
// the pool ratings: pit stu(K)/hrr(HR), hit pow(HR). pbabip(h) is nominally quad in the pareto but its fitted
// curve is NEAR-LINEAR (B.4 vertex ~1940) ⇒ cap-safe; kRat/eye/con/gap/babip are LOG ⇒ cap-safe.
const QUAD: Record<string, boolean> = { pow: true, hrr: true, stu: true, gap: false, eye: false, kRat: false, con: false, babip: false, pbabip: false /*quad-but-near-linear ⇒ cap-safe*/ };
const HIT = ["eye", "pow", "kRat", "babip", "gap"] as const, PIT = ["con", "stu", "hrr", "pbabip"] as const;

// (c) SPIKE CENSUS
const spikeOf = (c: any, chs: readonly string[]) => { const rs = chs.map((k) => R(c, k)).filter((x) => x > 0); if (rs.length < 2) return null; const s = [...rs].sort((a, b) => a - b); const med = s[Math.floor(0.5 * (s.length - 1))]!; const mx = Math.max(...rs); return { spike: mx - med, mx, med, which: chs[chs.map((k) => R(c, k)).indexOf(mx)]! }; };
const tiers: [string, (v: number) => boolean][] = [["iron≤55", (v) => v <= 55], ["bronze56-69", (v) => v > 55 && v <= 69], ["gold70-89", (v) => v > 69 && v <= 89], ["dia90+", (v) => v >= 90]];
console.log(`(c) SPIKE CENSUS — cards with intra-card spike ≥60 (one rating ≥60 above the card's own median). Format-definers.`);
for (const [role, chs] of [["HIT", HIT], ["PIT", PIT]] as const) {
  const sp = base.map((c) => ({ c, s: spikeOf(c, chs) })).filter((x) => x.s && x.s.spike >= 60);
  console.log(`  ${role}: ${sp.length} spiky cards | by tier ` + tiers.map(([n, p]) => `${n} ${sp.filter((x) => p(V(x.c))).length}`).join("  "));
  const byCh = chs.map((k) => `${k}${QUAD[k] ? "*" : ""} ${sp.filter((x) => x.s!.which === k).length}`).join("  ");
  console.log(`       spike channel (*=QUAD cap-risk): ${byCh}`);
}

// (a) TRANSFORM-ON-SPIKES — iron-like pool, top value-relevant spiky pitchers (stu/hrr = quad channels).
console.log(`\n(a) TRANSFORM ON SPIKES — IRON-like pool (val≤50). Top pitchers spiked in a QUAD channel (stu/hrr): raw profile,`);
console.log(`own-gap-lifted, additive-shifted; and the spike channel's predicted rate raw vs CAPPED (cap engaged ⇒ gap flattened).`);
const ironPit = base.filter((c) => V(c) <= 50 && R(c, "stu") > 1);
const poolField = computeUnifiedFieldStats(base.filter((c) => V(c) <= 50), coeffs, rp, FIELD_N, true);
const pt = buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined);
const fs = buildFrameShift(trained.trainingMeans, poolField);
const spikers = ironPit.map((c) => ({ c, s: spikeOf(c, PIT)! })).filter((x) => x.s && (x.s.which === "stu" || x.s.which === "hrr") && x.s.spike >= 60).sort((a, b) => b.s.spike - a.s.spike).slice(0, 5);
const pitFit: any = ef.pit;
for (const { c, s } of spikers) {
  const ch = s.which, aff = (pt.pit.vR as any)[ch], gap = (fs.pit.vR as any)[ch] ?? 0;
  const raw = s.mx, own = applyAffine(raw, aff), add = raw + gap;
  const e: FittedEvent = ch === "stu" ? pitFit.k : pitFit.hr;
  const capR = rate(e, own), rawR = rateRaw(e, own), capped = Math.abs(capR - rawR) > 1e-9;
  console.log(`  v${V(c)} spike ${ch}=${f(raw)} (med ${f(s.med)}): own→${f(own)} add→${f(add)} | ${ch}-rate@own raw ${rawR.toFixed(1)} capped ${capR.toFixed(1)} ${capped ? "◄ CAP ENGAGED" : ""}`);
}

// (b) QUAD CAP-ENGAGEMENT census across the iron pool.
console.log(`\n(b) QUAD CAP census (iron pool, own-gap ratings): fraction of pool cards whose quad-channel rate is CAP-clamped.`);
const poolCards = base.filter((c) => V(c) <= 50);
for (const [ch, e] of [["stu(K)", pitFit.k], ["hrr(HR)", pitFit.hr], ["pow(HR-hit)", (ef.hit as any).hr]] as const) {
  const chan = ch.startsWith("stu") ? "stu" : ch.startsWith("hrr") ? "hrr" : "pow";
  const isPit = chan !== "pow";
  const aff = isPit ? (pt.pit.vR as any)[chan] : (pt.hit.vR as any)[chan];
  const cards = poolCards.filter((c) => R(c, chan) > 1);
  const clamped = cards.filter((c) => { const own = applyAffine(R(c, chan), aff); return Math.abs(rate(e, own) - rateRaw(e, own)) > 1e-9; }).length;
  console.log(`  ${ch.padEnd(12)} ${clamped}/${cards.length} pool cards cap-clamped at own-gap ratings`);
}
console.log(`\nRead: spiky cards are a LARGE low-tier population (Derek). Where a spike lands on a QUAD channel (stu/hrr/pow*)`);
console.log(`and own-gap pushes it past the fitted domain, the cap flattens gaps among the top — the concrete distortion class.`);
console.log(`This MAP sizes it; DIAMOND/iron quicks (real outcomes) are needed to say whether the flattening mis-ranks them.`);
process.exit(0);
