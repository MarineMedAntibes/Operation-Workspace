import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkItemsInWorkbookOrder, inWorkbookOrder, workbookPosition } from "../src/lib/workbook-order";
import { demoWorkspace } from "../src/lib/demo";
import type { CheckItem } from "../src/lib/types";

test("workbook ordering handles both imports numerically without alphabetizing duplicate items", () => {
  const rows = [
    { id: "a", description: "A first alphabetically", attributes: { source_row: 100 } },
    { id: "b", description: "Duplicate", attributes: { source_arrival_row: "10" } },
    { id: "c", description: "Duplicate", attributes: { source_row: 3 } },
    { id: "d", description: "Last, added manually", attributes: {} },
  ];
  assert.deepEqual(inWorkbookOrder(rows).map(r => r.id), ["c", "b", "a", "d"]);
  assert.deepEqual(rows.map(r => r.id), ["a", "b", "c", "d"], "sorting must not mutate workspace data");
  assert.equal(workbookPosition({ sort_order: 0, source_arrival_row: 100 }), 3);
  assert.equal(workbookPosition({ source_pick_row: 2 }), 3);
  assert.equal(workbookPosition({ source_row: "", source_pick_row: 2 }), 3);
  assert.equal(workbookPosition({ source_row: "NaN" }), undefined);
});

test("older checks can use saved template order when their own metadata is absent", () => {
  const data = demoWorkspace();
  const check = data.kit_checks[0];
  const lines = data.check_items.filter(i => i.check_id === check.id);
  assert.ok(lines.length > 1);
  data.template_items.forEach((line, index) => { line.attributes.source_arrival_row = index + 3; });
  data.check_items = [...data.check_items].reverse().map(line => ({ ...line, attributes: undefined }));
  assert.deepEqual(checkItemsInWorkbookOrder(data, check.id).map(i => i.template_item_id), lines.map(i => i.template_item_id));
});

const imported = new URL("../private-import/completed-checks-data.json", import.meta.url);
test("all 14 archived check lists restore their complete source sequence after database ID sorting", {skip: !existsSync(imported)}, async () => {
  const checks: { id: string; lines: CheckItem[] }[] = JSON.parse(await readFile(imported, "utf8"));
  let count = 0;
  for (const check of checks) {
    const databaseOrder = [...check.lines].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(inWorkbookOrder(databaseOrder).map(i => i.id), check.lines.map(i => i.id));
    count += check.lines.length;
  }
  assert.equal(checks.length, 14);
  assert.equal(count, 2302);
});
