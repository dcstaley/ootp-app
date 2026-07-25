// COHORT-RULE COORDINATE GATE — server integration (2026-07-24).
//
// The cohort-rule event's z-sum selection was SHELVED (it failed its gates) and the machinery was
// meant to go dormant. Two things kept it live on the WRITE path, and this file pins both fixes
// against the REAL server over HTTP (same harness as tests/server.test.ts):
//
//   DEFECT 1 — the coordinate-mismatch guard only WARNED. A model selecting its cohort under one rule
//   while the enabled spread ramps were fitted under another puts every corrected K/HR on the wrong
//   coordinate, silently. A console.warn is not protection for a user who activates through the UI.
//   ⇒ activation now REJECTS (409) and the previously active model stays live.
//
//   DEFECT 2 — the trainer used and stamped the shelved rule UNCONDITIONALLY, so every new artifact
//   was on the shelved coordinate and there was no way left to train one under the legacy selection
//   (the live production model could not have been reconstructed).
//   ⇒ the rule is an explicit request field, defaulting to LEGACY (untagged).
//
// Also pinned: production scoring is BYTE-IDENTICAL across the whole sequence — the active model is
// untagged, so every one of these paths is a no-op for it.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COHORT_RULE_TAG } from "../src/scoring-core/index.ts";

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
/** The grid as production scored it at boot, under the untagged live model — the bit-identity anchor. */
let cardsAtBoot = "";
/** The pointer at boot. Nothing in this file may move it except the final (legal) activation. */
let bootActiveId: string | null = null;

// Training dominates the runtime here (three fits), and a COLD field build is expensive since C2'
// made every field a presence mixture — same reason tests/server.test.ts raised its budgets.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });

type ModelRow = {
  id: string; name: string; cohortRule?: string; trainingMeans?: unknown;
  cohortMismatch?: { ramp: string; fitRule: string; activeRule: string }[];
};
type SaveResp = { ok: boolean; error?: string; model: ModelRow; activeId: string | null };
const listModels = async (): Promise<{ models: ModelRow[]; activeId: string | null }> =>
  (await (await fetch(`${base}/api/training/models`)).json()) as { models: ModelRow[]; activeId: string | null };
