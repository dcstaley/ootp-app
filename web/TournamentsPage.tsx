// Tournament settings (D4) — the single config source. Edits are immediate: creating a
// tournament persists it right away and every change auto-saves (debounced); there is no
// manual Save. Editor covers roster shape, budget (cap/slots), value range, pool sizes,
// platoon split, coverage depth, era/park refs, variants, eligibility, and position
// constraints (absolute mins + rank requirements, with live pool metrics).

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, SLOT_TIER_KEYS, POSITION_RATING_KEYS, FIELD_POS, newTournamentCfg, TOURNAMENT_DEFAULTS, TOURNAMENT_ADJ_DEFAULTS, type TournamentCfg, type TournamentAdjustment, type TournamentTuning, type EligibilityGroup, type EligibilityRule, type RuleOp, type EraCfg, type ParkCfg } from "./shared.ts";

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

// A run-environment factor: green when it boosts (>1), red when it suppresses (<1), grey neutral.
const modColor = (v: number) => (v > 1.001 ? "#86efac" : v < 0.999 ? "#f87171" : C.sub);
// Compact factor strip shown beside an era/park selector. Each group is a label + one or more
// values (e.g. park AVG has separate L/R). All-neutral ⇒ a single "neutral" tag.
function ModStrip({ groups }: { groups: { label: string; values: number[] }[] }) {
  const live = groups.some((g) => g.values.some((v) => Math.abs(v - 1) > 0.001));
  return (
    <div style={{ display: "flex", gap: 11, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
      {!live && <span style={{ color: C.sub, fontStyle: "italic" }}>neutral</span>}
      {live && groups.map((g) => (
        <span key={g.label} style={{ display: "inline-flex", gap: 4, alignItems: "baseline" }}>
          <span style={{ color: C.sub, opacity: 0.7 }}>{g.label}</span>
          {g.values.map((v, i) => (
            <Fragment key={i}>
              {i > 0 && <span style={{ color: C.sub, opacity: 0.45 }}>/</span>}
              <span style={{ color: modColor(v), fontVariantNumeric: "tabular-nums" }}>{v.toFixed(2)}</span>
            </Fragment>
          ))}
        </span>
      ))}
    </div>
  );
}
const eraModGroups = (e?: EraCfg) => e ? [
  { label: "BB", values: [e.bb] }, { label: "K", values: [e.k] }, { label: "AVG", values: [e.avg] },
  { label: "HR", values: [e.hr] }, { label: "GAP", values: [e.gap] },
] : [];
const parkModGroups = (p?: ParkCfg) => p ? [
  { label: "AVG vL", values: [p.avg_l] }, { label: "AVG vR", values: [p.avg_r] },
  { label: "HR vL", values: [p.hr_l] }, { label: "HR vR", values: [p.hr_r] },
  { label: "GAP", values: [p.gap] }, ...(p.triple != null ? [{ label: "3B", values: [p.triple] }] : []),
] : [];

type ExpSplits = { platoonVR: number; r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split_sp: number; l_pitch_split_sp: number; r_pitch_split_rp: number; l_pitch_split_rp: number };
type ExposureInfo = {
  active: boolean; mode?: "realized" | "estimate"; note?: string; n?: number;
  baseline?: { platoonVR: number; r_pitch_split: number; l_pitch_split: number };
  effective?: ExpSplits;
};

export function TournamentsPage() {
  const { tournaments, tournamentId, reloadTournaments, reloadView } = useAppData();
  const [selId, setSelId] = useState(tournamentId);
  const [draft, setDraft] = useState<TournamentCfg | null>(null);
  const [libs, setLibs] = useState<{ eras: Lib[]; parks: Lib[]; columns: string[]; platoonDefaults?: { r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split: number; l_pitch_split: number; teamVR?: number; teamVL?: number; pitchRoleSplits?: { sp: { r: number; l: number }; rp: { r: number; l: number } } } }>({ eras: [], parks: [], columns: [] });
  const [eraMap, setEraMap] = useState<Record<string, EraCfg>>({});
  const [parkMap, setParkMap] = useState<Record<string, ParkCfg>>({});
  const [metrics, setMetrics] = useState<PosMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [exposure, setExposure] = useState<ExposureInfo | null>(null);
  // Raw text of a numeric field mid-edit (keyed by field). While a field holds unparseable
  // text (e.g. cleared for retyping) the DRAFT is left untouched, so the auto-save never
  // persists a transient 0 — the draft only moves on parseable values (W-5).
  const [editRaw, setEditRaw] = useState<Record<string, string>>({});
  const savedRef = useRef<string>(""); // JSON of the last-persisted draft (auto-save baseline)
  const adoptedIdRef = useRef<string | null>(null); // id the server re-slugged us to (skip its reload)

  useEffect(() => { fetch("/api/libraries").then((r) => r.json()).then(setLibs).catch((e) => setMsg({ text: "Libraries failed to load: " + String(e), ok: false })); }, []);
  // Full era/park objects (for the factor strips beside the selectors) — keyed by id.
  useEffect(() => {
    fetch("/api/eras").then((r) => r.json()).then((d) => setEraMap(Object.fromEntries((d.eras ?? []).map((e: EraCfg) => [e.id, e])))).catch((e) => setMsg({ text: "Eras failed to load: " + String(e), ok: false }));
    fetch("/api/parks").then((r) => r.json()).then((d) => setParkMap(Object.fromEntries((d.parks ?? []).map((p: ParkCfg) => [p.id, p])))).catch((e) => setMsg({ text: "Parks failed to load: " + String(e), ok: false }));
  }, []);
  // If the page mounts before the active tournament is known, adopt it once it arrives.
  useEffect(() => { if (!selId && tournamentId) setSelId(tournamentId); }, [tournamentId, selId]);
  // Load the selected tournament; seed the auto-save baseline so a plain load never re-saves.
  // Latest-wins (a slow response for a previously-selected id is dropped). On a FAILED load
  // the editor is cleared/disabled — otherwise the previous draft would linger under the new
  // selection and the 500ms auto-save would write those edits onto the WRONG tournament id.
  useEffect(() => {
    if (!selId) return;
    // We just re-slugged this record ourselves (rename auto-save) — the draft is already
    // current; refetching would clobber in-progress edits. Consume the flag and skip.
    if (adoptedIdRef.current === selId) { adoptedIdRef.current = null; return; }
    let stale = false;
    const fail = (why: string) => {
      if (stale) return;
      setDraft(null); savedRef.current = "";
      setMsg({ text: `Couldn't load tournament: ${why} — editor disabled until a load succeeds.`, ok: false });
    };
    fetch("/api/tournament?id=" + encodeURIComponent(selId)).then((r) => r.json()).then((t) => {
      if (stale) return;
      if (t.error) { fail(String(t.error)); return; }
      setDraft(t); setEditRaw({}); savedRef.current = JSON.stringify(t); setMsg(null);
    }).catch((e) => fail(String(e)));
    return () => { stale = true; };
  }, [selId]);

  const set = <K extends keyof TournamentCfg>(k: K, v: TournamentCfg[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const mode = draft?.budget_mode ?? (draft?.slot_counts && Object.keys(draft.slot_counts).length ? "slots" : (draft?.total_cap ? "cap" : "none"));
  const vR = draft?.platoonVR ?? libs.platoonDefaults?.teamVR ?? 0.62;
  // Per-hand OVR splits — show the active model's defaults until the tournament has its own;
  // the first edit materializes a full platoon object so editing one split keeps the rest.
  // HITTER OVR-blend splits — these (with the pitcher role splits below) weight the
  // Cards-page OVR columns ONLY. The optimizer uses team exposure (above) for hitters.
  const HIT_SPLITS = [
    { k: "r_hit_split", label: "RHB vs RHP" }, { k: "l_hit_split", label: "LHB vs LHP" }, { k: "s_hit_split", label: "SHB vs RHP" },
  ] as const;
  // Role-conditional pitch splits (SP vs RP usage) — the optimizer's deployment-aware
  // pitcher collapse. Defaults come from the model's measured pitchRoleSplits.
  const PITCH_ROLE_SPLITS = [
    { k: "r_pitch_split_sp", label: "RHP vs RHB (SP)" }, { k: "l_pitch_split_sp", label: "LHP vs LHB (SP)" },
    { k: "r_pitch_split_rp", label: "RHP vs RHB (RP)" }, { k: "l_pitch_split_rp", label: "LHP vs LHB (RP)" },
  ] as const;
  // Role-blind r/l_pitch_split are NOT shown: they only weight the grid pitcher OVR
  // column (score-card blend) + are the optimizer's no-role fallback — editing them
  // here would read as a duplicate of the SP/RP rows the optimizer actually uses.
  // They stay in the persisted platoon object (materialized in setSplit) so the grid
  // keeps a weight; the `SplitKey` union retains them for that.
  type SplitKey = (typeof HIT_SPLITS)[number]["k"] | (typeof PITCH_ROLE_SPLITS)[number]["k"] | "r_pitch_split" | "l_pitch_split";
  const roleDefault = (k: SplitKey): number | undefined => {
    const rs = libs.platoonDefaults?.pitchRoleSplits; if (!rs) return undefined;
    return k === "r_pitch_split_sp" ? rs.sp.r : k === "l_pitch_split_sp" ? rs.sp.l
      : k === "r_pitch_split_rp" ? rs.rp.r : k === "l_pitch_split_rp" ? rs.rp.l : undefined;
  };
  const splitDef = (k: SplitKey): number => {
    const own = draft?.platoon?.[k]; if (own != null) return own;
    const rd = roleDefault(k); if (rd != null) return rd;
    const pd = libs.platoonDefaults as Record<string, number> | undefined;
    return (pd && k in pd ? pd[k] : undefined) ?? 0.5;
  };
  const setSplit = (k: SplitKey, x: number) => {
    if (!draft) return;
    const base = draft.platoon ?? {
      r_hit_split: splitDef("r_hit_split"), l_hit_split: splitDef("l_hit_split"), s_hit_split: splitDef("s_hit_split"),
      r_pitch_split: splitDef("r_pitch_split"), l_pitch_split: splitDef("l_pitch_split"),
      r_pitch_split_sp: splitDef("r_pitch_split_sp"), l_pitch_split_sp: splitDef("l_pitch_split_sp"),
      r_pitch_split_rp: splitDef("r_pitch_split_rp"), l_pitch_split_rp: splitDef("l_pitch_split_rp"),
    };
    set("platoon", { ...base, [k]: r3(x) });
  };

  // Auto-save: persist the draft (debounced) whenever it differs from the last-saved snapshot.
  // No-op on a fresh load (baseline matches). Skips while the name is empty.
  useEffect(() => {
    if (!draft) return;
    const snap = JSON.stringify(draft);
    if (snap === savedRef.current) return;
    if (!draft.name.trim()) { setMsg({ text: "Name is required.", ok: false }); return; }
    // Inline validation — block the auto-save with a visible message instead of letting
    // the inconsistency surface later as a solver "Infeasible" on another page.
    const bad = draft.hitters + draft.pitchers !== draft.roster_size
      ? `hitters (${draft.hitters}) + pitchers (${draft.pitchers}) must equal the roster size (${draft.roster_size})`
      : draft.min_starters > draft.pitchers
        ? `rotation size (${draft.min_starters}) can't exceed pitchers (${draft.pitchers})`
        : null;
    if (bad) { setMsg({ text: `Not saved — ${bad}.`, ok: false }); return; }
    setMsg({ text: "Saving…", ok: true });
    const tmo = setTimeout(async () => {
      try {
        const r = await fetch("/api/tournaments/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        const d = await r.json();
        if (!r.ok) { setMsg({ text: d.error || "Save failed.", ok: false }); return; }
        savedRef.current = snap;
        // The server re-slugs the id to track the name (D4). Adopt the new id so later
        // saves target the moved record (not a stale id → duplicate), without letting
        // the selId reload effect refetch over our in-flight draft.
        if (d.id && d.id !== draft.id) {
          const adopted = { ...draft, id: d.id };
          savedRef.current = JSON.stringify(adopted);
          adoptedIdRef.current = d.id;
          setDraft(adopted);
          setSelId(d.id);
        }
        await reloadTournaments();
        if (d.id === tournamentId) await reloadView();
        setMsg({ text: "Saved.", ok: true });
      } catch { setMsg({ text: "Save failed.", ok: false }); }
    }, 500);
    return () => clearTimeout(tmo);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // Platoon-exposure provenance (baseline → deployment → effective) for the selected
  // tournament. Server computes from the SAVED config, so refetch on select + after saves.
  useEffect(() => {
    if (!selId) { setExposure(null); return; }
    let stale = false; // latest-wins: a slow response for a previous select/save is dropped
    fetch("/api/exposure?t=" + encodeURIComponent(selId)).then((r) => r.json())
      .then((d) => { if (!stale) setExposure(d); })
      .catch(() => { if (!stale) setExposure(null); });
    return () => { stale = true; };
  }, [selId, msg?.text]);

  // Pool metrics for the position-constraint editor. Recomputed (debounced) when a
  // pool-defining field changes (era/park/eligibility/value-range/Top-X). POSTs the draft
  // so it reflects unsaved edits.
  const poolSig = draft ? JSON.stringify([draft.id, draft.eraId, draft.parkId, draft.topHitters, draft.card_value_min, draft.card_value_max, draft.eligibility]) : "";
  useEffect(() => {
    if (!draft) { setMetrics(null); return; }
    const ctrl = new AbortController();
    const tmo = setTimeout(() => {
      fetch("/api/position-metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: ctrl.signal })
        .then((r) => r.json()).then((d) => setMetrics(d.metrics ?? null))
        .catch((e) => { if ((e as Error)?.name !== "AbortError") setMsg({ text: "Pool metrics failed: " + String(e), ok: false }); });
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
  // Compact label-over-control field — lets short inputs sit side by side in a grid (fgrid)
  // instead of each consuming a full stacked row.
  const field = (label: string, node: ReactNode, hint?: string): ReactNode => (
    <label style={{ display: "grid", gap: 3, fontSize: 14, alignContent: "start" }}>
      <span style={{ color: C.sub, fontSize: 13 }}>{label}{hint && <span style={{ display: "block", fontSize: 11, color: C.sub, opacity: 0.7 }}>{hint}</span>}</span>
      {node}
    </label>
  );
  // Responsive multi-column wrapper for `field`s — fills the available width, wrapping as needed.
  const fgrid = (children: ReactNode, min = 130): ReactNode => (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: "12px 16px" }}>{children}</div>
  );
  // FIXED 4-column grid — used so the Top-X, hitter-split, and pitcher-split rows line their
  // first three columns up vertically (pitcher splits fill the 4th; the others leave it empty).
  const grid4 = (children: ReactNode): ReactNode => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px 16px" }}>{children}</div>
  );
  // Checkbox + label inline (left-aligned next to its label, not stranded in a wide value column).
  const checkRow = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): ReactNode => (
    <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer", color: C.sub }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>{hint && <span style={{ fontSize: 12, opacity: 0.7 }}>· {hint}</span>}
    </label>
  );
  // `def` autofills the displayed value when the field is unset, so defaulted fields show
  // their effective value instead of a blank box. Mid-edit text that doesn't parse (a
  // cleared field being retyped) is held in editRaw and NOT written to the draft — only
  // parseable values reach the auto-save; blur discards the held text (reverts to the draft).
  const dropRaw = (k: string) => setEditRaw((m) => { if (!(k in m)) return m; const n = { ...m }; delete n[k]; return n; });
  const numIn = (k: keyof TournamentCfg, opts: { min?: number; max?: number; step?: number; nullable?: boolean; width?: number; def?: number } = {}): ReactNode => (
    <input type="number" value={editRaw[k] ?? ((draft?.[k] as number | null | undefined) ?? opts.def ?? "")} min={opts.min} max={opts.max} step={opts.step ?? 1}
      onChange={(e) => {
        const t = e.target.value;
        if (t === "" && opts.nullable) { dropRaw(k); set(k, null as TournamentCfg[typeof k]); return; }
        const n = Number(t);
        if (t === "" || !Number.isFinite(n)) { setEditRaw((m) => ({ ...m, [k]: t })); return; } // hold — no transient 0 into the draft
        dropRaw(k); set(k, n as TournamentCfg[typeof k]);
      }}
      onBlur={() => dropRaw(k)}
      style={{ ...inputStyle, width: opts.width ?? 120 }} />
  );
  const section = (title: string, children: ReactNode, style?: CSSProperties): ReactNode => (
    <div style={{ marginBottom: 20, ...style }}>
      <div style={{ fontSize: 14, color: C.link, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, margin: "0 0 10px" }}>{title}</div>
      {children}
    </div>
  );
  // A section styled as a panel card — used for the small sections that sit side by side.
  const card = (title: string, children: ReactNode): ReactNode =>
    section(title, children, { flex: "1 1 280px", minWidth: 250, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 0 });

  // ── Tournament adjustment (second era-modifier set, multiplied onto era) ──
  const adj: TournamentAdjustment = draft?.tournamentAdjustment ?? TOURNAMENT_ADJ_DEFAULTS;
  const setAdj = (patch: Partial<TournamentAdjustment>) => set("tournamentAdjustment", { ...adj, ...patch });

  // ── E[wins] optimizer steering (cap/slots only) ──
  const tun: TournamentTuning = draft?.tuning ?? {};
  const setTun = (patch: Partial<TournamentTuning>) => set("tuning", { ...tun, ...patch });
  const setDial = (seg: "lineup" | "bench" | "rotation" | "bullpen", v: number) => setTun({ dials: { ...(tun.dials ?? {}), [seg]: v } });
  const lev = tun.bullpenLeverage ?? [2.5, 1.5];
  const setLev = (i: number, v: number) => { const a = [...lev]; a[i] = v; setTun({ bullpenLeverage: a }); };
  // Slider row: value with a live readout; `def` shows the effective default when unset.
  const slider = (label: string, value: number | undefined, def: number, min: number, max: number, step: number, onChange: (v: number) => void, hint?: string): ReactNode => (
    <label style={{ display: "grid", gridTemplateColumns: "150px 1fr 48px", gap: 8, alignItems: "center", fontSize: 13, color: C.sub }}>
      <span>{label}{hint && <span style={{ opacity: 0.6 }}> · {hint}</span>}</span>
      <input type="range" min={min} max={max} step={step} value={value ?? def} onChange={(e) => onChange(Number(e.target.value))} />
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: (value ?? def) === def ? C.sub : C.link }}>{(value ?? def).toFixed(2)}</span>
    </label>
  );
  const ADJ_KEYS: { k: keyof Omit<TournamentAdjustment, "enabled">; label: string }[] = [
    { k: "hr", label: "HR" }, { k: "bb", label: "BB" }, { k: "k", label: "K" }, { k: "h", label: "H" }, { k: "gap", label: "GAP" },
  ];

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
          <div style={{ flex: "1 1 720px", minWidth: 0, maxWidth: 1180 }}>
            {section("Identity & environment", <div style={{ display: "grid", gap: 10 }}>
              {row("Name", <input value={draft.name} onChange={(e) => set("name", e.target.value)} style={{ ...inputStyle, width: 340 }} />)}
              {row("Type", <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {(["tournament", "league"] as const).map((k) => (
                  <label key={k} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                    <input type="radio" name="tkind" checked={(draft.kind ?? "tournament") === k} onChange={() => set("kind", k)} /> {k === "league" ? "League" : "Tournament"}
                  </label>
                ))}
              </div>, "League ⇒ uses the model's learned REAL splits (this IS the training pool); Tournament ⇒ estimates from this pool's baseline + the model's deployment shift")}
              {row("Era", <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <Combo value={draft.eraId} options={libs.eras} onChange={(id) => set("eraId", id)} width={240} placeholder="Search eras…" />
                <ModStrip groups={eraModGroups(eraMap[draft.eraId])} />
              </div>)}
              {row("Park", <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <Combo value={draft.parkId} options={libs.parks} onChange={(id) => set("parkId", id)} width={240} placeholder="Search parks…" />
                <ModStrip groups={parkModGroups(parkMap[draft.parkId])} />
              </div>)}
              {row("Tournament adjustment", <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                {checkRow("On", adj.enabled, (v) => setAdj({ enabled: v }))}
                {ADJ_KEYS.map(({ k, label }) => (
                  <label key={k} style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 13, color: C.sub, opacity: adj.enabled ? 1 : 0.45 }}>
                    {label}
                    <input type="number" step={0.05} min={0} value={adj[k]} disabled={!adj.enabled}
                      onChange={(e) => setAdj({ [k]: e.target.value === "" ? 1 : Number(e.target.value) })}
                      style={{ ...inputStyle, width: 62, padding: "3px 6px", fontSize: 13 }} />
                  </label>
                ))}
              </div>, "Multiplied onto the era factors (era × adjustment). Default HR 1.15, BB 0.85.")}
            </div>)}

            {/* Small sections, side by side to use width */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20, alignItems: "stretch" }}>
              {card("Roster shape", <>
                {fgrid(<>
                  {field("Hitters", numIn("hitters", { min: 0, width: 80 }))}
                  {field("Pitchers", numIn("pitchers", { min: 0, width: 80 }))}
                  {field("Rotation", numIn("min_starters", { min: 0, width: 80 }), "starters")}
                  {field("Min stamina", numIn("min_starter_stamina", { min: 0, width: 80 }), "starter")}
                  {field("Min pitch types", numIn("min_pitch_types", { min: 0, width: 80 }))}
                  {field("Backups / pos", numIn("minPlayersPerPosition", { min: 1, max: 5, width: 80, def: TOURNAMENT_DEFAULTS.minPlayersPerPosition }), "coverage depth")}
                </>, 110)}
                <div style={{ marginTop: 12 }}>{checkRow("DH", draft.dh, (v) => set("dh", v))}</div>
              </>)}

              {card("Budget", <>
                <div style={{ display: "inline-flex", gap: 14, marginBottom: 10 }}>
                  {(["none", "cap", "slots"] as const).map((m) => (
                    <label key={m} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                      <input type="radio" name="bmode" checked={mode === m} onChange={() => set("budget_mode", m)} /> {m === "none" ? "None" : m === "cap" ? "Cap" : "Slots"}
                    </label>
                  ))}
                </div>
                {mode === "cap" && <div style={{ marginBottom: 10 }}>{field("Total cap", numIn("total_cap", { min: 0, nullable: true, width: 150 }))}</div>}
                {mode === "slots" && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
                  {SLOT_TIER_KEYS.map((key) => (
                    <label key={key} style={{ fontSize: 12, color: C.sub, display: "grid", gap: 2 }}>{key}
                      <input type="number" min={0} value={draft.slot_counts?.[key] ?? ""} onChange={(e) => set("slot_counts", { ...(draft.slot_counts ?? {}), [key]: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} />
                    </label>
                  ))}
                </div>}
                {fgrid(<>
                  {field("Card value min", numIn("card_value_min", { min: 0, nullable: true, width: 90 }), "blank = no floor")}
                  {field("Card value max", numIn("card_value_max", { min: 0, nullable: true, width: 90 }), "blank = no ceiling")}
                </>, 120)}
              </>)}

              {card("Variants", <>
                <div style={{ marginBottom: 12 }}>{checkRow("Variants allowed", draft.variants_allowed, (v) => set("variants_allowed", v))}</div>
                {field("Max variants on roster", numIn("max_variants_on_roster", { min: 0, width: 90 }), "0 = unlimited")}
              </>)}
            </div>

            {section("Pool & weighting", <>
              {exposure?.active && exposure.effective && (() => {
                const e = exposure.effective!, est = exposure.mode === "estimate";
                const items: { label: string; eff: number; base?: number }[] = [
                  { label: "vs RHP (team)", eff: e.platoonVR, base: est ? exposure.baseline?.platoonVR : undefined },
                  { label: "RHB vs RHP", eff: e.r_hit_split }, { label: "LHB vs LHP", eff: e.l_hit_split }, { label: "SHB vs RHP", eff: e.s_hit_split },
                  { label: "RHP→RHB · SP", eff: e.r_pitch_split_sp, base: est ? exposure.baseline?.r_pitch_split : undefined },
                  { label: "LHP→LHB · SP", eff: e.l_pitch_split_sp, base: est ? exposure.baseline?.l_pitch_split : undefined },
                  { label: "RHP→RHB · RP", eff: e.r_pitch_split_rp }, { label: "LHP→LHB · RP", eff: e.l_pitch_split_rp },
                ];
                return (
                  <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
                    <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 8 }}>
                      <b style={{ color: C.text }}>Exposure the optimizer uses</b> — {exposure.mode === "realized"
                        ? "League pool → the model's learned REAL splits, verbatim."
                        : `Tournament pool → this pool's baseline + the model's deployment shift (top-${exposure.n ?? 100}). Shown as baseline → effective.`}
                    </div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      {items.map((it) => (
                        <div key={it.label} style={{ display: "grid", gap: 1 }}>
                          <span style={{ color: C.sub, fontSize: 11 }}>{it.label}</span>
                          <span style={{ color: C.text, fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                            {it.base != null && <span style={{ color: C.sub }}>{r3(it.base)} → </span>}<b>{r3(it.eff)}</b>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {grid4(<>
                {field("Top-X hitters", numIn("topHitters", { min: 0, nullable: true, width: 90, def: TOURNAMENT_DEFAULTS.topHitters }), "each side · two-way cutoff / non-cap pool")}
                {field("Top-X pitchers", numIn("topPitchers", { min: 0, nullable: true, width: 90, def: TOURNAMENT_DEFAULTS.topPitchers }), "by OVR")}
              </>)}
              <div style={{ marginTop: 16, ...(exposure?.active ? { opacity: 0.5 } : {}) }}>
                <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>
                  {exposure?.active
                    ? "Manual platoon splits — FALLBACK ONLY. The computed exposure above is in use (active model); these apply only when no model is active."
                    : "Platoon splits — team exposure + per-hand OVR blends:"}
                </div>
                {grid4(<>
                  {field("RHP exposure (vR)", <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
                    <input type="number" min={0} max={1} step={0.001} value={r3(vR)} onChange={(e) => { const x = Math.max(0, Math.min(1, Number(e.target.value))); set("platoonVR", r3(x)); set("platoonVL", r3(1 - x)); }} style={{ ...inputStyle, width: 90 }} />
                    <span style={{ fontSize: 13, color: C.sub }}>vL = {r3(1 - vR)}</span>
                  </span>, "team exposure")}
                </>)}
                <div style={{ fontSize: 12, color: C.sub, margin: "14px 0 6px" }}>Hitter OVR splits — weight on the same-letter side:</div>
                {grid4(HIT_SPLITS.map((s) => (
                  <Fragment key={s.k}>{field(s.label, <input type="number" min={0} max={1} step={0.001} value={r3(splitDef(s.k))} onChange={(e) => setSplit(s.k, Math.max(0, Math.min(1, Number(e.target.value))))} style={{ ...inputStyle, width: 90 }} />)}</Fragment>
                )))}
                <div style={{ fontSize: 12, color: C.sub, margin: "14px 0 6px" }}>Pitcher splits — same-side weight by SP vs RP usage:</div>
                {grid4(PITCH_ROLE_SPLITS.map((s) => (
                  <Fragment key={s.k}>{field(s.label, <input type="number" min={0} max={1} step={0.001} value={r3(splitDef(s.k))} onChange={(e) => setSplit(s.k, Math.max(0, Math.min(1, Number(e.target.value))))} style={{ ...inputStyle, width: 90 }} />)}</Fragment>
                )))}
              </div>
            </>)}

            {mode !== "none" && section("E[wins] optimizer", <>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>Cap/slots only — the roster is built to maximize expected win%. Greyed values are the (sensible) defaults; adjust to steer. Dials nudge a segment's spend relative to the optimizer's own choice (1.00 = leave alone).</div>
              <div style={{ marginBottom: 14 }}>{field("Series format", (
                <select value={draft.bestOf ?? 7} onChange={(e) => set("bestOf", Number(e.target.value))} style={{ ...inputStyle, width: 130 }}>
                  {[3, 5, 7, 9].map((n) => <option key={n} value={n}>Best of {n}</option>)}
                </select>
              ), "round length → starter usage")}</div>
              <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
                <div style={{ fontSize: 13, color: C.link, fontWeight: 600 }}>Spend dials</div>
                {slider("Lineup", tun.dials?.lineup, 1, 0.5, 1.5, 0.05, (v) => setDial("lineup", v))}
                {slider("Bench", tun.dials?.bench, 1, 0.5, 1.5, 0.05, (v) => setDial("bench", v))}
                {slider("Rotation", tun.dials?.rotation, 1, 0.5, 1.5, 0.05, (v) => setDial("rotation", v))}
                {slider("Bullpen", tun.dials?.bullpen, 1, 0.5, 1.5, 0.05, (v) => setDial("bullpen", v))}
                <div style={{ fontSize: 13, color: C.link, fontWeight: 600, marginTop: 8 }}>Usage knobs</div>
                {slider("Rotation share", tun.rotationShare, 0.62, 0.4, 0.8, 0.01, (v) => setTun({ rotationShare: v }), "vs bullpen innings")}
                {slider("SP5 decay", tun.rotationDecay, 0, 0, 0.6, 0.05, (v) => setTun({ rotationDecay: v }), "tilt toward SP1")}
                {slider("Platoon capture", tun.platoonCapture, 0.8, 0.5, 1, 0.05, (v) => setTun({ platoonCapture: v }), "favorable-matchup rate")}
                {slider("Bench usage", tun.fullStrengthShare, 0.6, 0.3, 1, 0.05, (v) => setTun({ fullStrengthShare: v }), "full-strength share")}
                {slider("Closer premium", lev[0], 2.5, 1, 4, 0.1, (v) => setLev(0, v), "top reliever leverage")}
                {slider("Setup premium", lev[1], 1.5, 1, 3, 0.1, (v) => setLev(1, v))}
              </div>
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
                    {FIELD_POS.map((pos, pIdx) => {
                      const ratings = POSITION_RATING_KEYS[pos]!;
                      // Strongly alternating block fill so each position reads as its own band.
                      const blockBg = pIdx % 2 === 1 ? "#2c333e" : "#1b2027";
                      return ratings.map((rt, i) => {
                        const m = metrics?.[pos]?.[rt.key];
                        return (
                          <tr key={pos + rt.key} style={{ background: blockBg, borderTop: i === 0 ? `2px solid ${C.border}` : "none" }}>
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
