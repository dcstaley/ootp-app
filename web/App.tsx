import { useEffect, useMemo, useRef, useState } from "react";

interface Card {
  id: string; variant: string; title: string; first: string; last: string;
  bats: number; throws: number; value: number; owned: number;
  learn: Record<string, number>; eligible: boolean;
  stamina: number; pitches: number;
  hitVL: number; hitVR: number; hitOVR: number; basicHit: number; basicHitVL: number; basicHitVR: number;
  pitchVL: number; pitchVR: number; pitchOVR: number; basicPitch: number; basicPitchVL: number; basicPitchVR: number;
  def: Record<string, number>;
}
interface Meta { configName: string; tournament: string; account: string; accountId: string | null; catalogSource: string; cardCount: number; eligibleCount: number; ownedCount: number }
interface TournamentOpt { id: string; name: string }
interface AccountOpt { id: string; name: string; ownedCount: number; totalQty: number; variantCount: number }

const BATS: Record<number, string> = { 1: "R", 2: "L", 3: "S" };
const THROWS: Record<number, string> = { 1: "R", 2: "L" };

type Align = "l" | "r" | "c";
type Fmt = "woba" | "basic" | "int";
interface Col { key: string; label: string; align: Align; get: (c: Card) => string | number; sort?: (c: Card) => string | number; fmt?: Fmt }

const def = (k: string) => (c: Card) => c.def?.[k] ?? 0;
const COLS: Record<string, Col> = {
  id: { key: "id", label: "Card ID", align: "l", get: (c) => c.id },
  variant: { key: "variant", label: "Var", align: "c", get: (c) => c.variant },
  title: { key: "title", label: "Card", align: "l", get: (c) => c.title, sort: (c) => `${c.last} ${c.first}`.toLowerCase() },
  bats: { key: "bats", label: "B", align: "c", get: (c) => BATS[c.bats] ?? "", sort: (c) => c.bats },
  throws: { key: "throws", label: "T", align: "c", get: (c) => THROWS[c.throws] ?? "", sort: (c) => c.throws },
  value: { key: "value", label: "Val", align: "r", get: (c) => c.value, fmt: "int" },
  owned: { key: "owned", label: "Own", align: "r", get: (c) => c.owned, fmt: "int" },
  hitOVR: { key: "hitOVR", label: "Hit wOBA", align: "r", get: (c) => c.hitOVR, fmt: "woba" },
  hitVL: { key: "hitVL", label: "Hit vL", align: "r", get: (c) => c.hitVL, fmt: "woba" },
  hitVR: { key: "hitVR", label: "Hit vR", align: "r", get: (c) => c.hitVR, fmt: "woba" },
  basicHit: { key: "basicHit", label: "Basic Hit", align: "r", get: (c) => c.basicHit, fmt: "basic" },
  basicHitVL: { key: "basicHitVL", label: "Basic Hit vL", align: "r", get: (c) => c.basicHitVL, fmt: "basic" },
  basicHitVR: { key: "basicHitVR", label: "Basic Hit vR", align: "r", get: (c) => c.basicHitVR, fmt: "basic" },
  pitchOVR: { key: "pitchOVR", label: "Pitch wOBA", align: "r", get: (c) => c.pitchOVR, fmt: "woba" },
  pitchVL: { key: "pitchVL", label: "Pitch vL", align: "r", get: (c) => c.pitchVL, fmt: "woba" },
  pitchVR: { key: "pitchVR", label: "Pitch vR", align: "r", get: (c) => c.pitchVR, fmt: "woba" },
  basicPitch: { key: "basicPitch", label: "Basic Pitch", align: "r", get: (c) => c.basicPitch, fmt: "basic" },
  basicPitchVL: { key: "basicPitchVL", label: "Basic Pitch vL", align: "r", get: (c) => c.basicPitchVL, fmt: "basic" },
  basicPitchVR: { key: "basicPitchVR", label: "Basic Pitch vR", align: "r", get: (c) => c.basicPitchVR, fmt: "basic" },
  stamina: { key: "stamina", label: "Stam", align: "r", get: (c) => c.stamina, fmt: "int" },
  pitches: { key: "pitches", label: "# Pit", align: "r", get: (c) => c.pitches, fmt: "int" },
  ifR: { key: "ifR", label: "IF Rng", align: "r", get: def("Infield Range"), fmt: "int" },
  ifE: { key: "ifE", label: "IF Err", align: "r", get: def("Infield Error"), fmt: "int" },
  ifA: { key: "ifA", label: "IF Arm", align: "r", get: def("Infield Arm"), fmt: "int" },
  dp: { key: "dp", label: "DP", align: "r", get: def("DP"), fmt: "int" },
  cAb: { key: "cAb", label: "C Abil", align: "r", get: def("CatcherAbil"), fmt: "int" },
  cFr: { key: "cFr", label: "C Frm", align: "r", get: def("CatcherFrame"), fmt: "int" },
  cAr: { key: "cAr", label: "C Arm", align: "r", get: def("Catcher Arm"), fmt: "int" },
  ofR: { key: "ofR", label: "OF Rng", align: "r", get: def("OF Range"), fmt: "int" },
  ofE: { key: "ofE", label: "OF Err", align: "r", get: def("OF Error"), fmt: "int" },
  ofA: { key: "ofA", label: "OF Arm", align: "r", get: def("OF Arm"), fmt: "int" },
};

