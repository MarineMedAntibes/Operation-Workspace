import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import manifest from "../../assets/workbook-templates/manifest.json";
import type { Batch, CheckItem, Workspace } from "./types";
import { checkItemsInWorkbookOrder } from "./workbook-order";
import { quantities } from "./rules";
import { calculateFinance } from "./finance";

type CellValue = string | number | boolean | null | undefined;
type SourceLine = { item_id: string; location: string; line_key: string; arrival_row: number; pick_row: number; directory_row: number | null };
const xmlEscape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** Patch values inside existing cells without changing style references, drawings or layout. */
export function patchWorksheetCells(xml: string, values: Record<string, CellValue>, cacheFormulas = false): string {
  for (const [address, value] of Object.entries(values)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(address)) throw new Error("Invalid workbook cell address.");
    const pattern = new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*(?:/>|>[\\s\\S]*?<\\/c>)`);
    const old = xml.match(pattern)?.[0];
    const opening = old?.match(/^<c\b[^>]*?(?:>|\/>)/)?.[0].replace(/\s+t="[^"]*"/, "").replace(/\s*\/>$/, ">") ?? `<c r="${address}">`;
    const formula = cacheFormulas ? old?.match(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/)?.[0] ?? "" : "";
    let encoded: string;
    if (value === undefined || value === null || value === "") encoded = `${opening}${formula}</c>`;
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Cannot export a non-finite workbook value.");
      encoded = `${opening}${formula}<v>${value}</v></c>`;
    } else if (typeof value === "boolean") encoded = `${opening.replace(/>$/, ' t="b">')}${formula}<v>${value ? 1 : 0}</v></c>`;
    else if (formula) encoded = `${opening.replace(/>$/, ' t="str">')}${formula}<v>${xmlEscape(value)}</v></c>`;
    else encoded = `${opening.replace(/>$/, ' t="inlineStr">')}<is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    if (old) xml = xml.replace(pattern, () => encoded);
    else {
      const row = address.match(/\d+/)![0];
      const rowPattern = new RegExp(`(<row\\b(?=[^>]*\\br="${row}")[^>]*>)([\\s\\S]*?)(<\\/row>)`);
      if (rowPattern.test(xml)) xml = xml.replace(rowPattern, (_all, start, body, end) => start + body + encoded + end);
      else xml = xml.replace("</sheetData>", `<row r="${row}">${encoded}</row></sheetData>`);
    }
  }
  return xml;
}

function sheetPaths(archive: Record<string, Uint8Array>): Map<string, string> {
  const relationships = new Map<string, string>();
  const rels = strFromU8(archive["xl/_rels/workbook.xml.rels"]);
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1];
    const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relationships.set(id, target.startsWith("/") ? target.slice(1) : "xl/" + target);
  }
  const result = new Map<string, string>();
  for (const match of strFromU8(archive["xl/workbook.xml"]).matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const name = match[1].match(/\bname="([^"]+)"/)?.[1];
    const rid = match[1].match(/\br:id="([^"]+)"/)?.[1];
    if (name && rid && relationships.has(rid)) result.set(name.replaceAll("&amp;", "&"), relationships.get(rid)!);
  }
  return result;
}

function excelDate(date: string | null): number | null {
  if (!date) return null;
  const parsed = Date.parse(date.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(parsed)) throw new Error("An exported record has an invalid date.");
  return (parsed - Date.UTC(1899, 11, 30)) / 86400000;
}
const labelMonth = (date: string) => `${date.slice(5, 7)}/${date.slice(0, 4)}`;
const normal = (value: string) => value.normalize("NFKC").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

