// Tournament settings (D4) — the single config source. Edits are immediate: creating a
// tournament persists it right away and every change auto-saves (debounced); there is no
// manual Save. Editor covers roster shape, budget (cap/slots), value range, pool sizes,
// platoon split, coverage depth, era/park refs, variants, eligibility, and position
// constraints (absolute mins + rank requirements, with live pool metrics).

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, SLOT_TIER_KEYS, POSITION_RATING_KEYS, FIELD_POS, newTournamentCfg, TOURNAMENT_DEFAULTS, type TournamentCfg, type EligibilityGroup, type EligibilityRule, type RuleOp } from "./shared.ts";

type Lib = { id: string; name: string };
type PoolMetric = { n: number; mean: number; max: number; p90: number; p95: number; top5: number; top10: number };
type PosMetrics = Record<string, Record<string, PoolMetric>>;

const r3 = (x: number) => Math.round(x * 1000) / 1000; // round to 3 decimals

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

// Searchable dropdown (combobox). Shows the selected option's name; typing filters the
// list; selection commits the option id. Falls back to the raw value when the id is not
// in the option set (e.g. an orphaned era/park ref).
function Combo({ value, options, onChange, width, placeholder }: { value: string; options: Lib[]; onChange: (id: string) => void; width?: number | string; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const sel = options.find((o) => o.id === value);
  const shown = open ? options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80) : [];
  return (
    <div style={{ position: "relative", width: width ?? 340 }}>
      <input
        value={open ? q : (sel?.name ?? value)}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setQ(""); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} />
      {open && shown.length > 0 && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 2, maxHeight: 280, overflowY: "auto", background: C.input, border: `1px solid ${C.border}`, borderRadius: 4 }}>
          {shown.map((o) => (
            <div key={o.id} onMouseDown={() => { onChange(o.id); setOpen(false); }}
              style={{ padding: "6px 9px", cursor: "pointer", fontSize: 14, background: o.id === value ? C.navActive : "transparent" }}>{o.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TournamentsPage() {
  const { tournaments, tournamentId, reloadTournaments, reloadView } = useAppData();
  const [selId, setSelId] = useState(tournamentId);
  const [draft, setDraft] = useState<TournamentCfg | null>(null);
  const [libs, setLibs] = useState<{ eras: Lib[]; parks: Lib[]; columns: string[]; platoonDefaults?: { r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split: number; l_pitch_split: number; teamVR?: number; teamVL?: number } }>({ eras: [], parks: [], columns: [] });
  const [metrics, setMetrics] = useState<PosMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const savedRef = useRef<string>(""); // JSON of the last-persisted draft (auto-save baseline)

  useEffect(() => { fetch("/api/libraries").then((r) => r.json()).then(setLibs).catch(() => {}); }, []);
  // If the page mounts before the active tournament is known, adopt it once it arrives.
  useEffect(() => { if (!selId && tournamentId) setSelId(tournamentId); }, [tournamentId, selId]);
  // Load the selected tournament; seed the auto-save baseline so a plain load never re-saves.
  useEffect(() => {
    if (!selId) return;
    fetch("/api/tournament?id=" + encodeURIComponent(selId)).then((r) => r.json()).then((t) => {
      if (!t.error) { setDraft(t); savedRef.current = JSON.stringify(t); setMsg(null); }
    }).catch(() => {});
  }, [selId]);

  const set = <K extends keyof TournamentCfg>(k: K, v: TournamentCfg[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const mode = draft?.budget_mode ?? (draft?.slot_counts && Object.keys(draft.slot_counts).length ? "slots" : (draft?.total_cap ? "cap" : "none"));
  const vR = draft?.platoonVR ?? libs.platoonDefaults?.teamVR ?? 0.62;
  // Per-hand OVR splits — show the active model's defaults until the tournament has its own;
  // the first edit materializes a full platoon object so editing one split keeps the rest.
  const PLATOON_SPLITS = [
    { k: "r_hit_split", label: "RHB vs RHP" }, { k: "l_hit_split", label: "LHB vs LHP" }, { k: "s_hit_split", label: "SHB vs RHP" },
    { k: "r_pitch_split", label: "RHP vs RHB" }, { k: "l_pitch_split", label: "LHP vs LHB" },
  ] as const;
  type SplitKey = (typeof PLATOON_SPLITS)[number]["k"];
  const splitDef = (k: SplitKey): number => draft?.platoon?.[k] ?? libs.platoonDefaults?.[k] ?? 0.5;
  const setSplit = (k: SplitKey, x: number) => {
    if (!draft) return;
    const base = draft.platoon ?? { r_hit_split: splitDef("r_hit_split"), l_hit_split: splitDef("l_hit_split"), s_hit_split: splitDef("s_hit_split"), r_pitch_split: splitDef("r_pitch_split"), l_pitch_split: splitDef("l_pitch_split") };
    set("platoon", { ...base, [k]: r3(x) });
  };

  // Auto-save: persist the draft (debounced) whenever it differs from the last-saved snapshot.
  // No-op on a fresh load (baseline matches). Skips while the name is empty.
  useEffect(() => {
    if (!draft) return;
    const snap = JSON.stringify(draft);
    if (snap === savedRef.current) return;
    if (!draft.name.trim()) { setMsg({ text: "Name is required.", ok: false }); return; }
    setMsg({ text: "Saving…", ok: true });
    const tmo = setTimeout(async () => {
      try {
        const r = await fetch("/api/tournaments/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        const d = await r.json();
        if (!r.ok) { setMsg({ text: d.error || "Save failed.", ok: false }); return; }
        savedRef.current = snap;
        await reloadTournaments();
        if (d.id === tournamentId) await reloadView();
        setMsg({ text: "Saved.", ok: true });
      } catch { setMsg({ text: "Save failed.", ok: false }); }
    }, 500);
    return () => clearTimeout(tmo);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pool metrics for the position-constraint editor. Recomputed (debounced) when a
  // pool-defining field changes (era/park/eligibility/value-range/Top-X). POSTs the draft
  // so it reflects unsaved edits.
  const poolSig = draft ? JSON.stringify([draft.id, draft.eraId, draft.parkId, draft.topHitters, draft.card_value_min, draft.card_value_max, draft.eligibility]) : "";
  useEffect(() => {
    if (!draft) { setMetrics(null); return; }
    const ctrl = new AbortController();
    const tmo = setTimeout(() => {
      fetch("/api/position-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: ctrl.signal })
        .then((r) => r.json()).then((d) => setMetrics(d.metrics ?? null)).catch(() => {});
    }, 250);
    return () => { ctrl.abort(); clearTimeout(tmo); };
  }, [poolSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // New tournaments are created immediately (from the defined defaults) — they exist as soon
  // as you click + New; further edits auto-save. platoon fields are left unset so the server
  // seeds them from the active model on create.
  const newT = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/tournaments/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newTournamentCfg()) });
      const d = await r.json();
      if (!r.ok) { setMsg({ text: d.error || "Create failed.", ok: false }); return; }
      await reloadTournaments(); setSelId(d.id); setMsg({ text: "Created.", ok: true });
    } finally { setBusy(false); }
  };
  const duplicate = async () => {
    if (!selId) return; setBusy(true);
    const d = await (await fetch("/api/tournaments/duplicate?id=" + encodeURIComponent(selId), { method: "POST" })).json();
    setBusy(false); if (d.id) { await reloadTournaments(); setSelId(d.id); setMsg({ text: "Duplicated.", ok: true }); }
  };
  const del = async () => {
    if (!selId || !confirm(`Delete tournament “${draft?.name}”? This can't be undone.`)) return;
    setBusy(true);
    const r = await fetch("/api/tournaments/delete?id=" + encodeURIComponent(selId), { method: "POST" });
    const d = await r.json(); setBusy(false);
    if (!r.ok) { setMsg({ text: d.error || "Delete failed.", ok: false }); return; }
    await reloadTournaments(); setSelId(d.defaultId); setMsg({ text: "Deleted.", ok: true });
  };

  // ── field helpers ──
  const row = (label: string, node: ReactNode, hint?: string): ReactNode => (
    <label style={{ display: "grid", gridTemplateColumns: "190px 1fr", gap: 12, alignItems: "center", fontSize: 14, marginBottom: 8 }}>
      <span style={{ color: C.sub }}>{label}{hint && <span style={{ display: "block", fontSize: 12, color: C.sub, opacity: 0.75 }}>{hint}</span>}</span>
      {node}
    </label>
  );
  // `def` autofills the displayed value when the field is unset, so defaulted fields show
  // their effective value instead of a blank box.
  const numIn = (k: keyof TournamentCfg, opts: { min?: number; max?: number; step?: number; nullable?: boolean; width?: number; def?: number } = {}): ReactNode => (
    <input type="number" value={(draft?.[k] as number | null | undefined) ?? opts.def ?? ""} min={opts.min} max={opts.max} step={opts.step ?? 1}
      onChange={(e) => set(k, (e.target.value === "" ? (opts.nullable ? null : 0) : Number(e.target.value)) as TournamentCfg[typeof k])}
      style={{ ...inputStyle, width: opts.width ?? 120 }} />
  );
  const section = (title: string, children: ReactNode): ReactNode => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 14, color: C.link, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, margin: "0 0 10px" }}>{title}</div>
      {children}
    </div>
  );

  // ── Eligibility rule helpers ──
  const elig: EligibilityGroup = draft?.eligibility ?? { mode: "ALL", rules: [] };
  const setElig = (g: EligibilityGroup) => set("eligibility", g);
  const addRule = () => setElig({ ...elig, rules: [...elig.rules, { id: `r${Date.now()}-${elig.rules.length}`, column: libs.columns[0] ?? "", op: "num_ge" }] });
  const updRule = (id: string, patch: Partial<EligibilityRule>) => setElig({ ...elig, rules: elig.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const delRule = (id: string) => setElig({ ...elig, rules: elig.rules.filter((r) => r.id !== id) });
  const smIn: CSSProperties = { ...inputStyle, padding: "4px 6px", fontSize: 13 };
  const colOpts = (extra?: string): Lib[] => {
    const cols = extra && !libs.columns.includes(extra) ? [extra, ...libs.columns] : libs.columns;
    return cols.map((c) => ({ id: c, name: c }));
  };

  // ── Position constraints (absolute mins + rank requirements) ──
  const pm = draft?.positionMins ?? {};
  const pr = draft?.positionRanks ?? {};
  const setPosMin = (pos: string, tier: "starter" | "backup", key: string, v: string) => {
    const cur = pm[pos] ?? {};
    const tierObj: Record<string, number> = { ...(cur[tier] ?? {}) };
    if (v === "") delete tierObj[key]; else tierObj[key] = Number(v);
    set("positionMins", { ...pm, [pos]: { ...cur, [tier]: tierObj } });
  };
  const setPosRank = (pos: string, tier: "starter" | "backup", key: string, v: string) => {
    const cur = pr[pos] ?? {};
    const tierObj: Record<string, number> = { ...(cur[tier] ?? {}) };
    if (v === "") delete tierObj[key]; else tierObj[key] = Number(v);
    set("positionRanks", { ...pr, [pos]: { ...cur, [tier]: tierObj } });
  };
  const consIn = (val: number | undefined, on: (v: string) => void, min: number): ReactNode => (
    <input type="number" min={min} value={val ?? ""} onChange={(e) => on(e.target.value)} style={{ ...inputStyle, width: 56, padding: "1px 5px", fontSize: 14, textAlign: "center" }} />
  );
  const fmt = (x: number | undefined) => (x == null || !Number.isFinite(x) ? "—" : Math.round(x).toString());
  const poolN = (pos: string): number | undefined => { const m = metrics?.[pos]; return m ? Object.values(m)[0]?.n : undefined; };

  // Position-constraint table styles (compact rows; numbers at body-text size).
  const cellPad: CSSProperties = { padding: "1px 8px" };
  const thG: CSSProperties = { padding: "2px 8px", fontSize: 13, fontWeight: 700, color: C.sub, textAlign: "center", borderBottom: `1px solid ${C.border}` };
  const thS: CSSProperties = { padding: "1px 8px", fontSize: 13, fontWeight: 600, color: C.sub, whiteSpace: "nowrap" };
  const tdPos: CSSProperties = { ...cellPad, fontWeight: 700, fontSize: 15, verticalAlign: "middle", borderRight: `1px solid ${C.border}` };
  const tdRating: CSSProperties = { ...cellPad, color: C.text };
  const tdNum: CSSProperties = { ...cellPad, textAlign: "right", color: C.text, fontVariantNumeric: "tabular-nums" };

  return (
    <div className="tourney" style={{ width: "100%", fontSize: 14 }}>
      <style>{`
        .tourney input[type=number]{ -moz-appearance: textfield; }
        .tourney input[type=number]::-webkit-outer-spin-button,
        .tourney input[type=number]::-webkit-inner-spin-button{ -webkit-appearance: none; margin: 0; }
      `}</style>
      <h2 style={{ margin: "0 0 14px", fontSize: 22 }}>Tournaments</h2>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: list */}
        <div style={{ flex: "0 0 250px", minWidth: 230 }}>
          <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
            {tournaments.map((t) => (
              <button key={t.id} onClick={() => setSelId(t.id)}
                style={{ ...inputStyle, textAlign: "left", cursor: "pointer", background: selId === t.id ? C.navActive : C.input, fontWeight: selId === t.id ? 700 : 400 }}>
                {t.name}{t.id === tournamentId && <span style={{ color: C.link, fontSize: 12 }}> · active</span>}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={newT} disabled={busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>+ New</button>
            <button onClick={duplicate} disabled={busy || !selId} style={{ ...inputStyle, cursor: "pointer" }}>Duplicate</button>
            <button onClick={del} disabled={busy || !selId} style={{ ...inputStyle, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444" }}>Delete</button>
          </div>
          {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.ok ? "#86efac" : "#f87171" }}>{msg.text}</div>}
        </div>

        {/* Right: editor */}
        {draft ? (
          <div style={{ flex: "1 1 620px", minWidth: 0, maxWidth: 860 }}>
            {section("Identity & environment", <>
              {row("Name", <input value={draft.name} onChange={(e) => set("name", e.target.value)} style={{ ...inputStyle, width: 340 }} />)}
              {row("Era", <Combo value={draft.eraId} options={libs.eras} onChange={(id) => set("eraId", id)} placeholder="Search eras…" />)}
              {row("Park", <Combo value={draft.parkId} options={libs.parks} onChange={(id) => set("parkId", id)} placeholder="Search parks…" />)}
            </>)}

            {section("Roster shape", <>
              {row("Hitters", numIn("hitters", { min: 0 }))}
              {row("Pitchers", numIn("pitchers", { min: 0 }))}
              {row("Rotation (starters)", numIn("min_starters", { min: 0 }))}
              {row("Min starter stamina", numIn("min_starter_stamina", { min: 0 }))}
              {row("Min pitch types", numIn("min_pitch_types", { min: 0 }))}
              {row("DH", <input type="checkbox" checked={draft.dh} onChange={(e) => set("dh", e.target.checked)} />)}
              {row("Backups per position", numIn("minPlayersPerPosition", { min: 1, max: 5, def: TOURNAMENT_DEFAULTS.minPlayersPerPosition }), "coverage depth")}
            </>)}

            {section("Budget", <>
              {row("Mode", <span style={{ display: "inline-flex", gap: 14 }}>
                {(["none", "cap", "slots"] as const).map((m) => (
                  <label key={m} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="bmode" checked={mode === m} onChange={() => set("budget_mode", m)} /> {m === "none" ? "None" : m === "cap" ? "Cap" : "Slots"}
                  </label>
                ))}
              </span>)}
              {mode === "cap" && row("Total cap", numIn("total_cap", { min: 0, nullable: true, width: 150 }))}
              {mode === "slots" && row("Slot tiers", <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {SLOT_TIER_KEYS.map((key) => (
                  <label key={key} style={{ fontSize: 12, color: C.sub, display: "grid", gap: 2 }}>{key}
                    <input type="number" min={0} value={draft.slot_counts?.[key] ?? ""} onChange={(e) => set("slot_counts", { ...(draft.slot_counts ?? {}), [key]: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} />
                  </label>
                ))}
              </div>)}
              {row("Card value min", numIn("card_value_min", { min: 0, nullable: true }), "blank = no floor (entire pool)")}
              {row("Card value max", numIn("card_value_max", { min: 0, nullable: true }), "blank = no ceiling")}
            </>)}

            {section("Pool & weighting", <>
              {row("Top-X hitters", numIn("topHitters", { min: 0, nullable: true, def: TOURNAMENT_DEFAULTS.topHitters }), "each side (vL/vR) · two-way cutoff / non-cap pool")}
              {row("Top-X pitchers", numIn("topPitchers", { min: 0, nullable: true, def: TOURNAMENT_DEFAULTS.topPitchers }), "by OVR")}
              {row("RHP exposure (vR)", <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                <input type="number" min={0} max={1} step={0.001} value={r3(vR)} onChange={(e) => { const x = Math.max(0, Math.min(1, Number(e.target.value))); set("platoonVR", r3(x)); set("platoonVL", r3(1 - x)); }} style={{ ...inputStyle, width: 100 }} />
                <span style={{ fontSize: 13, color: C.sub }}>vL = {r3(1 - vR)}</span>
              </span>, `team RHP/LHP exposure — optimizer${draft.platoonVR == null ? " (model default)" : ""}`)}
              <div style={{ fontSize: 12, color: C.sub, margin: "8px 0 6px" }}>
                Per-hand OVR splits — weight on the same-letter side{!draft.platoon && libs.platoonDefaults ? " (showing active-model defaults)" : ""}:
              </div>
              {PLATOON_SPLITS.map((s) => (
                <Fragment key={s.k}>{row(s.label, <input type="number" min={0} max={1} step={0.001} value={r3(splitDef(s.k))} onChange={(e) => setSplit(s.k, Math.max(0, Math.min(1, Number(e.target.value))))} style={{ ...inputStyle, width: 100 }} />)}</Fragment>
              ))}
            </>)}

            {section("Variants", <>
              {row("Variants allowed", <input type="checkbox" checked={draft.variants_allowed} onChange={(e) => set("variants_allowed", e.target.checked)} />)}
              {row("Max variants on roster", numIn("max_variants_on_roster", { min: 0 }), "0 = unlimited")}
            </>)}

            {section("Eligibility rules", <>
              <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 10 }}>
                {(["ALL", "ANY"] as const).map((m) => (
                  <label key={m} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer", fontSize: 14 }}>
                    <input type="radio" name="eligmode" checked={elig.mode === m} onChange={() => setElig({ ...elig, mode: m })} /> Match {m === "ALL" ? "ALL rules" : "ANY rule"}
                  </label>
                ))}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {elig.rules.map((r) => {
                  const kind = opKind(r.op);
                  return (
                    <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <Combo value={r.column} options={colOpts(r.column)} onChange={(c) => updRule(r.id, { column: c })} width={230} placeholder="Search columns…" />
                      <select value={r.op} onChange={(e) => updRule(r.id, { op: e.target.value as RuleOp, a: undefined, b: undefined, values: undefined })} style={{ ...smIn, width: 140, cursor: "pointer" }}>
                        {ELIG_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {kind === "ab" && <>
                        <input type="number" value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="min" style={{ ...smIn, width: 76 }} />
                        <input type="number" value={r.b ?? ""} onChange={(e) => updRule(r.id, { b: e.target.value })} placeholder="max" style={{ ...smIn, width: 76 }} />
                      </>}
                      {kind === "num" && <input type="number" value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="value" style={{ ...smIn, width: 96 }} />}
                      {kind === "text" && <input value={r.a ?? ""} onChange={(e) => updRule(r.id, { a: e.target.value })} placeholder="text" style={{ ...smIn, width: 170 }} />}
                      {kind === "values" && <input value={(r.values ?? []).join(", ")} onChange={(e) => updRule(r.id, { values: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="a, b, c" style={{ ...smIn, flex: "1 1 170px", maxWidth: 250 }} />}
                      <button onClick={() => delRule(r.id)} title="Remove rule" style={{ ...inputStyle, padding: "2px 0", width: 28, textAlign: "center", boxSizing: "border-box", fontSize: 13, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
                    </div>
                  );
                })}
              </div>
              <button onClick={addRule} style={{ ...inputStyle, marginTop: 10, cursor: "pointer" }}>+ Add rule</button>
            </>)}

            {section("Position constraints", <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th rowSpan={2} style={{ ...thG, textAlign: "left", borderBottom: undefined }}>Position</th>
                      <th rowSpan={2} style={{ ...thG, textAlign: "left", borderBottom: undefined }}>Rating</th>
                      <th colSpan={4} style={thG}>Pool (eligible at position)</th>
                      <th colSpan={2} style={{ ...thG, borderLeft: `1px solid ${C.border}` }}>Starter</th>
                      <th colSpan={2} style={thG}>Backup</th>
                    </tr>
                    <tr>
                      <th style={{ ...thS, textAlign: "right" }}>Mean</th>
                      <th style={{ ...thS, textAlign: "right" }}>Max</th>
                      <th style={{ ...thS, textAlign: "right" }}>Top 5</th>
                      <th style={{ ...thS, textAlign: "right" }}>Top 10</th>
                      <th style={{ ...thS, textAlign: "center", borderLeft: `1px solid ${C.border}` }}>Minimum rating</th>
                      <th style={{ ...thS, textAlign: "center" }}>Top-N rank</th>
                      <th style={{ ...thS, textAlign: "center" }}>Minimum rating</th>
                      <th style={{ ...thS, textAlign: "center" }}>Top-N rank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FIELD_POS.map((pos) => {
                      const ratings = POSITION_RATING_KEYS[pos]!;
                      return ratings.map((rt, i) => {
                        const m = metrics?.[pos]?.[rt.key];
                        return (
                          <tr key={pos + rt.key} style={{ borderTop: i === 0 ? `1px solid ${C.border}` : `1px solid ${C.border}33` }}>
                            {i === 0 && <td rowSpan={ratings.length} style={tdPos}>
                              <div>{pos}</div>
                              <div style={{ fontSize: 12, fontWeight: 400, color: C.sub }}>n = {poolN(pos) ?? "…"}</div>
                            </td>}
                            <td style={tdRating}>{rt.label}</td>
                            <td style={tdNum}>{m ? fmt(m.mean) : "…"}</td>
                            <td style={tdNum}>{m ? fmt(m.max) : "…"}</td>
                            <td style={tdNum}>{m ? fmt(m.top5) : "…"}</td>
                            <td style={tdNum}>{m ? fmt(m.top10) : "…"}</td>
                            <td style={{ ...cellPad, textAlign: "center", borderLeft: `1px solid ${C.border}` }}>{consIn(pm[pos]?.starter?.[rt.key], (v) => setPosMin(pos, "starter", rt.key, v), 0)}</td>
                            <td style={{ ...cellPad, textAlign: "center" }}>{consIn(pr[pos]?.starter?.[rt.key], (v) => setPosRank(pos, "starter", rt.key, v), 1)}</td>
                            <td style={{ ...cellPad, textAlign: "center" }}>{consIn(pm[pos]?.backup?.[rt.key], (v) => setPosMin(pos, "backup", rt.key, v), 0)}</td>
                            <td style={{ ...cellPad, textAlign: "center" }}>{consIn(pr[pos]?.backup?.[rt.key], (v) => setPosRank(pos, "backup", rt.key, v), 1)}</td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            </>)}

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: 12, color: C.sub }}>Changes save automatically. Roster size is fixed at 26. Era/Park factors are edited in Eras & Parks.</span>
            </div>
          </div>
        ) : <p style={{ color: C.sub }}>Select a tournament to edit.</p>}
      </div>
    </div>
  );
}