const POSNS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const FIELD_POS = POSNS.map((p) => "pos" + p);
for (const p of POSNS) {
  COLS["pos" + p] = { key: "pos" + p, label: p, align: "c", get: (c) => c.learn?.[p] ?? 0, sort: (c) => c.learn?.[p] ?? 0, fmt: "int" };
}

const DEF = ["ifR", "ifE", "ifA", "dp", "cAb", "cFr", "cAr", "ofR", "ofE", "ofA"];
const PRESETS: Record<string, { cols: string[]; sort: string; dir: 1 | -1 }> = {
  Hitting: { cols: ["title", "variant", "bats", "value", "owned", "hitOVR", "hitVL", "hitVR", "basicHit", "basicHitVL", "basicHitVR", ...FIELD_POS, ...DEF], sort: "hitOVR", dir: -1 },
  Pitching: { cols: ["title", "variant", "throws", "value", "owned", "pitchOVR", "pitchVL", "pitchVR", "basicPitch", "basicPitchVL", "basicPitchVR", "stamina", "pitches"], sort: "pitchOVR", dir: 1 },
};

const isNumeric = (col: Col) => !!col.fmt;
const sortVal = (col: Col, c: Card) => (col.sort ? col.sort(c) : col.get(c));
const fmtVal = (col: Col, c: Card): string => {
  const v = col.get(c);
  if (col.fmt === "woba") return Number.isFinite(v as number) ? (v as number).toFixed(4) : "";
  if (col.fmt === "basic") return Number.isFinite(v as number) ? (v as number).toFixed(1) : "";
  return String(v ?? "");
};
const haystack = (c: Card) => `${c.title} ${c.first} ${c.last} ${c.id}`.toLowerCase();

function defaultWidth(col: Col): number {
  if (col.key === "title") return 300;
  if (col.key.startsWith("pos")) return 40;
  if (col.key === "variant") return 50;
  if (col.key === "bats" || col.key === "throws") return 40;
  if (col.fmt === "woba") return 92;
  if (col.fmt === "basic") return 100;
  return 64;
}

// ── per-column filter (Sheets-style: condition + values) ─────────────────────
type Op = "" | "empty" | "nempty" | "contains" | "ncontains" | "starts" | "ends" | "exact"
  | "gt" | "ge" | "lt" | "le" | "eq" | "ne" | "between" | "nbetween";
interface ColFilter { op: Op; v1: string; v2: string; values: string[] | null } // values null = all
const emptyFilter = (): ColFilter => ({ op: "", v1: "", v2: "", values: null });
const filterActive = (f?: ColFilter) => !!f && (!!f.op || f.values !== null);
const TXT_CONDS: [Op, string][] = [["contains", "Text contains"], ["ncontains", "Text does not contain"], ["starts", "Text starts with"], ["ends", "Text ends with"], ["exact", "Text is exactly"]];
const NUM_CONDS: [Op, string][] = [["gt", "Greater than"], ["ge", "Greater than or equal to"], ["lt", "Less than"], ["le", "Less than or equal to"], ["eq", "Is equal to"], ["ne", "Is not equal to"], ["between", "Is between"], ["nbetween", "Is not between"]];
const needsV1 = (op: Op) => !["", "empty", "nempty"].includes(op);
const needsV2 = (op: Op) => op === "between" || op === "nbetween";

