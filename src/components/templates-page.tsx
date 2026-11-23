"use client";

import { useEffect, useState } from "react";
import type { TemplateItem, Workspace } from "@/lib/types";
import type { Action } from "@/lib/commands";
import { euros, requiredPacks } from "@/lib/rules";
import { inWorkbookOrder, workbookPosition } from "@/lib/workbook-order";

type Props = { data: Workspace; busy: boolean; command: (action: Action, payload: Record<string, unknown>) => Promise<boolean | undefined> };
export default function TemplatesPage({ data, busy, command }: Props) {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [crew, setCrew] = useState(10);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TemplateItem | "new" | null>(null);
  const [pendingDraft, setPendingDraft] = useState<{ framework: string; category: string; version: string } | null>(null);
  useEffect(() => {
    if (!pendingDraft) return;
    const created = data.kit_templates.find((t) => t.framework === pendingDraft.framework && t.category === pendingDraft.category && t.version === pendingDraft.version);
    if (created) { setSelected(created.id); setPendingDraft(null); }
  }, [data.kit_templates, pendingDraft]);
  const template = data.kit_templates.find((t) => t.id === selected);
  const locked = !!template && (template.published || template.ever_published || data.kit_checks.some((c) => c.template_id === template.id));
  const lines = inWorkbookOrder(data.template_items.filter((i) => i.template_id === selected));
  const health = [
    ...(!lines.length ? ["This template has no lines."] : []),
    ...(lines.some(i=>i.attributes.price_missing) ? ["Review missing sell prices before publication."] : []),
    ...(lines.some(i=>!Number.isInteger(Number(i.baseline_packs))) ? ["Some baseline quantities are fractional packs; review pack sizes and whole-pack entry."] : []),
    ...(lines.some(i=>!i.attributes.item_id) ? ["Some lines have no separate original Item ID; check their source references before Excel export."] : []),
    ...(template?.framework==="ALL"&&lines.some(i=>!i.attributes.statutory_section) ? ["Review mandatory-versus-extra classification for every combined-regulation line."] : []),
  ];
  async function create(form: FormData) {
    const payload = Object.fromEntries(form.entries());
    if (!payload.source_template_id) delete payload.source_template_id;
    if (await command("create_template", payload)) {
      setPendingDraft({ framework: String(payload.framework), category: String(payload.category), version: String(payload.version).trim() });
      setCreating(false);
    }
  }
  async function save(form: FormData) {
    if (!template || !editing) return;
    const original = editing === "new" ? undefined : editing;
    const attrs = { ...original?.attributes };
    if (!original) attrs.sort_order = lines.length ? Math.max(...lines.map((line, index) => (workbookPosition(line.attributes) ?? index + 3) - 3)) + 1 : 0;
    attrs.price_missing = false;
    for (const key of ["item_id", "dose_route", "uses", "side_effects", "statutory_section", "notes"]) attrs[key] = String(form.get(key) ?? "");
    for (const key of ["ned", "refrigerated", "masters_safe", "flammable"]) attrs[key] = form.has(key);
    const payload = { template_id: template.id, ...(original ? { item_id: original.id } : {}), source_code: String(form.get("source_code")), description: String(form.get("description")), location: String(form.get("location")), pack_description: String(form.get("pack_description")), baseline_packs: Number(form.get("baseline_packs")), scaling: String(form.get("scaling")), unit_price: Number(form.get("unit_price")), attributes: attrs };
    if (await command("save_template_item", payload)) setEditing(null);
  }
  const field = (name: string, label: string, value: unknown, type = "text", required = false) => <label key={name}>{label}<input name={name} type={type} defaultValue={String(value ?? "")} required={required} min={type === "number" ? 0 : undefined} step={type === "number" ? "any" : undefined} /></label>;
  return <>
    <div className="info">Published versions are frozen. Clone a version to make changes, review its lines, then publish it for future checks. Existing checks keep their original version and saved quantities and prices.</div>
    <section className="panel template-panel">
      <div className="toolbar"><label>Template version<select aria-label="Template version" value={selected} onChange={(e) => { setSelected(e.target.value); setEditing(null); }}>{<option value="">Choose a template…</option>}{[...data.kit_templates].sort((a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version)).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.version} · {t.published ? "Published" : t.ever_published ? "Retired" : "Draft"}</option>)}</select></label><button className="primary" disabled={busy} onClick={() => { setCreating(!creating); setEditing(null); }}>New template / version</button></div>
      {creating && <form className="template-form" onSubmit={(e) => { e.preventDefault(); void create(new FormData(e.currentTarget)); }}>
        <h2>Create a draft</h2><label>Copy lines from<select name="source_template_id" defaultValue={template?.id ?? ""} onChange={(e) => { const source = data.kit_templates.find((t) => t.id === e.target.value); if (source) for (const key of ["name", "framework", "category"] as const) { const field = e.currentTarget.form?.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null; if (field) field.value = source[key]; } }}><option value="">Start with an empty list</option>{data.kit_templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.version}</option>)}</select></label>
        {field("name", "Template name", template?.name, "text", true)}
        <label>Framework<select name="framework" defaultValue={template?.framework ?? "MSN"}>{["MSN", "Malta", "ALL"].map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Category<select name="category" defaultValue={template?.category ?? "CAT A"}>{["CAT A", "CAT B", "CAT C PLUS"].map((s) => <option key={s}>{s}</option>)}</select></label>
        {field("version", "New version identifier (must be unique in this kit family)", "", "text", true)}
        <button className="primary" disabled={busy}>Create draft</button><button type="button" className="secondary" onClick={() => setCreating(false)}>Cancel</button>
      </form>}
      {template && <>
        <details className="template-provenance"><summary>Template health check — {health.length ? `${health.length} points to review` : "basic data checks clear"}</summary>{health.map(message=><p key={message}>{message}</p>)}<p>Source row order and unique line keys are preserved. Regulatory amendment currency and the suitability of substitutions still require your review.</p></details>
        <div className="template-provenance"><p>{lines.filter((i) => i.attributes.price_missing).length} prices need review before publication.</p>{lines[0]?.attributes.source_filename ? <details><summary>Workbook source and regulation basis</summary><p>{String(lines[0].attributes.source_filename)}</p><p>{String(lines[0].attributes.regulation_basis ?? "")}</p><p>Imported source basis; review amendments and operational quantities before publishing.</p></details> : null}</div>
        <div className="section-heading"><div><h2>{template.name} · {template.version}</h2><p>{lines.length} lines · {template.framework} / {template.category} · {template.published ? "Published" : locked ? "Retired / frozen" : "Editable draft"}</p></div><div className="template-actions">{!locked && <><button className="secondary" disabled={busy} onClick={() => setEditing("new")}>Add line</button><button className="primary" disabled={busy || !lines.length} onClick={() => { if (window.confirm("Publish this version? It will be frozen and replace the currently published version for this kit family.")) void command("publish_template", { template_id: template.id }); }}>Publish version</button></>}{template.published && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm("Retire this version from new checks? Existing checks are preserved.")) void command("retire_template", { template_id: template.id }); }}>Retire version</button>}</div></div>
        {editing && <form key={editing === "new" ? "new" : editing.id} className="template-form" onSubmit={(e) => { e.preventDefault(); void save(new FormData(e.currentTarget)); }}>
          <h2>{editing === "new" ? "Add a template line" : "Edit template line"}</h2>
          {field("source_code", "Unique line key (Item ID | bag)", editing === "new" ? "" : editing.source_code, "text", true)}
          {field("item_id", "Original Item ID", editing === "new" ? "" : editing.attributes.item_id)}
          {field("description", "Description / medicine and dose", editing === "new" ? "" : editing.description, "text", true)}
          {field("location", "Bag / location", editing === "new" ? "" : editing.location)}
          {field("pack_description", "Pack size / breakdown", editing === "new" ? "" : editing.pack_description)}
          {field("baseline_packs", "Packs required at 10 crew", editing === "new" ? 1 : editing.baseline_packs, "number", true)}
          <label>Scaling<select name="scaling" defaultValue={editing === "new" ? "fixed" : editing.scaling}><option value="fixed">Fixed — any crew band</option><option value="band">Scales — crew band / 10</option></select></label>
          {field("unit_price", "MMA sell price per pack (€) — enter a reviewed price", editing === "new" ? "" : editing.attributes.price_missing ? "" : editing.unit_price, "number", true)}
          {["dose_route", "uses", "side_effects", "statutory_section", "notes"].map((key) => field(key, key.replaceAll("_", " "), editing === "new" ? "" : editing.attributes[key]))}
          {["ned", "refrigerated", "masters_safe", "flammable"].map((key) => <label className="checkbox-label" key={key}><input type="checkbox" name={key} defaultChecked={editing !== "new" && editing.attributes[key] === true} />{key === "ned" ? "No expiry date (NED)" : key.replaceAll("_", " ")}</label>)}
          <button className="primary" disabled={busy}>Save line</button><button className="secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
        </form>}
        <div className="toolbar"><input aria-label="Search template lines" placeholder="Find item, bag or code…" value={search} onChange={(e) => setSearch(e.target.value)} /><label>Preview crew band<select value={crew} onChange={(e) => setCrew(Number(e.target.value))}>{[10, 20, 30, 40, 60].map((c) => <option key={c} value={c}>{c} crew</option>)}</select></label></div>
        <div className="table-wrap"><table><thead><tr><th>Item / bag</th><th>10 crew packs</th><th>Scaling</th><th>{crew} crew packs</th><th>Expiry / storage</th><th>Sell / pack</th><th>Actions</th></tr></thead><tbody>{lines.filter((i) => `${i.description} ${i.source_code} ${i.location}`.toLowerCase().includes(search.toLowerCase())).map((i) => <tr key={i.id}><td><strong>{i.description}</strong><small>{String(i.attributes.item_id ?? i.source_code)}</small><small>{i.location} · {i.pack_description}</small><small>{String(i.attributes.statutory_section ?? "")}</small></td><td>{i.baseline_packs}</td><td>{i.scaling === "fixed" ? "Fixed" : "Scales"}</td><td>{requiredPacks(Number(i.baseline_packs), i.scaling, crew)}</td><td>{[i.attributes.ned && "NED", i.attributes.refrigerated && "Refrigerated", i.attributes.masters_safe && "Master’s safe", i.attributes.flammable && "Flammable"].filter(Boolean).join(" · ") || "Dated"}</td><td>{i.attributes.price_missing ? "Price needs review" : euros(i.unit_price)}</td><td>{!locked && <div className="row-actions"><button className="secondary compact" disabled={busy} onClick={() => setEditing(i)}>Edit</button><button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Delete ${i.description} from this draft?`)) void command("delete_template_item", { template_id: template.id, item_id: i.id }); }}>Delete</button></div>}</td></tr>)}</tbody></table></div>
      </>}
      {!template && !creating && <div className="empty"><h3>Manage your kit lists</h3><p>Choose a version to review its requirements, or create a new draft.</p></div>}
    </section>
  </>;
}
