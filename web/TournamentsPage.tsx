// Tournament settings (D4) — the single config source, now editable. Phase 1:
// roster shape, budget (cap/slots), value range, pool sizes, platoon split,
// coverage depth, era/park refs, variants. softcaps + eligibility rules ride
// along untouched (Phase 2 editors). Create / duplicate / rename / delete.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, SLOT_TIER_KEYS, SOFTCAP_GROUPS, type TournamentCfg, type EligibilityGroup, type EligibilityRule, type RuleOp } from "./shared.ts";

type Lib = { id: string; name: string };

const ELIG_OPS: { value: RuleOp; label: string }[] = [
  { value: "num_ge", label: "≥ (num)" }, { value: "num_gt", label: "> (num)" },
  { value: "num_le", label: "≤ (num)" }, { value: "num_lt", label: "< (num)" },
  { value: "num_eq", label: "= (num)" }, { value: "num_between", label: "between (num)" },
  { value: "set_in", label: "is one of" }, { value: "set_not_in", label: "is not one of" },
  { value: "text_contains", label: "contains" }, { value: "text_equals", label: "equals" },
  { value: "is_blank", label: "is blank" }, { value: "is_not_blank", label: "is not blank" },
];
const opKind = (op: RuleOp): "ab" | "num" | "text" | "values" | "none" =>
  op === "num_between" ? "ab" : op.startsWith("num_") ? "num" : (op === "set_in" || op === "set_not_in") ? "values"
    : (op === "text_contains" || op === "text_equals") ? "text" : "none";

export function TournamentsPage() {
  const { tournaments, tournamentId, reloadTournaments, reloadView } = useAppData();
  const [selId, setSelId] = useState(tournamentId);
  const [draft, setDraft] = useState<TournamentCfg | null>(null);
  const [libs, setLibs] = useState<{ eras: Lib[]; parks: Lib[]; columns: string[] }>({ eras: [], parks: [], columns: [] });
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => { fetch("/api/libraries").then((r) => r.json()).then(setLibs).catch(() => {}); }, []);
  // If the page mounts before the active tournament is known, adopt it once it arrives.
  useEffect(() => { if (!selId && tournamentId) setSelId(tournamentId); }, [tournamentId, selId]);
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

  // ── Eligibility rule helpers ──
  const elig: EligibilityGroup = draft?.eligibility ?? { mode: "ALL", rules: [] };
  const setElig = (g: EligibilityGroup) => set("eligibility", g);
  const addRule = () => setElig({ ...elig, rules: [...elig.rules, { id: `r${Date.now()}-${elig.rules.length}`, column: libs.columns[0] ?? "", op: "num_ge" }] });
  const updRule = (id: string, patch: Partial<EligibilityRule>) => setElig({ ...elig, rules: elig.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const delRule = (id: string) => setElig({ ...elig, rules: elig.rules.filter((r) => r.id !== id) });
  const smIn: React.CSSProperties = { ...inputStyle, padding: "3px 5px", fontSize: 12 };

  // ── Softcaps ──
  const sc = draft?.softcaps ?? {};
  const setSc = (key: string, v: string) => set("softcaps", { ...sc, [key]: v === "" ? 0 : Number(v) });
  const scIn = (key: string, opts: { step?: number; max?: number } = {}): ReactNode => (
    <input type="number" min={0} max={opts.max} step={opts.step ?? 1} value={sc[key] ?? ""} onChange={(e) => setSc(key, e.target.value)} style={{ ...smIn, width: 72 }} />
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

            {section("Eligibility rules", <>
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 8 }}>
                {(["ALL", "ANY"] as const).map((m) => (
                  <label key={m} style={{ display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer", fontSize: 13 }}>
                    <input type="radio" name="eligmode" checked={elig.mode === m} onChange={() => setElig({ ...elig, mode: m })} /> Match {m === "ALL" ? "ALL rules" : "ANY rule"}
                  </label>
                ))}
              </div>
              <p style={{ margin: "0 0 8px", fontSize: 11, color: C.sub }}>Card-value min/max (above) is applied separately. No rules = every card in the value range is eligible.</p>
              <div style={{ display: "grid", gap: 6 }}>
                {elig.rules.map((r) => {
                  const kind = opKind(r.op);
                  const cols = libs.columns.includes(r.column) || !r.column ? libs.columns : [r.column, ...libs.columns];
                  return (
                    <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <select value={r.column} onChange={(e) => updRule(r.id, { column: e.target.value })} style={{ ...smIn, flex: "1 1 200px", maxWidth: 240, cursor: "pointer" }}>
                        {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select value={r.op} onChange={(e) => updRule(r.id, { op: e.target.value as RuleOp, a: undefined, b: undefined, values: undefined })} style={{ ...smIn, width: 130, cursor: "pointer" }}>
                        {ELIG_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {kind === "ab" && <>
                        <input type="number" value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="min" style={{ ...smIn, width: 70 }} />
                        <input type="number" value={r.b ?? ""} onChange={(e) => updRule(r.id, { b: e.target.value })} placeholder="max" style={{ ...smIn, width: 70 }} />
                      </>}
                      {kind === "num" && <input type="number" value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="value" style={{ ...smIn, width: 90 }} />}
                      {kind === "text" && <input value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="text" style={{ ...smIn, width: 160 }} />}
                      {kind === "values" && <input value={(r.values ?? []).join(", ")} onChange={(e) => updRule(r.id, { values: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="a, b, c" style={{ ...smIn, flex: "1 1 160px", maxWidth: 240 }} />}
                      <button onClick={() => delRule(r.id)} title="Remove rule" style={{ ...inputStyle, padding: "1px 0", width: 26, textAlign: "center", boxSizing: "border-box", fontSize: 12, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
                    </div>
                  );
                })}
              </div>
              <button onClick={addRule} style={{ ...inputStyle, marginTop: 8, cursor: "pointer" }}>+ Add rule</button>
            </>)}

            {section("Softcaps", <>
              <p style={{ margin: "0 0 8px", fontSize: 11, color: C.sub }}>Per rating group: ratings above <b>Top</b> get diminishing returns, below <b>Bottom</b> get penalized, by <b>Penalty</b> strength (0–1). Model-seeded — these directly shape scoring.</p>
              <div style={{ display: "grid", gridTemplateColumns: "120px 72px 72px 72px", gap: 6, alignItems: "center", fontSize: 12 }}>
                <span style={{ color: C.sub }} /> <span style={{ color: C.sub, fontWeight: 600 }}>Top</span> <span style={{ color: C.sub, fontWeight: 600 }}>Bottom</span> <span style={{ color: C.sub, fontWeight: 600 }}>Penalty</span>
                {SOFTCAP_GROUPS.map((g) => (
                  <Fragment key={g.key}>
                    <span style={{ color: C.sub }}>{g.label}</span>
                    {scIn(`cap_${g.key}_top`)}
                    {scIn(`cap_${g.key}_bot`)}
                    {scIn(`pen_${g.key}`, { step: 0.05, max: 1 })}
                  </Fragment>
                ))}
              </div>
            </>)}

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
              <button onClick={save} disabled={busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff", fontWeight: 600 }}>{busy ? "Saving…" : isNew ? "Create" : "Save"}</button>
              {msg && <span style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#f87171" }}>{msg.text}</span>}
              <span style={{ fontSize: 11, color: C.sub }}>Era/Park factors are edited in Eras & Parks.</span>
            </div>
          </div>
        ) : <p style={{ color: C.sub }}>Select a tournament to edit.</p>}
      </div>
    </div>
  );
}
