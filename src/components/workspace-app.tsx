"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Anchor, ArrowDownToLine, ArrowRight, Box, Check, ChevronRight, ClipboardCheck, Compass, FileText, LayoutDashboard, LogOut, Package, Plus, Search, Ship, ShoppingBag, Users, X, TrendingUp } from "lucide-react";
import type { Batch, CheckItem, KitCheck, Workspace } from "@/lib/types";
import { addMonths, euros, quantities } from "@/lib/rules";
import { applyDemoCommand, type Action } from "@/lib/commands";
import { signOut } from "@/app/login/actions";
import { DEMO_STORAGE_KEY } from "@/lib/demo";
import TemplatesPage from "./templates-page";
import { checkItemsInWorkbookOrder, inWorkbookOrder } from "@/lib/workbook-order";

type Page = "Overview" | "Kit checks" | "Clients" | "Vessels" | "Vendors" | "Catalogue" | "Templates" | "Forecast" | "Import review";
type Modal = { title: string; action: Action; fixed?: Record<string, unknown>; fields: Field[] };
type Field = { name: string; label: string; type?: string; options?: { value: string; label: string }[]; value?: string | number; checked?: boolean; required?: boolean };
const navigation = [
  { label: "Overview" as Page, icon: LayoutDashboard }, { label: "Kit checks" as Page, icon: ClipboardCheck },
  { label: "Clients" as Page, icon: Users }, { label: "Vessels" as Page, icon: Ship },
  { label: "Vendors" as Page, icon: ShoppingBag }, { label: "Catalogue" as Page, icon: Package },
  { label: "Templates" as Page, icon: FileText },
  { label: "Forecast" as Page, icon: TrendingUp },
  { label: "Import review" as Page, icon: ClipboardCheck },
];
const statusLabel = { assessing: "Assessment", awaiting_approval: "Awaiting approval", packing: "Pick & pack", complete: "Medical packing complete" };
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const shortDate = (date: string) => new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (date: string) => new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={id} onCancel={onClose}><div className="dialog-heading"><h2 id={id}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</dialog>;
}

function ImportReview({ check, busy, onReview }: { check: KitCheck; busy: boolean; onReview: () => void }) {
  if (!check.attributes?.imported) return null;
  const issues = Array.isArray(check.attributes.issues) ? check.attributes.issues : [];
  return <section className="info import-review"><strong>Imported workbook {check.attributes.review_required ? "— review required" : "— review recorded"}</strong>
    <p>{String(check.attributes.source_file ?? check.attributes.source_filename ?? "")}</p>
    <details><summary>Source issues and import notes ({issues.length})</summary>
      <ul>{issues.map((issue, index) => <li key={index}>{typeof issue === "string" ? issue : JSON.stringify(issue)}</li>)}</ul>
      {check.notes && <p>{check.notes}</p>}
    </details>
    {check.attributes.review_required ? <button className="secondary" disabled={busy} onClick={onReview}>Record import review</button> : <p>{String(check.attributes.review_notes ?? "")}</p>}
    <p>Reviewing acknowledges the source issues; it does not approve a quote or certify compliance. Unknown quantities and prices must be corrected separately.</p>
  </section>;
}

