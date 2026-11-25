"use client";

import { useEffect, useRef, useState } from "react";
import type { TemplateItem, Workspace } from "@/lib/types";
import type { Action } from "@/lib/commands";
import { requiredPacks } from "@/lib/rules";
import { isTemplateLineReviewed, templateCrewBands, templateLineIssues, templateMaximumPacks, templatePriceKey } from "@/lib/template-review";
import DraftForm from "./draft-form";
import { inWorkbookOrder, workbookPosition } from "@/lib/workbook-order";

const packPrice = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 4 });

type Props = { data: Workspace; demo?: boolean; busy: boolean; dirty: boolean; onDirtyChange: (dirty: boolean) => void; serverError?: string; command: (action: Action, payload: Record<string, unknown>) => Promise<boolean | undefined> };
export default function TemplatesPage({ data, demo, busy, dirty, onDirtyChange, serverError, command }: Props) {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [nextReviewId, setNextReviewId] = useState<string>();
  const [needsReview, setNeedsReview] = useState(false);
  const [lastSaved, setLastSaved] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [editError, setEditError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TemplateItem | "new" | null>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<{ line: TemplateItem | "new"; quantity: string; scaling: TemplateItem["scaling"]; itemId: string; pack: string; maximum: string }>();
  const [pendingDraft, setPendingDraft] = useState<{ framework: string; category: string; version: string } | null>(null);
  useEffect(() => {
    setPreview(undefined);
    if (editing) editHeading.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!pendingDraft) return;
    const created = data.kit_templates.find((t) => t.framework === pendingDraft.framework && t.category === pendingDraft.category && t.version === pendingDraft.version);
    if (created) { setSelected(created.id); setPendingDraft(null); }
  }, [data.kit_templates, pendingDraft]);
  useEffect(() => {
    if (nextReviewId) {
      setEditing(data.template_items.find(line => line.id === nextReviewId) ?? null);
      setNextReviewId(undefined);
    }
  }, [data.template_items, nextReviewId]);
  const template = data.kit_templates.find((t) => t.id === selected);
  const locked = !!template && (template.published || template.ever_published || data.kit_checks.some((c) => c.template_id === template.id));
  const lines = inWorkbookOrder(data.template_items.filter((i) => i.template_id === selected));
  const remaining = lines.filter(line => !isTemplateLineReviewed(line));
  const baseline = editing === "new" ? "1" : editing?.attributes.requirement_unknown ? "" : String(editing?.baseline_packs ?? "");
  const currentPreview = preview && preview.line === editing ? preview : { quantity: baseline, maximum: editing && editing !== "new" ? String(templateMaximumPacks(editing.attributes) ?? "") : "", scaling: editing && editing !== "new" ? editing.scaling : "fixed" as const };
  const sharedPricingReady = demo || data.template_sell_prices !== undefined;
  const editedLine = editing && editing !== "new" ? editing : undefined;
  const itemKey = templatePriceKey(preview?.line === editing ? preview?.itemId : editedLine?.attributes.item_id);
  const packKey = templatePriceKey(preview?.line === editing ? preview?.pack : editedLine?.pack_description);
  const sharedPrice = data.template_sell_prices?.find(price => price.item_key === itemKey && price.pack_key === packKey);
  const matchingDraftLines = itemKey && packKey ? data.template_items.filter(line =>
    line.id !== editedLine?.id && templatePriceKey(line.attributes.item_id) === itemKey && templatePriceKey(line.pack_description) === packKey &&
    data.kit_templates.some(t => t.id === line.template_id && !t.published && !t.ever_published) &&
    !data.kit_checks.some(check => check.template_id === line.template_id)).length : 0;
  const health = [
    ...(!lines.length ? ["This template has no lines."] : []),
    ...(lines.some(i=>i.attributes.price_missing) ? ["Review missing sell prices before publication."] : []),
    ...(lines.some(i=>i.scaling === "fixed" && !Number.isInteger(Number(i.baseline_packs))) ? ["Some baseline quantities are fractional packs; review pack sizes and whole-pack entry."] : []),
    ...(lines.some(i=>!i.attributes.item_id) ? ["Some lines have no separate original Item ID; check their source references before Excel export."] : []),
    ...(template?.framework==="ALL"&&lines.some(i=>!i.attributes.statutory_section) ? ["Review mandatory-versus-extra classification for every combined-regulation line."] : []),
  ];
  const canLeave = () => !busy && (!dirty || window.confirm("Discard unsaved template changes?"));
  function openLine(line: TemplateItem | "new" | null) {
    if (!canLeave()) return;
    setEditError("");
    setSaveFailed(false);
    setCreating(false);
    setEditing(line);
  }
  async function create(form: FormData) {
    const payload = Object.fromEntries(form.entries());
    if (!payload.source_template_id) delete payload.source_template_id;
    if (await command("create_template", payload)) {
      setPendingDraft({ framework: String(payload.framework), category: String(payload.category), version: String(payload.version).trim() });
      setCreating(false);
    }
  }
  async function save(form: FormData, advance: boolean) {
    setEditError("");
    setSaveFailed(false);
    if (!template || !editing) return;
    const original = editing === "new" ? undefined : editing;
    const attrs = { ...original?.attributes };
    if (!original) attrs.sort_order = lines.length ? Math.max(...lines.map((line, index) => (workbookPosition(line.attributes) ?? index + 3) - 3)) + 1 : 0;
    const price = String(form.get("unit_price") ?? "").trim();
    const quantity = String(form.get("baseline_packs") ?? "").trim();
    const scaling = String(form.get("scaling"));
    const maximum = scaling === "band" ? String(form.get("maximum_packs") ?? "").trim() : "";
    delete attrs.maximum_packs;
    if (maximum !== "") {
      const cap = Number(maximum);
      if (!quantity || !Number.isInteger(cap) || cap < Math.round(Number(quantity)) || cap > 1000000) {
        setEditError("Enter a whole-pack maximum at least as large as the 10-crew quantity.");
        return;
      }
      attrs.maximum_packs = cap;
    }
    attrs.price_missing = price === "";
    attrs.requirement_unknown = quantity === "";
    attrs.price_quantity_reviewed = form.has("price_quantity_reviewed");
    if (attrs.price_quantity_reviewed && (!price || !quantity || (scaling === "fixed" && !Number.isInteger(Number(quantity))))) {
      setEditError("Enter a sell price and a valid quantity before confirming. Fixed quantities must be whole packs.");
      return;
    }
    for (const key of ["item_id", "dose_route", "uses", "side_effects", "statutory_section", "notes"]) attrs[key] = String(form.get(key) ?? "");
    for (const key of ["ned", "refrigerated", "masters_safe", "flammable"]) attrs[key] = form.has(key);
    const payload = { share_price: form.has("share_price"), template_id: template.id, ...(original ? { item_id: original.id, expected_revision: original.edit_revision } : {}), source_code: String(form.get("source_code")), description: String(form.get("description")), location: String(form.get("location")), pack_description: String(form.get("pack_description")), baseline_packs: Number(quantity), scaling, unit_price: Number(price), attributes: attrs };
    if (await command("save_template_item", payload)) {
      const index = original ? lines.findIndex(line => line.id === original.id) : -1;
      const next = [...lines.slice(index + 1), ...lines.slice(0, Math.max(0, index))]
        .find(line => !isTemplateLineReviewed(line));
      setLastSaved(String(payload.description));
      setEditing(null);
      if (advance && next) setNextReviewId(next.id);
    } else setSaveFailed(true);
  }
  const field = (name: string, label: string, value: unknown, type = "text", required = false) => <label key={name}>{label}<input name={name} type={type} defaultValue={String(value ?? "")} required={required} min={type === "number" ? 0 : undefined} step={type === "number" ? "any" : undefined} /></label>;
  return <>
    <section className="panel template-panel">
      <div className="toolbar template-selection"><label>Template version<select aria-label="Template version" value={selected} onChange={(e) => { if (!canLeave()) return; setSelected(e.target.value); setEditing(null); setEditError(""); setSearch(""); setLastSaved(""); }}>{<option value="">Choose a template…</option>}{data.kit_templates.filter(t => showRetired || t.published || !t.ever_published || t.id === selected).sort((a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version)).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.version} · {t.published ? "Published" : t.ever_published ? "Retired" : "Draft"}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />Show retired versions</label><button className="primary" disabled={busy} onClick={() => { if (!canLeave()) return; setCreating(!creating); setEditing(null); }}>New template / version</button></div>
      {creating && <DraftForm busy={busy} className="template-form" onDirtyChange={onDirtyChange} onSubmit={(e) => { e.preventDefault(); void create(new FormData(e.currentTarget)); }}>
        <h2>Create a draft</h2><label>Copy lines from<select name="source_template_id" defaultValue={template?.id ?? ""} onChange={(e) => { const source = data.kit_templates.find((t) => t.id === e.target.value); if (source) for (const key of ["name", "framework", "category"] as const) { const field = e.currentTarget.form?.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null; if (field) field.value = source[key]; } }}><option value="">Start with an empty list</option>{data.kit_templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.version}</option>)}</select></label>
        {field("name", "Template name", template?.name, "text", true)}
        <label>Framework<select name="framework" defaultValue={template?.framework ?? "MSN"}>{["MSN", "Malta", "ALL"].map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Category<select name="category" defaultValue={template?.category ?? "CAT A"}>{["CAT A", "CAT B", "CAT C PLUS"].map((s) => <option key={s}>{s}</option>)}</select></label>
        {field("version", "New version identifier (must be unique in this kit family)", "", "text", true)}
        <button className="primary" disabled={busy}>Create draft</button><button type="button" className="secondary" onClick={() => { if (canLeave()) setCreating(false); }}>Cancel</button>
      </DraftForm>}
      {template && <>
        <div className="section-heading template-heading"><div><h2>{template.name} · {template.version}</h2><p>{lines.length} lines · {template.framework} / {template.category} · {template.published ? "Published" : locked ? "Retired / frozen" : "Editable draft"}</p></div><div className="template-actions">{!locked && <><button className="secondary" disabled={busy} onClick={() => openLine("new")}>Add line</button>{sharedPricingReady && <button className="secondary" disabled={busy} onClick={async () => {
          if (canLeave() && window.confirm(`Delete draft ${template.name} ${template.version} and all its lines?`) &&
            await command("delete_template", { template_id: template.id })) {
            setSelected(""); setEditing(null);
          }
        }}>Delete draft</button>}<button className="primary" disabled={busy || !lines.length || remaining.length > 0} onClick={() => { if (canLeave() && window.confirm("Publish this version? It will be frozen and replace the currently published version for this kit family.")) void command("publish_template", { template_id: template.id }); }}>Publish version</button></>}{locked && <button className="primary" disabled={busy} onClick={() => { setEditing(null); setCreating(true); }}>Clone for review</button>}{template.published && <button className="secondary" disabled={busy} onClick={() => { if (window.confirm("Retire this version from new checks? Existing checks are preserved.")) void command("retire_template", { template_id: template.id }).then(ok => { if (ok) { setSelected(""); setEditing(null); } }); }}>Retire version</button>}</div></div>
        <div className="template-review-summary">
          <div>
            <strong>{locked ? "Version history" : `${lines.length - remaining.length} of ${lines.length} lines reviewed`}</strong>
            {!locked && <progress aria-label="Template review progress" value={lines.length - remaining.length} max={lines.length || 1} />}
            <p>{locked ? "Create a draft to edit this version for future checks." : "Edit and save each line as you go. Finish reviewing all lines before publishing."}</p>
          </div>
          {!locked && <button className="primary" disabled={busy || !remaining.length} onClick={() => openLine(remaining[0])}>Review next line</button>}
        </div>
        <details className="template-provenance"><summary>Health and source{health.length ? ` ? ${health.length} to review` : ""}</summary>
          {health.map(message => <p key={message}>{message}</p>)}
          {typeof lines[0]?.attributes.source_filename === "string" && <p>{lines[0].attributes.source_filename}</p>}
          {typeof lines[0]?.attributes.regulation_basis === "string" && <p>{lines[0].attributes.regulation_basis}</p>}
        </details>
        {lastSaved && <p className="template-save-status" role="status">Saved {lastSaved}</p>}
        {editing && <DraftForm busy={busy} key={editing === "new" ? "new" : editing.id} className="template-form" onDirtyChange={onDirtyChange} onDraftChange={element => {
          const form = new FormData(element);
          const maximum = element.elements.namedItem("maximum_packs") as HTMLInputElement | null;
          setPreview({ line: editing, quantity: String(form.get("baseline_packs") ?? ""), scaling: form.get("scaling") === "band" ? "band" : "fixed", itemId: String(form.get("item_id") ?? ""), pack: String(form.get("pack_description") ?? ""), maximum: maximum?.value ?? "" });
        }} onSubmit={(e) => { e.preventDefault(); void save(new FormData(e.currentTarget), (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "next"); }}>
          <h2 ref={editHeading} tabIndex={-1}>{editing === "new" ? "Add a template line" : `Review ${editing.description}`}</h2>
          {field("source_code", "Unique line key (Item ID | bag)", editing === "new" ? "" : editing.source_code, "text", true)}
          {field("item_id", "Original Item ID", editing === "new" ? "" : editing.attributes.item_id)}
          {field("description", "Description / medicine and dose", editing === "new" ? "" : editing.description, "text", true)}
          {field("location", "Bag / location", editing === "new" ? "" : editing.location)}
          {field("pack_description", "Pack size / breakdown", editing === "new" ? "" : editing.pack_description)}
          {field("baseline_packs", "Baseline packs at 10 crew", baseline, "number")}
          <label>Scaling<select name="scaling" defaultValue={editing === "new" ? "fixed" : editing.scaling}><option value="fixed">Fixed — any crew band</option><option value="band">Scales — crew band / 10</option></select></label>
          <label>Maximum packs for scaled lines (optional)<input name="maximum_packs" type="number" min={0} max={1000000} step={1}
            disabled={currentPreview.scaling !== "band"}
            defaultValue={editing === "new" ? "" : templateMaximumPacks(editing.attributes) ?? ""} /></label>
          {field("unit_price", "MMA sell price per pack (€) — enter a reviewed price", editing === "new" ? "" : editing.attributes.price_missing ? "" : editing.unit_price, "number")}
          {sharedPricingReady && <div>
            <label className="checkbox-label"><input type="checkbox" name="share_price" disabled={!itemKey || !packKey} />Update shared price</label>
            <small>{sharedPrice ? `Current shared price ${packPrice.format(sharedPrice.unit_price)} per pack. ` : ""}Applies to the same Item ID and pack breakdown in editable drafts. {matchingDraftLines ? `${matchingDraftLines} other draft lines match.` : ""}</small>
          </div>}
          <div className="template-actions" aria-label="Calculated packs by crew band">{templateCrewBands.map(band => <span key={band}><strong>{band} crew</strong>{" "}{currentPreview.quantity && Number.isFinite(Number(currentPreview.quantity)) && Number(currentPreview.quantity) >= 0 ? requiredPacks(Number(currentPreview.quantity), currentPreview.scaling, band, currentPreview.maximum && Number.isInteger(Number(currentPreview.maximum)) && Number(currentPreview.maximum) >= 0 ? Number(currentPreview.maximum) : undefined) : "—"} packs</span>)}</div>
          {editing !== "new" && editing.attributes.source_arrival_row != null && <p>Source workbook arrival row {String(editing.attributes.source_arrival_row)}</p>}
          {["dose_route", "uses", "side_effects", "statutory_section", "notes"].map((key) => field(key, key.replaceAll("_", " "), editing === "new" ? "" : editing.attributes[key]))}
          {["ned", "refrigerated", "masters_safe", "flammable"].map((key) => <label className="checkbox-label" key={key}><input type="checkbox" name={key} defaultChecked={editing !== "new" && editing.attributes[key] === true} />{key === "ned" ? "No expiry date (NED)" : key.replaceAll("_", " ")}</label>)}
          <label className="checkbox-label"><input type="checkbox" name="price_quantity_reviewed" />I verified the sell price per pack, pack breakdown and crew quantities for this line.</label>
          {(editError || (saveFailed && serverError)) && <div role="alert" className="error">{editError || serverError}</div>}
          <div className="template-actions"><button className="primary" disabled={busy}>Save line</button><button className="secondary" value="next" disabled={busy}>Save and review next</button></div><button className="secondary" type="button" onClick={() => openLine(null)}>Cancel</button>
        </DraftForm>}
        <div className="toolbar template-line-filters"><input aria-label="Search template lines" placeholder="Find item, bag or code…" value={search} onChange={(e) => setSearch(e.target.value)} /><label className="checkbox-label"><input type="checkbox" checked={needsReview} onChange={e => setNeedsReview(e.target.checked)} />Needs review only</label></div>
        <div className="table-wrap"><table><thead><tr><th>Item / bag</th><th>Baseline packs</th><th>Scaling</th>{templateCrewBands.map(band => <th key={band}>{band} crew</th>)}<th>Expiry / storage</th><th>Sell / pack</th><th>Review</th><th>Actions</th></tr></thead><tbody>{lines.filter((i) => `${i.description} ${i.source_code} ${i.location}`.toLowerCase().includes(search.toLowerCase()) && (!needsReview || !isTemplateLineReviewed(i))).map((i) => <tr key={i.id}><td><strong>{i.description}</strong><small>{String(i.attributes.item_id ?? i.source_code)}</small><small>{i.location} · {i.pack_description}</small><small>{String(i.attributes.statutory_section ?? "")}</small></td><td>{i.attributes.requirement_unknown ? "Missing" : i.baseline_packs}</td><td>{i.scaling === "fixed" ? "Fixed" : templateMaximumPacks(i.attributes) === undefined ? "Scales" : `Scales up to ${templateMaximumPacks(i.attributes)} packs`}</td>{templateCrewBands.map(band => <td key={band}>{i.attributes.requirement_unknown ? "-" : requiredPacks(Number(i.baseline_packs), i.scaling, band, templateMaximumPacks(i.attributes))}</td>)}<td>{[i.attributes.ned && "NED", i.attributes.refrigerated && "Refrigerated", i.attributes.masters_safe && "Master’s safe", i.attributes.flammable && "Flammable"].filter(Boolean).join(" · ") || "Dated"}</td><td>{i.attributes.price_missing ? "Price needs review" : packPrice.format(i.unit_price)}</td><td>{isTemplateLineReviewed(i) ? "Reviewed" : templateLineIssues(i).join(", ") || "Needs review"}</td><td>{!locked && <div className="row-actions"><button className="secondary compact" disabled={busy} onClick={() => openLine(i)}>Edit</button><button className="text-button" disabled={busy} onClick={() => { if (canLeave() && window.confirm(`Delete ${i.description} from this draft?`)) { setEditing(null); void command("delete_template_item", { template_id: template.id, item_id: i.id, expected_revision: i.edit_revision }); } }}>Delete</button></div>}</td></tr>)}</tbody></table></div>
      </>}
      {!template && !creating && <div className="empty"><h3>Manage your kit lists</h3><p>Choose a version to review its requirements, or create a new draft.</p></div>}
    </section>
  </>;
}
