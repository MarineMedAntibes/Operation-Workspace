import { z } from "zod";
import type { Workspace, Batch } from "./types";
import { addMonths, keepExisting, quantities, requiredPacks, validSupplyExpiry } from "./rules";
import { workflowSchemas, applySlotCommand } from "./check-workflow";
import { calculateFinance } from "./finance";
import { isTemplateLineReviewed, templateMaximumPacks, templatePriceKey } from "./template-review";

const text = z.string().trim().min(1).max(500);
const optional = z.string().trim().max(4000).default("");
const contact = { name: text, email: z.union([z.email(), z.literal("")]).default(""), phone: optional, notes: optional };
const client = z.object({ ...contact, billing_address: optional });
const vessel = z.object({
  name: text, client_id: z.union([text, z.literal("")]).default(""),
  new_client: client.optional(), framework: z.enum(["MSN", "Malta", "Other"]),
  flag_state: optional, crew: z.coerce.number().int().min(1).max(60), loyalty: z.boolean().default(false),
});
const product = z.object({
  vendor_id: z.union([text, z.literal("")]), description: text, sku: optional, pack_description: optional,
  price: z.preprocess(value => value === "" ? null : value, z.coerce.number().min(0).max(1000000).nullable()),
});
export const schemas = {
  ...workflowSchemas,
  acknowledge_import_review: z.object({ check_id: text, reason: z.string().trim().min(1).max(4000) }),
  edit_check_item: z.object({ item_id: text, substitute_description: z.string().trim().max(500).default(""), pack_description: optional, required_packs: z.coerce.number().finite().min(0).max(1000000), unit_price: z.coerce.number().finite().min(0).max(1000000), reason: z.string().trim().min(1).max(4000),dose_route:z.string().trim().max(4000).optional(),uses:z.string().trim().max(4000).optional(),side_effects:z.string().trim().max(4000).optional() }),
  create_template: z.object({ name: text, framework: z.enum(["MSN", "Malta", "ALL"]), category: text, version: text, source_template_id: text.optional() }),
  save_template_item: z.object({ template_id: text, item_id: text.optional(), expected_revision: z.uuid().optional(), source_code: text, description: text, location: optional, pack_description: optional, baseline_packs: z.coerce.number().finite().min(0).max(1000000), scaling: z.enum(["fixed", "band"]), unit_price: z.coerce.number().finite().min(0).max(1000000), attributes: z.record(z.string(), z.unknown()).default({}), share_price: z.boolean().optional() }),
  delete_template: z.object({ template_id: text }),
  delete_template_item: z.object({ template_id: text, item_id: text, expected_revision: z.uuid().optional() }),
  publish_template: z.object({ template_id: text }),
  retire_template: z.object({ template_id: text }),
  set_kill_line: z.object({ item_id: text, kill_line: z.boolean() }),
  create_client: client,
  create_vendor: z.object(contact),
  create_vessel: vessel,
  create_vendor_product: product.extend({ vendor_id: text }),
  update_client: client.extend({ id: text, active_season: z.string().regex(/^(20\d{2})?$/) }),
  update_vendor: z.object({ ...contact, id: text }),
  update_vessel: vessel.extend({ id: text }),
  update_vendor_product: product.extend({ id: text }),
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

function isEditableTemplate(data: Workspace, templateId: string) {
  const template = data.kit_templates.find(t => t.id === templateId);
  return !!template && !template.published && !template.ever_published && !data.kit_checks.some(c => c.template_id === templateId);
}

function applyParentPrice(line: Workspace["template_items"][number], price: number) {
  if (line.unit_price === price && line.attributes.price_missing !== true) return;
  line.unit_price = price;
  line.attributes.price_missing = false;
  delete line.attributes.price_quantity_reviewed;
}

// Fictional local preview only. The live database independently enforces all transitions.
export function applyDemoCommand(original: Workspace, input: unknown): Workspace {
  const { action, payload } = parseCommand(input);
  const p = payload as Record<string, unknown>;
  const data = structuredClone(original);
  const id = crypto.randomUUID();
  if (action in workflowSchemas) {
    const item=data.check_items.find(i=>i.id===p.item_id);
    const check=data.kit_checks.find(c=>c.id===(p.check_id ?? item?.check_id));
    if (!check) throw new Error("Check not found.");
    if(action==='save_check_header') {
      const header=workflowSchemas.save_check_header.parse(p);
      if(check.status!=='assessing'||data.invoices?.some(i=>i.check_id===check.id))throw new Error('Reopen assessment before changing check settings.');
      const oldCrew=check.crew;
      Object.assign(check,{check_date:header.check_date,valid_until:header.valid_until,crew:header.crew,job_type:header.job_type,loyalty:header.loyalty});
      for(const line of data.check_items.filter(i=>i.check_id===check.id)){
        const template=data.template_items.find(t=>t.id===line.template_item_id);
        if(oldCrew!==header.crew&&template&&!line.attributes?.edited_at&&line.attributes?.source_override_add_packs==null)line.required_packs=requiredPacks(template.baseline_packs,template.scaling,header.crew,templateMaximumPacks(template.attributes));
        line.assessment_state='unreviewed';
        for(const batch of data.batches.filter(b=>b.check_item_id===line.id&&!b.voided_at&&b.kind!=='supplied')){
          batch.voided_at=new Date().toISOString();data.batches.push({...batch,id:crypto.randomUUID(),voided_at:null,kind:keepExisting(batch.expiry,batch.no_expiry,header.valid_until)?'kept':'removed',notes:`Reassessed after header correction: ${header.reason}`});
        }
      }
      check.attributes={...check.attributes,header_correction_reason:header.reason};
      const settings=check.attributes.workflow as {finance?:Record<string,unknown>}|undefined;
      if(settings?.finance){for(const key of ['standard_fee','assessment_fee_override','loyalty_discount_percent','proceeds_credit_percent','new_build_kit_price'])delete settings.finance[key];settings.finance.pricing_reviewed=false;settings.finance.tax_reviewed=false;}
    } else if (action==='save_line_slots') applySlotCommand(data,check,item!,workflowSchemas.save_line_slots.parse(p));
    else if (action==='save_check_setup') {
      const setup=workflowSchemas.save_check_setup.parse(p).workflow;
      const old=check.attributes?.workflow as {finance?:unknown}|undefined;
      if(check.status!=='assessing' && JSON.stringify(old?.finance??{})!==JSON.stringify(setup.finance)) throw new Error('Revise the quote before changing approved pricing.');
      check.attributes={...check.attributes,workflow:setup};
    } else if(action==='revise_quote') {
      if(check.status==='complete'||data.invoices?.some(i=>i.check_id===check.id)) throw new Error('Completed or invoiced checks require a separate correction.');
      data.quotes.filter(q=>q.check_id===check.id&&!q.superseded_at).forEach(q=>{q.superseded_at=new Date().toISOString();});
      check.status='assessing';
    } else if(action==='prepare_quote') {
      if(check.status!=='assessing'||check.attributes?.review_required||data.check_items.some(i=>i.check_id===check.id&&(i.assessment_state==='unreviewed'||i.attributes?.requirement_unknown||i.attributes?.price_missing))) throw new Error('Review every assessment line and imported issues first.');
      const snapshot=calculateFinance(data,check,'quote');
      if(snapshot.pricing_missing||!snapshot.tax_reviewed||(check.attributes?.workflow as {finance?:{pricing_reviewed?:boolean}}|undefined)?.finance?.pricing_reviewed!==true) throw new Error('Review pricing and tax in Setup.');
      data.quotes.push({id,check_id:check.id,status:'draft',subtotal:snapshot.subtotal,lines:snapshot.lines,financials:{...snapshot},created_at:new Date().toISOString()});check.status='awaiting_approval';check.assessment_fee=snapshot.assessment_fee;
    } else if(action==='save_finance_tracker') {
      const tracker=workflowSchemas.save_finance_tracker.parse(p).tracker;
      if((tracker.invoice_sent_at||tracker.invoice_paid_at)&&!data.invoices?.some(i=>i.check_id===check.id))throw new Error('Prepare an invoice snapshot before recording invoice dates.');
      check.attributes={...check.attributes,finance_tracker:tracker};
      for(const invoice of data.invoices?.filter(i=>i.check_id===check.id)??[])invoice.status=tracker.invoice_paid_at?'paid':tracker.invoice_sent_at?'issued':'draft';
    }
    else if(action==='create_invoice') {
      const quote=data.quotes.find(q=>q.check_id===check.id&&q.status==='approved'&&!q.superseded_at);
      if(check.status!=='complete'||!quote) throw new Error('Finish packing and approve the quote first.');
      if(data.invoices?.some(i=>i.check_id===check.id)) throw new Error('This check already has an invoice snapshot.');
      if(data.invoices?.some(i=>i.invoice_number===p.invoice_number)) throw new Error('Invoice number already exists.');
      const snapshot=calculateFinance(data,check,'invoice');
      if(snapshot.pricing_missing||!snapshot.tax_reviewed) throw new Error('Review invoice pricing and tax.');
      (data.invoices??=[]).push({id,check_id:check.id,quote_id:quote.id,invoice_number:String(p.invoice_number),status:'draft',financials:{...snapshot},created_at:new Date().toISOString()});
    } else if(action==='save_legacy_item') {
      if(check.status==='complete') throw new Error('Completed checks are locked.');
      const input=workflowSchemas.save_legacy_item.parse(p);
      const entry={...input,id:input.item_id??id,expiry:input.expiry||null};
      const index=data.legacy_items?.findIndex(i=>i.id===input.item_id&&i.check_id===check.id)??-1;
      if(input.item_id&&index<0) throw new Error('Legacy item not found.');
      if(index<0)(data.legacy_items??=[]).push(entry);else data.legacy_items![index]=entry;
    } else if(action==='delete_legacy_item') {
      if(check.status==='complete') throw new Error('Completed checks are locked.');
      data.legacy_items=data.legacy_items?.filter(i=>i.id!==p.item_id||i.check_id!==check.id);
    } else if(action==='reconcile_stock') {
      const input=workflowSchemas.reconcile_stock.parse(p);
      for(const g of input.groups){const target=data.check_items.find(i=>i.id===g.item_id&&i.check_id===check.id);if(!target)throw new Error('Match must belong to this check.');applySlotCommand(data,check,target,{...g,phase:'arrival',reviewed:false,notes:`Reconciled from ${input.source_name}`});}
      check.attributes={...check.attributes,reconciliation:{...input,confirmed_at:new Date().toISOString()}};
    }
    return data;
  }
  if (action === "create_template") {
    if (data.kit_templates.some((t) => t.framework === p.framework && t.category === p.category && t.version === p.version)) throw new Error("This version already exists.");
    const source = p.source_template_id ? data.kit_templates.find((t) => t.id === p.source_template_id) : undefined;
    if (p.source_template_id && !source) throw new Error("Source template not found.");
    if (source && (source.framework !== p.framework || source.category !== p.category)) throw new Error("A new version must keep its source framework and category.");
    data.kit_templates.push({ id, name: String(p.name), framework: String(p.framework), category: String(p.category), version: String(p.version), published: false, ever_published: false });
    if (source) for (const line of original.template_items.filter((i) => i.template_id === source.id)) {
      const copy = structuredClone(line);
      delete copy.attributes.price_quantity_reviewed;
      const price = data.template_sell_prices?.find(parent => parent.item_key === templatePriceKey(copy.attributes.item_id) &&
        parent.pack_key === templatePriceKey(copy.pack_description));
      if (price) applyParentPrice(copy, price.unit_price);
      data.template_items.push({ ...copy, id: crypto.randomUUID(), template_id: id });
    }
  } else if (["save_template_item", "delete_template_item", "delete_template", "publish_template", "retire_template"].includes(action)) {
    const template = data.kit_templates.find((t) => t.id === p.template_id);
    if (!template) throw new Error("Template not found.");
    if (action === "publish_template") {
      if (!data.template_items.some((i) => i.template_id === template.id)) throw new Error("Template has no items.");
      if (data.template_items.some((i) => i.template_id === template.id && i.attributes.price_missing === true)) throw new Error("Review missing sell prices before publishing.");
      if (data.template_items.some((i) => i.template_id === template.id && !isTemplateLineReviewed(i))) throw new Error("Review prices and quantities on every line before publishing.");
      for (const t of data.kit_templates) if (t.framework === template.framework && t.category === template.category) { if (t.published) t.ever_published = true; t.published = false; }
      template.published = true; template.ever_published = true;
    } else if (action === "retire_template") { if (template.published) template.ever_published = true; template.published = false; }
    else {
      if (!isEditableTemplate(data, template.id)) throw new Error("Published or used templates are immutable. Create a new version.");
      if (action === "delete_template") {
        data.template_items = data.template_items.filter(line => line.template_id !== template.id);
        data.kit_templates = data.kit_templates.filter(t => t.id !== template.id);
        return data;
      }
      const index = data.template_items.findIndex((i) => i.id === p.item_id && i.template_id === template.id);
      if (p.item_id && index < 0) throw new Error("Template item not found.");
      if (action === "delete_template_item") data.template_items.splice(index, 1);
      else {
        if (data.template_items.some((i) => i.template_id === template.id && i.source_code === p.source_code && i.id !== p.item_id)) throw new Error("Line key already exists.");
        const { share_price, item_id, expected_revision: _, ...values } = schemas.save_template_item.parse(payload);
        const line = { ...values, id: item_id || id };
        const maximum = templateMaximumPacks(line.attributes);
        if (line.attributes.maximum_packs !== undefined && (maximum === undefined || maximum > 1000000 ||
          line.scaling !== "band" || maximum < Math.round(line.baseline_packs) || line.attributes.requirement_unknown === true)) {
          throw new Error("Enter a whole-pack maximum at least as large as the 10-crew quantity on a scaled line.");
        }
        const itemKey = templatePriceKey(line.attributes.item_id);
        const packKey = templatePriceKey(line.pack_description);
        line.unit_price = Number(line.unit_price.toFixed(4));
        const parent = data.template_sell_prices?.find(price => price.item_key === itemKey && price.pack_key === packKey);
        if (share_price) {
          if (!itemKey || !packKey || line.attributes.price_missing === true) throw new Error("Enter an Item ID, pack breakdown and sell price to share a price.");
          if (parent) parent.unit_price = line.unit_price;
          else (data.template_sell_prices ??= []).push({ item_key: itemKey, pack_key: packKey, unit_price: line.unit_price });
        } else if (parent && (line.unit_price !== parent.unit_price || line.attributes.price_missing === true)) {
          throw new Error("This item uses a shared price. Enter the shared amount or select Update shared price.");
        }
        if (index < 0) data.template_items.push(line); else data.template_items[index] = line;
        if (share_price) for (const other of data.template_items) {
          if (templatePriceKey(other.attributes.item_id) === itemKey && templatePriceKey(other.pack_description) === packKey &&
            isEditableTemplate(data, other.template_id)) applyParentPrice(other, line.unit_price);
        }
      }
    }
  } else if (action === "create_client") data.clients.push({ id, ...payload } as Workspace["clients"][number]);
  else if (action === "create_vendor") data.vendors.push({ id, ...payload } as Workspace["vendors"][number]);
  else if (action === "create_vessel" || action === "update_vessel") {
    const { new_client, ...values } = vessel.parse(payload);
    const existing = action === "update_vessel" ? data.vessels.find(row => row.id === p.id) : undefined;
    if (action === "update_vessel" && !existing) throw new Error("Vessel not found.");
    if (values.client_id && (new_client || !data.clients.some(c => c.id === values.client_id))) throw new Error("Choose a valid client.");
    if (new_client) {
      values.client_id = crypto.randomUUID();
      data.clients.push({ id: values.client_id, ...new_client });
    }
    const fields = { ...values, client_id: values.client_id || null };
    if (existing) Object.assign(existing, fields);
    else data.vessels.push({ id, ...fields });
  } else if (action === "create_vendor_product") data.vendor_products.push({ id, ...payload } as Workspace["vendor_products"][number]);
  else if (action === "update_client") {
    const { id, active_season, ...fields } = schemas.update_client.parse(payload);
    const row = data.clients.find(c => c.id === id);
    if (!row) throw new Error("Client not found.");
    const attributes = { ...row.attributes };
    if (active_season) attributes.active_season = active_season;
    else delete attributes.active_season;
    Object.assign(row, fields, { attributes });
  } else if (action === "update_vendor") {
    const row = data.vendors.find(v => v.id === p.id);
    if (!row) throw new Error("Vendor not found.");
    Object.assign(row, payload);
  } else if (action === "update_vendor_product") {
    const fields = schemas.update_vendor_product.parse(payload);
    const row = data.vendor_products.find(v => v.id === fields.id);
    if (!row) throw new Error("Product not found.");
    const vendor_id = fields.vendor_id || null;
    if (vendor_id && !data.vendors.some(v => v.id === vendor_id)) throw new Error("Vendor not found.");
    if (row.price !== fields.price || row.vendor_id !== vendor_id || (row.pack_description ?? "") !== fields.pack_description) {
      row.attributes = { ...row.attributes, review_required: true };
      delete row.attributes.unit_price;
    }
    Object.assign(row, fields, { vendor_id });
  }
  else if (action === "create_check") {
    const vessel = data.vessels.find((v) => v.id === p.vessel_id);
    const template = data.kit_templates.find((t) => t.id === p.template_id && t.published);
    if (!vessel?.client_id || !template || (template.framework !== vessel.framework && template.framework !== "ALL")) throw new Error("Choose a vessel with a client and a compatible published template.");
    const templateItems = data.template_items.filter((i) => i.template_id === template.id);
    if (!templateItems.length) throw new Error("Template has no items.");
    const check = { id, vessel_id: vessel.id, client_id: vessel.client_id, template_id: template.id, check_date: String(p.check_date), valid_until: addMonths(String(p.check_date), 12), crew: vessel.crew, job_type: String(p.job_type), status: "assessing" as const, notes: "", assessment_fee: 0, loyalty: vessel.loyalty };
    data.kit_checks.push(check);
    for (const item of templateItems) data.check_items.push({ id: crypto.randomUUID(), check_id: id, template_item_id: item.id, source_code: item.source_code, description: item.description, location: item.location, pack_description: item.pack_description, required_packs: requiredPacks(item.baseline_packs, item.scaling, vessel.crew, templateMaximumPacks(item.attributes)), unit_price: item.unit_price, assessment_state: "unreviewed", attributes: structuredClone(item.attributes), kill_line: false });
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
      for(const key of ['dose_route','uses','side_effects'])if(p[key]!==undefined){item.attributes[`original_${key}`]=attrs[`original_${key}`]??attrs[key]??'';item.attributes[key]=p[key];}
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
      const quote = data.quotes.findLast((q) => q.check_id === check.id && q.status === "draft" && !q.superseded_at);
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