export default function WorkspaceApp({ initial, demo }: { initial: Workspace; demo: boolean }) {
  const [data, setData] = useState(initial);
  const [page, setPage] = useState<Page>("Overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("Assessment");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);
  const [directory, setDirectory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forecastMonth, setForecastMonth] = useState("");
  const [forecastMode, setForecastMode] = useState("visit");
  const check = data.kit_checks.find((c) => c.id === selected);
  const items = checkItemsInWorkbookOrder(data, selected);
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const vesselName = (id: string) => data.vessels.find((v) => v.id === id)?.name ?? "Unknown vessel";
  const clientName = (id: string | null) => data.clients.find((c) => c.id === id)?.name ?? "Unassigned";
  const checkName = (c: KitCheck) => `${vesselName(c.vessel_id)} · ${shortDate(c.check_date)}`;

  useEffect(() => {
    if (!demo) return;
    try { const saved = sessionStorage.getItem(DEMO_STORAGE_KEY); if (saved) setData(JSON.parse(saved)); } catch { /* A corrupt preview never affects live data. */ }
  }, [demo]);

  async function command(action: Action, payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      let next: Workspace;
      if (demo) {
        next = applyDemoCommand(data, { action, payload });
        sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(next));
      } else {
        const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to save.");
        next = result;
      }
      setData(next); setModal(null); setNotice("Changes saved.");
      if (action === "create_check") {
        const created = next.kit_checks.find((c) => !data.kit_checks.some((old) => old.id === c.id));
        if (created) { setSelected(created.id); setPage("Kit checks"); setTab("Assessment"); }
      }
      if (action === "approve_quote") setTab("Pick & pack");
      if (action === "create_quote") setTab("Quote");
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); return false; }
    finally { setBusy(false); }
  }

  function navigate(next: Page) { setPage(next); setSelected(null); setSearch(""); setError(""); setNotice(""); }
  function openCheck(c: KitCheck) { setSelected(c.id); setPage("Kit checks"); setSearch(""); setTab(c.status === "packing" ? "Pick & pack" : c.status === "awaiting_approval" ? "Quote" : "Assessment"); }
  function newCheck() {
    setModal({ title: "Start a kit check", action: "create_check", fields: [
      { name: "vessel_id", label: "Vessel", options: data.vessels.filter((v) => v.client_id).map((v) => ({ value: v.id, label: `${v.name} · ${v.framework} · ${v.crew} crew` })) },
      { name: "template_id", label: "Kit template", options: data.kit_templates.filter((t) => t.published).map((t) => ({ value: t.id, label: `${t.name} · ${t.version}` })) },
      { name: "check_date", label: "Check date", type: "date", value: today() },
      { name: "job_type", label: "Job type", options: ["Routine Refill", "Category Swap", "Restructure"].map((s) => ({ value: s, label: s })) },
    ] });
  }
  function addBatch(item: CheckItem) {
    setModal({ title: check?.status === "packing" ? "Record a supplied batch" : "Record existing stock", action: "add_batch", fixed: { item_id: item.id }, fields: [
      { name: "quantity", label: "Number of packs", type: "number", value: 1 },
      { name: "expiry_month", label: "Expiry month", type: "month", required: false },
      { name: "no_expiry", label: "This product has no expiry", type: "checkbox", checked: item.attributes?.ned === true },
      { name: "notes", label: "Batch notes", required: false },
    ] });
  }
  function editCheckItem(item: CheckItem) {
    const packing = check?.status === "packing";
    setModal({ title: packing ? "Record a substitute product" : "Edit check line / substitute", action: "edit_check_item",
      fixed: { item_id: item.id, ...(packing ? { required_packs: item.required_packs, unit_price: item.unit_price, pack_description: item.pack_description } : {}) },
      fields: [
        { name: "substitute_description", label: "Substitute product (leave blank to use the original item)", value: String(item.attributes?.substitute_description ?? ""), required: false },
        ...(!packing ? [
          { name: "pack_description", label: "Pack description", value: item.pack_description, required: false },
          { name: "required_packs", label: "Required packs for this check", type: "number", value: item.attributes?.requirement_unknown ? "" : item.required_packs },
          { name: "unit_price", label: "Reviewed sell price per pack (€)", type: "number", value: item.attributes?.price_missing ? "" : item.unit_price },
        ] : []),
        { name: "reason", label: packing ? "Reason / client request (approved quantity, pack size and price stay fixed)" : "Reason for change / client request" },
      ] });
  }

  const activeChecks = data.kit_checks.filter((c) => c.status !== "complete");
  const totalOutstanding = data.check_items.reduce((sum, item) => sum + (data.kit_checks.some((c) => c.id === item.check_id && c.status === "packing") ? quantities(item, data.batches).outstanding : 0), 0);
  const sortedChecks = [...data.kit_checks].sort((a, b) => b.check_date.localeCompare(a.check_date));
  const latestCompleted = new Map<string, KitCheck>();
  for (const c of sortedChecks.filter((c) => c.status === "complete" && c.attributes?.forecast_eligible !== false && c.attributes?.review_required !== true)) {
    const template = data.kit_templates.find((t) => t.id === c.template_id);
    const key = `${c.vessel_id}:${template?.framework}:${template?.category}`;
    if (!latestCompleted.has(key)) latestCompleted.set(key, c);
  }
  const forecasts = [...latestCompleted.values()].flatMap((c) => {
    const nextVisit = addMonths(c.check_date, 12);
    if (forecastMonth && !nextVisit.startsWith(forecastMonth)) return [];
    const horizon = forecastMode === "visit" ? nextVisit : addMonths(nextVisit, 12);
    return checkItemsInWorkbookOrder(data, c.id).flatMap((item) => {
      const batches = data.batches.filter((b) => b.check_item_id === item.id && b.kind !== "removed" && !b.no_expiry && b.expiry && addMonths(b.expiry, 1) <= horizon);
      const quantity = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
      return quantity ? [{ c, item, quantity, nextVisit, cost: quantity * item.unit_price }] : [];
    });
  });

  function CheckRows({ rows }: { rows: KitCheck[] }) {
    return <div className="table-wrap"><table><thead><tr><th>Vessel / client</th><th>Kit</th><th>Check date</th><th>Stage</th><th /></tr></thead><tbody>{rows.map((c) => <tr key={c.id} onClick={() => openCheck(c)}><td><button className="text-button" onClick={() => openCheck(c)}>{vesselName(c.vessel_id)}</button><small>{clientName(c.client_id)}</small></td><td>{data.kit_templates.find((t) => t.id === c.template_id)?.category}<small>{c.job_type}</small></td><td>{shortDate(c.check_date)}</td><td><span className={`badge ${c.status}`}>{statusLabel[c.status]}</span>{c.attributes?.review_required ? <small>Import review required</small> : null}</td><td><ChevronRight size={16} /></td></tr>)}</tbody></table>{rows.length === 0 && <div className="empty"><ClipboardCheck /><h3>No checks here yet</h3><p>Start a check to generate its assessment list.</p><button className="primary" onClick={newCheck}>Start a kit check</button></div>}</div>;
  }

  return <div className="app-shell">
    <aside className="sidebar"><a href="/" className="brand"><span className="brand-mark"><Anchor size={25} /></span><span>MARINE MEDICAL<small>OPERATIONS WORKSPACE</small></span></a><div className="workspace-label">WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(({ label, icon: Icon }) => <button key={label} onClick={() => navigate(label)} className={page === label ? "active" : ""}><Icon size={19} />{label}{label === "Kit checks" && <span className="nav-count">{activeChecks.length}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="port"><span className="online-dot" />Antibes, France<small>Care on board. Confidence ashore.</small></div><div className="staff"><span className="avatar">MM</span><div>Staff workspace<small>Shared team access</small></div>{!demo && <form action={signOut}><button className="icon-button" aria-label="Sign out"><LogOut size={17} /></button></form>}</div></div></aside>
    <div className="main-shell"><header className="topbar"><div><span className="breadcrumb">Workspace</span><ChevronRight size={14} /><span>{page}</span></div><span className="top-status"><span className="online-dot" />{demo ? "Local preview" : "Staff workspace"}</span></header>
      {demo && <div className="demo-banner"><Compass size={16} /><span>Fictional preview · 6 example checks across assessment, approval, packing and completion. Changes stay in this browser session.</span><button onClick={() => { sessionStorage.removeItem(DEMO_STORAGE_KEY); location.reload(); }}>Reset preview</button></div>}
      <main className="content">
        <div className="page-heading"><div><span className="eyebrow">{check ? "KIT CHECK" : "MARINE MEDICAL ANTIBES"}</span><h1>{check ? vesselName(check.vessel_id) : page === "Overview" ? "Your operations, at a glance." : page}</h1><p>{check ? `${clientName(check.client_id)} · ${shortDate(check.check_date)} · ${check.crew} crew` : page === "Overview" ? "A clear view of the vessels and kits in your care." : ({ "Kit checks": "From first assessment to a fully replenished kit.", Clients: "The people and companies behind every vessel.", Vessels: "Every vessel, connected to its client and check history.", Vendors: "Your supplier network, in one place.", Catalogue: "Supplier products, pack sizes and reference prices.", Templates: "Review kit requirements and publish new versions.", "Import review": "Source files needing review, supporting documents and older revisions.", Forecast: "Plan next year's replacements from recorded kit contents." } as Record<string, string>)[page]}</p></div>{check ? <button className="secondary" onClick={() => { setSelected(null); setSearch(""); }}>← All checks</button> : <button className="primary" onClick={newCheck}><Plus size={17} />New kit check</button>}</div>
        {error && !modal && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status"><Check size={16} />{notice}</div>}

        {page === "Overview" && <>
          <div className="stats"><Stat label="ACTIVE KIT CHECKS" value={activeChecks.length} detail="Across all workflow stages" icon={<ClipboardCheck />} /><Stat label="AWAITING APPROVAL" value={data.kit_checks.filter((c) => c.status === "awaiting_approval").length} detail="Quotes ready for a decision" icon={<FileText />} /><Stat label="PACKS OUTSTANDING" value={totalOutstanding} detail="On approved kit checks" icon={<Box />} /><Stat label="VESSELS IN YOUR CARE" value={data.vessels.length} detail={`${data.clients.length} connected clients`} icon={<Ship />} /></div>
          <div className="overview-grid"><section className="panel"><div className="section-heading"><div><span className="eyebrow">WORK IN PROGRESS</span><h2>Current kit checks</h2></div><button className="text-button" onClick={() => navigate("Kit checks")}>View all <ArrowRight size={15} /></button></div><CheckRows rows={sortedChecks.filter((c) => c.status !== "complete").slice(0, 6)} /></section><section className="panel next-step"><span className="round-icon"><Anchor /></span><span className="eyebrow">A CONNECTED WORKFLOW</span><h2>One check.<br />Every detail.</h2><p>Assess what is on board, prepare a quote, and record each batch as your team packs.</p><ol><li>Assess existing stock</li><li>Review and approve the quote</li><li>Pack in stages</li><li>Review final kit contents</li></ol><button className="secondary" onClick={newCheck}>Start a check <ArrowRight size={15} /></button></section></div>
          <div className="planning-strip"><TrendingUp /><div><h3>Next season starts with what you pack today.</h3><p>Completed kit contents feed your monthly replacement forecast.</p></div><button className="text-button" onClick={() => navigate("Forecast")}>Open forecast <ArrowRight size={16} /></button></div>
        </>}

        {page === "Kit checks" && !check && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vessel or client…" /><CheckRows rows={sortedChecks.filter((c) => matches(`${vesselName(c.vessel_id)} ${clientName(c.client_id)} ${statusLabel[c.status]}`))} /></section>}

        {check && <>
          <ImportReview check={check} busy={busy} onReview={() => setModal({ title: "Record review of imported workbook", action: "acknowledge_import_review", fixed: { check_id: check.id }, fields: [{ name: "reason", label: "What was checked / remaining actions" }] })} /><div className="check-summary"><div><span className={`badge ${check.status}`}>{statusLabel[check.status]}</span><span>{data.kit_templates.find((t) => t.id === check.template_id)?.name}</span><span>Coverage until {shortDate(check.valid_until)}</span></div><small>Template and item prices are retained on this check.</small></div>
          <div className="tabs" role="tablist" aria-label="Kit check sections">{["Assessment", "Quote", "Pick & pack", "Directory"].map((name) => <button key={name} role="tab" aria-selected={tab === name} onClick={() => { setTab(name); setSearch(""); }}>{name}</button>)}</div>
          {(tab === "Assessment" || tab === "Pick & pack") && <section className="panel"><div className="section-heading"><div><h2>{tab === "Assessment" ? "Initial kit assessment" : "Staged pick & pack"}</h2><p>{tab === "Assessment" ? "Add every existing batch, then confirm each line. Confirming without stock records a shortage." : "Record each supplied batch as it is packed. Outstanding quantities update with every save."}</p></div>{tab === "Pick & pack" && check.status === "packing" && <button disabled={busy || items.some((i) => quantities(i, data.batches).outstanding > 0)} className="primary" onClick={() => command("finish", { check_id: check.id })}><Check size={16} />Finish medical packing</button>}</div>
            {tab === "Pick & pack" && !["packing", "complete"].includes(check.status) && <div className="info">Packing opens after quote approval.</div>}
            <Toolbar search={search} setSearch={setSearch} placeholder="Find an item or bag…" /><div className="table-wrap"><table className="item-table"><thead><tr><th>Item / location</th><th>Required</th><th>Kept</th><th>Supplied</th><th>To {tab === "Assessment" ? "add" : "pack"}</th><th>Action</th></tr></thead><tbody>{items.filter((i) => matches(`${i.description} ${i.source_code} ${i.location}`)).map((item) => { const q = quantities(item, data.batches); const own = data.batches.filter((b) => b.check_item_id === item.id); return <tr key={item.id}><td><strong>{item.description}</strong><small>{item.source_code} · {item.location}</small><small>{item.pack_description}</small>{Array.isArray(item.attributes?.issues) && item.attributes.issues.length > 0 ? <details><summary>Source issues ({item.attributes.issues.length})</summary><ul>{item.attributes.issues.map((issue, index) => <li key={index}>{typeof issue === "string" ? issue : JSON.stringify(issue)}</li>)}</ul><small>Source previous quantity: {String(item.attributes.source_prior_quantity ?? "not recorded")}</small><small>Source previous expiry: {String(item.attributes.source_prior_expiry ?? "not recorded")}</small>{item.attributes.source_stock_notes ? <small>{String(item.attributes.source_stock_notes)}</small> : null}</details> : null}{item.attributes?.original_description && item.attributes?.substitute_description ? <small>Original: {String(item.attributes.original_description)}</small> : null}{item.attributes?.override_reason ? <small>Change reason: {String(item.attributes.override_reason)}</small> : null}{item.attributes?.requirement_unknown || item.attributes?.price_missing ? <span className="badge">Quantity / price needs review</span> : null}<small>{[item.attributes?.ned && "NED", item.attributes?.refrigerated && "Refrigerated", item.attributes?.masters_safe && "Master safe", item.attributes?.flammable && "Flammable"].filter(Boolean).join(" / ")}</small>{item.kill_line && <span className="badge">Kill line / no restock</span>}{own.length > 0 && <details><summary>{own.length} batch record{own.length !== 1 ? "s" : ""}</summary>{own.map((b) => <small key={b.id}>{b.quantity} packs · {b.no_expiry ? "No expiry" : monthLabel(b.expiry!)} · {b.kind}{b.notes ? ` · ${b.notes}` : ""}</small>)}</details>}</td><td>{item.required_packs}</td><td>{q.kept}</td><td>{q.supplied}</td><td><span className={q.outstanding ? "quantity-needed" : "quantity-done"}>{tab === "Assessment" ? q.needed : q.outstanding}</span></td><td><div className="row-actions">{tab === "Assessment" && check.status === "assessing" ? <><button disabled={busy || item.assessment_state === "not_applicable"} className="secondary compact" onClick={() => addBatch(item)}>Add existing batch</button><button disabled={busy} className="text-button" onClick={() => command("mark_assessed", { item_id: item.id, state: "reviewed" })}>{item.assessment_state === "reviewed" ? "✓ Reviewed" : "Confirm assessment"}</button><button className="text-button" disabled={busy} onClick={() => command("set_kill_line", { item_id: item.id, kill_line: !item.kill_line })}>{item.kill_line ? "Restore restocking" : "Kill line / no restock"}</button></> : tab === "Pick & pack" && check.status === "packing" && q.outstanding > 0 ? <button disabled={busy} className="primary compact" onClick={() => addBatch(item)}><Plus size={14} />Record supply</button> : <span className="badge">{tab === "Assessment" ? item.assessment_state : q.outstanding === 0 ? "Packed" : "Pending approval"}</span>}{["assessing", "packing"].includes(check.status) && <button className="secondary compact" disabled={busy} onClick={() => editCheckItem(item)}>Edit / substitute</button>}</div></td></tr>; })}</tbody></table></div>
            {tab === "Assessment" && check.status === "assessing" && <div className="panel-footer"><span>{items.filter((i) => i.assessment_state !== "unreviewed").length} / {items.length} lines reviewed</span><button className="primary" disabled={busy || items.some((i) => i.assessment_state === "unreviewed")} onClick={() => setModal({ title: "Prepare a net quote", action: "create_quote", fixed: { check_id: check.id }, fields: [{ name: "assessment_fee", label: "Reviewed assessment fee (€, net)", type: "number", value: 0 }] })}>Prepare quote <ArrowRight size={15} /></button></div>}
          </section>}
          {tab === "Quote" && <section className="panel"><div className="section-heading"><div><h2>Quote review</h2><p>Net item prices and an explicitly reviewed assessment fee. Tax, delivery and extras are not yet included in this pilot.</p></div></div>{data.quotes.filter((q) => q.check_id === check.id).map((quote) => <div key={quote.id}><div className="table-wrap"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Net total</th></tr></thead><tbody>{quote.lines.map((line, index) => <tr key={index}><td>{line.description}</td><td>{line.quantity}</td><td>{euros(line.unit_price)}</td><td>{euros(line.quantity * line.unit_price)}</td></tr>)}</tbody></table></div><div className="quote-total"><span>Net subtotal</span><strong>{euros(quote.subtotal)}</strong></div><div className="panel-footer"><span className="badge">{quote.status === "approved" ? "Approval recorded" : "Draft · not a final customer quote"}</span>{quote.status === "draft" && <button disabled={busy} className="primary" onClick={() => command("approve_quote", { check_id: check.id })}>Record client approval <ArrowRight size={15} /></button>}</div></div>)}{!data.quotes.some((q) => q.check_id === check.id) && <div className="empty"><FileText /><h3>Assessment comes first</h3><p>Review every line, then prepare the replacement quote.</p><button className="secondary" onClick={() => setTab("Assessment")}>Open assessment</button></div>}</section>}
          {tab === "Directory" && <section className="panel"><div className="section-heading"><div><h2>Final kit contents</h2><p>Retained plus supplied batches. This working directory is not a certificate of conformity.</p></div><button className="secondary" onClick={() => setDirectory(true)}><ArrowDownToLine size={16} />Print working directory</button></div><Directory check={check} data={data} vessel={vesselName(check.vessel_id)} /></section>}
        </>}

        {page === "Import review" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search source file, vessel or issue..." /><div className="info">Source manifests preserve which files were imported or deferred. A manifest is not a completed assessment. Files with missing dates, conflicting versions or unsupported layouts stay here for review.</div><div className="table-wrap"><table><thead><tr><th>Vessel / source</th><th>Import status</th><th>Issues / notes</th></tr></thead><tbody>{(data.import_sources ?? []).filter((source) => matches(`${source.vessel_name} ${source.source_path} ${JSON.stringify(source.attributes)}`)).map((source) => <tr key={source.id}><td><strong>{source.vessel_name}</strong><small>{source.source_path}</small></td><td><span className="badge">{source.status.replaceAll("_", " ")}</span></td><td>{String(source.attributes.summary ?? source.attributes.reason ?? "")}<details><summary>Source metadata</summary><dl>{Object.entries(source.attributes).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl></details></td></tr>)}</tbody></table></div></section>}
        {page === "Templates" && <TemplatesPage data={data} busy={busy} command={command} />}
        {page === "Clients" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search clients…" action={<button className="secondary" onClick={() => setModal({ title: "Add a client", action: "create_client", fields: contactFields(true) })}><Plus size={16} />Add client</button>} /><DataTable headers={["Client", "Email", "Phone", "Vessels", "Review"]} rows={data.clients.filter((c) => matches(`${c.name} ${c.email ?? ""}`)).map((c) => [c.name, c.email || "—", c.phone || "—", String(data.vessels.filter((v) => v.client_id === c.id).length), c.attributes?.provisional ? "Contact details needed" : ""]) } /></section>}
        {page === "Vessels" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vessels…" action={<button className="secondary" onClick={() => setModal({ title: "Add a vessel", action: "create_vessel", fields: [{ name: "name", label: "Vessel name" }, { name: "client_id", label: "Client", options: data.clients.map((c) => ({ value: c.id, label: c.name })) }, { name: "framework", label: "Framework", options: ["MSN", "Malta", "Other"].map((s) => ({ value: s, label: s })) }, { name: "crew", label: "Crew (1–60)", type: "number", value: 10 }, { name: "flag_state", label: "Flag state", required: false }, { name: "loyalty", label: "Loyalty agreement signed", type: "checkbox" }] })}><Plus size={16} />Add vessel</button>} /><DataTable headers={["Vessel", "Client", "Framework", "Crew", "Checks"]} rows={data.vessels.filter((v) => matches(`${v.name} ${clientName(v.client_id)}`)).map((v) => [v.name, clientName(v.client_id), v.framework, String(v.crew), String(data.kit_checks.filter((c) => c.vessel_id === v.id).length)])} /></section>}
        {page === "Vendors" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vendors…" action={<button className="secondary" onClick={() => setModal({ title: "Add a vendor", action: "create_vendor", fields: contactFields(false) })}><Plus size={16} />Add vendor</button>} /><DataTable headers={["Vendor", "Email", "Phone", "Catalogue entries"]} rows={data.vendors.filter((v) => matches(v.name)).map((v) => [v.name, v.email || "—", v.phone || "—", String(data.vendor_products.filter((p) => p.vendor_id === v.id).length)])} /></section>}
        {page === "Catalogue" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search product, SKU or vendor…" action={<button className="secondary" onClick={() => setModal({ title: "Add a vendor product", action: "create_vendor_product", fields: [{ name: "vendor_id", label: "Vendor", options: data.vendors.map((v) => ({ value: v.id, label: v.name })) }, { name: "description", label: "Product description" }, { name: "sku", label: "Supplier code", required: false }, { name: "pack_description", label: "Pack description", required: false }, { name: "price", label: "Vendor price per pack (€)", type: "number", value: 0 }] })}><Plus size={16} />Add product</button>} /><DataTable headers={["Product", "Vendor", "Supplier code", "Pack / pricing basis", "Vendor price / pack", "Vendor price / unit", "Item links / review"]} rows={inWorkbookOrder(data.vendor_products).filter((p) => matches(`${p.description} ${p.sku} ${p.attributes?.mma_article_number ?? ""} ${p.attributes?.matched_item_ids ?? ""} ${data.vendors.find((v) => v.id === p.vendor_id)?.name}`)).map((p) => [p.description, data.vendors.find((v) => v.id === p.vendor_id)?.name ?? "Unassigned", p.sku ?? "—", `${p.pack_description ?? ""} / ${String(p.attributes?.pricing_basis ?? "per pack")}`, p.price === null ? "Not set" : euros(p.price), p.attributes?.unit_price == null ? "Not set" : euros(Number(p.attributes.unit_price)), `${String(p.attributes?.matched_item_ids ?? "")} ${p.attributes?.review_required ? "Review pricing" : ""}`])} /></section>}
        {page === "Forecast" && <><div className="forecast-controls"><label>Next check month<input type="month" value={forecastMonth} onChange={(e) => setForecastMonth(e.target.value)} /></label><label>Replacement horizon<select value={forecastMode} onChange={(e) => setForecastMode(e.target.value)}><option value="visit">Expired by the next visit</option><option value="coverage">Due before the following coverage ends</option></select></label><button className="text-button" onClick={() => setForecastMonth("")}>All months</button></div><div className="info">Assumes no consumption. Uses the latest completed medical check per vessel and kit family, and its saved item prices. This is a planning estimate.</div><section className="panel"><div className="section-heading"><div><h2>Expected replacements</h2><p>{forecasts.reduce((s, f) => s + f.quantity, 0)} packs · {euros(forecasts.reduce((s, f) => s + f.cost, 0))} estimated</p></div></div><DataTable headers={["Next check", "Vessel", "Item", "Packs", "Estimate"]} rows={forecasts.map((f) => [monthLabel(f.nextVisit), vesselName(f.c.vessel_id), f.item.description, String(f.quantity), euros(f.cost)])} /></section></>}
        <footer className="page-footer">Marine Medical Antibes<span>Pilot · invoicing, certificates, equipment checks and legacy reconciliation are still to be implemented.</span></footer>
      </main>
    </div>
    {modal && <Dialog title={modal.title} onClose={() => { if (!busy) { setModal(null); setError(""); } }}><form onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const payload: Record<string, unknown> = { ...modal.fixed };
      for (const field of modal.fields) payload[field.name] = field.type === "checkbox" ? form.has(field.name) : form.get(field.name) ?? "";
      if ("expiry_month" in payload) { payload.expiry = payload.expiry_month ? `${payload.expiry_month}-01` : ""; delete payload.expiry_month; }
      void command(modal.action, payload);
    }}><div className="form-fields">{modal.fields.map((field) => <label className={field.type === "checkbox" ? "checkbox-label" : ""} key={field.name}>{field.type !== "checkbox" && field.label}{field.options ? <select name={field.name} required={field.required !== false} defaultValue=""><option value="" disabled>Select…</option>{field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input name={field.name} type={field.type ?? "text"} required={field.type !== "checkbox" && field.required !== false} min={field.type === "number" ? 0 : undefined} step={field.type === "number" ? "any" : undefined} defaultValue={field.value} defaultChecked={field.type === "checkbox" ? field.checked : undefined} maxLength={field.type ? undefined : 4000} />}{field.type === "checkbox" && field.label}</label>)}</div>{error && <div className="error" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="secondary" disabled={busy} onClick={() => { setModal(null); setError(""); }}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save and continue"}<ArrowRight size={15} /></button></div></form></Dialog>}
    {directory && check && <Dialog title="Working kit directory" onClose={() => setDirectory(false)}><div className="print-area"><h2>Marine Medical · {vesselName(check.vessel_id)}</h2><p>{shortDate(check.check_date)} · Coverage until {shortDate(check.valid_until)}</p><p>Working contents record · not a certificate of conformity</p><Directory check={check} data={data} vessel={vesselName(check.vessel_id)} /></div><div className="dialog-footer"><button className="primary" onClick={() => window.print()}>Print directory</button></div></Dialog>}
  </div>;
}

function contactFields(address: boolean): Field[] { return [{ name: "name", label: "Name" }, { name: "email", label: "Email", type: "email", required: false }, { name: "phone", label: "Phone", required: false }, ...(address ? [{ name: "billing_address", label: "Billing address", required: false }] : []), { name: "notes", label: "Notes", required: false }]; }
function Stat({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: React.ReactNode }) { return <section className="stat"><div><span>{label}</span>{icon}</div><strong>{value}</strong><p>{detail}</p></section>; }
function Toolbar({ search, setSearch, placeholder, action }: { search: string; setSearch: (v: string) => void; placeholder: string; action?: React.ReactNode }) { return <div className="toolbar"><label className="search"><Search size={17} /><input aria-label={placeholder} placeholder={placeholder} value={search} onChange={(e) => setSearch(e.target.value)} /></label>{action}</div>; }
function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) { return <div className="table-wrap"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{col === 0 ? <strong>{cell}</strong> : cell}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <div className="empty"><Package /><h3>No records to show</h3><p>Add a record or adjust your search.</p></div>}</div>; }
function Directory({ check, data }: { check: KitCheck; data: Workspace; vessel: string }) { const lines = checkItemsInWorkbookOrder(data, check.id); return <div className="table-wrap"><table><thead><tr><th>Item / code</th><th>Location</th><th>Final packs</th><th>Batch expiries</th></tr></thead><tbody>{lines.map((item) => { const batches: Batch[] = data.batches.filter((b) => b.check_item_id === item.id && b.kind !== "removed"); return <tr key={item.id}><td><strong>{item.description}</strong><small>{item.source_code}</small></td><td>{item.location}</td><td>{quantities(item, data.batches).final}</td><td>{batches.length ? batches.map((b) => `${b.quantity} × ${b.no_expiry ? "No expiry" : monthLabel(b.expiry!)}`).join("; ") : "No stock recorded"}</td></tr>; })}</tbody></table></div>; }