function passesCond(col: Col, c: Card, f: ColFilter): boolean {
  if (!f.op) return true;
  const disp = fmtVal(col, c);
  if (f.op === "empty") return disp.trim() === "";
  if (f.op === "nempty") return disp.trim() !== "";
  if (!isNumeric(col)) {
    const s = disp.toLowerCase(), q = f.v1.toLowerCase();
    switch (f.op) {
      case "contains": return s.includes(q); case "ncontains": return !s.includes(q);
      case "starts": return s.startsWith(q); case "ends": return s.endsWith(q);
      case "exact": return s === q; default: return true;
    }
  }
  const raw = Number(col.get(c)), x = parseFloat(f.v1), y = parseFloat(f.v2);
  const inRange = raw >= Math.min(x, y) && raw <= Math.max(x, y);
  switch (f.op) {
    case "gt": return raw > x; case "ge": return raw >= x; case "lt": return raw < x; case "le": return raw <= x;
    case "eq": return raw === x; case "ne": return raw !== x;
    case "between": return inRange; case "nbetween": return !inRange; default: return true;
  }
}
const passesFilter = (col: Col, c: Card, f: ColFilter) =>
  (f.values === null || f.values.includes(fmtVal(col, c))) && passesCond(col, c, f);

const C = {
  bg: "#1e2228", text: "#d7dbe0", sub: "#9aa3ad", border: "#3a414b",
  head: "#2a2f37", headActive: "#3b4657", stripe: "#23282f", row: "#1e2228",
  input: "#2a2f37", hot: "#4a4326", accent: "#2563eb", star: "#b06bf0", panel: "#2a2f37", link: "#7aa2f7",
};

