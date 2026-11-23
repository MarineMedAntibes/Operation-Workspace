import assert from "node:assert/strict";
import test from "node:test";
import { calculateFinance, type FinancePricingRule } from "../src/lib/finance";
import type { KitCheck, Workspace, PricingRule } from "../src/lib/types";

function fixture() {
  const check: KitCheck = { id: "check", vessel_id: "vessel", client_id: "client", template_id: "template", check_date: "2026-11-20", valid_until: "2027-11-20", crew: 10, job_type: "Restructure", status: "packing", notes: "", assessment_fee: 0, loyalty: true,
    attributes: { workflow: { finance: { standard_fee: 100, loyalty_discount_percent: 50, proceeds_credit_percent: 50, job_proceeded: true, goods_share_percent: 40, goods_vat_percent: 0, service_vat_percent: 20, shipping_vat_percent: 20, tax_reviewed: true,
      extras: [{ id: "extra", description: "Client requested supplies", kind: "goods", quantity: 2, unit_price: 5 }], coolbox: 20, shipping: 3, handling: 2 } } } };
  const data: Workspace = { clients: [], vessels: [], vendors: [], vendor_products: [], kit_templates: [{ id: "template", name: "Test", framework: "MSN", category: "CAT B", version: "v1", published: true }], template_items: [], kit_checks: [check], quotes: [],
    check_items: [
      { id: "one", check_id: "check", template_item_id: "t1", source_code: "ONE", description: "Partly packed", location: "Bag", pack_description: "Each", required_packs: 3, unit_price: 10, assessment_state: "reviewed" },
      { id: "two", check_id: "check", template_item_id: "t2", source_code: "TWO", description: "Fully packed", location: "Bag", pack_description: "Each", required_packs: 2, unit_price: 20, assessment_state: "reviewed" },
    ], batches: [
      { id: "b1", check_item_id: "one", kind: "kept", quantity: 1, no_expiry: true, expiry: null, notes: "", created_at: "2026-11-20" },
      { id: "b2", check_item_id: "one", kind: "supplied", quantity: 1, no_expiry: true, expiry: null, notes: "", created_at: "2026-11-20" },
      { id: "b3", check_item_id: "two", kind: "supplied", quantity: 2, no_expiry: true, expiry: null, notes: "", created_at: "2026-11-20" },
    ] };
  const settings = ((check.attributes!.workflow as Record<string, unknown>).finance as Record<string, unknown>);
  return {data, check, settings};
}

test("workbook cost breakdown applies sequential fee credits and separate reviewed tax percentages", () => {
  const {data, check} = fixture();
  const result = calculateFinance(data, check, "quote");
  assert.equal(result.assessment_fee, 25);
  assert.equal(result.items_subtotal, 60);
  assert.equal(result.goods_net, 24);
  assert.equal(result.service_net, 36);
  assert.equal(result.extras_net, 10);
  assert.equal(result.subtotal, 120);
  assert.equal(result.vat, 17.2);
  assert.equal(result.total, 137.2);
  assert.equal(result.pricing_missing, false);
  assert.equal(result.tax_reviewed, true);
  assert.equal(result.lines.reduce((sum,l) => sum+l.net,0),result.subtotal);
});

test("invoice basis excludes partially packed lines instead of billing their partial quantities", () => {
  const {data, check} = fixture();
  const result = calculateFinance(data,check,"invoice");
  assert.equal(result.items_subtotal, 40);
  assert.equal(result.subtotal, 100);
  assert.equal(result.vat,14.8);
  assert.equal(result.total,114.8);
  data.check_items[1].assessment_state="unreviewed";
  assert.equal(calculateFinance(data,check,"invoice").items_subtotal,0);
});

test("explicit no-proceeds is fee-only and is not interpreted as client quote approval", () => {
  const {data,check,settings}=fixture();
  settings.job_proceeded=false;
  const result=calculateFinance(data,check,"quote");
  assert.equal(result.items_subtotal,60,"planning basis remains visible");
  assert.equal(result.assessment_fee,50,"no proceeds credit is applied");
  assert.equal(result.goods_net,0); assert.equal(result.extras_net,0);
  assert.equal(result.subtotal,50); assert.equal(result.total,60);
  assert.ok(result.warnings.some(w=>w.includes("separate from client quote approval")));
});

test("missing tax review and rates stay visible; zero overrides and zero tax are valid explicit inputs", () => {
  const {data,check,settings}=fixture();
  delete settings.standard_fee; delete settings.tax_reviewed;
  let result=calculateFinance(data,check,"quote");
  assert.equal(result.pricing_missing,true); assert.equal(result.tax_reviewed,false);
  settings.assessment_fee_override=0;
  settings.goods_vat_percent=0; settings.service_vat_percent=0; settings.shipping_vat_percent=0;
  result=calculateFinance(data,check,"quote");
  assert.equal(result.assessment_fee,0); assert.equal(result.pricing_missing,false); assert.equal(result.vat,0);
  assert.equal(result.tax_reviewed,false,"a numeric zero tax rate does not infer exemption approval");
});

test("new-build explicit price replaces item sums and unreviewed source prices are not embedded defaults", () => {
  const {data,check,settings}=fixture();
  check.job_type="New Build";
  assert.equal(calculateFinance(data,check,"quote").pricing_missing,true);
  settings.new_build_kit_price=1000;
  data.check_items[0].attributes={price_missing:true};
  let result=calculateFinance(data,check,"quote");
  assert.equal(result.assessment_fee,0); assert.equal(result.items_subtotal,1000); assert.equal(result.pricing_missing,false);
  delete settings.new_build_kit_price;
  const rule:PricingRule & FinancePricingRule={id:"rule",framework:"MSN",category:"CAT B",crew_band:10,job_type:"New Build",standard_fee:0,member_discount_percent:50,proceeds_credit_percent:50,new_build_kit_price:900,review_required:true};
  data.pricing_rules=[rule];
  result=calculateFinance(data,check,"quote");
  assert.equal(result.items_subtotal,900); assert.equal(result.pricing_missing,true);
  settings.pricing_reviewed=true;
  assert.equal(calculateFinance(data,check,"quote").pricing_missing,false);
});

test("invalid numeric settings cannot quietly generate negative or non-finite invoices", () => {
  const {data,check,settings}=fixture();
  settings.standard_fee=-100; settings.goods_share_percent=101; settings.shipping=Infinity;
  const result=calculateFinance(data,check,"quote");
  assert.equal(result.pricing_missing,true);
  assert.ok(Number.isFinite(result.total)); assert.ok(result.total>=0);
});
