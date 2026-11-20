import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, crewBand, keepExisting, quantities, requiredPacks, validSupplyExpiry } from "../src/lib/rules";
import { applyDemoCommand } from "../src/lib/commands";
import { demoWorkspace } from "../src/lib/demo";

test("crew bands, fixed quantities and Excel-positive rounding", () => {
  assert.equal(crewBand(12), 20);
  assert.equal(crewBand(40), 40);
  assert.equal(requiredPacks(1, "band", 12), 2);
  assert.equal(requiredPacks(1, "fixed", 12), 1);
  assert.throws(() => crewBand(61)); assert.throws(() => crewBand(0));
});
test("calendar arithmetic and intentional difference between old and new batch expiry", () => {
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.throws(() => addMonths("2026-02-30", 1));
  assert.equal(keepExisting("2027-09-01", false, "2027-09-18"), true);
  assert.equal(keepExisting("2027-08-01", false, "2027-09-18"), false);
  assert.equal(validSupplyExpiry("2027-08-01", false, "2027-09-18"), true);
  assert.equal(validSupplyExpiry("2027-07-01", false, "2027-09-18"), false);
});
test("preview exercises assessment, approval gate, staged supply and final totals", () => {
  let data = applyDemoCommand(demoWorkspace({ includeExamples: false }), { action: "create_check", payload: { vessel_id: "vessel-demo", template_id: "template-demo", check_date: "2026-09-18", job_type: "Routine Refill" } });
  const check = data.kit_checks[0]; const item = data.check_items[0];
  const quote = { action: "create_quote", payload: { check_id: check.id, assessment_fee: 25 } };
  assert.throws(() => applyDemoCommand(data, quote), /Review every line/);
  data = applyDemoCommand(data, { action: "add_batch", payload: { item_id: item.id, quantity: 1, expiry: "2028-01-01" } });
  for (const line of data.check_items) data = applyDemoCommand(data, { action: "mark_assessed", payload: { item_id: line.id, state: "reviewed" } });
  data = applyDemoCommand(data, quote);
  assert.equal(data.quotes[0].subtotal, 77);
  assert.throws(() => applyDemoCommand(data, { action: "add_batch", payload: { item_id: item.id, quantity: 1, expiry: "2028-01-01" } }), /locked/);
  data = applyDemoCommand(data, { action: "approve_quote", payload: { check_id: check.id } });
  assert.throws(() => applyDemoCommand(data, { action: "finish", payload: { check_id: check.id } }), /Outstanding/);
  for (const line of data.check_items) {
    const outstanding = quantities(line, data.batches).outstanding;
    if (outstanding) data = applyDemoCommand(data, { action: "add_batch", payload: { item_id: line.id, quantity: outstanding, no_expiry: true } });
  }
  assert.equal(quantities(item, data.batches).final, 2);
  assert.throws(() => applyDemoCommand(data, { action: "add_batch", payload: { item_id: item.id, quantity: 1, no_expiry: true } }), /exceeds/);
  data = applyDemoCommand(data, { action: "finish", payload: { check_id: check.id } });
  assert.equal(data.kit_checks[0].status, "complete");
});

test("populated preview has usable examples and consistent final contents and forecasts", () => {
  let data = demoWorkspace();
  assert.equal(data.clients.length, 5);
  assert.equal(data.vessels.length, 7);
  assert.equal(data.vendor_products.length, 18);
  assert.deepEqual(new Set(data.kit_checks.map((c) => c.status)), new Set(["assessing", "awaiting_approval", "packing", "complete"]));
  for (const quote of data.quotes) {
    const total = Math.round(quote.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0) * 100) / 100;
    assert.equal(quote.subtotal, total);
  }
  const dueMonths = new Set<string>();
  for (const check of data.kit_checks.filter((c) => c.status === "complete")) {
    const lines = data.check_items.filter((i) => i.check_id === check.id);
    assert.equal(data.quotes.find((q) => q.check_id === check.id)?.status, "approved");
    for (const item of lines) {
      const totals = quantities(item, data.batches);
      assert.equal(totals.outstanding, 0);
      assert.equal(totals.final, item.required_packs);
      const due = data.batches.some((b) => b.check_item_id === item.id && b.kind !== "removed" && b.expiry && addMonths(b.expiry, 1) <= addMonths(check.check_date, 12));
      if (due) dueMonths.add(addMonths(check.check_date, 12).slice(0, 7));
    }
  }
  assert.deepEqual([...dueMonths].sort(), ["2027-09", "2027-10"]);
  const calypso = data.kit_checks.find((c) => c.vessel_id === "vessel-calypso")!;
  const dressing = data.check_items.find((i) => i.check_id === calypso.id && i.source_code === "DEMO-A-01")!;
  assert.deepEqual(quantities(dressing, data.batches), { kept: 1, supplied: 2, needed: 3, outstanding: 1, final: 3 });
  assert.equal(data.batches.filter((b) => b.check_item_id === dressing.id && b.kind === "supplied").length, 2);
  for (const item of data.check_items.filter((i) => i.check_id === calypso.id)) {
    const remaining = quantities(item, data.batches).outstanding;
    if (remaining) data = applyDemoCommand(data, { action: "add_batch", payload: { item_id: item.id, quantity: remaining, no_expiry: true } });
  }
  data = applyDemoCommand(data, { action: "finish", payload: { check_id: calypso.id } });
  assert.equal(data.kit_checks.find((c) => c.id === calypso.id)!.status, "complete");
  const fresh = demoWorkspace();
  assert.equal(fresh.kit_checks.find((c) => c.vessel_id === "vessel-calypso")!.status, "packing");
});
