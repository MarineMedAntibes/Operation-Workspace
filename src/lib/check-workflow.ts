import { z } from "zod";
import type { Workspace, KitCheck, Batch, CheckItem } from "./types";
import { addMonths, keepExisting, validSupplyExpiry, quantities } from "./rules";

export function parseExpiryMonth(input: string): string {
  const value = input.trim();
  const iso = /^(\d{4})-(\d{2})(?:-01)?$/.exec(value);
  const short = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  const year = iso ? Number(iso[1]) : short ? Number(short[2]) + (short[2].length === 2 ? 2000 : 0) : NaN;
  const month = iso ? Number(iso[2]) : short ? Number(short[1]) : NaN;
  if (!Number.isInteger(year) || year < 1900 || year > 2199 || month < 1 || month > 12 || !Number.isInteger(month)) throw new Error("Use MM/YY or MM/YYYY, for example 02/28 or 02/2028.");
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
export const expiryText = (value: string | null) => value ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : "";
const text = z.string().trim().max(4000);
const id = z.string().min(1).max(500);
const money = z.coerce.number().finite().min(0).max(10000000);
const percent = z.coerce.number().finite().min(0).max(100);
export const slotSchema = z.object({ quantity: z.coerce.number().int().min(0).max(100000), expiry: z.string().default(""), no_expiry: z.boolean().default(false) }).superRefine((s, ctx) => {
  if (!s.quantity) return;
  if (s.no_expiry && s.expiry) ctx.addIssue({ code: "custom", message: "Choose an expiry or NED, not both." });
  if (!s.no_expiry) { try { if (parseExpiryMonth(s.expiry) !== s.expiry) throw new Error(); } catch { ctx.addIssue({ code: "custom", message: "Enter a valid expiry month." }); } }
});
export type StockSlot = z.infer<typeof slotSchema>;
export const financeSchema = z.object({
  standard_fee: money.nullable().optional(), assessment_fee_override: money.nullable().optional(),
  loyalty_discount_percent: percent.optional(), proceeds_credit_percent: percent.optional(),
  job_proceeded: z.boolean().default(false), new_build_kit_price: money.nullable().optional(),
  goods_share_percent: percent.default(40), goods_vat_percent: percent.default(20), service_vat_percent: percent.default(20), shipping_vat_percent: percent.default(20),
  tax_reviewed: z.boolean().default(false), pricing_reviewed: z.boolean().default(false),
  tax_notes: text.default(""), coolbox: money.default(0), shipping: money.default(0), handling: money.default(0),
  extras: z.array(z.object({ id, description: z.string().trim().min(1).max(500), kind: z.enum(["goods", "service", "shipping"]), quantity: money, unit_price: money })).max(100).default([]),
});
export const workflowSchema = z.object({
  assessor: z.string().trim().max(200).default(""), certificate_number: z.string().trim().max(100).default(""),
  critical_equipment: z.array(z.object({ name: z.string().max(100), present: z.enum(["Yes", "No", "Unknown"]), model: text.default(""), expiry: z.union([z.iso.date(),z.literal("")]).default(""), hydrotest: z.union([z.iso.date(),z.literal("")]).default(""), notes: text.default("") })).max(3).default([]),
  telemedical_customer: z.enum(["Yes", "No", "Unknown"]).default("Unknown"), document_booklet: z.enum(["Yes", "No", "Not interested", "Unknown"]).default("Unknown"),
  client_type: z.enum(["B2B", "B2C", "Unknown"]).default("Unknown"), tva_status: z.enum(["COMMERCIAL", "PRIVATE", "Unknown"]).default("Unknown"),
  delivery_location: text.default(""), billing_name: text.default(""), billing_address: text.default(""), vat_number: text.default(""),
  finance: financeSchema,
});
export const workflowSchemas = {
  save_check_header: z.object({check_id:id,check_date:z.iso.date(),valid_until:z.iso.date(),crew:z.coerce.number().int().min(1).max(60),job_type:z.enum(["Routine Refill","Category Swap","Restructure","New Build"]),loyalty:z.boolean(),reason:z.string().trim().min(1).max(4000)}).refine(v=>v.valid_until>v.check_date,"Coverage end must be after the check date."),
  save_check_setup: z.object({ check_id: id, workflow: workflowSchema }),
  save_line_slots: z.object({ item_id: id, phase: z.enum(["arrival", "supply"]), slots: z.array(slotSchema).max(2), expected_batch_ids: z.array(id).max(100), expected_valid_until:z.iso.date().optional(),expected_required_packs:money.optional(), reviewed: z.boolean().default(true), notes: text.default("") }),
  reconcile_stock: z.object({ check_id: id, source_name: z.string().trim().min(1).max(500), groups: z.array(z.object({ item_id: id, slots: z.array(slotSchema).max(2), expected_batch_ids: z.array(id).max(100), source_rows: z.array(z.object({ row: z.number().int(), description: text, quantity: z.number(), expiry: text })).max(500) })).min(1).max(500) }),
  revise_quote: z.object({ check_id: id, reason: z.string().trim().min(1).max(4000) }),
  prepare_quote: z.object({ check_id: id }),
  create_invoice: z.object({ check_id: id, invoice_number: z.string().trim().min(1).max(100) }),
  save_finance_tracker: z.object({ check_id: id, tracker: z.object({ quote_sent_at: z.union([z.iso.date(),z.literal("")]), invoice_sent_at: z.union([z.iso.date(),z.literal("")]), invoice_paid_at: z.union([z.iso.date(),z.literal("")]), ipaid_external_id: text, ipaid_url: z.union([z.url(), z.literal("")]), notes: text }).refine(v=>!v.invoice_paid_at||!!v.invoice_sent_at,"Record the invoice sent date before marking it paid.") }),
  save_legacy_item: z.object({ check_id: id, item_id: id.optional(), description: z.string().trim().min(1).max(500), quantity: money, expiry: z.union([z.iso.date(),z.literal("")]).default(""), no_expiry: z.boolean(), location: text, notes: text }).refine(v => v.no_expiry ? !v.expiry : !!v.expiry && v.expiry.endsWith("-01"), "Enter an expiry or select NED."),
  delete_legacy_item: z.object({ check_id: id, item_id: id }),
};

export function activeBatches(data: Workspace, item: CheckItem, phase: "arrival" | "supply"): Batch[] {
  return data.batches.filter(b => b.check_item_id === item.id && !b.voided_at && (phase === "arrival" ? b.kind !== "supplied" : b.kind === "supplied"));
}
export function lineSlots(batches: Batch[]): StockSlot[] {
  const groups = new Map<string, StockSlot>();
  for (const b of batches) {
    const key = b.no_expiry ? "NED" : b.expiry ?? "";
    const slot = groups.get(key) ?? { quantity: 0, expiry: b.expiry ?? "", no_expiry: b.no_expiry };
    slot.quantity += Number(b.quantity); groups.set(key, slot);
  }
  return [...groups.values()];
}
export function equipmentStatus(equipment: { present: string; expiry?: string; hydrotest?: string }, today: string) {
  if (equipment.present === "No") return "Not on board";
  if (equipment.present !== "Yes") return "Needs review";
  const dates = [equipment.expiry,equipment.hydrotest].filter(Boolean) as string[];
  if (!dates.length) return "No date recorded";
  const first = dates.sort()[0];
  return first < today ? "Expired" : first < addMonths(today,3) ? "Expires soon" : "In date";
}

export function applySlotCommand(data: Workspace, check: KitCheck, item: CheckItem, payload: z.infer<typeof workflowSchemas.save_line_slots>) {
  const allowed = payload.phase === "arrival" ? "assessing" : "packing";
  if (check.status !== allowed) throw new Error("This stage is locked.");
  const existing = activeBatches(data,item,payload.phase);
  if((payload.expected_valid_until&&payload.expected_valid_until!==check.valid_until)||(payload.expected_required_packs!=null&&payload.expected_required_packs!==Number(item.required_packs)))throw new Error("Check settings changed. Refresh before saving again.");
  if ([...existing.map(b => b.id)].sort().join() !== [...payload.expected_batch_ids].sort().join()) throw new Error("This line changed. Refresh before saving again.");
  const slots = payload.slots.filter(s => s.quantity > 0);
  if (new Set(slots.map(s => s.no_expiry ? "NED" : s.expiry)).size !== slots.length) throw new Error("Combine quantities for the same expiry into one slot.");
  if (payload.phase === "supply") {
    if (item.assessment_state !== "reviewed") throw new Error("Review this item before packing.");
    if (slots.reduce((n,s) => n+s.quantity,0) > quantities(item,data.batches).needed) throw new Error("Supply exceeds required packs.");
    if (slots.some(s => !validSupplyExpiry(s.expiry || null,s.no_expiry,check.valid_until))) throw new Error("A supplied expiry does not cover the required window.");
  }
  const stamp = new Date().toISOString();
  for (const b of existing) b.voided_at=stamp;
  for (const s of slots) data.batches.push({id:crypto.randomUUID(),check_item_id:item.id,quantity:s.quantity,expiry:s.no_expiry ? null:s.expiry,no_expiry:s.no_expiry,kind:payload.phase === "supply" ? "supplied" : keepExisting(s.expiry || null,s.no_expiry,check.valid_until) ? "kept":"removed",notes:payload.notes,created_at:stamp});
  if (payload.phase === "arrival") item.assessment_state=payload.reviewed ? "reviewed":"unreviewed";
}
