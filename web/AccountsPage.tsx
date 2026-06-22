// Accounts — manage PT accounts (D6). Accounts share the catalog and differ only
// in owned quantities + variants. Here you: switch the active account, rename,
// import ownership (a pt_card_list export — also refreshes the shared catalog),
// create a new account, and manage the active account's v5 variants (search-add,
// import the game's variant export, remove). Scoring is unaffected by the account.

import { useRef, useState } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, haystack } from "./shared.ts";

export function AccountsPage() {
  const { accounts, accountId, activeAccount, chooseAccount, cards, busy,
    renameAccount, importOwnership, toggleVariant, importVariants, clearVariants } = useAppData();
  const ownershipRef = useRef<HTMLInputElement>(null);
  const newAccRef = useRef<HTMLInputElement>(null);
  const variantRef = useRef<HTMLInputElement>(null);
  const [variantQuery, setVariantQuery] = useState("");
  const [info, setInfo] = useState<string | null>(null);

  const variantRows = cards.filter((c) => c.variant === "Y");
  const variantIds = new Set(variantRows.map((r) => r.id));
  const q = variantQuery.trim().toLowerCase();
  const candidates = q
    ? cards.filter((c) => c.variant !== "Y" && !variantIds.has(c.id) && haystack(c).includes(q)).slice(0, 12)
    : [];

  const doRename = async (id: string, current: string) => {
    const name = window.prompt("Rename account", current);
    if (name && name.trim()) await renameAccount(id, name.trim());
  };
  const onOwnership = async (e: React.ChangeEvent<HTMLInputElement>, target: string | null) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    let name: string | undefined;
    if (!target) {
      name = window.prompt("New account name", file.name.replace(/^pt_card_list/i, "").replace(/\.csv$/i, "").trim() || "Account") || "";
      if (!name.trim()) return;
    }
    setInfo(null);
    await importOwnership(target ? { id: target, text: await file.text() } : { name: name!.trim(), text: await file.text() });
  };
  const onVariantFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    const r = await importVariants(await file.text());
    if (r.ok) setInfo(`Imported ${r.matched} variant${r.matched === 1 ? "" : "s"} (${r.unmatched} unmatched) from "${r.column}" column.`);
  };

  const cell: React.CSSProperties = { padding: "7px 10px", borderBottom: `1px solid ${C.border}`, fontSize: 13 };
  const btn = { ...inputStyle, cursor: "pointer" } as React.CSSProperties;
  const sectionTitle: React.CSSProperties = { fontSize: 12, color: C.sub, margin: "0 0 4px" };

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 4px" }}>Accounts</h2>
      <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 13 }}>
        Accounts share the card catalog and differ only in ownership and variants. Importing ownership uses your
        in-game <code>pt_card_list</code> export and also refreshes the shared card list with any new cards.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}`, marginBottom: 10 }}>
        <thead>
          <tr style={{ background: C.head }}>
            <th style={{ ...cell, textAlign: "left" }}>Account</th>
            <th style={{ ...cell, textAlign: "right" }}>Owned</th>
            <th style={{ ...cell, textAlign: "right" }}>Total qty</th>
            <th style={{ ...cell, textAlign: "right" }}>Variants</th>
            <th style={{ ...cell, textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} style={{ background: a.id === accountId ? C.navActive : "transparent" }}>
              <td style={{ ...cell }}>
                {a.id === accountId && <span style={{ color: C.accent, marginRight: 6 }}>●</span>}
                <b style={{ color: C.text }}>{a.name}</b>
              </td>
              <td style={{ ...cell, textAlign: "right" }}>{a.ownedCount}</td>
              <td style={{ ...cell, textAlign: "right" }}>{a.totalQty}</td>
              <td style={{ ...cell, textAlign: "right" }}>{a.variantCount}</td>
              <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                {a.id !== accountId && <button onClick={() => chooseAccount(a.id)} disabled={!!busy} style={{ ...btn, marginRight: 6 }}>Set active</button>}
                <button onClick={() => doRename(a.id, a.name)} disabled={!!busy} style={{ ...btn, marginRight: 6 }}>Rename</button>
                <button onClick={() => { ownershipRef.current?.setAttribute("data-target", a.id); ownershipRef.current?.click(); }} disabled={!!busy} title="Replace this account's ownership from a pt_card_list export" style={btn}>Import ownership…</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 24 }}>
        <button onClick={() => newAccRef.current?.click()} disabled={!!busy} style={btn}>+ New account</button>
        {busy && <span style={{ fontSize: 12, color: C.sub }}>{busy === "upload" ? "importing…" : busy === "rename" ? "saving…" : "updating…"}</span>}
      </div>

      <input ref={ownershipRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
        onChange={(e) => onOwnership(e, ownershipRef.current?.getAttribute("data-target") || null)} />
      <input ref={newAccRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => onOwnership(e, null)} />
      <input ref={variantRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={onVariantFile} />

      {/* ── Variants for the active account ── */}
      <h3 style={{ margin: "0 0 4px" }}>Variants — {activeAccount?.name ?? "(no account)"} ({variantRows.length})</h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: C.sub }}>
        The v5 boost is computed in-app. Import the game's variant export (replaces the list), or add/remove individually.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <button onClick={() => variantRef.current?.click()} disabled={!accountId || !!busy} style={{ ...btn, background: C.accent, color: "#fff" }}>Import variant CSV…</button>
        {variantRows.length > 0 && <button onClick={async () => { if (window.confirm(`Remove all ${variantRows.length} variants from ${activeAccount?.name}?`)) { setInfo(null); await clearVariants(); } }} disabled={!!busy} style={btn}>Clear all</button>}
        {info && <span style={{ fontSize: 12, color: C.sub }}>{info}</span>}
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 340px" }}>
          <div style={sectionTitle}>Add a variant — search cards</div>
          <input value={variantQuery} onChange={(e) => setVariantQuery(e.target.value)} placeholder="Search by player or card name…" style={{ ...inputStyle, width: "100%", marginBottom: 6 }} disabled={!accountId} />
          {q && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, maxHeight: 320, overflow: "auto" }}>
              {candidates.length === 0 ? <div style={{ padding: 8, fontSize: 13, color: C.sub }}>No matches (already-variant cards are hidden).</div>
                : candidates.map((c) => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title} <span style={{ color: C.sub }}>#{c.id}</span></span>
                    <button onClick={() => toggleVariant(c.id, true)} disabled={!!busy} style={{ ...btn, padding: "3px 8px" }}>+ Add</button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div style={{ flex: "1 1 340px" }}>
          <div style={sectionTitle}>Current variants ({variantRows.length})</div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, maxHeight: 360, overflow: "auto" }}>
            {variantRows.length === 0 ? <div style={{ padding: 8, fontSize: 13, color: C.sub }}>None yet.</div>
              : [...variantRows].sort((a, b) => a.title.localeCompare(b.title)).map((c) => (
                <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: C.star }}>★</span>{c.title.replace(/^★\s*/, "").replace(/\s*v5$/, "")} <span style={{ color: C.sub }}>#{c.id}</span>
                  </span>
                  <button onClick={() => toggleVariant(c.id, false)} disabled={!!busy} style={{ ...btn, padding: "3px 8px" }}>Remove</button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
