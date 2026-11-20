import { z } from "zod";
import type { Workspace, Batch } from "./types";
import { addMonths, keepExisting, quantities, requiredPacks, validSupplyExpiry } from "./rules";

const text = z.string().trim().min(1).max(500);
const optional = z.string().trim().max(4000).default("");
const contact = { name: text, email: z.union([z.email(), z.literal("")]).default(""), phone: optional, notes: optional };
export const schemas = {
  acknowledge_import_review: z.object({ check_id: text, reason: z.string().trim().min(1).max(4000) }),
  edit_check_item: z.object({ item_id: text, substitute_description: z.string().trim().max(500).default(""), pack_description: optional, required_packs: z.coerce.number().finite().min(0).max(1000000), unit_price: z.coerce.number().finite().min(0).max(1000000), reason: z.string().trim().min(1).max(4000) }),
  create_template: z.object({ name: text, framework: z.enum(["MSN", "Malta", "ALL"]), category: text, version: text, source_template_id: text.optional() }),
  save_template_item: z.object({ template_id: text, item_id: text.optional(), source_code: text, description: text, location: optional, pack_description: optional, baseline_packs: z.coerce.number().finite().min(0).max(1000000), scaling: z.enum(["fixed", "band"]), unit_price: z.coerce.number().finite().min(0).max(1000000), attributes: z.record(z.string(), z.unknown()).default({}) }),
  delete_template_item: z.object({ template_id: text, item_id: text }),
  publish_template: z.object({ template_id: text }),
  retire_template: z.object({ template_id: text }),
  set_kill_line: z.object({ item_id: text, kill_line: z.boolean() }),
  create_client: z.object({ ...contact, billing_address: optional }),
  create_vendor: z.object(contact),
  create_vessel: z.object({ name: text, client_id: text, framework: z.enum(["MSN", "Malta", "Other"]), flag_state: optional, crew: z.coerce.number().int().min(1).max(60), loyalty: z.boolean().default(false) }),
  create_vendor_product: z.object({ vendor_id: text, description: text, sku: optional, pack_description: optional, price: z.coerce.number().min(0).max(1000000) }),
  create_check: z.object({ vessel_id: text, template_id: text, check_date: z.iso.date(), job_type: z.enum(["Routine Refill", "Category Swap", "Restructure", "New Build"]) }),
  add_batch: z.object({ item_id: text, quantity: z.coerce.number().int().positive().max(100000), expiry: z.union([z.iso.date(), z.literal("")]).default(""), no_expiry: z.boolean().default(false), notes: optional }).refine((v) => v.no_expiry ? !v.expiry : !!v.expiry && v.expiry.endsWith("-01"), "Enter an expiry month or select no expiry."),
  mark_assessed: z.object({ item_id: text, state: z.enum(["reviewed", "not_applicable"]) }),
  create_quote: z.object({ check_id: text, assessment_fee: z.coerce.number().min(0).max(1000000) }),
  approve_quote: z.object({ check_id: text }),
  finish: z.object({ check_id: text }),
};
export type Action = keyof typeof schemas;
export function parseCommand(input: unknown) {
  const command = z.object({ action: z.enum(Object.keys(schemas) as [Action, ...Action[]]), payload: z.unknown() }).parse(input);
  return { action: command.action, payload: schemas[command.action].parse(command.payload) };
}

