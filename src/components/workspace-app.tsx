"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Anchor, ArrowDownToLine, ArrowRight, Box, Check, ChevronRight, ClipboardCheck, Compass, FileText, LayoutDashboard, LogOut, Package, Plus, Search, Ship, ShoppingBag, Users, X, TrendingUp } from "lucide-react";
import type { Batch, CheckItem, Client, KitCheck, Vendor, VendorProduct, Vessel, Workspace } from "@/lib/types";
import { addMonths, euros, quantities } from "@/lib/rules";
import { applyDemoCommand, type Action } from "@/lib/commands";
import { signOut } from "@/app/login/actions";
import { DEMO_STORAGE_KEY } from "@/lib/demo";
import DraftForm from "./draft-form";
import CataloguePage from "./catalogue-page";
import TemplatesPage from "./templates-page";
import CheckWorkspace from "./check-workspace";
import { checkItemsInWorkbookOrder } from "@/lib/workbook-order";

type Page = "Overview" | "Kit checks" | "Clients" | "Vessels" | "Vendors" | "Catalogue" | "Templates" | "Forecast" | "Finance" | "Import review" | "Staff workspace";
type Modal = { title: string; action: Action; fixed?: Record<string, unknown>; fields: Field[] };
type Field = { name: string; label: string; type?: string; options?: { value: string; label: string }[]; value?: string | number; checked?: boolean; required?: boolean };
const navigation = [
  { label: "Overview" as Page, icon: LayoutDashboard }, { label: "Kit checks" as Page, icon: ClipboardCheck },
  { label: "Clients" as Page, icon: Users }, { label: "Vessels" as Page, icon: Ship },
  { label: "Vendors" as Page, icon: ShoppingBag }, { label: "Catalogue" as Page, icon: Package },
  { label: "Templates" as Page, icon: FileText },
  { label: "Finance" as Page, icon: FileText },
  { label: "Forecast" as Page, icon: TrendingUp },
  { label: "Import review" as Page, icon: ClipboardCheck },
  { label: "Staff workspace" as Page, icon: Users },
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
  const [templateDirty, setTemplateDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forecastMonth, setForecastMonth] = useState("");
  const [forecastMode, setForecastMode] = useState("visit");
  const [draftVessel, setDraftVessel] = useState("");
  const [inlineClient, setInlineClient] = useState(false);
  const [clientSeason, setClientSeason] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const season = new Date().getFullYear();
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
        const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json", ...(action === "save_line_slots" ? {"X-Workspace-Partial":"line"} : {}) }, body: JSON.stringify({ action, payload }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to save.");
        next = result.partial === "line" ? { ...data, check_items: data.check_items.map(item => item.id === result.item.id ? result.item : item), batches: [...data.batches.filter(batch => batch.check_item_id !== result.item.id), ...result.batches] } : result;
      }
      setData(next); setModal(null); setNotice("Changes saved.");
      if (action === "create_check") {
        const created = next.kit_checks.find((c) => !data.kit_checks.some((old) => old.id === c.id));
        if (created) { setSelected(created.id); setPage("Kit checks"); setTab("Assessment"); }
      }
      if (action === "approve_quote") setTab("Pick & pack");
      if (action === "create_quote" || action === "prepare_quote") setTab("Quote");
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); return false; }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!templateDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [templateDirty]);

  function navigate(next: Page) { if (page === "Templates" && next !== page && templateDirty && !window.confirm("Discard unsaved template changes?")) return; setPage(next); setSelected(null); setSearch(""); setError(""); setNotice(""); }
  function openCheck(c: KitCheck) { setSelected(c.id); setPage("Kit checks"); setSearch(""); setTab(c.status === "packing" ? "Pick & pack" : c.status === "awaiting_approval" ? "Quote" : "Assessment"); }
  function newCheck() {
    setDraftVessel("");
    setModal({ title: "Start a kit check", action: "create_check", fields: [
      { name: "vessel_id", label: "Vessel", options: data.vessels.filter((v) => v.client_id).map((v) => ({ value: v.id, label: `${v.name} · ${v.framework} · ${v.crew} crew` })) },
      { name: "template_id", label: "Kit template", options: data.kit_templates.filter((t) => t.published).map((t) => ({ value: t.id, label: `${t.name} · ${t.version}` })) },
      { name: "check_date", label: "Check date", type: "date", value: today() },
      { name: "job_type", label: "Job type", options: ["Routine Refill", "Category Swap", "Restructure", "New Build"].map((s) => ({ value: s, label: s })) },
    ] });
  }
  function contactModal(kind: "client" | "vendor", record?: Client | Vendor) {
    const values: Record<string, unknown> = { ...record };
    const fields = contactFields(kind === "client").map(field => ({ ...field, value: String(values[field.name] ?? "") }));
    if (kind === "client" && record) {
      const saved = String((record as Client).attributes?.active_season ?? "");
      fields.push({ name: "active_season", label: "Active kit-check season", required: false, value: saved,
        options: [...new Set([String(season), String(season + 1), String(season + 2), saved])].filter(Boolean).sort().map(value => ({ value, label: value })) });
    }
    setModal({ title: record ? `Edit ${kind}` : `Add a ${kind}`, action: record ? `update_${kind}` : `create_${kind}`, fixed: record && { id: record.id }, fields });
  }

  function vesselModal(record?: Vessel) {
    setInlineClient(false);
    setModal({ title: record ? "Edit vessel" : "Add a vessel", action: record ? "update_vessel" : "create_vessel", fixed: record && { id: record.id }, fields: [
      { name: "name", label: "Vessel name", value: record?.name },
      { name: "client_id", label: "Vessel contact or management company", required: false, value: record?.client_id ?? "", options: [
        ...[...data.clients].sort((a,b) => a.name.localeCompare(b.name)).map(c => ({ value: c.id, label: c.name })),
        { value: "__new__", label: "Add a new client…" },
      ] },
      { name: "framework", label: "Framework", value: record?.framework, options: ["MSN", "Malta", "Other"].map(value => ({ value, label: value })) },
      { name: "crew", label: "Crew (1–60)", type: "number", value: record?.crew ?? 10 },
      { name: "flag_state", label: "Flag state", required: false, value: record?.flag_state ?? "" },
      { name: "loyalty", label: "Loyalty agreement signed", type: "checkbox", checked: record?.loyalty },
    ] });
  }

  function productModal(record?: VendorProduct) {
    setModal({ title: record ? "Edit vendor product" : "Add a vendor product", action: record ? "update_vendor_product" : "create_vendor_product", fixed: record && { id: record.id }, fields: [
      { name: "vendor_id", label: "Vendor", required: !record, value: record?.vendor_id ?? "", options: data.vendors.map(v => ({ value: v.id, label: v.name })) },
      { name: "description", label: "Product description", value: record?.description },
      { name: "sku", label: "Supplier code", required: false, value: record?.sku ?? "" },
      { name: "pack_description", label: "Pack description", required: false, value: record?.pack_description ?? "" },
      { name: "price", label: "Vendor price per pack (€)", type: "number", required: false, value: record?.price ?? "" },
    ] });
  }

  const editButton = (label: string, edit: () => void) => <button className="secondary" aria-label={`Edit ${label}`} onClick={edit}>Edit</button>;

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
        { name: "dose_route", label: "Reviewed dose / route for this product", value: String(item.attributes?.dose_route ?? ""), required: false },
        { name: "uses", label: "Reviewed uses / instructions", value: String(item.attributes?.uses ?? ""), required: false },
        { name: "side_effects", label: "Reviewed side effects / directory notes", value: String(item.attributes?.side_effects ?? ""), required: false },
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

  const staffName = data.staff_profile?.name ?? "Staff workspace";
  const signOutButton = !demo && <form action={signOut} onSubmit={event => { if (templateDirty && !window.confirm("Discard unsaved template changes and sign out?")) event.preventDefault(); }}><button className="secondary"><LogOut size={16} />Sign out</button></form>;

  return <div className="app-shell">
    <aside className="sidebar"><a href="/" className="brand"><span className="brand-mark"><Anchor size={25} /></span><span>MARINE MEDICAL<small>OPERATIONS WORKSPACE</small></span></a><div className="workspace-label">WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(({ label, icon: Icon }) => <button key={label} onClick={() => navigate(label)} className={page === label ? "active" : ""}><Icon size={19} />{label}{label === "Kit checks" && <span className="nav-count">{activeChecks.length}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="port"><span className="online-dot" />Antibes, France<small>Care on board. Confidence ashore.</small></div><div className="staff"><span className="avatar">MM</span><div>{staffName}<small>Shared team access</small></div></div></div></aside>
    <div className="main-shell"><header className="topbar"><div><span className="breadcrumb">Workspace</span><ChevronRight size={14} /><span>{page}</span></div><div className="topbar-account"><span className="top-status"><span className="online-dot" />{demo ? "Local preview" : "Staff workspace"}</span>{signOutButton}</div></header>
      {demo && <div className="demo-banner"><Compass size={16} /><span>Fictional preview · 6 example checks across assessment, approval, packing and completion. Changes stay in this browser session.</span><button onClick={() => { sessionStorage.removeItem(DEMO_STORAGE_KEY); location.reload(); }}>Reset preview</button></div>}
      <main className="content">
        <div className="page-heading"><div><span className="eyebrow">{check ? "KIT CHECK" : "MARINE MEDICAL ANTIBES"}</span><h1>{check ? vesselName(check.vessel_id) : page === "Overview" ? "Your operations, at a glance." : page}</h1><p>{check ? `${clientName(check.client_id)} · ${shortDate(check.check_date)} · ${check.crew} crew` : page === "Overview" ? "A clear view of the vessels and kits in your care." : ({ "Kit checks": "From first assessment to a fully replenished kit.", Clients: "The people and companies behind every vessel.", Vessels: "Every vessel, connected to its client and check history.", Vendors: "Your supplier network, in one place.", Catalogue: "Supplier products, pack sizes and reference prices.", Finance: "Track quotes, invoices and payments across kit checks.", Templates: "Review kit requirements and publish new versions.", "Import review": "Source files needing review, supporting documents and older revisions.", "Staff workspace": "Your account and quick access to daily work.", Forecast: "Plan next year's replacements from recorded kit contents." } as Record<string, string>)[page]}</p></div>{check ? <button className="secondary" onClick={() => { setSelected(null); setSearch(""); }}>← All checks</button> : <button className="primary" onClick={newCheck}><Plus size={17} />New kit check</button>}</div>
        {error && !modal && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status"><Check size={16} />{notice}</div>}

        {page === "Staff workspace" && <section className="panel">
          <div className="section-heading"><div><h2>{demo ? "Local preview" : staffName}</h2>
            {data.staff_profile?.email && <p>{data.staff_profile.email}</p>}
            <p>{demo ? "Preview the staff workspace with fictional records." : "Your staff account has shared access to MarineMed records."}</p>
          </div></div>
          <div className="workflow-actions">
            <button className="secondary" onClick={() => navigate("Kit checks")}>Open kit checks</button>
            <button className="secondary" onClick={() => navigate("Templates")}>Review templates</button>
            <button className="secondary" onClick={() => navigate("Finance")}>Open finance</button>
          </div>
        </section>}

        {page === "Overview" && <>
          <div className="stats"><Stat label="ACTIVE KIT CHECKS" value={activeChecks.length} detail="Across all workflow stages" icon={<ClipboardCheck />} /><Stat label="AWAITING APPROVAL" value={data.kit_checks.filter((c) => c.status === "awaiting_approval").length} detail="Quotes ready for a decision" icon={<FileText />} /><Stat label="PACKS OUTSTANDING" value={totalOutstanding} detail="On approved kit checks" icon={<Box />} /><Stat label="VESSELS IN YOUR CARE" value={data.vessels.length} detail={`${data.clients.length} connected clients`} icon={<Ship />} /></div>
          <div className="overview-grid"><section className="panel"><div className="section-heading"><div><span className="eyebrow">WORK IN PROGRESS</span><h2>Current kit checks</h2></div><button className="text-button" onClick={() => navigate("Kit checks")}>View all <ArrowRight size={15} /></button></div><CheckRows rows={sortedChecks.filter((c) => c.status !== "complete").slice(0, 6)} /></section><section className="panel next-step"><span className="round-icon"><Anchor /></span><span className="eyebrow">A CONNECTED WORKFLOW</span><h2>One check.<br />Every detail.</h2><p>Assess what is on board, prepare a quote, and record each batch as your team packs.</p><ol><li>Assess existing stock</li><li>Review and approve the quote</li><li>Pack in stages</li><li>Review final kit contents</li></ol><button className="secondary" onClick={newCheck}>Start a check <ArrowRight size={15} /></button></section></div>
          <div className="planning-strip"><TrendingUp /><div><h3>Next season starts with what you pack today.</h3><p>Completed kit contents feed your monthly replacement forecast.</p></div><button className="text-button" onClick={() => navigate("Forecast")}>Open forecast <ArrowRight size={16} /></button></div>
        </>}

        {page === "Kit checks" && !check && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vessel or client…" /><CheckRows rows={sortedChecks.filter((c) => matches(`${vesselName(c.vessel_id)} ${clientName(c.client_id)} ${statusLabel[c.status]}`))} /></section>}

        {check && <>
          <ImportReview check={check} busy={busy} onReview={() => setModal({ title: "Record review of imported workbook", action: "acknowledge_import_review", fixed: { check_id: check.id }, fields: [{ name: "reason", label: "What was checked / remaining actions" }] })} /><div className="check-summary"><div><span className={`badge ${check.status}`}>{statusLabel[check.status]}</span><span>{data.kit_templates.find((t) => t.id === check.template_id)?.name}</span><span>Coverage until {shortDate(check.valid_until)}</span></div><small>Template and item prices are retained on this check.</small></div>
          <CheckWorkspace data={data} check={check} busy={busy} command={command} tab={tab} setTab={setTab} edit={editCheckItem} demo={demo} serverError={error} />
        </>}

        {page === "Import review" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search source file, vessel or issue..." /><div className="info">Source manifests preserve which files were imported or deferred. A manifest is not a completed assessment. Files with missing dates, conflicting versions or unsupported layouts stay here for review.</div><div className="table-wrap"><table><thead><tr><th>Vessel / source</th><th>Import status</th><th>Issues / notes</th></tr></thead><tbody>{(data.import_sources ?? []).filter((source) => matches(`${source.vessel_name} ${source.source_path} ${JSON.stringify(source.attributes)}`)).map((source) => <tr key={source.id}><td><strong>{source.vessel_name}</strong><small>{source.source_path}</small></td><td><span className="badge">{source.status.replaceAll("_", " ")}</span></td><td>{String(source.attributes.summary ?? source.attributes.reason ?? "")}<details><summary>Source metadata</summary><dl>{Object.entries(source.attributes).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl></details></td></tr>)}</tbody></table></div></section>}
        {page === "Templates" && <TemplatesPage data={data} demo={demo} busy={busy} command={command} dirty={templateDirty} onDirtyChange={setTemplateDirty} serverError={error} />}
        {page === "Clients" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search clients…" action={<><label>Season <select value={clientSeason} onChange={e => setClientSeason(e.target.value)}><option value="">All clients</option>{[...new Set([String(season), String(season + 1), ...data.clients.flatMap(c => c.attributes?.active_season ? [String(c.attributes.active_season)] : [])])].sort().map(year => <option key={year} value={year}>Active in {year}</option>)}</select></label><button className="secondary" onClick={() => contactModal("client")}><Plus size={16} />Add client</button></>} /><DataTable headers={["Client", "Email", "Phone", "Vessels", "Review", "Active season", "Actions"]} rows={data.clients.filter((c) => matches(`${c.name} ${c.email ?? ""}`) && (!clientSeason || String(c.attributes?.active_season ?? "") === clientSeason)).map((c) => [c.name, c.email || "—", c.phone || "—", String(data.vessels.filter((v) => v.client_id === c.id).length), c.attributes?.provisional ? "Contact details needed" : "", String(c.attributes?.active_season ?? "—"), editButton(c.name, () => contactModal("client", c))]) } /></section>}
        {page === "Vessels" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vessels…" action={<button className="secondary" onClick={() => vesselModal()}><Plus size={16} />Add vessel</button>} /><DataTable headers={["Vessel", "Client", "Framework", "Crew", "Checks", "Actions"]} rows={data.vessels.filter((v) => matches(`${v.name} ${clientName(v.client_id)}`)).map((v) => [v.name, clientName(v.client_id), v.framework, String(v.crew), String(data.kit_checks.filter((c) => c.vessel_id === v.id).length), editButton(v.name, () => vesselModal(v))])} /></section>}
        {page === "Vendors" && <section className="panel"><Toolbar search={search} setSearch={setSearch} placeholder="Search vendors…" action={<button className="secondary" onClick={() => contactModal("vendor")}><Plus size={16} />Add vendor</button>} /><DataTable headers={["Vendor", "Email", "Phone", "Catalogue entries", "Actions"]} rows={data.vendors.filter((v) => matches(v.name)).map((v) => [v.name, v.email || "—", v.phone || "—", String(data.vendor_products.filter((p) => p.vendor_id === v.id).length), editButton(v.name, () => contactModal("vendor", v))])} /></section>}
        {page === "Catalogue" && <CataloguePage data={data} demo={demo} busy={busy} search={search} setSearch={setSearch} editProduct={productModal} command={command} />}
        {page === "Finance" && <section className="panel">
          <Toolbar search={search} setSearch={setSearch} placeholder="Search vessel, client or invoice…" action={<label>Payment status <select value={paymentStatus} onChange={event => setPaymentStatus(event.target.value)}>
            <option value="">All</option><option>Awaiting payment</option><option>Paid</option><option>Draft</option><option>Quote</option>
          </select></label>} />
          <DataTable headers={["Vessel", "Client", "Quote sent", "Invoice", "Invoice sent", "Paid", "Status", "Total", "Actions"]} rows={sortedChecks.flatMap(c => {
            const tracker = c.attributes?.finance_tracker as Record<string, string> | undefined;
            const invoice = data.invoices?.find(row => row.check_id === c.id);
            const quote = data.quotes.find(row => row.check_id === c.id && !row.superseded_at);
            if (!invoice && !quote && !tracker?.quote_sent_at && !tracker?.invoice_sent_at && !tracker?.invoice_paid_at && !tracker?.ipaid_external_id) return [];
            const status = tracker?.invoice_paid_at || invoice?.status === "paid" ? "Paid" : tracker?.invoice_sent_at || invoice?.status === "issued" ? "Awaiting payment" : invoice ? "Draft" : "Quote";
            if ((paymentStatus && paymentStatus !== status) || !matches(`${vesselName(c.vessel_id)} ${clientName(c.client_id)} ${invoice?.invoice_number ?? ""} ${tracker?.ipaid_external_id ?? ""}`)) return [];
            const total = invoice?.financials.total ?? quote?.financials?.total;
            return [[vesselName(c.vessel_id), clientName(c.client_id), tracker?.quote_sent_at || "—",
              invoice?.invoice_number ?? (tracker?.ipaid_external_id || "—"), tracker?.invoice_sent_at || "—",
              tracker?.invoice_paid_at || "—", status, typeof total === "number" ? euros(total) : "—",
              <button className="secondary" onClick={() => { openCheck(c); setTab("Invoice"); }}>Open tracker</button>]];
          })} />
        </section>}
        {page === "Forecast" && <><div className="forecast-controls"><label>Next check month<input type="month" value={forecastMonth} onChange={(e) => setForecastMonth(e.target.value)} /></label><label>Replacement horizon<select value={forecastMode} onChange={(e) => setForecastMode(e.target.value)}><option value="visit">Expired by the next visit</option><option value="coverage">Due before the following coverage ends</option></select></label><button className="text-button" onClick={() => setForecastMonth("")}>All months</button></div><div className="info">Assumes no consumption. Uses the latest completed medical check per vessel and kit family, and its saved item prices. This is a planning estimate.</div><section className="panel"><div className="section-heading"><div><h2>Expected replacements</h2><p>{forecasts.reduce((s, f) => s + f.quantity, 0)} packs · {euros(forecasts.reduce((s, f) => s + f.cost, 0))} estimated</p></div></div><DataTable headers={["Next check", "Vessel", "Item", "Packs", "Estimate"]} rows={forecasts.map((f) => [monthLabel(f.nextVisit), vesselName(f.c.vessel_id), f.item.description, String(f.quantity), euros(f.cost)])} /></section></>}
        <footer className="page-footer">Marine Medical Antibes<span>Staff workspace · review and issue documents through your approved process.</span></footer>
      </main>
    </div>
    {modal && <Dialog title={modal.title} onClose={() => { if (!busy) { setModal(null); setError(""); } }}><DraftForm busy={busy} onDraftChange={form => {
      const values = new FormData(form);
      setInlineClient(values.get("client_id") === "__new__");
      if (modal.action === "create_check") setDraftVessel(String(values.get("vessel_id") ?? ""));
    }} onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const payload: Record<string, unknown> = { ...modal.fixed };
      for (const field of modal.fields) payload[field.name] = field.type === "checkbox" ? form.has(field.name) : form.get(field.name) ?? "";
      if (payload.client_id === "__new__") {
        payload.client_id = "";
        payload.new_client = Object.fromEntries(contactFields(true).map(field => [field.name, form.get(`new_${field.name}`) ?? ""]));
      }
      if ("expiry_month" in payload) { payload.expiry = payload.expiry_month ? `${payload.expiry_month}-01` : ""; delete payload.expiry_month; }
      void command(modal.action, payload);
    }}><div className="form-fields">{modal.fields.map((field) => <label className={field.type === "checkbox" ? "checkbox-label" : ""} key={field.name}>{field.type !== "checkbox" && field.label}{field.options ? <select name={field.name} required={field.required !== false} defaultValue={field.value ?? ""} onChange={e=>{if(modal.action==="create_check"&&field.name==="vessel_id"){const template=e.currentTarget.form?.elements.namedItem("template_id") as HTMLSelectElement|null;if(template)template.value="";}}}><option value="" disabled={field.required !== false}>{field.name === "client_id" ? "Assign later" : field.name === "active_season" ? "No active season" : field.required === false ? "Unassigned" : "Select…"}</option>{field.options.map((o) => {
        const template = modal.action === "create_check" && field.name === "template_id" && draftVessel
          ? data.kit_templates.find(t => t.id === o.value) : undefined;
        const incompatible = !!template && template.framework !== "ALL" && template.framework !== data.vessels.find(v => v.id === draftVessel)?.framework;
        return <option key={o.value} value={o.value} hidden={incompatible} disabled={incompatible}>{o.label}</option>;
      })}</select> : <input name={field.name} type={field.type ?? "text"} required={field.type !== "checkbox" && field.required !== false} min={field.type === "number" ? 0 : undefined} step={field.type === "number" ? "any" : undefined} defaultValue={field.value} defaultChecked={field.type === "checkbox" ? field.checked : undefined} maxLength={field.type ? undefined : 4000} />}{field.type === "checkbox" && field.label}</label>)}{modal.fields.some(field => field.name === "client_id") && <fieldset hidden={!inlineClient} disabled={!inlineClient}><legend>New client contact</legend>{contactFields(true).map(field => <label key={field.name}>{field.label}<input name={`new_${field.name}`} type={field.type ?? "text"} required={field.required !== false} /></label>)}</fieldset>}</div>{error && <div className="error" role="alert">{error}</div>}<div className="dialog-footer"><button type="button" className="secondary" disabled={busy} onClick={() => { setModal(null); setError(""); }}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save and continue"}<ArrowRight size={15} /></button></div></DraftForm></Dialog>}
    {directory && check && <Dialog title="Working kit directory" onClose={() => setDirectory(false)}><div className="print-area"><h2>Marine Medical · {vesselName(check.vessel_id)}</h2><p>{shortDate(check.check_date)} · Coverage until {shortDate(check.valid_until)}</p><p>Working contents record · not a certificate of conformity</p><Directory check={check} data={data} vessel={vesselName(check.vessel_id)} /></div><div className="dialog-footer"><button className="primary" onClick={() => window.print()}>Print directory</button></div></Dialog>}
  </div>;
}

function contactFields(address: boolean): Field[] { return [{ name: "name", label: "Name" }, { name: "email", label: "Email", type: "email", required: false }, { name: "phone", label: "Phone", required: false }, ...(address ? [{ name: "billing_address", label: "Billing address", required: false }] : []), { name: "notes", label: "Notes", required: false }]; }
function Stat({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: React.ReactNode }) { return <section className="stat"><div><span>{label}</span>{icon}</div><strong>{value}</strong><p>{detail}</p></section>; }
function Toolbar({ search, setSearch, placeholder, action }: { search: string; setSearch: (v: string) => void; placeholder: string; action?: React.ReactNode }) { return <div className="toolbar"><label className="search"><Search size={17} /><input aria-label={placeholder} placeholder={placeholder} value={search} onChange={(e) => setSearch(e.target.value)} /></label>{action}</div>; }
function DataTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) { return <div className="table-wrap"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{col === 0 ? <strong>{cell}</strong> : cell}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <div className="empty"><Package /><h3>No records to show</h3><p>Add a record or adjust your search.</p></div>}</div>; }
function Directory({ check, data }: { check: KitCheck; data: Workspace; vessel: string }) { const lines = checkItemsInWorkbookOrder(data, check.id); return <div className="table-wrap"><table><thead><tr><th>Item / code</th><th>Location</th><th>Final packs</th><th>Batch expiries</th></tr></thead><tbody>{lines.map((item) => { const batches: Batch[] = data.batches.filter((b) => b.check_item_id === item.id && b.kind !== "removed"); return <tr key={item.id}><td><strong>{item.description}</strong><small>{item.source_code}</small></td><td>{item.location}</td><td>{quantities(item, data.batches).final}</td><td>{batches.length ? batches.map((b) => `${b.quantity} × ${b.no_expiry ? "No expiry" : monthLabel(b.expiry!)}`).join("; ") : "No stock recorded"}</td></tr>; })}</tbody></table></div>; }
