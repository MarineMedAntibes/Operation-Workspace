import { crewBand, quantities } from "./rules";
import type { KitCheck, Workspace } from "./types";

export type FinanceKind = "goods" | "service" | "shipping";
export type FinanceLine = {
  key: string; description: string; kind: FinanceKind; quantity: number;
  unit_price: number; net: number; vat_percent: number; vat: number; total: number;
};
export type FinanceResult = {
  assessment_fee: number; items_subtotal: number; goods_net: number;
  service_net: number; extras_net: number; coolbox_net: number;
  shipping_net: number; handling_net: number; subtotal: number; vat: number;
  total: number; lines: FinanceLine[]; tax_reviewed: boolean;
  pricing_missing: boolean; basis: string; warnings: string[];
};
export type FinancePricingRule = {
  framework: string; category: string; crew_band: number; job_type: string;
  standard_fee: number | null; member_discount_percent: number | null;
  proceeds_credit_percent: number | null; new_build_kit_price?: number | null;
  review_required?: boolean;
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const numeric = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Reproduce workbook pricing inputs, without inferring tax exemption or approval.
 * Rates remain database data. Missing/unreviewed values are visible, never a
 * hidden fallback to a confidential rate table embedded in the browser bundle.
 */
export function calculateFinance(data: Workspace, check: KitCheck, mode: "quote" | "invoice"): FinanceResult {
  const workflow = record(check.attributes?.workflow);
  const settings = record(workflow.finance);
  const warnings: string[] = [];
  let pricingMissing = false;
  const template = data.kit_templates.find((t) => t.id === check.template_id);
  const rules = (data as Workspace & { pricing_rules?: FinancePricingRule[] }).pricing_rules ?? [];
  const rule = rules.find((r) => r.framework === template?.framework && r.category === template?.category && Number(r.crew_band) === crewBand(check.crew) && r.job_type === check.job_type);
  const missing = (message: string) => { pricingMissing = true; warnings.push(message); };
  const amount = (key: string, fallback = 0): number => {
    if (settings[key] == null || settings[key] === "") return fallback;
    const value = numeric(settings[key]);
    if (value === undefined) { missing(`Review ${key.replaceAll("_", " ")}.`); return fallback; }
    return value;
  };
  const percent = (value: unknown, label: string, fallback: number): number => {
    const parsed = numeric(value);
    if (parsed === undefined || parsed > 100) {
      if (value != null && value !== "") missing(`Review ${label}; enter a percentage from 0 to 100.`);
      return fallback;
    }
    return parsed;
  };
  const chosen = (key: string, ruleValue: unknown): number | undefined => {
    if (settings[key] != null && settings[key] !== "" && numeric(settings[key]) === undefined) missing(`Review ${key.replaceAll("_", " ")}.`);
    return numeric(settings[key]) ?? numeric(ruleValue);
  };
  const proceeded = settings.job_proceeded === true;
  if (typeof settings.job_proceeded !== "boolean") missing("Choose explicitly whether the job proceeded.");
  const newBuild = check.job_type === "New Build";
  const feeOverride = numeric(settings.assessment_fee_override);
  if (settings.assessment_fee_override != null && settings.assessment_fee_override !== "" && feeOverride === undefined) missing("Review the assessment fee override.");
  const standard = chosen("standard_fee", rule?.standard_fee);
  const loyaltyPercent = chosen("loyalty_discount_percent", rule?.member_discount_percent);
  const proceedsPercent = chosen("proceeds_credit_percent", rule?.proceeds_credit_percent);
  let assessmentFee = 0;
  if (feeOverride !== undefined) assessmentFee = feeOverride;
  else if (!newBuild) {
    if (standard === undefined) missing("A reviewed standard assessment fee or explicit assessment fee override is required.");
    if (check.loyalty && loyaltyPercent === undefined) missing("Review the loyalty discount percentage.");
    if (proceeded && proceedsPercent === undefined) missing("Review the waived-if-proceeds credit percentage.");
    const loyalty = check.loyalty ? percent(loyaltyPercent, "loyalty discount", 0) / 100 : 0;
    const credit = proceeded ? percent(proceedsPercent, "proceeds credit", 0) / 100 : 0;
    assessmentFee = (standard ?? 0) * (1 - loyalty) * (1 - credit);
    if (rule?.review_required && numeric(settings.standard_fee) === undefined && settings.pricing_reviewed !== true) missing("The matching rate rule needs review; confirm it or enter a reviewed fee.");
  }
  assessmentFee = money(assessmentFee);

  const items = data.check_items.filter((item) => item.check_id === check.id);
  let itemSum = 0;
  for (const item of items) {
    if (newBuild) continue;
    const q = quantities(item, data.batches);
    if (mode === "invoice" && (item.assessment_state === "unreviewed" || q.outstanding > 0)) continue;
    if (q.needed <= 0) continue;
    if (item.attributes?.price_missing === true || item.attributes?.requirement_unknown === true) missing(`Review quantity/price for ${item.source_code}.`);
    const price = numeric(item.unit_price);
    if (price === undefined) missing(`Review the price for ${item.source_code}.`);
    itemSum += q.needed * (price ?? 0);
  }
  if (newBuild) {
    const kitSell = chosen("new_build_kit_price", rule?.new_build_kit_price);
    if (kitSell === undefined) missing("New builds require an explicit reviewed kit sell price; item-sum pricing is not used.");
    if (rule?.review_required && numeric(settings.new_build_kit_price) === undefined && settings.pricing_reviewed !== true) missing("Review the suggested new-build kit price before use.");
    itemSum = kitSell ?? 0;
  }
  const itemsSubtotal = money(itemSum);
  if (!proceeded && itemsSubtotal > 0) warnings.push("Job priced as not proceeding: workbook Cost Analysis charges only the assessment fee. Choose proceeding explicitly to include kit fulfilment in the proposal; this is separate from client quote approval.");
  const goodsShare = percent(settings.goods_share_percent, "goods share", 40) / 100;
  const goodsNet = proceeded ? money(itemsSubtotal * goodsShare) : 0;
  const serviceNet = proceeded ? money(itemsSubtotal - goodsNet) : 0;
  const goodsVat = percent(settings.goods_vat_percent, "goods VAT", 20);
  const serviceVat = percent(settings.service_vat_percent, "service VAT", 20);
  const shippingVat = percent(settings.shipping_vat_percent, "shipping VAT", 20);
  const taxReviewed = settings.tax_reviewed === true;
  if (!taxReviewed) warnings.push("Tax percentages are provisional until explicitly reviewed; client type or vessel status does not automatically establish exemption.");
  const lines: FinanceLine[] = [];
  const line = (key: string, description: string, kind: FinanceKind, net: number, quantity = 1, unitPrice = net) => {
    const vatPercent = kind === "goods" ? goodsVat : kind === "service" ? serviceVat : shippingVat;
    const vat = money(net * vatPercent / 100);
    lines.push({ key, description, kind, quantity, unit_price: unitPrice, net: money(net), vat_percent: vatPercent, vat, total: money(net + vat) });
  };
  line("assessment", "1. Medical Stores Compliance Assessment", "service", assessmentFee);
  line("supply", "2A. Medical Stores Sourcing & Supply", "goods", goodsNet);
  line("compliance", "2B. Medical Stores Compliance Servicing", "service", serviceNet);
  let extrasNet = 0;
  const extras = Array.isArray(settings.extras) ? settings.extras : [];
  for (const [index, input] of extras.entries()) {
    const extra = record(input);
    const quantity = numeric(extra.quantity);
    const unitPrice = numeric(extra.unit_price);
    const kind = extra.kind;
    if (quantity === undefined || unitPrice === undefined || !["goods", "service", "shipping"].includes(String(kind)) || !String(extra.description ?? "").trim()) {
      missing(`Review supplementary line ${index + 1}: description, kind, quantity and unit price are required.`);
      continue;
    }
    if (!proceeded) continue;
    const net = money(quantity * unitPrice);
    extrasNet += net;
    line(`extra-${String(extra.id ?? index)}`, `3. ${String(extra.description)}`, kind as FinanceKind, net, quantity, unitPrice);
  }
  const coolboxNet = proceeded ? money(amount("coolbox")) : 0;
  const shippingNet = proceeded ? money(amount("shipping")) : 0;
  const handlingNet = proceeded ? money(amount("handling")) : 0;
  if (coolboxNet) line("coolbox", "4. Coolbox / Packaging", "shipping", coolboxNet);
  if (shippingNet) line("shipping", "4. Freight / Shipping", "shipping", shippingNet);
  if (handlingNet) line("handling", "4. Additional Handling", "shipping", handlingNet);
  const subtotal = money(lines.reduce((sum, item) => sum + item.net, 0));
  const vat = money(lines.reduce((sum, item) => sum + item.vat, 0));
  return {
    assessment_fee: assessmentFee, items_subtotal: itemsSubtotal,
    goods_net: goodsNet, service_net: serviceNet, extras_net: money(extrasNet),
    coolbox_net: coolboxNet, shipping_net: shippingNet, handling_net: handlingNet,
    subtotal, vat, total: money(subtotal + vat), lines, tax_reviewed: taxReviewed,
    pricing_missing: pricingMissing,
    basis: `${newBuild ? "New-build kit price (not item sum)" : mode === "quote" ? "Planned replacement packs" : "Completed replacement lines only"}${proceeded ? "" : "; job not proceeded — assessment fee only"}`,
    warnings: [...new Set(warnings)],
  };
}