// Fictional local preview only. The live database independently enforces all transitions.
export function applyDemoCommand(original: Workspace, input: unknown): Workspace {
  const { action, payload } = parseCommand(input);
  const p = payload as Record<string, unknown>;
  const data = structuredClone(original);
  const id = crypto.randomUUID();
  if (action === "create_template") {
    if (data.kit_templates.some((t) => t.framework === p.framework && t.category === p.category && t.version === p.version)) throw new Error("This version already exists.");
    const source = p.source_template_id ? data.kit_templates.find((t) => t.id === p.source_template_id) : undefined;
    if (p.source_template_id && !source) throw new Error("Source template not found.");
    if (source && (source.framework !== p.framework || source.category !== p.category)) throw new Error("A new version must keep its source framework and category.");
    data.kit_templates.push({ id, name: String(p.name), framework: String(p.framework), category: String(p.category), version: String(p.version), published: false, ever_published: false });
    if (source) for (const line of original.template_items.filter((i) => i.template_id === source.id)) data.template_items.push({ ...structuredClone(line), id: crypto.randomUUID(), template_id: id });
  } else if (["save_template_item", "delete_template_item", "publish_template", "retire_template"].includes(action)) {
    const template = data.kit_templates.find((t) => t.id === p.template_id);
    if (!template) throw new Error("Template not found.");
    if (action === "publish_template") {
      if (!data.template_items.some((i) => i.template_id === template.id)) throw new Error("Template has no items.");
      if (data.template_items.some((i) => i.template_id === template.id && i.attributes.price_missing === true)) throw new Error("Review missing sell prices before publishing.");
      for (const t of data.kit_templates) if (t.framework === template.framework && t.category === template.category) { if (t.published) t.ever_published = true; t.published = false; }
      template.published = true; template.ever_published = true;
    } else if (action === "retire_template") { if (template.published) template.ever_published = true; template.published = false; }
    else {
      if (template.published || template.ever_published || data.kit_checks.some((c) => c.template_id === template.id)) throw new Error("Published or used templates are immutable. Create a new version.");
      const index = data.template_items.findIndex((i) => i.id === p.item_id && i.template_id === template.id);
      if (p.item_id && index < 0) throw new Error("Template item not found.");
      if (action === "delete_template_item") data.template_items.splice(index, 1);
      else {
        if (data.template_items.some((i) => i.template_id === template.id && i.source_code === p.source_code && i.id !== p.item_id)) throw new Error("Line key already exists.");
        const line = { ...p, id: p.item_id || id } as Workspace["template_items"][number];
        if (index < 0) data.template_items.push(line); else data.template_items[index] = line;
      }
    }
  } else if (action === "create_client") data.clients.push({ id, ...payload } as Workspace["clients"][number]);
  else if (action === "create_vendor") data.vendors.push({ id, ...payload } as Workspace["vendors"][number]);
  else if (action === "create_vessel") {
    if (!data.clients.some((c) => c.id === p.client_id)) throw new Error("Choose a client.");
    data.vessels.push({ id, ...payload } as Workspace["vessels"][number]);
  } else if (action === "create_vendor_product") data.vendor_products.push({ id, ...payload } as Workspace["vendor_products"][number]);
  else if (action === "create_check") {
    const vessel = data.vessels.find((v) => v.id === p.vessel_id);
    const template = data.kit_templates.find((t) => t.id === p.template_id && t.published);
    if (!vessel?.client_id || !template || (template.framework !== vessel.framework && template.framework !== "ALL")) throw new Error("Choose a vessel with a client and a compatible published template.");
    const templateItems = data.template_items.filter((i) => i.template_id === template.id);
    if (!templateItems.length) throw new Error("Template has no items.");
    const check = { id, vessel_id: vessel.id, client_id: vessel.client_id, template_id: template.id, check_date: String(p.check_date), valid_until: addMonths(String(p.check_date), 12), crew: vessel.crew, job_type: String(p.job_type), status: "assessing" as const, notes: "", assessment_fee: 0, loyalty: vessel.loyalty };
    data.kit_checks.push(check);
    for (const item of templateItems) data.check_items.push({ id: crypto.randomUUID(), check_id: id, template_item_id: item.id, source_code: item.source_code, description: item.description, location: item.location, pack_description: item.pack_description, required_packs: requiredPacks(item.baseline_packs, item.scaling, vessel.crew), unit_price: item.unit_price, assessment_state: "unreviewed", attributes: structuredClone(item.attributes), kill_line: false });
  } else {
    const item = data.check_items.find((i) => i.id === p.item_id);
    const check = data.kit_checks.find((c) => c.id === (item?.check_id ?? p.check_id));
    if (!check) throw new Error("Kit check not found.");
    const items = data.check_items.filter((i) => i.check_id === check.id);
    if (["create_quote", "finish"].includes(action)) {
      if (check.attributes?.imported === true && check.attributes?.review_required === true) throw new Error("Review the imported workbook issues and record the import review first.");
      if (items.some((i) => i.attributes?.requirement_unknown === true)) throw new Error("Review unknown imported quantities before continuing.");
    }
    if (action === "acknowledge_import_review") {
      if (check.attributes?.imported !== true) throw new Error("This is not an imported check.");
      check.attributes = { ...check.attributes, review_required: false, reviewed_at: new Date().toISOString(), review_notes: p.reason };
    } else if (action === "edit_check_item") {
      if (!item || !["assessing", "packing"].includes(check.status)) throw new Error("Line editing is locked while a quote awaits approval or after completion.");
      if (check.status === "packing" && (Number(p.required_packs) !== Number(item.required_packs) || Number(p.unit_price) !== Number(item.unit_price) || p.pack_description !== item.pack_description)) throw new Error("Quantity, pack size and price are locked after quote approval; review a revised quote before changing them.");
      const attrs = item.attributes ?? {};
      const original = String(attrs.original_description ?? item.description);
      item.attributes = { ...attrs, original_description: original, original_required_packs: attrs.original_required_packs ?? item.required_packs, original_unit_price: attrs.original_unit_price ?? item.unit_price, original_pack_description: attrs.original_pack_description ?? item.pack_description, substitute_description: p.substitute_description, override_reason: p.reason, edited_at: new Date().toISOString(), requirement_unknown: false, price_missing: false };
      item.description = String(p.substitute_description || original);
      item.pack_description = String(p.pack_description);
      item.required_packs = Number(p.required_packs); item.unit_price = Number(p.unit_price);
    } else if (action === "set_kill_line") {
      if (!item || check.status !== "assessing") throw new Error("Assessment is locked.");
      item.kill_line = Boolean(p.kill_line);
    } else if (action === "mark_assessed") {
      if (!item || check.status !== "assessing") throw new Error("Assessment is locked.");
      if (p.state === "not_applicable" && quantities(item, data.batches).kept > 0) throw new Error("An item with retained stock cannot be excluded.");
      item.assessment_state = p.state as "reviewed" | "not_applicable";
    } else if (action === "add_batch") {
      if (!item || !["assessing", "packing"].includes(check.status)) throw new Error("Batch entry is locked.");
      const expiry = p.expiry ? String(p.expiry) : null;
      let kind: Batch["kind"];
      if (check.status === "assessing") {
        if (item.assessment_state === "not_applicable") throw new Error("Item is not applicable.");
        kind = keepExisting(expiry, Boolean(p.no_expiry), check.valid_until) ? "kept" : "removed";
      } else {
        if (item.assessment_state !== "reviewed") throw new Error("Review the item first.");
        if (Number(p.quantity) > quantities(item, data.batches).outstanding) throw new Error("Supply exceeds outstanding quantity.");
        if (!validSupplyExpiry(expiry, Boolean(p.no_expiry), check.valid_until)) throw new Error("Supplied batch has insufficient expiry coverage.");
        kind = "supplied";
      }
      data.batches.push({ id, check_item_id: item.id, kind, quantity: Number(p.quantity), expiry, no_expiry: Boolean(p.no_expiry), notes: String(p.notes), created_at: new Date().toISOString() });
    } else if (action === "create_quote") {
      if (check.status !== "assessing" || items.some((i) => i.assessment_state === "unreviewed")) throw new Error("Review every line before preparing the quote.");
      if (check.job_type === "New Build") throw new Error("New-build pricing is not yet configured in this pilot.");
      if (items.some((i) => i.attributes?.price_missing === true)) throw new Error("Review missing sell prices before quoting.");
      const lines = items.map((i) => ({ description: i.description, quantity: quantities(i, data.batches).needed, unit_price: i.unit_price })).filter((i) => i.quantity > 0);
      lines.push({ description: "Assessment fee (net, manually reviewed)", quantity: 1, unit_price: Number(p.assessment_fee) });
      data.quotes.push({ id, check_id: check.id, status: "draft", subtotal: Math.round(lines.reduce((s, i) => s + i.quantity * i.unit_price, 0) * 100) / 100, lines, created_at: new Date().toISOString() });
      check.status = "awaiting_approval";
      check.assessment_fee = Number(p.assessment_fee);
    } else if (action === "approve_quote") {
      const quote = data.quotes.findLast((q) => q.check_id === check.id && q.status === "draft");
      if (check.status !== "awaiting_approval" || !quote) throw new Error("No quote awaiting approval.");
      quote.status = "approved"; check.status = "packing";
    } else if (action === "finish") {
      if (check.status !== "packing" || items.some((i) => i.assessment_state === "unreviewed" || quantities(i, data.batches).outstanding > 0)) throw new Error("Outstanding packing remains.");
      check.status = "complete";
      check.attributes = { ...check.attributes, forecast_eligible: true };
    }
  }
  return data;
}
