"""Prepare private, reviewable SQL from the five authoritative handover workbooks.

Uses only Python's standard library. Never connects to Supabase. No clients,
vessels, completed checks, or spreadsheet formulas are imported as live data.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
NAMESPACE = uuid.UUID("506ec627-2716-4dd6-a0cf-7f6078d93ddc")
TEMPLATES = [
    ("MMA_MSN_CAT_A_KitCheck_TEMPLATE_v9_NEW_FORMAT.xlsx", "MSN", "CAT A", 199),
    ("MMA_MSN_CAT_B_KitCheck_TEMPLATE_v27d.xlsx", "MSN", "CAT B", 155),
    ("MMA_MALTA_CAT_A_KitCheck_TEMPLATE_v2.xlsx", "Malta", "CAT A", 190),
    ("MMA_MALTA_CAT_B_KitCheck_TEMPLATE_v3.xlsx", "Malta", "CAT B", 164),
    ("MMA_CAT_C_PLUS_ALL_REG_KitCheck_TEMPLATE_v3.xlsx", "ALL", "CAT C PLUS", 69),
]


def stable_id(kind, key):
    return str(uuid.uuid5(NAMESPACE, kind + ":" + key))


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("Non-finite source number")
        return str(value)
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if "\x00" in str(value):
        raise ValueError("NUL is not valid PostgreSQL text")
    return "'" + str(value).replace("'", "''") + "'"


def workbook(path):
    """Read stored values and formulas independently; do not trust formula caches."""
    result = {}
    with zipfile.ZipFile(path) as z:
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            strings = ["".join(t.text or "" for t in si.iterfind(".//s:t", NS))
                       for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
        rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        for sheet in ET.fromstring(z.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS):
            rid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rels[rid]
            target = target.lstrip("/") if target.startswith("/") else "xl/" + target
            rows = {}
            for row in ET.fromstring(z.read(target)).findall("s:sheetData/s:row", NS):
                cells = {}
                for c in row.findall("s:c", NS):
                    col = re.match(r"[A-Z]+", c.attrib["r"])[0]
                    v = c.find("s:v", NS)
                    f = c.find("s:f", NS)
                    typ = c.attrib.get("t")
                    if f is not None:
                        value = "=" + (f.text or "")
                    elif typ == "inlineStr":
                        value = "".join(t.text or "" for t in c.findall(".//s:t", NS))
                    elif v is None or v.text is None:
                        continue
                    elif typ == "s":
                        value = strings[int(v.text)]
                    elif typ == "b":
                        value = v.text == "1"
                    elif typ in ("str", "e"):
                        value = v.text
                    else:
                        value = float(v.text)
                        if value.is_integer():
                            value = int(value)
                    cells[col] = value
                rows[int(row.attrib["r"])] = cells
            result[sheet.attrib["name"]] = rows
    return result


def text(value):
    return str(value).strip() if value is not None else ""


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def static(cells):
    return {k: v for k, v in cells.items() if not (isinstance(v, str) and v.startswith("="))}


def flag(value):
    return text(value).upper() not in ("", "N", "NO", "FALSE", "0", "NONE")


def prepare(package, *, compact=False, statements_out=None):
    output = ["-- PRIVATE supplier data. Review report before applying as database owner.",
              "-- Requires the template-management migration. No client/vessel/check data included.",
              "BEGIN;", "SET LOCAL standard_conforming_strings = on;",
              "CREATE TEMP TABLE handover_new_templates (id uuid primary key) ON COMMIT DROP;"]
    counts = Counter()
    report = {"templates": [], "issues": [], "source_files": {}, "prepared_counts": {},
              "publication": "Imported as draft. Review quantities, prices and regulation metadata, then publish in Templates.",
              "limitations": ["MSN workbooks retain Amendment 4 basis; full Amendment 5 comparison remains outstanding.",
                              "Malta scaling is the workbook's operational judgment, not a statutory quantity.",
                              "No source price is inferred from a vendor unit price. Missing sell prices use a flagged draft placeholder.",
                              "No client, vessel, completed check, attachment or regulatory certification is imported.",
                              "Existing same-name suppliers are reused. Exact supplier/SKU/description product matches are skipped without overwriting staff changes; existing mismatched descriptions remain separate records.",
                              "Rerunning skips an entire previously imported template, including deleted or modified draft lines; existing edits are never resurrected or overwritten."]}

    def insert(table, values):
        if compact and "attributes" in values:
            values = {**values, "attributes": {k: v for k, v in values["attributes"].items() if k not in ("arrival", "pick", "source_cells")}}
        cols, vals = ', '.join(values), ', '.join(literal(v) for v in values.values())
        if table == "kit_templates":
            output.append(f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.kit_templates WHERE id={literal(values['id'])} AND source_hash IS DISTINCT FROM {literal(values['source_hash'])}) THEN RAISE EXCEPTION 'Existing imported template source hash differs'; END IF; END $$;")
            output.append(f"WITH added AS (INSERT INTO public.{table} ({cols}) VALUES ({vals}) ON CONFLICT (id) DO NOTHING RETURNING id) INSERT INTO handover_new_templates SELECT id FROM added;")
        elif table == "template_items":
            output.append(f"INSERT INTO public.{table} ({cols}) SELECT {vals} WHERE EXISTS (SELECT 1 FROM handover_new_templates WHERE id={literal(values['template_id'])}) ON CONFLICT (id) DO NOTHING;")
        elif table == "vendors":
            output.append(f"INSERT INTO public.{table} ({cols}) SELECT {vals} WHERE NOT EXISTS (SELECT 1 FROM public.vendors WHERE name={literal(values['name'])}) ON CONFLICT (id) DO NOTHING;")
        else:
            output.append(f"INSERT INTO public.{table} ({cols}) VALUES ({vals}) ON CONFLICT (id) DO NOTHING;")
        counts[table] += 1

    for filename, framework, category, expected in TEMPLATES:
        path = package / "02_Kit_Check_Templates" / filename
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        report["source_files"][filename] = digest
        sheets = workbook(path)
        arrival, pick = sheets["3. ARRIVAL CHECK"], sheets["5. PICK & FILL"]
        lines = [(row, cells) for row, cells in arrival.items() if row >= 3 and cells.get("C") and cells.get("E") and not text(cells["C"]).startswith("=")]
        if len(lines) != expected:
            raise ValueError(f"{filename}: expected {expected} lines, got {len(lines)}")
        template_id = stable_id("template", digest)
        version = "handover-" + re.search(r"_v([0-9]+[a-z]?)", filename)[0][1:] + "-" + digest[:8]
        insert("kit_templates", {"id": template_id, "name": f"{framework} {category}", "framework": framework,
                                 "category": category, "version": version, "published": False, "source_hash": digest})
        seen = Counter()
        item_counts, ned_count, missing = Counter(), 0, []
        for row, a in lines:
            p = pick[row - 1]
            item_id, bag = text(a["C"]), text(a.get("B"))
            if text(p.get("A")) != item_id or text(p.get("C")) != bag:
                raise ValueError(f"Arrival/Pick row alignment mismatch in {filename}:{row}")
            base = number(a.get("I"))
            if base is None:
                raise ValueError(f"Missing/invalid baseline in {filename}:{row}")
            scaling = {"Fixed*": "fixed", "Scales": "band"}.get(a.get("AA"))
            if scaling is None:
                raise ValueError(f"Unknown scaling in {filename}:{row}")
            price = number(a.get("K"))
            key = item_id + "|" + bag
            seen[key] += 1
            if seen[key] > 1:
                key += "|occurrence:" + str(seen[key])
            ned = text(p.get("AF")).upper() == "NED"
            attrs = {"item_id": item_id, "line_key": key, "source_filename": filename, "source_hash": digest,
                     "source_arrival_row": row, "source_pick_row": row - 1, "sort_order": row - 3,
                     "reg_code": a.get("D", ""), "dose_route": a.get("F", ""), "regulation_quantity": a.get("G", ""),
                     "ned": ned, "no_expiry": ned, "price_missing": price is None, "item_type": p.get("V", ""),
                     "masters_safe": flag(p.get("Y")), "flammable": flag(p.get("Z")),
                     "uses": p.get("AA", ""), "side_effects": p.get("AB", ""), "notes": p.get("AC", ""),
                     "statutory_section": p.get("AD", ""), "refrigerated": text(p.get("AE")).upper() == "Y",
                     "regulation_basis": "MSN 1905 Amendment 4" if framework == "MSN" else "Malta Fifth Schedule" if framework == "Malta" else "MSN Cat C + Malta Cat C + MMA additions",
                     "arrival": static(a), "pick": static(p)}
            insert("template_items", {"id": stable_id("template_item", digest + ":" + key), "template_id": template_id,
                                      "source_code": key, "description": text(a["E"]), "location": bag,
                                      "pack_description": text(a.get("H")), "baseline_packs": base,
                                      "scaling": scaling, "unit_price": price if price is not None else 0, "attributes": attrs})
            item_counts[item_id] += 1
            ned_count += int(ned)
            if price is None:
                missing.append({"item_id": item_id, "line_key": key, "row": row, "description": a["E"]})
        report["templates"].append({"filename": filename, "id": template_id, "version": version, "lines": len(lines),
                                    "first_arrival_row": lines[0][0], "last_arrival_row": lines[-1][0],
                                    "no_expiry_lines": ned_count, "missing_prices": missing,
                                    "duplicate_item_ids": {k: v for k, v in item_counts.items() if v > 1}})

    cat_path = package / "03_Master_Data" / "Master_Vendor_Catalogue_v20.xlsx"
    cat_hash = hashlib.sha256(cat_path.read_bytes()).hexdigest()
    report["source_files"][cat_path.name] = cat_hash
    catalogue = workbook(cat_path)["Master Catalogue"]
    seen_products = set()
    vendors = {}
    for row, values in catalogue.items():
        if row == 1 or not values.get("A") or not values.get("D"):
            continue
        article, supplier = text(values["A"]), text(values.get("B"))
        if article in seen_products:
            raise ValueError(f"Duplicate catalogue article: {article}")
        seen_products.add(article)
        if supplier and supplier not in vendors:
            vendors[supplier] = stable_id("vendor", supplier.casefold())
            insert("vendors", {"id": vendors[supplier], "name": supplier,
                               "notes": "Imported from " + cat_path.name, "legacy_id": "handover:vendor:" + supplier})
        if not supplier:
            report["issues"].append({"article": article, "reason": "Supplier blank; retained unassigned, no supplier inferred."})
        pack_price = number(values.get("J"))
        if pack_price is None:
            report["issues"].append({"article": article, "reason": "Pack price missing/non-numeric; retained NULL."})
        attrs = {"mma_article_number": article, "pricing_basis": text(values.get("H")), "units_per_pack": number(values.get("I")),
                 "unit_price": number(values.get("K")), "matched_item_ids": text(values.get("E")),
                 "category": text(values.get("F")), "hs_code": text(values.get("L")), "hs_classification_basis": text(values.get("M")),
                 "supplier_note": text(values.get("N")), "preferred_supplier": text(values.get("O")),
                 "mma_sell_price": number(values.get("P")), "notes": text(values.get("Q")),
                 "latest_invoice": text(values.get("R")), "latest_invoice_date": text(values.get("S")),
                 "review_required": supplier == "Robe Medical" or pack_price is None or not supplier,
                 "source_filename": cat_path.name, "source_hash": cat_hash, "source_row": row, "source_cells": static(values)}
        product = {"id": stable_id("vendor_product", article), "vendor_id": None,
                   "description": text(values["D"]), "sku": text(values.get("C")) or None,
                   "pack_description": text(values.get("G")) or None, "price": pack_price,
                   "legacy_id": "handover:product:" + article, "attributes": attrs}
        if compact:
            product["attributes"] = {k: v for k, v in attrs.items() if k != "source_cells"}
        vendor_sql = f"(SELECT id FROM public.vendors WHERE name={literal(supplier)} ORDER BY id LIMIT 1)" if supplier else "NULL::uuid"
        vals = ', '.join(vendor_sql if k == "vendor_id" else literal(v) for k, v in product.items())
        output.append(f"INSERT INTO public.vendor_products ({', '.join(product)}) SELECT {vals} WHERE NOT EXISTS (SELECT 1 FROM public.vendor_products p WHERE coalesce(p.legacy_id,'') NOT LIKE 'handover:product:%' AND p.vendor_id IS NOT DISTINCT FROM {vendor_sql} AND p.sku IS NOT DISTINCT FROM {literal(product['sku'])} AND p.description={literal(product['description'])}) ON CONFLICT (id) DO NOTHING;")
        counts["vendor_products"] += 1
    if len(seen_products) != 902:
        raise ValueError(f"Expected 902 catalogue rows, got {len(seen_products)}")
    report["prepared_counts"] = dict(counts)
    output.append("COMMIT;")
    if statements_out is not None:
        statements_out.extend(output)
    return "\n".join(output) + "\n", report


def write_editor_parts(package, directory):
    """One atomic file per template; small standalone vendor/catalogue files.

    Work with complete generated statements, never split SQL text on newlines or
    semicolons: workbook descriptions can contain both inside quoted literals.
    Only redundant raw worksheet-cell copies are omitted from these parts. The
    full seed and original workbooks retain those cells.
    """
    statements = []
    prepare(package, compact=True, statements_out=statements)
    templates, vendors, products = [], [], []
    for statement in statements:
        if statement.startswith("DO $$"):
            templates.append([statement])
        elif statement.startswith("WITH added AS") or statement.startswith("INSERT INTO public.template_items"):
            templates[-1].append(statement)
        elif statement.startswith("INSERT INTO public.vendors"):
            vendors.append(statement)
        elif statement.startswith("INSERT INTO public.vendor_products"):
            products.append(statement)
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    header = "-- PRIVATE handover import. Run numbered files in order.\nBEGIN;\nSET LOCAL standard_conforming_strings = on;\n"

    def save(label, body, template=False):
        filename = f"{len(files)+1:02d}-{label}.sql"
        content = header + ("CREATE TEMP TABLE handover_new_templates (id uuid primary key) ON COMMIT DROP;\n" if template else "") + "\n".join(body) + "\nCOMMIT;\n"
        (directory / filename).write_bytes(content.encode("utf-8"))
        files.append({"file": filename, "bytes": len(content.encode("utf-8"))})

    for group, (_, framework, category, _) in zip(templates, TEMPLATES):
        save(f"template-{framework.lower()}-{category.lower().replace(' ', '-')}", group, template=True)
    save("vendors", vendors)
    chunk, size = [], 0
    for statement in products:
        statement_size = len(statement.encode("utf-8")) + 1
        if chunk and size + statement_size > 120_000:
            save("catalogue", chunk)
            chunk, size = [], 0
        chunk.append(statement)
        size += statement_size
    if chunk:
        save("catalogue", chunk)
    (directory / "manifest.json").write_text(json.dumps(files, indent=2), encoding="utf-8")
    (directory / "READ-ME.txt").write_text(
        "Apply 202611200001_templates.sql first if not already applied.\n"
        "Then open, copy and run each SQL file below in Supabase SQL Editor, in order.\n"
        "Wait for success before moving to the next file. Each file has its own transaction.\n"
        "If a file fails, rerun that entire file; no reset or database clearing is needed.\n"
        "These parts replace handover-seed.sql; do not run both. Existing matching imports are skipped.\n"
        "Template files must be run whole; do not split their contents across runs.\n"
        "Only redundant raw worksheet-cell copies are omitted; all app fields, original IDs,\n"
        "source hashes, prices, NED, scaling and storage metadata are retained.\n\n"
        + "\n".join(f"{p['file']} ({p['bytes']:,} bytes)" for p in files) + "\n",
        encoding="utf-8")
    return files


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path, help="Extracted package directory containing 02_Kit_Check_Templates")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "private-import")
    args = parser.parse_args()
    sql, report = prepare(args.package)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "handover-seed.sql").write_text(sql, encoding="utf-8")
    (args.output / "handover-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    parts = write_editor_parts(args.package, args.output / "sql-editor-parts")
    print(json.dumps({"prepared_counts": report["prepared_counts"], "issues": len(report["issues"]),
                      "missing_template_prices": sum(len(t["missing_prices"]) for t in report["templates"]),
                      "editor_parts": len(parts), "largest_part_bytes": max(p["bytes"] for p in parts)}, indent=2))