type Group = { quantity: number; expiry: string | null; no_expiry: boolean; kind: Batch["kind"] };
function expiryGroups(batches: Batch[], item: CheckItem, maximum=2): Group[] {
  const groups = new Map<string, Group>();
  for (const batch of batches) {
    const key = batch.no_expiry ? "NED" : batch.expiry ?? "UNKNOWN";
    if (!batch.no_expiry && !batch.expiry) throw new Error(`Resolve the missing expiry on ${item.description} before exporting.`);
    const existing = groups.get(key);
    if (existing && existing.kind !== batch.kind && ![existing.kind, batch.kind].every(kind => kind === "supplied")) throw new Error(`Resolve conflicting keep/remove decisions at the same expiry for ${item.description}.`);
    if (existing) existing.quantity += Number(batch.quantity);
    else groups.set(key, { quantity: Number(batch.quantity), expiry: batch.expiry, no_expiry: batch.no_expiry, kind: batch.kind });
  }
  const result = [...groups.values()].sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999"));
  if (result.length > maximum) throw new Error(`${item.description} has more than two expiry groups. Resolve the extra expiries before exporting to the two-slot Excel format.`);
  return result;
}

type Workflow = Record<string, unknown>;
const record = (value: unknown): Workflow => value && typeof value === "object" && !Array.isArray(value) ? value as Workflow : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Export a draft copy of the original formatted workbook. Never issues a certificate. */
export async function buildWorkbookExport({ data, checkId }: { data: Workspace; checkId: string }): Promise<Uint8Array> {
  const check = data.kit_checks.find(value => value.id === checkId);
  if (!check) throw new Error("Kit check not found.");
  const template = data.kit_templates.find(value => value.id === check.template_id);
  const source = manifest.find(value => value.framework === template?.framework && value.category === template?.category);
  if (!source) throw new Error("No original Excel format is available for this kit family.");
  const bytes = await readFile(join(process.cwd(), "assets", "workbook-templates", source.file));
  const archive = unzipSync(bytes);
  const paths = sheetPaths(archive);
  const pending = new Map<string, { plain: Record<string, CellValue>; cached: Record<string, CellValue> }>();
  const set = (sheet: string, address: string, value: CellValue, cache = false) => {
    if (!pending.has(sheet)) pending.set(sheet, { plain: {}, cached: {} });
    pending.get(sheet)![cache ? "cached" : "plain"][address] = value;
  };
  const vessel = data.vessels.find(value => value.id === check.vessel_id);
  const workflow = record(check.attributes?.workflow);
  const finance = record(workflow.finance);
  const config: Record<string, CellValue> = {
    C5: vessel?.name ?? "", C6: vessel?.flag_state ?? "", C7: template?.framework === "ALL" ? "ALL REG" : template?.framework,
    C8: String(workflow.management_company ?? check.attributes?.source_management_company ?? ""), C9: check.crew,
    C10: excelDate(check.check_date), C11: excelDate(check.valid_until), C12: String(workflow.assessor ?? check.attributes?.assessor ?? ""),
    C15: template?.category, C16: check.job_type, C18: check.loyalty,
    C19: typeof finance.job_proceeded === "boolean" ? finance.job_proceeded : check.status === "packing" || check.status === "complete",
    C21: "DRAFT - NOT ISSUED", C32: workflow.client_type === "B2B" ? "B2B - Business to Business" : workflow.client_type === "B2C" ? "B2C - Private" : String(workflow.client_type ?? ""),
    C33: String(workflow.tva_status ?? ""), C34: String(workflow.delivery_location ?? ""),
    J26: String(workflow.telemedical_customer ?? "Unknown"),
    J28: String(workflow.document_booklet ?? "Unknown"),
  };
  for (const [address, value] of Object.entries(config)) set("1.CONFIG", address, value);
  const critical = Array.isArray(workflow.critical_equipment) ? workflow.critical_equipment.map(record) : [];
  for (const [index, item] of critical.slice(0, 3).entries()) {
    const row = index + 26;
    set("1.CONFIG", `C${row}`, typeof item.present === "boolean" ? item.present ? "Yes" : "No" : String(item.present ?? ""));
    set("1.CONFIG", `D${row}`, String(item.model_serial ?? item.model ?? ""));
    set("1.CONFIG", `E${row}`, excelDate(typeof item.expiry === "string" ? item.expiry : null));
    set("1.CONFIG", `F${row}`, excelDate(typeof item.hydrotest === "string" ? item.hydrotest || null : null));
  }
  set("1.CONFIG", "B49", "DRAFT APP EXPORT - review in Excel before sharing. No certificate has been issued or signed.");
  set("7.CERTIFICATE", "A8", "DRAFT CERTIFICATE OF CONFORMITY - NOT ISSUED");
  set("7.CERTIFICATE", "A10", "DRAFT - NOT ISSUED", true);
  set("7.CERTIFICATE", "A27", "DRAFT - NOT ISSUED. This workbook export is not an issued compliance certificate.");
  set("6.KIT DIRECTORY", "A4", vessel?.name ?? "", true);
  set("6.KIT DIRECTORY", "A6", `Check Date: ${labelMonth(check.check_date)}  /  Coverage: ${labelMonth(check.valid_until)}  /  DRAFT`, true);

  const sourceByKey = new Map<string, SourceLine>();
  for (const line of source.lines) sourceByKey.set(normal(line.line_key), line as SourceLine);
  const rows = checkItemsInWorkbookOrder(data, check.id);
  const missing: string[] = [];
  let reconciliationRow = 7;
  for (const item of rows) {
    const attrs = item.attributes ?? {};
    const itemId = String(attrs.item_id ?? item.source_code.split("|")[0]);
    const line = sourceByKey.get(normal(itemId + "|" + item.location));
    if (!line) { missing.push(itemId + " / " + item.location); continue; }
    const r = line.arrival_row, p = line.pick_row;
    const own = data.batches.filter(batch => batch.check_item_id === item.id && !batch.voided_at);
    const old = expiryGroups(own.filter(batch => batch.kind !== "supplied"), item);
    const supplied = expiryGroups(own.filter(batch => batch.kind === "supplied"), item);
    const final = expiryGroups(own.filter(batch => batch.kind !== "removed").map(batch => ({ ...batch, kind: "kept" })), item,4);
    const q = quantities(item, data.batches);
    const origin = String(attrs.original_description ?? item.description);
    const master = data.template_items.find(value => value.id === item.template_item_id);
    for (const [address, value] of Object.entries({ [`E${r}`]: origin, [`H${r}`]: item.pack_description, [`I${r}`]: master?.baseline_packs ?? item.required_packs, [`K${r}`]: item.unit_price, [`Y${r}`]: String(attrs.override_reason ?? attrs.source_stock_notes ?? ""), [`Z${r}`]: String(attrs.substitute_description ?? "") })) set("3. ARRIVAL CHECK", address, value);
    // A check-specific requirement is an intentional workbook override. Otherwise
    // keep the source scaled-quantity formula and its cached snapshot.
    const band = [10, 20, 30, 40, 60].find(value => check.crew <= value) ?? 60;
    const expected = master ? master.scaling === "fixed" ? Number(master.baseline_packs) : Math.round(Number(master.baseline_packs) * band / 10) : item.required_packs;
    set("3. ARRIVAL CHECK", `J${r}`, item.required_packs, Number(item.required_packs) === expected);
    for (const [index, group] of old.entries()) {
      const [expiryCol, countCol, flagCol, overrideCol] = index === 0 ? ["N", "P", "O", "W"] : ["Q", "S", "R", "X"];
      const expiry = group.no_expiry ? "NED" : excelDate(group.expiry);
      set("3. ARRIVAL CHECK", `${overrideCol}${r}`, expiry);
      set("3. ARRIVAL CHECK", `${expiryCol}${r}`, expiry, true);
      set("3. ARRIVAL CHECK", `${countCol}${r}`, group.quantity);
      set("3. ARRIVAL CHECK", `${flagCol}${r}`, group.no_expiry ? "NED" : group.kind === "kept" ? "KEEP" : "REMOVE", true);
      if (reconciliationRow > 300) throw new Error("The original Excel reconciliation sheet supports 294 source rows; this check needs a reviewed extended workbook.");
      for (const [col, value] of Object.entries({ B: origin, C: group.quantity, D: expiry, E: "App stock record", F: itemId, H: "User confirmed" })) set("2. RECONCILIATION", `${col}${reconciliationRow}`, value);
      reconciliationRow++;
    }
    set("3. ARRIVAL CHECK", `T${r}`, q.kept, true);
    set("3. ARRIVAL CHECK", `U${r}`, q.needed, true);
    set("3. ARRIVAL CHECK", `V${r}`, item.assessment_state === "unreviewed" ? "OPEN" : "COMPLETE", true);
    const flags = [attrs.refrigerated && "Refrigerated", attrs.masters_safe && "Master's Safe", attrs.flammable && "Flammable", attrs.substitute_description && "SUBSTITUTE"].filter(Boolean).join(" / ");
    for (const [address, value] of Object.entries({ [`B${p}`]: item.description, [`D${p}`]: item.pack_description, [`G${p}`]: item.unit_price, [`P${p}`]: String(attrs.override_reason ?? attrs.directory_note ?? ""), [`S${p}`]: String(attrs.override_reason ?? ""), [`X${p}`]: String(attrs.dose_route ?? ""), [`Y${p}`]: attrs.masters_safe ? "Master's Safe" : "", [`Z${p}`]: attrs.flammable ? "Y" : "", [`AA${p}`]: String(attrs.uses ?? ""), [`AB${p}`]: String(attrs.side_effects ?? ""), [`AD${p}`]: String(attrs.statutory_section ?? ""), [`AE${p}`]: attrs.refrigerated ? "Y" : "", [`AF${p}`]: attrs.ned ? "NED" : "", [`AG${p}`]: item.kill_line || item.assessment_state === "not_applicable" ? "Y" : "" })) set("5. PICK & FILL", address, value);
    if (Number(attrs.original_required_packs ?? item.required_packs) !== Number(item.required_packs) || attrs.source_override_add_packs !== undefined) set("5. PICK & FILL", `Q${p}`, q.needed);
    if (Number(attrs.original_unit_price ?? item.unit_price) !== Number(item.unit_price)) set("5. PICK & FILL", `R${p}`, item.unit_price);
    for (const [index, group] of supplied.entries()) {
      set("5. PICK & FILL", `${index === 0 ? "H" : "J"}${p}`, group.no_expiry ? "NED" : excelDate(group.expiry));
      set("5. PICK & FILL", `${index === 0 ? "I" : "K"}${p}`, group.quantity);
    }
    set("5. PICK & FILL", `F${p}`, q.needed, true);
    set("5. PICK & FILL", `E${p}`, q.outstanding > 0 ? "RESTOCK NEEDED" : q.supplied > 0 ? "RESTOCKED" : "NO STOCK NEEDED", true);
    set("5. PICK & FILL", `M${p}`, q.outstanding > 0 ? "INCOMPLETE" : "COMPLETE", true);
    set("5. PICK & FILL", `N${p}`, q.needed * item.unit_price, true);
    set("5. PICK & FILL", `O${p}`, q.supplied, true);
    set("5. PICK & FILL", `U${p}`, flags, true);
    if (line.directory_row) {
      const k = line.directory_row;
      for (const [col, value] of Object.entries({ C: item.description, D: String(attrs.dose_route ?? ""), E: String(attrs.uses ?? ""), F: String(attrs.side_effects ?? ""), G: q.final, H: item.pack_description, I: final.map(group => `${group.quantity} x ${group.no_expiry ? "NED" : labelMonth(group.expiry!)}`).join("; "), J: flags })) set("6.KIT DIRECTORY", `${col}${k}`, value, true);
    }
  }
  if (missing.length) throw new Error(`The original Excel format has no matching line for ${missing.slice(0, 3).join("; ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}. Review these custom lines before exporting; no lines were silently dropped.`);

  const quoteFinance = calculateFinance(data, check, "quote");
  const invoiceFinance = calculateFinance(data, check, "invoice");
  const fee = quoteFinance.assessment_fee;
  set("4. COST ANALYSIS", "F15", fee);
  if (finite(finance.standard_fee) !== null) set("4. COST ANALYSIS", "F8", finite(finance.standard_fee));
  for (const [address, key] of Object.entries({ F10: "loyalty_discount_percent", F13: "proceeds_credit_percent", H23: "goods_share_percent", H32: "goods_share_percent" })) {
    if (finite(finance[key]) !== null) set("4. COST ANALYSIS", address, Number(finance[key]) / 100);
  }
  for (const [address, key] of Object.entries({ F19: "new_build_kit_price", F59: "shipping", F60: "coolbox", F61: "handling" })) if (finite(finance[key]) !== null) set("4. COST ANALYSIS", address, finite(finance[key]));
  // The source's one-rate TVA formulas cannot express reviewed per-kind rates.
  // Write the app's explicit snapshot totals into those original formatted cells.
  for (const [address, value] of Object.entries({ F21: quoteFinance.items_subtotal, F24: quoteFinance.goods_net, F25: quoteFinance.service_net, F30: invoiceFinance.items_subtotal, F33: invoiceFinance.goods_net, F34: invoiceFinance.service_net, F65: quoteFinance.subtotal, I65: invoiceFinance.subtotal, F68: quoteFinance.vat, I68: invoiceFinance.vat, F71: quoteFinance.total, I71: invoiceFinance.total })) set("4. COST ANALYSIS", address, value);
  for (const [mode, start] of [["quote", 19], ["invoice", 27]] as const) {
    const totals = mode === "quote" ? quoteFinance : invoiceFinance;
    const aggregate = [totals.lines.filter(l => l.key === "assessment"), totals.lines.filter(l => l.key === "supply"), totals.lines.filter(l => l.key === "compliance"), totals.lines.filter(l => l.key.startsWith("extra-")), totals.lines.filter(l => ["coolbox", "shipping", "handling"].includes(l.key))];
    aggregate.forEach((lines, index) => {
      const row = start + index;
      set("QUOTE + INVOICE", `C${row}`, lines.reduce((sum, line) => sum + line.net, 0));
      const rates = [...new Set(lines.map(line => line.vat_percent))];
      set("QUOTE + INVOICE", `D${row}`, rates.length > 1 ? "Mixed reviewed rates - see app breakdown" : rates.length ? `${rates[0]}% (app tax input)` : "No charge");
    });
  }
  if (quoteFinance.warnings.length) set("1.CONFIG", "B50", "Finance review: " + quoteFinance.warnings.join(" / "));
  const extras = Array.isArray(finance.extras) ? finance.extras.map(record) : [];
  if (extras.length > 16) throw new Error("The original Excel extras table supports 16 rows; reduce or combine extras before exporting.");
  for (const [index, extra] of extras.entries()) {
    const row = index + 39;
    for (const [col, value] of Object.entries({ B: String(extra.description ?? ""), D: finite(extra.quantity), E: finite(extra.unit_price), F: String(extra.kind ?? "") })) set("4. COST ANALYSIS", `${col}${row}`, value);
  }
  const legacy = data.legacy_items?.filter(item => item.check_id === check.id) ?? [];
  if (legacy.length > 40) throw new Error("The original Excel legacy-items sheet supports 40 rows; split the legacy list before exporting.");
  for (const [index, item] of legacy.entries()) {
    const row = index + 8;
    for (const [col, value] of Object.entries({ B: item.description, E: item.quantity, F: "Legacy / non-regulated", G: item.no_expiry ? "NED" : excelDate(item.expiry), H: "On board", I: [item.location, item.notes].filter(Boolean).join(" / ") })) set("NON-REG - LEGACY ITEMS", `${col}${row}`, value);
  }
  for (const [sheet, values] of pending) {
    const path = paths.get(sheet);
    if (!path) throw new Error(`Original worksheet ${sheet} is unavailable.`);
    archive[path] = strToU8(patchWorksheetCells(patchWorksheetCells(strFromU8(archive[path]), values.cached, true), values.plain));
  }
  return zipSync(archive, { level: 6 });
}