function Funnel({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ display: "block" }}>
      <path d="M1.5 2.5h13l-5 6v4.2l-3 1.6V8.5z" fill={active ? "#facc15" : C.sub} stroke={active ? "#facc15" : C.sub} strokeWidth="0.5" strokeLinejoin="round" />
    </svg>
  );
}

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tournaments, setTournaments] = useState<TournamentOpt[]>([]);
  const [tournamentId, setTournamentId] = useState<string>("");
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const variantFileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null); // account id to import into; null = new account
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [variantQuery, setVariantQuery] = useState("");
  const [variantInfo, setVariantInfo] = useState<string | null>(null);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("Hitting");
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState("");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [sortKey, setSortKey] = useState("hitOVR");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [colF, setColF] = useState<Record<string, ColFilter>>({});
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [openF, setOpenF] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [valSearch, setValSearch] = useState("");

  // Load tournament + account lists once, then default-select; card/meta react.
  const loadAccounts = () =>
    fetch("/api/accounts").then((r) => r.json()).then((d: { accounts: AccountOpt[]; activeId: string | null }) => {
      setAccounts(d.accounts);
      setAccountId((cur) => cur || d.activeId || d.accounts[0]?.id || "");
      return d;
    });
  useEffect(() => {
    fetch("/api/tournaments").then((r) => r.json())
      .then((d: { tournaments: TournamentOpt[]; defaultId: string }) => {
        setTournaments(d.tournaments);
        setTournamentId(d.defaultId || d.tournaments[0]?.id || "");
      }).catch((e) => setErr(String(e)));
    loadAccounts().catch((e) => setErr(String(e)));
  }, []);

  // (Re)load for the selected tournament + account. Tournament drives scoring
  // (server resolves era/park/softcaps + re-calibrates); account scopes owned +
  // variants. The grid just reads the result.
  useEffect(() => {
    if (!tournamentId) return;
    const q = `?tournament=${encodeURIComponent(tournamentId)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`;
    setLoading(true);
    Promise.all([fetch("/api/meta" + q).then((r) => r.json()), fetch("/api/cards" + q).then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); }).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  }, [tournamentId, accountId]);

  // Re-fetch meta + cards for the current tournament/account (after a mutation
  // that doesn't change those selections, e.g. a variant or catalog change).
  const reloadView = () => {
    if (!tournamentId) return Promise.resolve();
    const q = `?tournament=${encodeURIComponent(tournamentId)}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`;
    return Promise.all([fetch("/api/meta" + q).then((r) => r.json()), fetch("/api/cards" + q).then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); });
  };

  // Persist the active selections (so a reload restores them).
  const persist = (patch: Record<string, string>) =>
    fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => {});
  const chooseTournament = (id: string) => { setTournamentId(id); persist({ activeTournamentId: id }); };
  const chooseAccount = (id: string) => { setAccountId(id); persist({ activeAccountId: id }); };

  const renameAccount = async () => {
    const acc = accounts.find((a) => a.id === accountId);
    const name = window.prompt("Rename account", acc?.name ?? "");
    if (!name || !name.trim()) return;
    setBusy("rename");
    await fetch("/api/accounts/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: accountId, name: name.trim() }) });
    await loadAccounts();
    setBusy(null);
  };

  // Upload a pt_card_list CSV: updates the target account's ownership AND refreshes
  // the shared catalog (newest full list wins). uploadTarget=null → new account.
  const pickUpload = (target: string | null) => { uploadTarget.current = target; fileRef.current?.click(); };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let id = uploadTarget.current;
    let name = "";
    if (!id) {
      name = window.prompt("New account name", file.name.replace(/^pt_card_list/i, "").replace(/\.csv$/i, "").trim() || "Account") || "";
      if (!name.trim()) return;
    }
    setBusy("upload");
    const text = await file.text();
    const qs = id ? `?id=${encodeURIComponent(id)}` : `?name=${encodeURIComponent(name.trim())}`;
    const r = await fetch("/api/accounts/import" + qs, { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
    const d = await r.json().catch(() => null);
    if (!r.ok) { setErr(d?.error || "import failed"); setBusy(null); return; }
    await loadAccounts();
    if (!id && d?.accounts?.length) chooseAccount(d.accounts[d.accounts.length - 1].id); // effect reloads
    else await reloadView(); // catalog changed → refresh current view
    setBusy(null);
  };

  // ── Variants (per account; writes overlay.variantCardIds) ───────────────────
  const toggleVariant = async (cid: string, on: boolean) => {
    if (!accountId) return;
    setBusy("variant");
    await fetch("/api/accounts/variants/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: accountId, cardId: cid, on }) });
    await loadAccounts();
    await reloadView();
    setBusy(null);
  };
  const onVariantFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !accountId) return;
    setBusy("variant");
    const text = await file.text();
    const r = await fetch("/api/accounts/variants/import?id=" + encodeURIComponent(accountId), { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
    const d = await r.json().catch(() => null);
    if (!r.ok) { setErr(d?.error || "variant import failed"); setBusy(null); return; }
    setVariantInfo(`Imported ${d.matched} variant${d.matched === 1 ? "" : "s"} (${d.unmatched} unmatched) from "${d.column}" column.`);
    await loadAccounts();
    await reloadView();
    setBusy(null);
  };

  const choosePreset = (name: keyof typeof PRESETS) => { setPreset(name); setSortKey(PRESETS[name].sort); setSortDir(PRESETS[name].dir); };
  const cols = PRESETS[preset].cols.map((k) => COLS[k]!);
  const sortCol = COLS[sortKey] ?? COLS.title!;
  const w = (k: string) => widths[k] ?? defaultWidth(COLS[k]!);
  const getF = (k: string) => colF[k] ?? emptyFilter();
  const setF = (k: string, patch: Partial<ColFilter>) => setColF((m) => ({ ...m, [k]: { ...getF(k), ...patch } }));

  // distinct display values per visible column (for the value checklist), capped.
  const distinct = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of cols) {
      const set = new Set<string>();
      let over = false;
      for (const c of cards) { set.add(fmtVal(col, c)); if (set.size > 200) { over = true; break; } }
      out[col.key] = over ? [] : [...set].sort((a, b) => (isNumeric(col) ? Number(a) - Number(b) : a.localeCompare(b)));
    }
    return out;
  }, [cards, cols]);

  const rows = useMemo(() => {
    const fq = filter.trim().toLowerCase();
    let r = cards;
    if (fq) r = r.filter((c) => haystack(c).includes(fq));
    if (ownedOnly) r = r.filter((c) => c.owned > 0);
    if (eligibleOnly) r = r.filter((c) => c.eligible);
    const active = cols.filter((col) => filterActive(colF[col.key]));
    if (active.length) r = r.filter((c) => active.every((col) => passesFilter(col, c, colF[col.key]!)));
    return [...r].sort((a, b) => {
      const av = sortVal(sortCol, a), bv = sortVal(sortCol, b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }, [cards, filter, ownedOnly, eligibleOnly, sortCol, sortDir, cols, colF]);

  const hq = highlight.trim().toLowerCase();
  const sortBy = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(COLS[key]?.fmt ? -1 : 1); }
  };
  const startResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = w(key);
    const move = (ev: MouseEvent) => setWidths((m) => ({ ...m, [key]: Math.max(28, startW + (ev.clientX - startX)) }));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const openFilter = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: Math.min(r.left - 20, window.innerWidth - 290), y: r.bottom + 4 });
    setValSearch(""); setOpenF(key);
  };

  const inputStyle: React.CSSProperties = { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "6px 8px", fontSize: 13 };
  const ta = (a: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");

  // Filter popover state for the open column
  const fcol = openF ? COLS[openF]! : null;
  const ff = openF ? getF(openF) : emptyFilter();
  const condList = fcol && isNumeric(fcol) ? NUM_CONDS : TXT_CONDS;
  const allVals = fcol ? (distinct[fcol.key] ?? []) : [];
  const shownVals = allVals.filter((v) => v.toLowerCase().includes(valSearch.toLowerCase()));
  const isChecked = (v: string) => ff.values === null || ff.values.includes(v);
  const toggleVal = (v: string, on: boolean) => {
    if (!fcol) return;
    const base = ff.values === null ? new Set(allVals) : new Set(ff.values);
    if (on) base.add(v); else base.delete(v);
    setF(fcol.key, { values: base.size === allVals.length ? null : [...base] });
  };
  const link = { color: C.link, cursor: "pointer", fontSize: 12 } as React.CSSProperties;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, color: C.text, background: C.bg, minHeight: "100vh" }}>
      <h2 style={{ margin: "0 0 4px" }}>OOTP Optimizer — Data Grid</h2>
      {err && <p style={{ color: "#f87171" }}>Failed to load: {err} — is the server running?</p>}

      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13, color: C.sub }} htmlFor="tournament">Tournament</label>
          <select id="tournament" value={tournamentId} onChange={(e) => chooseTournament(e.target.value)}
            disabled={!tournaments.length} style={{ ...inputStyle, minWidth: 220, cursor: "pointer" }}>
            {tournaments.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13, color: C.sub }} htmlFor="account">Account</label>
          <select id="account" value={accountId} onChange={(e) => chooseAccount(e.target.value)}
            disabled={!accounts.length} style={{ ...inputStyle, minWidth: 150, cursor: "pointer" }}>
            {!accounts.length && <option value="">(no accounts)</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button onClick={renameAccount} disabled={!accountId || !!busy} title="Rename this account" style={{ ...inputStyle, cursor: "pointer" }}>Rename</button>
          <button onClick={() => pickUpload(accountId || null)} disabled={!accountId || !!busy} title="Replace this account's OWNERSHIP from a pt_card_list export (also refreshes the shared card list with any new cards)" style={{ ...inputStyle, cursor: "pointer" }}>Import ownership…</button>
          <button onClick={() => { setVariantInfo(null); setVariantQuery(""); setVariantsOpen(true); }} disabled={!accountId || !!busy} title="Add/remove this account's v5 variants (search or import a variant export)" style={{ ...inputStyle, cursor: "pointer" }}>
            Variants ({accounts.find((a) => a.id === accountId)?.variantCount ?? 0})…
          </button>
          <button onClick={() => pickUpload(null)} disabled={!!busy} title="Create a NEW account from a pt_card_list ownership export" style={{ ...inputStyle, cursor: "pointer" }}>+ New account</button>
        </span>
        {(loading || busy) && <span style={{ fontSize: 12, color: C.sub }}>{busy === "upload" ? "importing…" : busy === "rename" ? "saving…" : busy === "variant" ? "updating variants…" : "scoring…"}</span>}
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        <input ref={variantFileRef} type="file" accept=".csv,text/csv" onChange={onVariantFile} style={{ display: "none" }} />
      </div>

      {meta && (
        <p style={{ margin: "0 0 12px", color: C.sub, fontSize: 13 }}>
          Tournament: <b style={{ color: C.text }}>{meta.tournament}</b> · Account: <b style={{ color: C.text }}>{meta.account}</b>
          {" "}({meta.ownedCount} owned) · Config: <b style={{ color: C.text }}>{meta.configName}</b> · {meta.cardCount} cards
          ({meta.eligibleCount} eligible) · Catalog: {meta.catalogSource}. Pitch wOBA: lower = better.
        </p>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
          <button key={p} onClick={() => choosePreset(p)} style={{ ...inputStyle, cursor: "pointer", background: preset === p ? C.accent : C.input, color: "#fff", fontWeight: preset === p ? 600 : 400 }}>{p}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input placeholder="Search: hide non-matches…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...inputStyle, width: 230 }} />
        <input placeholder="Highlight (keep all)…" value={highlight} onChange={(e) => setHighlight(e.target.value)} style={{ ...inputStyle, width: 200 }} />
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} /> Eligible only</label>
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} /> Owned only</label>
        {Object.values(colF).some(filterActive) && <button onClick={() => setColF({})} style={{ ...inputStyle, cursor: "pointer" }}>Clear all filters</button>}
        <span style={{ color: C.sub, fontSize: 13 }}>{rows.length} shown · ⏷ funnel = filter · drag edges to resize</span>
      </div>

      <div style={{ overflow: "auto", border: `1px solid ${C.border}`, maxHeight: "74vh" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", width: "max-content" }}>
          <colgroup>{cols.map((c) => <col key={c.key} style={{ width: w(c.key) }} />)}</colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} onClick={() => sortBy(c.key)}
                  style={{ textAlign: ta(c.align), padding: "7px 24px 7px 8px", borderBottom: `2px solid ${C.border}`, cursor: "pointer",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", position: "sticky", top: 0,
                    background: sortKey === c.key ? C.headActive : C.head, userSelect: "none" }}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  <span onClick={(e) => openFilter(c.key, e)} title="Filter"
                    style={{ position: "absolute", right: 7, top: 0, height: "100%", display: "flex", alignItems: "center", padding: "0 3px", cursor: "pointer",
                      background: filterActive(colF[c.key]) ? "rgba(250,204,21,.12)" : "transparent", borderRadius: 3 }}>
                    <Funnel active={filterActive(colF[c.key])} />
                  </span>
                  <span onMouseDown={(e) => startResize(c.key, e)} onClick={(e) => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: 0, height: "100%", width: 5, cursor: "col-resize" }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 1000).map((c, i) => {
              const hot = hq && haystack(c).includes(hq);
              return (
                <tr key={c.id + ":" + c.variant + ":" + i} style={{ background: hot ? C.hot : i % 2 ? C.stripe : C.row }}>
                  {cols.map((col) => (
                    <td key={col.key} title={col.key === "title" ? c.title : undefined}
                      style={{ textAlign: ta(col.align), padding: "4px 8px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {col.key === "title" && c.title.startsWith("★")
                        ? <><span style={{ color: C.star }}>★</span>{c.title.slice(1)}</>
                        : fmtVal(col, c)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 1000 && <p style={{ color: C.sub, fontSize: 12 }}>Showing first 1000 of {rows.length}.</p>}

      {variantsOpen && (() => {
        const acc = accounts.find((a) => a.id === accountId);
        const variantRows = cards.filter((c) => c.variant === "Y");
        const variantIds = new Set(variantRows.map((r) => r.id));
        const q = variantQuery.trim().toLowerCase();
        const candidates = q
          ? cards.filter((c) => c.variant !== "Y" && !variantIds.has(c.id) && haystack(c).includes(q)).slice(0, 12)
          : [];
        return (
          <>
            <div onClick={() => setVariantsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.4)" }} />
            <div style={{ position: "fixed", left: "50%", top: "8vh", transform: "translateX(-50%)", zIndex: 100, width: 520, maxHeight: "82vh", overflow: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, boxShadow: "0 10px 40px rgba(0,0,0,.6)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <b style={{ fontSize: 15 }}>Variants — {acc?.name ?? "(account)"} ({variantRows.length})</b>
                <span onClick={() => setVariantsOpen(false)} style={{ cursor: "pointer", color: C.sub, fontSize: 16 }}>✕</span>
              </div>
              <p style={{ margin: "0 0 12px", fontSize: 12, color: C.sub }}>v5 boost is computed in-app. Import a game variant export (replaces the list) or add/remove individually.</p>

              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <button onClick={() => variantFileRef.current?.click()} disabled={!!busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>Import variant CSV…</button>
                {variantRows.length > 0 && <button onClick={async () => { if (window.confirm(`Remove all ${variantRows.length} variants from ${acc?.name}?`)) { setBusy("variant"); await fetch("/api/accounts/variants/import?id=" + encodeURIComponent(accountId), { method: "POST", headers: { "Content-Type": "text/csv" }, body: "CID\n" }); await loadAccounts(); await reloadView(); setBusy(null); } }} disabled={!!busy} style={{ ...inputStyle, cursor: "pointer" }}>Clear all</button>}
                {variantInfo && <span style={{ fontSize: 12, color: C.sub }}>{variantInfo}</span>}
              </div>

              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>Add a variant — search cards</div>
              <input value={variantQuery} onChange={(e) => setVariantQuery(e.target.value)} placeholder="Search by player or card name…" style={{ ...inputStyle, width: "100%", marginBottom: 6 }} />
              {q && (
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 14, maxHeight: 200, overflow: "auto" }}>
                  {candidates.length === 0 ? <div style={{ padding: 8, fontSize: 13, color: C.sub }}>No matches (already-variant cards are hidden).</div>
                    : candidates.map((c) => (
                      <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title} <span style={{ color: C.sub }}>#{c.id}</span></span>
                        <button onClick={() => toggleVariant(c.id, true)} disabled={!!busy} style={{ ...inputStyle, cursor: "pointer", padding: "3px 8px" }}>+ Add</button>
                      </div>
                    ))}
                </div>
              )}

              <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>Current variants ({variantRows.length})</div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, maxHeight: 280, overflow: "auto" }}>
                {variantRows.length === 0 ? <div style={{ padding: 8, fontSize: 13, color: C.sub }}>None yet.</div>
                  : [...variantRows].sort((a, b) => a.title.localeCompare(b.title)).map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: C.star }}>★</span>{c.title.replace(/^★\s*/, "").replace(/\s*v5$/, "")} <span style={{ color: C.sub }}>#{c.id}</span>
                      </span>
                      <button onClick={() => toggleVariant(c.id, false)} disabled={!!busy} style={{ ...inputStyle, cursor: "pointer", padding: "3px 8px" }}>Remove</button>
                    </div>
                  ))}
              </div>
            </div>
          </>
        );
      })()}

      {fcol && (
        <>
          <div onClick={() => setOpenF(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
          <div style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 100, width: 270, maxHeight: "70vh", overflow: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, boxShadow: "0 10px 30px rgba(0,0,0,.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <b>Filter · {fcol.label}</b>
              <span onClick={() => setOpenF(null)} style={{ cursor: "pointer", color: C.sub }}>✕</span>
            </div>

            <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>Filter by condition</div>
            <select value={ff.op} onChange={(e) => setF(fcol.key, { op: e.target.value as Op })} style={{ ...inputStyle, width: "100%" }}>
              <option value="">None</option>
              <optgroup label={isNumeric(fcol) ? "Number" : "Text"}>
                {condList.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </optgroup>
            </select>
            {needsV1(ff.op) && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input value={ff.v1} placeholder={isNumeric(fcol) ? "value" : "text"} onChange={(e) => setF(fcol.key, { v1: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
                {needsV2(ff.op) && <input value={ff.v2} placeholder="and" onChange={(e) => setF(fcol.key, { v2: e.target.value })} style={{ ...inputStyle, flex: 1 }} />}
              </div>
            )}

            {allVals.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.sub }}>Filter by values</span>
                  <span><a style={link} onClick={() => setF(fcol.key, { values: null })}>Select all</a> · <a style={link} onClick={() => setF(fcol.key, { values: [] })}>Clear</a></span>
                </div>
                <input value={valSearch} onChange={(e) => setValSearch(e.target.value)} placeholder="Search values…" style={{ ...inputStyle, width: "100%", marginBottom: 6 }} />
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Displaying {shownVals.length} of {allVals.length}</div>
                <div style={{ maxHeight: 200, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 4, padding: 4 }}>
                  {shownVals.map((v) => (
                    <label key={v} style={{ display: "block", fontSize: 13, padding: "2px 2px", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={isChecked(v)} onChange={(e) => toggleVal(v, e.target.checked)} /> {v === "" ? "(Blanks)" : v}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 12, color: C.sub }}>Too many distinct values to list — use a condition above.</div>
            )}

            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button onClick={() => setColF((m) => ({ ...m, [fcol.key]: emptyFilter() }))} style={{ ...inputStyle, cursor: "pointer", marginRight: 6 }}>Clear</button>
              <button onClick={() => setOpenF(null)} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>Done</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
