"""Prepare private pricing-rule SQL from MMA workbook evidence.

No live connection. Source amounts are read from a private extracted reference or
the supplied RATE TABLE workbook; they are never bundled into application code.
Run as database owner after the workflow migration. Existing rules are preserved.
"""
import argparse
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import uuid

NAMESPACE = uuid.UUID("b695005a-67f9-4a9a-a592-d542891f8f9a")
FAMILIES = [("MSN", "CAT A"), ("MSN", "CAT B"), ("Malta", "CAT A"), ("Malta", "CAT B"), ("ALL", "CAT C PLUS")]
JOBS = ["Routine Refill", "Category Swap", "Restructure", "New Build"]
BANDS = [10, 20, 30, 40, 60]


def from_workbook(package):
    import openpyxl
    path = package / "02_Kit_Check_Templates" / "MMA_MSN_CAT_B_KitCheck_TEMPLATE_v27d.xlsx"
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
    sheet = workbook["RATE TABLE"]
    result = {
        "version": str(sheet["B4"].value),
        "standard_fees": {sheet.cell(i, 1).value: [sheet.cell(i, j).value for j in range(2, 7)] for i in range(10, 16)},
        "cat_c_flat": {sheet.cell(17, j).value: sheet.cell(18, j).value for j in range(2, 6)},
        "policy": {sheet.cell(i, 1).value: {"loyalty_percent": sheet.cell(i, 2).value, "proceeds_credit_percent": sheet.cell(i, 3).value} for i in range(23, 27)},
        "new_build": {sheet.cell(i, 1).value: [sheet.cell(i, j).value for j in range(2, 7)] for i in [35, 36]},
        "cat_c_new_build": sheet["B37"].value,
    }
    workbook.close()
    return result


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def prepare(rates):
    rows = []
    source_hash = hashlib.sha256(json.dumps(rates, sort_keys=True, default=str).encode()).hexdigest()
    for framework, category in FAMILIES:
        for job in JOBS:
            for band_index, band in enumerate(BANDS):
                reasons = []
                if job == "New Build":
                    standard = 0
                    kit_price = rates["cat_c_new_build"] if category == "CAT C PLUS" else rates["new_build"][category][band_index]
                    reasons.append("Workbook requires a manually reviewed setup price for every new build; this is a suggested source amount.")
                    if framework == "Malta":
                        reasons.append("Generic new-build grid differs from the source's Malta 10-crew cost/sell benchmark; confirm framework pricing.")
                    if band in (40, 60) and category != "CAT C PLUS":
                        reasons.append("Source explicitly labels 40/60-crew new-build figures as proposed placeholders.")
                else:
                    kit_price = None
                    if category == "CAT C PLUS":
                        standard = rates["cat_c_flat"][job]
                        if job != "Routine Refill":
                            reasons.append("Flat Category Swap/Restructure source values are not explicitly marked as confirmed; review before use.")
                    else:
                        standard = rates["standard_fees"][category + " - " + job][band_index]
                        if band != 10:
                            reasons.append("Source states only the 10-crew assessment column is confirmed; this band is modelled pending sign-off.")
                policy = rates["policy"][job]
                key = f"{framework}:{category}:{band}:{job}"
                row = {
                    "id": str(uuid.uuid5(NAMESPACE, source_hash + ":" + key)),
                    "framework": framework, "category": category, "crew_band": band,
                    "job_type": job, "standard_fee": standard,
                    "member_discount_percent": policy["loyalty_percent"] * 100,
                    "proceeds_credit_percent": policy["proceeds_credit_percent"] * 100,
                    "new_build_kit_price": kit_price, "review_required": bool(reasons),
                }
                rows.append({"rule": row, "review_reasons": reasons})
    sql = ["-- PRIVATE internal pricing data. Do not commit this generated file.",
           "-- Apply after the workflow migration as database owner. Existing matching rules are kept.",
           "-- review_required=true amounts are suggestions, not signed-off pricing.", "BEGIN;"]
    for item in rows:
        row = item["rule"]
        sql.append("INSERT INTO public.pricing_rules (" + ",".join(row) + ") VALUES (" + ",".join(sql_value(v) for v in row.values()) + ") ON CONFLICT DO NOTHING;")
    sql.append("COMMIT;")
    report = {"source_version": rates["version"], "source_hash": source_hash,
              "rule_count": len(rows), "review_required": sum(r["rule"]["review_required"] for r in rows),
              "tax": "Tax is not inferred from these rates. Explicit reviewed goods/service/shipping percentages are separate check inputs.",
              "rules": rows}
    return "\n".join(sql) + "\n", report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, default=Path(__file__).resolve().parents[1] / "private-import/workflow-reference.json")
    parser.add_argument("--package", type=Path, help="Alternative extracted handover package; requires openpyxl")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "private-import")
    args = parser.parse_args()
    rates = from_workbook(args.package) if args.package else json.loads(args.reference.read_text(encoding="utf-8"))["_structured_rates_internal"]
    sql, report = prepare(rates)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "rate-rules.sql").write_bytes(sql.encode("utf-8"))
    (args.output / "rate-rules-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"rules": report["rule_count"], "need_review": report["review_required"], "sql_bytes": len(sql.encode("utf-8"))}))


if __name__ == "__main__":
    main()
