// Q-2 — server smoke tests for the S-5 hardening batch. Spins up the REAL server
// (node src/server/server.ts) on a free port against an isolated temp copy of data/,
// then exercises the acceptance list over HTTP:
//   • a malformed JSON body → 4xx/5xx, NEVER a process crash (top-level try/catch)
//   • a path-traversal ?id= on models/delete → 400
//   • an account import missing required catalog columns → 400
//   • a name-slug-collision import preserves the existing account's variant flags
//   • a same-catalog re-upload succeeds and the derived caches stay serviceable
//
// The server is heavy to boot (loads the catalog + scores the default tournament), so
// one instance is shared across the file. Skipped if the seed fixtures aren't present.

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

async function boot(port: number, dataRoot: string): Promise<void> {
  child = spawn(process.execPath, ["src/server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_ROOT: dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("server boot timeout")), 45_000);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes(`http://localhost:${port}`)) { clearTimeout(to); resolve(); }
    };
    child!.stdout!.on("data", onData);
    child!.stderr!.on("data", (b: Buffer) => { if (/Error|EADDRINUSE/.test(b.toString())) { clearTimeout(to); reject(new Error(b.toString())); } });
    child!.on("exit", (code) => { clearTimeout(to); reject(new Error(`server exited early (${code})`)); });
  });
}

