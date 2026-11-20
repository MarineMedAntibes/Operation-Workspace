"""Prepare a private, reviewable PostgreSQL seed; never connects to a database."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import uuid

NAMESPACE = uuid.UUID("da8541d7-02ac-4d18-ae29-44d30f46f9ce")


def stable_id(kind, key):
    return str(uuid.uuid5(NAMESPACE, kind + ":" + key))


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("Nonfinite number in source")
        return str(value)
    if isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if "\x00" in str(value):
        raise ValueError("NUL cannot be stored as PostgreSQL text")
    return "'" + str(value).replace("'", "''") + "'"


def prepare(export, reference):
    schema = json.loads((export / "airtable-schema.json").read_text(encoding="utf-8"))
    tables = {}
    source_counts = {}
    for table in schema["tables"]:
        fields = {f["id"]: f["name"] for f in table["fields"]}
        path = export / (table["id"] + ".records.json")
        rows = json.loads(path.read_text(encoding="utf-8"))
        tables[table["name"]] = [{"legacy_id": r["id"], **{fields.get(k, k): v for k, v in r["fields"].items()}} for r in rows]
        source_counts[table["name"]] = len(rows)
    output = ["-- PRIVATE DATA. Review before importing into a new Supabase workspace.", "BEGIN;", "SET LOCAL standard_conforming_strings = on;"]
    counts, issues = Counter(), []

    def insert(table, values):
        output.append(f"INSERT INTO public.{table} ({', '.join(values)}) VALUES ({', '.join(literal(v) for v in values.values())}) ON CONFLICT (id) DO NOTHING;")
        counts[table] += 1

    client_ids = {}
    for row in tables.get("Clients", []):
        key = row["legacy_id"]
        client_ids[key] = stable_id("client", key)
        insert("clients", {"id": client_ids[key], "name": row.get("Client Name") or key, "email": row.get("Email"), "phone": row.get("Phone number"), "billing_address": row.get("Billing Address"), "notes": row.get("Notes (Ownership Change etc)"), "legacy_id": key})
    for row in tables.get("Vessels", []):
        key = row["legacy_id"]
        links = row.get("Client (Linked)", [])
        crew = row.get("Crew Count")
        if not isinstance(crew, (int, float)) or not float(crew).is_integer() or not 1 <= crew <= 60:
            issues.append({"record": key, "reason": "Vessel crew missing/out of range; not imported"})
            continue
        if len(links) != 1 or links[0] not in client_ids:
            issues.append({"record": key, "reason": "Vessel client relationship needs review; not imported"})
            continue
        insert("vessels", {"id": stable_id("vessel", key), "name": row.get("Vessel Name") or key, "client_id": client_ids[links[0]], "framework": row.get("Regulatory Framework") or "Other", "flag_state": row.get("Flag State"), "crew": int(crew), "loyalty": row.get("Loyalty Signed?", False), "legacy_id": key})
    vendor_ids = {}
    for row in tables.get("Vendor Summary", []):
        key = row["legacy_id"]
        vendor_ids[key] = stable_id("vendor", key)
        insert("vendors", {"id": vendor_ids[key], "name": row.get("Supplier Name") or key, "legacy_id": key})
    for row in tables.get("Vendor Catalogue", []):
        key = row["legacy_id"]
        links = row.get("Supplier Name", [])
        vendor = vendor_ids.get(links[0]) if len(links) == 1 else None
        if vendor is None:
            issues.append({"record": key, "reason": "Supplier missing/ambiguous; catalogue record retained unassigned"})
        insert("vendor_products", {"id": stable_id("vendor_product", key), "vendor_id": vendor, "description": row.get("Item Description (EN)") or key, "sku": row.get("Vendor Article Number"), "pack_description": row.get("Vendor Unit Breakdown"), "price": row.get("Vendor Price (Per Pack)"), "legacy_id": key})

    reference_data = json.loads(reference.read_text(encoding="utf-8"))
    for workbook in reference_data["workbooks"]:
        template_id = stable_id("template", workbook["sha256"])
        insert("kit_templates", {"id": template_id, "name": f"{workbook['framework']} {workbook['category']}", "framework": workbook["framework"], "category": workbook["category"], "version": workbook["filename"], "published": True, "source_hash": workbook["sha256"]})
        for item in workbook["items"]:
            values = item["arrival_static_cells"]
            price, packs = values.get("K"), values.get("I")
            if not isinstance(price, (int, float)) or price < 0 or not isinstance(packs, (int, float)) or packs < 0:
                raise ValueError(f"Review price/quantity for {item['item_id']}")
            scaling = {"Fixed*": "fixed", "Scales": "band"}.get(values.get("AA"))
            if scaling is None:
                raise ValueError(f"Unknown scaling for {item['item_id']}")
            insert("template_items", {"id": stable_id("template_item", workbook["sha256"] + item["item_id"]), "template_id": template_id, "source_code": item["item_id"], "description": values.get("E") or item["item_id"], "location": values.get("B", ""), "pack_description": values.get("H", ""), "baseline_packs": packs, "scaling": scaling, "unit_price": price, "attributes": {"source_arrival_row": item["arrival_row"], "arrival": values, "pick": item["pick_static_cells"]}})
    output.append("COMMIT;")
    report = {"source_counts": source_counts, "prepared_counts": dict(counts), "issues": issues,
        "reference_sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "not_migrated_yet": ["Existing operational checks/lines/batches need reviewed reconciliation to new requirements; retained in the archive", "Source attachments remain local; Storage transfer not yet implemented", "Price book automation, equipment, invoices, certificates and additional reference tables remain archived"],
        "privacy": "Contains business data. Keep this directory private and out of source control."}
    return "\n".join(output) + "\n", report


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, default=root / "airtable-export")
    parser.add_argument("--reference", type=Path, default=root / "template-reference.json")
    parser.add_argument("--output", type=Path, default=root / "web" / "private-import")
    args = parser.parse_args()
    sql, report = prepare(args.export, args.reference)
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "seed.sql").write_text(sql, encoding="utf-8")
    (args.output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print("Prepared counts:", report["prepared_counts"])
    print("Records needing review:", len(report["issues"]))
    print("Private files:", args.output)