const train = async (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${base}/api/training/models/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!HAVE_DATA)("cohort-rule coordinate gate — trainer default + activation block", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ootp-cohort-"));
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
      child!.stderr!.on("data", (b: Buffer) => { if (/EADDRINUSE/.test(b.toString())) { clearTimeout(to); reject(new Error(b.toString())); } });
      child!.on("exit", (code) => { clearTimeout(to); reject(new Error(`server exited early (${code})`)); });
    });
    bootActiveId = (await listModels()).activeId;
    cardsAtBoot = await (await fetch(`${base}/api/cards`)).text();
    // NON-VACUITY. Both anchors below are compared for EQUALITY, which is the kind of assertion that
    // passes loudest when it is measuring nothing — a null pointer or a two-line error body would sail
    // through. Fail here instead, where the cause is obvious.
    expect(bootActiveId, "a model must be active at boot or the pointer-does-not-move test is vacuous").toBeTruthy();
    expect(cardsAtBoot.length, "/api/cards must return a real grid or the byte-identity test is vacuous").toBeGreaterThan(10_000);
  }, 90_000);

  afterAll(() => {
    child?.kill();
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // DEFECT 2, the default. A train request that says nothing about the cohort rule must produce
  // EXACTLY what the pre-event trainer produced: means built without the z-sum refs and NO stamp.
  // `undefined` is the same value every pre-event artifact carries, and is what downstream reads as
  // "model-woba" — so a default retrain is indistinguishable from a pre-event one.
  it("DEFAULT train produces an UNTAGGED artifact on the legacy coordinate", async () => {
    const r = await train({ name: "Cohort Legacy Default" });
    expect(r.status).toBe(200);
    const d = (await r.json()) as SaveResp;
    expect(d.ok, d.error).toBe(true);
    expect(d.model.cohortRule).toBeUndefined();      // the stamp is the whole defect — no stamp
    expect(d.model.trainingMeans).toBeTruthy();      // ...and it is untagged BECAUSE legacy, not because the frame is missing
    expect(d.model.cohortMismatch).toBeUndefined();  // on the ramps' own coordinate ⇒ activatable
  });

  // DEFECT 2, the opt-in. The shelved rule is still reachable — dormant means "only by name", not
  // "deleted" — and an artifact built under it is stamped honestly, which is what makes it blockable.
  it("EXPLICIT cohortRule trains under z-sum, stamps the tag, and is flagged as a coordinate mismatch", async () => {
    const r = await train({ name: "Cohort ZSum Explicit", cohortRule: COHORT_RULE_TAG });
    expect(r.status).toBe(200);
    const d = (await r.json()) as SaveResp;
    expect(d.ok, d.error).toBe(true);
    expect(d.model.cohortRule).toBe(COHORT_RULE_TAG);
    // Derived like `stale`: both shipped ramps are fitted on model-woba and both are on by default.
    expect(d.model.cohortMismatch).toBeDefined();
    expect(d.model.cohortMismatch!.length).toBeGreaterThan(0);
    expect(d.model.cohortMismatch!.every((b) => b.fitRule === "model-woba" && b.activeRule === COHORT_RULE_TAG)).toBe(true);
  });

  it("an unknown cohortRule is rejected outright (no silent fallback to either coordinate)", async () => {
    const r = await train({ name: "Cohort Bogus", cohortRule: "not-a-rule" });
    expect(r.status).toBe(400);
    expect(String(((await r.json()) as { error: string }).error)).toMatch(/unknown cohortRule/i);
  });

  // DEFECT 1. The gate. Rejection must happen BEFORE any state is written, so the previously active
  // model is still the live scoring model afterwards.
  it("activating a MISMATCHED artifact is REJECTED and the active pointer does not move", async () => {
    const before = await listModels();
    const zsum = before.models.find((m) => m.cohortRule === COHORT_RULE_TAG);
    expect(zsum, "the explicit z-sum artifact should be listed").toBeTruthy();

    const r = await fetch(`${base}/api/training/models/activate?id=${encodeURIComponent(zsum!.id)}`, { method: "POST" });
    expect(r.status).toBe(409);
    const d = (await r.json()) as { ok: boolean; error: string; activeId: string | null };
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/COORDINATE MISMATCH/);
    expect(d.error).toMatch(/tools\/fit-kspread-c3\.ts/);   // actionable: name the refit tool
    expect(d.error).toMatch(/tools\/fit-hrspread-c6\.ts/);
    expect(d.activeId).toBe(before.activeId);

    const after = await listModels();
    expect(after.activeId).toBe(before.activeId);
    expect(after.activeId).toBe(bootActiveId); // ...and still the model that was live at boot
  });

  // The constraint the whole change is subject to: the live model is untagged, so none of the above
  // may have touched what production scores. Byte-for-byte, through the real grid endpoint.
  it("production scoring is BYTE-IDENTICAL across the whole sequence (the active model is untagged)", async () => {
    const now = await (await fetch(`${base}/api/cards`)).text();
    expect(now.length).toBe(cardsAtBoot.length);
    expect(now).toBe(cardsAtBoot);
  });

  // The gate must not be a blanket ban: an artifact on the ramps' own coordinate still activates.
  // (Runs last — it is the only test here that legitimately moves the pointer.)
  it("a legacy/untagged artifact activates normally (the gate is coordinate-specific, not a lockout)", async () => {
    const models = (await listModels()).models;
    const legacy = models.find((m) => m.name === "Cohort Legacy Default");
    expect(legacy).toBeTruthy();
    const r = await fetch(`${base}/api/training/models/activate?id=${encodeURIComponent(legacy!.id)}`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await r.json() as { ok: boolean; activeId: string }).activeId).toBe(legacy!.id);
  });
});