// BUDGET RAISED 2026-07-22, deliberately. C2' made every field a PRESENCE MIXTURE, so a COLD field
// build costs materially more than when the 5s default was chosen — the heaviest endpoint here
// measures ~4.2s ISOLATED and failed only under parallel suite contention. Reference-dedupe in
// computeUnifiedFieldStats and poolChanBy already reclaimed the worst of it (poolMeanKOwn alone cost
// 1282ms before it). What remains is real work, not a leak, and trimming the model to fit a budget
// calibrated for the old workload would be the wrong repair.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe.skipIf(!HAVE_DATA)("Q-2 — server hardening smoke", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ootp-srv-"));
    cpSync("data", join(tmp, "data"), { recursive: true });
    const port = await freePort();
    base = `http://localhost:${port}`;
    await boot(port, join(tmp, "data"));
  }, 60_000);

  afterAll(() => {
    child?.kill();
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("a malformed JSON body returns an error, not a crash — and the server survives", async () => {
    const bad = await fetch(`${base}/api/tournaments/save`, { method: "POST", body: "{not json" });
    expect(bad.status).toBeGreaterThanOrEqual(400); // 400/500, handled
    // server is still alive and serving
    const ok = await fetch(`${base}/api/tournaments`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { tournaments: unknown[] };
    expect(Array.isArray(body.tournaments)).toBe(true);
  });

  it("a path-traversal model id is rejected with 400", async () => {
    const r = await fetch(`${base}/api/training/models/delete?id=${encodeURIComponent("../../state/app")}`, { method: "POST" });
    expect(r.status).toBe(400);
    // the state file must still be there (nothing deleted / escaped the collection)
    expect(existsSync(join(tmp, "data", "state", "app.json"))).toBe(true);
  });

  it("an account import missing required columns is rejected with 400", async () => {
    const r = await fetch(`${base}/api/accounts/import?name=BadCsv`, { method: "POST", body: "Card ID,Foo\n1,2\n" });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(String(body.error)).toMatch(/missing required columns/i);
  });

  it("a name-slug-collision import preserves the existing account's variants", async () => {
    const csv = readCatalog();
    // create a fresh account
    let r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    // flag a variant on it (pick a Card ID present in the catalog)
    const cardId = firstCardId(csv);
    r = await fetch(`${base}/api/accounts/variants/toggle`, { method: "POST", body: JSON.stringify({ id: "smokeacct", cardId, on: true }) });
    expect(r.status).toBe(200);
    let summary = await r.json() as { accounts: { id: string; variantCount: number }[] };
    expect(summary.accounts.find((a) => a.id === "smokeacct")?.variantCount).toBe(1);
    // re-import as a "new" account with the SAME name (slugs to smokeacct) → must NOT wipe variants
    r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    summary = await r.json() as { accounts: { id: string; variantCount: number }[] };
    expect(summary.accounts.find((a) => a.id === "smokeacct")?.variantCount).toBe(1);
  });

  // TIMEOUT RAISED 2026-07-22, deliberately and with a reason. C2' made every field a PRESENCE
  // MIXTURE, so a COLD field build now costs materially more than it did (measured: ~4.2s for this
  // endpoint isolated, against the old 5s budget it used to clear easily; it failed only under
  // parallel suite contention). Reference-dedupe in computeUnifiedFieldStats/poolChanBy already took
  // the worst of it back — poolMeanKOwn alone was 1282ms before that and is the reason this is not
  // simply a bigger number. The remaining cost is real work, not a leak, and shaving the model to
  // fit a budget calibrated for the old workload would be the wrong repair.
  it("a same-catalog re-upload succeeds and derived endpoints stay serviceable", async () => {
    const csv = readCatalog();
    const before = await (await fetch(`${base}/api/debug/scaling?t=gold-quick`)).json() as { tournament: string };
    const r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    const after = await fetch(`${base}/api/debug/scaling?t=gold-quick`);
    expect(after.status).toBe(200); // caches were invalidated + rebuilt without crashing
    const body = await after.json() as { tournament: string };
    expect(body.tournament).toBe(before.tournament);
  });

  // Regression pin (Derek, 2026-07-21): NOTHING in tournament modelling may depend on when the
  // tournament was created or which model was active then. The save handler used to seed
  // t.platoon/platoonVR/VL from the ACTIVE model on create, freezing a snapshot of a moving
  // quantity into config — 38 of 42 configs ended up with one of only four payloads, one per model
  // vintage. There is also a second path: a new tournament is built as {...base, ...body} where
  // base is the DEFAULT tournament, so a platoon left on default-neutral would propagate to every
  // tournament created after it. Both are closed; this pin covers both.
  it("creating a tournament NEVER seeds a platoon block (no create-time model snapshot)", async () => {
    const r = await fetch(`${base}/api/tournaments/save`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platoon Seed Pin", card_value_max: 69, eraId: "era-2010", parkId: "park-1" }),
    });
    expect(r.status).toBe(200);
    const list = await (await fetch(`${base}/api/tournaments`)).json() as { tournaments?: Record<string, unknown>[] } | Record<string, unknown>[];
    const arr = Array.isArray(list) ? list : (list.tournaments ?? []);
    const made = arr.find((t) => (t as { id?: string }).id === "platoon-seed-pin") as Record<string, unknown> | undefined;
    expect(made, "created tournament should be returned by /api/tournaments").toBeTruthy();
    expect(made!.platoon).toBeUndefined();
    expect(made!.platoonVR).toBeUndefined();
    expect(made!.platoonVL).toBeUndefined();
  }, 60_000);

  // Regression: a delete-then-retrain cycle used to land with a saved artifact and
  // `activeModelId: null` (delete correctly nulls the pointer; save never set it), so the app
  // scored through the log-linear fallback and every tool resolving the active model threw.
  // saveTrainedModel now auto-activates WHEN NOTHING IS ACTIVE — and must NOT hijack the
  // pointer when a model is already active (training an experimental model must not silently
  // swap production scoring).
  it("saving a trained model activates it only when no model is active", async () => {
    // deactivate → the null-pointer state a delete-of-the-active-model leaves behind
    let r = await fetch(`${base}/api/training/models/activate?id=`, { method: "POST" });
    expect(r.status).toBe(200);
    expect((await r.json() as { activeId: string | null }).activeId).toBe(null);

    // save with nothing active → the new artifact becomes active
    r = await fetch(`${base}/api/training/models/save`, {
      method: "POST", body: JSON.stringify({ name: "Smoke Autoactivate" }),
    });
    expect(r.status).toBe(200);
    const first = await r.json() as { ok: boolean; error?: string; model: { id: string }; activeId: string | null };
    expect(first.ok, first.error).toBe(true);
    expect(first.activeId).toBe(first.model.id);
    expect(first.activeId).not.toBe(null);

    // save again with one already active → pointer must stay on the FIRST model
    r = await fetch(`${base}/api/training/models/save`, {
      method: "POST", body: JSON.stringify({ name: "Smoke Second" }),
    });
    expect(r.status).toBe(200);
    const second = await r.json() as { ok: boolean; model: { id: string }; activeId: string | null };
    expect(second.ok).toBe(true);
    expect(second.model.id).not.toBe(first.model.id); // a genuinely new artifact
    expect(second.activeId).toBe(first.model.id);     // ...that did NOT steal the pointer
  }, 120_000);
});

// ── helpers that read the committed catalog once ─────────────────────────────
import { readFileSync } from "node:fs";
let _csv: string | null = null;
function readCatalog(): string { return (_csv ??= readFileSync("docs/pt_card_list.csv", "utf8")); }
function firstCardId(csv: string): string {
  const lines = csv.split(/\r?\n/);
  const header = lines[0]!.split(",");
  const idCol = header.indexOf("Card ID");
  return lines[1]!.split(",")[idCol]!;
}
