// Consistency sweep 2026-07-25, findings 8 and 6 — two numbers the SERVER prints that disagreed
// with the number the core computed. Both are exercised against the REAL server over HTTP (same
// harness as tests/server.test.ts) because the payload assembly lives in server.ts, which listens on
// import and cannot be unit-imported. Nothing here touches roster selection.
//
// ── Finding 8: the cards grid and the roster page must not rank the same two arms differently ──
//
// A pitcher can't be assigned to a platoon side, so its two per-side numbers must collapse to one —
// and the collapse weight is the pitcher's batter-hand exposure, which depends on DEPLOYED ROLE.
// The roster page collapsed at (hand, role) via `blendPitch`; the grid collapsed at
// `coeffs.r_pitch_split`, the unweighted SP/RP MEAN — a deployment no arm actually gets. Measured on
// the live catalog: ~0.0005 wOBA apart, and the ORDER CAN FLIP (Hudson/Yates tie at 0.3349 on the
// grid, separate as relievers). The roster path is the one that drives decisions, so the grid now
// agrees with it.
//
// ── Finding 6: /api/debug/card printed a BIP its own singles did not come from ──
//
// The trace re-derived balls-in-play as `600 − BB − K − HR − BIP_ADJ`, dropping the per-era
// `era_bip_adj` scale the core applies — so on every non-2010 era (most of the tournament library)
// the BIP on the line was 1.4-2.1% off the BIP that produced the single/XBH beside it. A debug
// endpoint that disagrees with itself is worse than none; this one is reached for when diagnosing an
// era bug. `hittingComponents`/`pitchingComponents` now RETURN their BIP, so the trace cannot fork.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_DATA = existsSync("data/state/app.json") && existsSync("docs/pt_card_list.csv");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    s.on("error", reject);
  });
}

let child: ChildProcess | null = null;
let base = "";
let tmp = "";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

