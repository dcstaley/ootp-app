// Tournament settings (D4) — the single config source, now editable. Phase 1:
// roster shape, budget (cap/slots), value range, pool sizes, platoon split,
// coverage depth, era/park refs, variants. softcaps + eligibility rules ride
// along untouched (Phase 2 editors). Create / duplicate / rename / delete.

import { useEffect, useState, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, SLOT_TIER_KEYS, type TournamentCfg } from "./shared.ts";

type Lib = { id: string; name: string };

export function TournamentsPage() {
  const { tournaments, tournamentId, reloadTournaments, reloadView } = useAppData();
  const [selId, setSelId] = useState(tournamentId);
  const [draft, setDraft] = useState<TournamentCfg | null>(null);
  const [libs, setLibs] = useState<{ eras: Lib[]; parks: Lib[] }>({ eras: [], parks: [] });
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => { fetch("/api/libraries").then((r) => r.json()).then(setLibs).catch(() => {}); }, []);
  useEffect(() => {
    if (isNew || !selId) return;
    fetch("/api/tournament?id=" + encodeURIComponent(selId)).then((r) => r.json()).then((t) => { if (!t.error) { setDraft(t); setMsg(null); } }).catch(() => {});
  }, [selId, isNew]);

  const set = <K extends keyof TournamentCfg>(k: K, v: TournamentCfg[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const mode = draft?.budget_mode ?? (draft?.slot_counts && Object.keys(draft.slot_counts).length ? "slots" : (draft?.total_cap ? "cap" : "none"));
  const vR = draft?.platoonVR ?? 0.62;

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setMsg({ text: "Name is required.", ok: false }); return; }
    setBusy(true); setMsg(null);
    const r = await fetch("/api/tournaments/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    const d = await r.json(); setBusy(false);
    if (!r.ok) { setMsg({ text: d.error || "Save failed.", ok: false }); return; }
    await reloadTournaments(); setIsNew(false); setSelId(d.id);
    if (d.id === tournamentId) await reloadView();
    setMsg({ text: "Saved.", ok: true });
  };
  const newT = () => { if (draft) { setIsNew(true); setDraft({ ...draft, id: "", name: "New Tournament" }); setMsg(null); } };
  const duplicate = async () => {
    if (!selId) return; setBusy(true);
    const d = await (await fetch("/api/tournaments/duplicate?id=" + encodeURIComponent(selId), { method: "POST" })).json();
    setBusy(false); if (d.id) { await reloadTournaments(); setSelId(d.id); setIsNew(false); setMsg({ text: "Duplicated.", ok: true }); }
  };
  const del = async () => {
    if (!selId || !confirm(`Delete tournament “${draft?.name}”? This can't be undone.`)) return;
    setBusy(true);
    const r = await fetch("/api/tournaments/delete?id=" + encodeURIComponent(selId), { method: "POST" });
    const d = await r.json(); setBusy(false);
    if (!r.ok) { setMsg({ text: d.error || "Delete failed.", ok: false }); return; }
    await reloadTournaments(); setIsNew(false); setSelId(d.defaultId); setMsg({ text: "Deleted.", ok: true });
  };

  // ── field helpers ──
  const row = (label: string, node: ReactNode, hint?: string): ReactNode => (
    <label style={{ display: "grid", gridTemplateColumns: "175px 1fr", gap: 10, alignItems: "center", fontSize: 13, marginBottom: 6 }}>
      <span style={{ color: C.sub }}>{label}{hint && <span style={{ display: "block", fontSize: 10, color: C.sub, opacity: 0.7 }}>{hint}</span>}</span>
      {node}
    </label>
  );
  const numIn = (k: keyof TournamentCfg, opts: { min?: number; max?: number; step?: number; nullable?: boolean; width?: number } = {}): ReactNode => (
    <input type="number" value={(draft?.[k] as number | null | undefined) ?? ""} min={opts.min} max={opts.max} step={opts.step ?? 1}
      onChange={(e) => set(k, (e.target.value === "" ? (opts.nullable ? null : 0) : Number(e.target.value)) as TournamentCfg[typeof k])}
      style={{ ...inputStyle, width: opts.width ?? 110 }} />
  );
  const section = (title: string, children: ReactNode): ReactNode => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: C.link, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, margin: "0 0 8px" }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div style={{ width: "100%" }}>
      <h2 style={{ margin: "0 0 12px" }}>Tournaments</h2>
      <div style={{ display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: list */}
        <div style={{ flex: "0 0 240px", minWidth: 220 }}>
          <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
            {tournaments.map((t) => (
              <button key={t.id} onClick={() => { setIsNew(false); setSelId(t.id); }}
                style={{ ...inputStyle, textAlign: "left", cursor: "pointer", background: !isNew && selId === t.id ? C.navActive : C.input, fontWeight: !isNew && selId === t.id ? 700 : 400 }}>
                {t.name}{t.id === tournamentId && <span style={{ color: C.link, fontSize: 11 }}> · active</span>}
              </button>
            ))}
            {isNew && <div style={{ ...inputStyle, background: C.navActive, fontWeight: 700 }}>New Tournament (unsaved)</div>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={newT} disabled={busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>+ New</button>
            <button onClick={duplicate} disabled={busy || isNew} style={{ ...inputStyle, cursor: "pointer" }}>Duplicate</button>
            <button onClick={del} disabled={busy || isNew} style={{ ...inputStyle, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444" }}>Delete</button>
          </div>
        </div>

        {/* Right: editor */}
        {draft ? (
          <div style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 720 }}>
            {section("Identity & environment", <>
              {row("Name", <input value={draft.name} onChange={(e) => set("name", e.target.value)} style={{ ...inputStyle, width: 320 }} />)}
              {row("Era", <select value={draft.eraId} onChange={(e) => set("eraId", e.target.value)} style={{ ...inputStyle, width: 320, cursor: "pointer" }}>
                {!libs.eras.some((e) => e.id === draft.eraId) && <option value={draft.eraId}>{draft.eraId || "(none)"}</option>}
                {libs.eras.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>)}
              {row("Park", <select value={draft.parkId} onChange={(e) => set("parkId", e.target.value)} style={{ ...inputStyle, width: 320, cursor: "pointer" }}>
                {!libs.parks.some((p) => p.id === draft.parkId) && <option value={draft.parkId}>{draft.parkId || "(none)"}</option>}
                {libs.parks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>)}
            </>)}

            {section("Roster shape", <>
              {row("Roster size", numIn("roster_size", { min: 1 }))}
              {row("Hitters", numIn("hitters", { min: 0 }))}
              {row("Pitchers", numIn("pitchers", { min: 0 }))}
              {row("Rotation (starters)", numIn("min_starters", { min: 0 }))}
              {row("Min starter stamina", numIn("min_starter_stamina", { min: 0 }))}
              {row("Min pitch types", numIn("min_pitch_types", { min: 0 }))}
              {row("DH", <input type="checkbox" checked={draft.dh} onChange={(e) => set("dh", e.target.checked)} />)}
              {row("Backups per position", numIn("minPlayersPerPosition", { min: 1, max: 5 }), "coverage depth (default 2)")}
            </>)}

            {section("Budget", <>
              {row("Mode", <span style={{ display: "inline-flex", gap: 12 }}>
                {(["none", "cap", "slots"] as const).map((m) => (
                  <label key={m} style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="bmode" checked={mode === m} onChange={() => set("budget_mode", m)} /> {m === "none" ? "None" : m === "cap" ? "Cap" : "Slots"}
                  </label>
                ))}
              </span>)}
              {mode === "cap" && row("Total cap", numIn("total_cap", { min: 0, nullable: true, width: 140 }))}
              {mode === "slots" && row("Slot tiers", <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                {SLOT_TIER_KEYS.map((key) => (
                  <label key={key} style={{ fontSize: 11, color: C.sub, display: "grid", gap: 2 }}>{key}
                    <input type="number" min={0} value={draft.slot_counts?.[key] ?? ""} onChange={(e) => set("slot_counts", { ...(draft.slot_counts ?? {}), [key]: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} />
                  </label>
                ))}
              </div>)}
              {row("Card value min", numIn("card_value_min", { min: 0, nullable: true }), "eligibility floor (default 40)")}
              {row("Card value max", numIn("card_value_max", { min: 0, nullable: true }))}
            </>)}

            {section("Pool & weighting", <>
              {row("Top-X hitters", numIn("topHitters", { min: 0, nullable: true }), "two-way cutoff / non-cap pool (default 100)")}
              {row("Top-X pitchers", numIn("topPitchers", { min: 0, nullable: true }))}
              {row("RHP exposure (vR)", <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <input type="number" min={0} max={1} step={0.01} value={vR} onChange={(e) => { const x = Math.max(0, Math.min(1, Number(e.target.value))); set("platoonVR", x); set("platoonVL", Math.round((1 - x) * 100) / 100); }} style={{ ...inputStyle, width: 90 }} />
                <span style={{ fontSize: 12, color: C.sub }}>vL = {Math.round((1 - vR) * 100) / 100}</span>
              </span>, "team platoon split (league default 0.62)")}
            </>)}

            {section("Variants", <>
              {row("Variants allowed", <input type="checkbox" checked={draft.variants_allowed} onChange={(e) => set("variants_allowed", e.target.checked)} />)}
              {row("Max variants on roster", numIn("max_variants_on_roster", { min: 0 }))}
            </>)}

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
              <button onClick={save} disabled={busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff", fontWeight: 600 }}>{busy ? "Saving…" : isNew ? "Create" : "Save"}</button>
              {msg && <span style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#f87171" }}>{msg.text}</span>}
              <span style={{ fontSize: 11, color: C.sub }}>Softcaps & eligibility rules are preserved (Phase-2 editors).</span>
            </div>
          </div>
        ) : <p style={{ color: C.sub }}>Select a tournament to edit.</p>}
      </div>
    </div>
  );
}