describe.skipIf(!HAVE_DATA)("server payload consistency (real server, real catalog)", () => {
  let cards: any[] = [];
  let roster: any = null;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ootp-payload-"));
    cpSync("data", join(tmp, "data"), { recursive: true });
    const port = await freePort();
    base = `http://localhost:${port}`;
    child = spawn(process.execPath, ["src/server/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), DATA_ROOT: join(tmp, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("server boot timeout")), 60_000);
      child!.stdout!.on("data", (b: Buffer) => { if (b.toString().includes(`http://localhost:${port}`)) { clearTimeout(to); resolve(); } });
      child!.on("exit", (c) => { clearTimeout(to); reject(new Error(`server exited early (${c})`)); });
    });
    // Both endpoints default to the SAME tournament (state.activeTournamentId), so no id is passed.
    cards = (await (await fetch(`${base}/api/cards`)).json()) as any[];
    roster = await (await fetch(`${base}/api/roster`)).json();
  }, 90_000);

  afterAll(() => {
    child?.kill();
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Grid rows for an owned variant share their base's Card ID, so restrict to ids with exactly one
  // row — otherwise "the grid's number for this card" is ambiguous, not inconsistent.
  const uniqueRows = () => {
    const count = new Map<string, number>();
    for (const c of cards) count.set(c.id, (count.get(c.id) ?? 0) + 1);
    return new Map(cards.filter((c) => count.get(c.id) === 1).map((c) => [c.id, c]));
  };

  it("the rostered arms exist on both pages (fixture sanity)", () => {
    expect(Array.isArray(cards) && cards.length).toBeGreaterThan(100);
    expect(roster.status).toBe("Optimal");
    const grid = uniqueRows();
    expect(roster.rosterPitchers.filter((p: any) => grid.has(p.id)).length).toBeGreaterThan(3);
  });

  it("grid pitchSP/pitchRP ARE the roster's wobaSP/wobaRP, arm for arm", () => {
    const grid = uniqueRows();
    let n = 0;
    for (const p of roster.rosterPitchers) {
      const g = grid.get(p.id);
      if (!g) continue;
      n++;
      expect(g.pitchSP).toBeCloseTo(p.wobaSP, 4);
      expect(g.pitchRP).toBeCloseTo(p.wobaRP, 4);
    }
    expect(n).toBeGreaterThan(3);
  });

  it("…and the grid's headline OVR is the number the roster shows for that arm's role", () => {
    const grid = uniqueRows();
    for (const p of roster.rosterPitchers) {
      const g = grid.get(p.id);
      if (!g) continue;
      // `pitchOVR` is the guessed role's blend; where the optimizer deployed the guessed role, it
      // must equal the roster's own figure exactly.
      const guessed = g.pitchRole === "sp" ? p.wobaSP : p.wobaRP;
      expect(g.pitchOVR).toBeCloseTo(guessed, 4);
      if ((g.pitchRole === "sp") === (p.role === "starter")) expect(g.pitchOVR).toBeCloseTo(p.woba, 4);
    }
  });

  // THE LEG THAT FAILS ON THE OLD BUILD. `r_pitch_split` is the unweighted SP/RP mean
  // (exposure.ts applyDeployment), and blendPitch is linear in the weight, so the pre-fix grid value
  // was EXACTLY the midpoint of the two role blends. Where the roles differ, that midpoint is neither
  // of them — so the assertions above could not have held before.
  it("the pre-fix role-agnostic mean matched NEITHER role blend on real arms", () => {
    const grid = uniqueRows();
    const split = [...grid.values()].filter((c) => c.stamina > 0 && Math.abs(c.pitchSP - c.pitchRP) >= 2e-4);
    expect(split.length).toBeGreaterThan(20); // the two collapses genuinely disagree, catalog-wide
    for (const c of split.slice(0, 50)) {
      const preFix = (c.pitchSP + c.pitchRP) / 2;
      expect(Math.abs(preFix - c.pitchSP)).toBeGreaterThan(0);
      expect(Math.abs(preFix - c.pitchRP)).toBeGreaterThan(0);
      expect(c.pitchOVR === c.pitchSP || c.pitchOVR === c.pitchRP).toBe(true);
    }
  });

  it("the role guess is starter-qualification, so a low-stamina arm is never priced as a starter", () => {
    const t = roster.minStarterStamina as number, mp = roster.minPitchTypes as number;
    for (const c of uniqueRows().values()) {
      if (!(c.stamina > 0)) continue;
      expect(c.pitchRole).toBe(c.stamina >= t && c.pitches >= mp ? "sp" : "rp");
    }
  });

  // ── finding 6 — the /api/debug/card trace must not fork the BIP ────────────────────────────────
  it("the debug trace's BIP is the one its own hits came from, on a non-2010 era", async () => {
    const { tournaments } = (await (await fetch(`${base}/api/tournaments`)).json()) as { tournaments: { id: string }[] };
    const q = String(cards[0].title).toLowerCase(); // one specific card — keeps the response small
    // Find a tournament whose era MATERIALLY scales BIP_ADJ. On era-2010 the two formulas coincide
    // exactly, and a near-2010 era separates them by less than the r4 rounding is worth asserting on,
    // so neither could distinguish the fix from the defect. Dead-ball eras run ≈2.4.
    let trace: any = null;
    for (const t of tournaments) {
      const r = (await (await fetch(`${base}/api/debug/card?t=${encodeURIComponent(t.id)}&q=${encodeURIComponent(q)}`)).json()) as { cards?: any[] };
      const c = (r.cards ?? []).find((x: any) => Math.abs((x.hit?.trace?.vR?.envFactors?.era_bip_adj ?? 1) - 1) > 0.3);
      if (c) { trace = c; break; }
    }
    expect(trace, "no tournament in the library has a materially non-1 era_bip_adj").not.toBeNull();

    for (const [role, kName] of [["hit", "SO"], ["pit", "K"]] as const) {
      for (const side of ["vR", "vL"] as const) {
        const tr = trace[role].trace[side];
        const f = tr.finalEvents_per600, adj = tr.envFactors.era_bip_adj;
        const BIP_ADJ = role === "hit" ? 6 + 3 - 4 : 6; // HIT_BIP_ADJ / PIT_BIP_ADJ (model/curves.ts)
        const outs = 600 - f.BB - f[kName] - f.HR;
        // The core's convention — what the singles/XBH on this same line were derived from.
        expect(f.BIP).toBeCloseTo(outs - BIP_ADJ * adj, 3);
        // The pre-fix expression (ADJ unscaled). On this era it is off by more than a whole ball in
        // play per 600 — so the assertion above is exactly what the old build could not satisfy.
        expect(Math.abs((outs - BIP_ADJ) - f.BIP)).toBeGreaterThan(1);
      }
    }
  });
});
