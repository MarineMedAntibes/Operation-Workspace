"""Prepare private, reviewable imports from MMA's completed-check ZIP archive.

Requires openpyxl. Never connects to a database and never assumes a cached Excel
COMPLETE flag establishes a client approval, issued certificate or valid inventory.
"""
import argparse
from collections import Counter
from datetime import date, datetime, time, timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import re
import uuid
import zipfile

import openpyxl
from openpyxl.utils.datetime import from_excel

NAMESPACE = uuid.UUID("a62c6f13-65d0-40d4-bcd1-4d74cc242b39")
# Explicit current-source selection. Earlier versions remain in the archive audit.
SELECTED = [
    "FAUDA CAT A & B/mca cat a .xlsx",
    "FAUDA CAT A & B/mca_cat_b_Fauda_reconciled.xlsx",
    "FLEUR/MMA_MSN_CAT_B_KitCheck_FLEUR_RECONCILED.xlsx",
    "KATHLEEN ANNE/KATHLEEN_ANNE_KitCheck_CAT_B_OCT_2026_RECONCILED_Amy Fix.xlsx",
    "LILIYA/Liliya oct 2026/MMA_MSN_CAT_B_KitCheck_M-Y_Liliya_2026-10-02_v24_NEW_TEMPLATE_v27c.xlsx",
    "NURJA/MMA_MSN_CAT_B_KitCheck_NURJA_UPDATED_2.xlsx",
    "PROVOCATEUR/MMA_MSN_CAT_A_KitCheck_MY_PROVOCATEUR_2026-10-08_v1_NEW.xlsx",
    "SHIMALI CAT B/MMA_MSN_CAT_B_KitCheck_Shimali_Oct2026_UPDATED_3.xlsx",
    "YOU & ME/YouAndMe_CATB_KitCheck_v27d_RECONCILED.xlsx",
    "ALLURE/MMA_MSN_CAT_B_KitCheck_ALLURE_reconciled.xlsx",
    "ANDIAMO/MMA_MSN_CAT_B_KitCheck_ANDIAMO_reconciled_NEW.xlsx",
    "BELLADONNA/MMA_MSN_CAT_B_KitCheck_Bella_Donna_RECONCILED.xlsx",
    "MALAHNE CAT/MMA_MSN_CAT_A_KitCheck_MALAHNE_Nov2026.xlsx",
    "RIVIERA SUN/MMA_MSN_CAT_B_KitCheck_TEMPLATE_v27d.xlsx",
]


def uid(kind, key):
    return str(uuid.uuid5(NAMESPACE, kind + ":" + key))


def clean(value):
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def text(value):
    return str(value).strip() if value is not None else ""


def num(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        return float(value)
    return None


def yes(value):
    return text(value).upper() not in ("", "N", "NO", "FALSE", "0", "NONE")


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        assert math.isfinite(value)
        return str(value)
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if "\0" in str(value):
        raise ValueError("NUL in SQL value")
    return "'" + str(value).replace("'", "''") + "'"


def month(value):
    """Read a single unambiguous pack expiry. Date precision is month-only."""
    if isinstance(value, (datetime, date)):
        return value.replace(day=1).isoformat()[:10]
    if isinstance(value, (int, float)) and 20000 < value < 80000:
        return from_excel(value).replace(day=1).date().isoformat()
    s = text(value).strip(". ")
    m = re.fullmatch(r"(\d{1,2})[/.-](\d{2}|\d{4})", s)
    if m:
        year = int(m[2]) + (2000 if len(m[2]) == 2 else 0)
        try:
            return date(year, int(m[1]), 1).isoformat()
        except ValueError:
            pass
    return None


def add_month(d, n):
    y, m = d.year + (d.month - 1 + n) // 12, (d.month - 1 + n) % 12 + 1
    return date(y, m, 1)


def expiry_keep(expiry, cutoff):
    return add_month(date.fromisoformat(expiry), 1) > cutoff


def cells(sheet):
    return {r: {c.column_letter: clean(c.value) for c in row if c.value is not None}
            for r, row in enumerate(sheet.iter_rows(), 1) if any(c.value is not None for c in row)}


def get(row, col):
    return row.get(col) if row else None


def pf_columns(headers):
    result = {}
    for col, value in headers.items():
        s = re.sub(r"\s+", " ", text(value)).lower()
        for key, needle in {"override_qty": "override qty", "override_price": "override unit price", "override_reason": "override reason", "ned": "no expiry", "kill": "kill line", "safe": "master's", "flammable": "flammable", "refrigerated": "refrigerated", "uses": "type of drug", "side_effects": "side effects", "notes": "notes", "statutory": "statutory section", "item_type": "type", "directory_note": "kit directory flag"}.items():
            if needle in s and (key != "item_type" or s == "type"):
                result[key] = col
    return result


def vessel_name(value):
    return re.sub(r"^(?:M/Y|MY|M\s*/\s*Y)\s+", "", text(value), flags=re.I).strip().upper()


def prepare_check(path, data, raw, as_of):
    digest = hashlib.sha256(data).hexdigest()
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    fw = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    config = cells(wb["1.CONFIG"])
    c = lambda row: get(config.get(row), "C")
    vessel, framework, category = vessel_name(c(5)), text(c(7)), text(c(15))
    checked = date.fromisoformat(text(c(10))[:10])
    crew = int(c(9))
    if not 1 <= crew <= 60:
        raise ValueError(f"{path}: crew outside supported range")
    band = next(b for b in [10, 20, 30, 40, 60] if b >= crew)
    issues = ["Billing identity and client approval are not established by the workbook; review the imported account and check."]
    # Use the actual date from CONFIG when present, not its display month.
    exact_cutoff = text(c(11))[:10] if isinstance(c(11), str) and re.match(r"\d{4}-\d{2}-\d{2}", c(11)) else None
    if not exact_cutoff:
        exact_cutoff = checked.replace(year=checked.year + 1).isoformat()
        issues.append("Certificate-valid-until cache missing; check coverage is provisionally check date +12 months.")
    valid_until = date.fromisoformat(exact_cutoff)
    if checked > as_of:
        issues.append(f"Check date {checked} is after archive review date {as_of}; verify scheduled vs completed work.")
    if num(c(17)) is not None and num(c(17)) != band:
        issues.append(f"Crew {crew} implies band {band}, but workbook cached band is {c(17)}; cached line requirements preserved.")
    manager = text(c(8))
    # User-authorized interim billing account is the vessel name. Management
    # remains evidence metadata and is not inferred to be the billed entity.
    client = vessel
    a = cells(wb["3. ARRIVAL CHECK"])
    p = cells(wb["5. PICK & FILL"])
    ar = cells(fw["3. ARRIVAL CHECK"])
    pr = cells(fw["5. PICK & FILL"])
    cols = pf_columns(p[1])
    recon = cells(wb["2. RECONCILIATION"])
    lines, batches, used = [], [], Counter()
    allrows = sorted({r for r in a if r >= 3 and get(a[r], "C")} | {r+1 for r in p if r >= 2 and get(p[r], "A")})
    source_ac, source_pf = Counter(), Counter()
    for r in allrows:
        ac, pf = a.get(r, {}), p.get(r - 1, {})
        if not ac.get("C") and not pf.get("A"):
            continue
        iid, desc, bag = text(ac.get("C") or pf.get("A")), text(ac.get("E") or pf.get("B")), text(ac.get("B") or pf.get("C"))
        if not desc:
            continue
        key = iid + "|" + bag
        used[key] += 1
        if used[key] > 1:
            key += "|" + str(used[key])
        lineid, tiid = uid("line", digest + key), uid("template-line", digest + key)
        li = []
        if not ac.get("C"):
            li.append("Pick line has no corresponding Arrival row; required quantity is unknown.")
        if ac.get("C") and pf.get("A") and (text(ac["C"]) != text(pf["A"]) or text(ac.get("B")) != text(pf.get("C"))):
            li.append("Arrival/Pick row identity mismatch; review row alignment.")
        base, required = num(ac.get("I")), num(ac.get("J"))
        price = num(ac.get("K"))
        if price is None:
            price = num(pf.get("G"))
        scaling = "fixed" if ac.get("AA") == "Fixed*" else "band"
        if required is None and base is not None:
            required = base if scaling == "fixed" else math.floor(base * band / 10 + 0.5)
            li.append("Scaled quantity cache missing; derived from explicit baseline and crew band.")
        requirement_unknown = required is None
        if requirement_unknown:
            required = 0
        if base is None:
            base = 0
        price_missing = price is None
        if price_missing:
            li.append("Sell price missing; zero placeholder requires explicit review.")
            price = 0
        col = lambda name: pf.get(cols.get(name, ""))
        override_qty, override_price = num(col("override_qty")), num(col("override_price"))
        override_reason = text(col("override_reason"))
        original_required, original_price = required, price
        # Excel override is packs to ADD, not total requirement. Retained stock is
        # added once valid, explicitly quantified retained batches are mapped.
        attrs = {"item_id": iid, "source_row": r, "ned": text(col("ned")).upper() == "NED",
                 "dose_route": text(ac.get("F")), "masters_safe": yes(col("safe")), "flammable": yes(col("flammable")),
                 "refrigerated": text(col("refrigerated")).upper() == "Y", "statutory_section": text(col("statutory")),
                 "original_description": desc, "substitute_description": "", "original_required_packs": original_required,
                 "original_unit_price": original_price, "override_reason": override_reason,
                 "source_arrival_state": text(ac.get("V")), "source_pick_state": text(pf.get("M")),
                 "source_stock_notes": text(ac.get("Y")), "directory_note": text(col("directory_note")),
                 "price_missing": price_missing, "requirement_unknown": requirement_unknown,
                 "source_prior_quantity": clean(ac.get("M")), "source_prior_expiry": clean(ac.get("L")),
                 "source_override_expiry_1": clean(ac.get("W")), "source_override_expiry_2": clean(ac.get("X"))}
        z_header = text(a.get(2, {}).get("Z")).lower()
        if text(ac.get("Z")):
            if "substitut" in z_header:
                attrs["substitute_description"] = text(ac["Z"])
                attrs["override_reason"] = override_reason or text(ac.get("Y")) or "Imported explicit workbook substitute; reason requires confirmation."
            else:
                attrs["directory_note"] = text(ac["Z"])
        actual_desc = attrs["substitute_description"] or desc
        kill = text(col("kill")).upper() == "Y"
        own = []
        # Counts are pack quantities only from explicit pack-count columns. The
        # reconciliation's raw/messy quantities are preserved, never guessed as packs.
        for slot, expcol, qtycol, flagcol in [(1, "N", "P", "O"), (2, "Q", "S", "R")]:
            count, expiry, marker = num(ac.get(qtycol)), month(ac.get(expcol)), text(ac.get(flagcol)).upper()
            noexp = text(ac.get(expcol)).upper() == "NED" or (attrs["ned"] and not expiry)
            if count is None and marker in ("KEEP", "NED") and num(ac.get("T")) and not num(ac.get("S" if slot == 1 else "P")):
                otherexp = ac.get("Q" if slot == 1 else "N")
                if not otherexp or text(otherexp).upper() in ("N/A", ""):
                    count = num(ac["T"])
                    li.append("Retained pack count mapped from single-expiry aggregate Packs Kept.")
            if count is None or count == 0:
                if ac.get(expcol) and marker in ("KEEP", "REMOVE"):
                    li.append(f"Existing expiry {slot} has no explicit pack count; raw reconciliation is retained for review.")
                continue
            if count != int(count):
                li.append(f"Existing pack count {slot} is fractional; batch staged in source evidence.")
                continue
            if not expiry and not noexp:
                li.append(f"Existing pack count {slot} has unknown/ambiguous expiry; batch staged in source evidence.")
                continue
            kind = "kept" if marker in ("KEEP", "NED") or noexp else "removed" if marker == "REMOVE" else "kept" if expiry_keep(expiry, valid_until) else "removed"
            if expiry and marker in ("KEEP", "REMOVE") and (kind == "kept") != expiry_keep(expiry, valid_until):
                li.append(f"Existing expiry {slot} cached KEEP/REMOVE differs from the coverage formula; source decision preserved for review.")
            own.append({"id": uid("batch", digest + key + f"old{slot}"), "check_item_id": lineid, "kind": kind,
                        "quantity": int(count), "expiry": expiry, "no_expiry": noexp,
                        "notes": f"Imported Arrival row {r}, expiry {slot}; original packing timestamp not supplied."})
        for slot, expcol, qtycol in [(1, "H", "I"), (2, "J", "K")]:
            count, expiry = num(pf.get(qtycol)), month(pf.get(expcol))
            noexp = text(pf.get(expcol)).upper() == "NED" or (attrs["ned"] and not expiry)
            if not count:
                continue
            if count != int(count) or (not expiry and not noexp):
                li.append(f"Supplied batch {slot} has fractional count or unknown expiry; batch staged in source evidence.")
                continue
            own.append({"id": uid("batch", digest + key + f"new{slot}"), "check_item_id": lineid, "kind": "supplied",
                        "quantity": int(count), "expiry": expiry, "no_expiry": noexp,
                        "notes": f"Imported Pick row {r-1}, expiry {slot}; original packing timestamp not supplied."})
        kept = sum(b["quantity"] for b in own if b["kind"] == "kept")
        supplied = sum(b["quantity"] for b in own if b["kind"] == "supplied")
        if override_qty is not None:
            required = kept + override_qty
            attrs["source_override_add_packs"] = override_qty
            if not override_reason:
                li.append("Quantity override has no reason in source workbook.")
        if override_price is not None:
            price = override_price
            attrs["price_missing"] = False
            li = [issue for issue in li if not issue.startswith("Sell price missing;")]
            if not override_reason:
                li.append("Price override has no reason in source workbook.")
        needed = 0 if kill else max(0, required - kept)
        if num(ac.get("T")) is not None and num(ac.get("T")) != kept:
            li.append(f"Cached Packs Kept={ac.get('T')} differs from verified mapped packs={kept}; cached default may imply stock without batch evidence.")
        attrs["retained_stock_unverified"] = any("no explicit pack count" in issue or "unknown/ambiguous expiry" in issue or "Cached Packs Kept" in issue for issue in li)
        if num(ac.get("U")) is not None and num(ac.get("U")) != max(0, original_required - kept) and not kill:
            li.append("Workbook packs-to-add differs from requirement minus verified retained packs.")
        if supplied > needed:
            li.append("Supplied packs exceed current verified shortage; preserve source and review override/pack units.")
        source_ac[text(ac.get("V")) or "uncached"] += 1
        source_pf[text(pf.get("M")) or "uncached"] += 1
        reviewed = text(ac.get("V")) == "COMPLETE" and not li and not requirement_unknown and not price_missing
        attrs["issues"] = li
        state = "reviewed" if reviewed else "unreviewed"
        lines.append({"id": lineid, "template_item_id": tiid, "source_code": key, "description": actual_desc,
                      "location": bag, "pack_description": text(ac.get("H") or pf.get("D")), "required_packs": required,
                      "baseline_packs": base, "scaling": scaling, "unit_price": price, "assessment_state": state,
                      "kill_line": kill, "attributes": attrs, "outstanding": max(0, needed - supplied)})
        batches.extend(own)
    if "uncached" in source_ac or "uncached" in source_pf:
        issues.append("Workbook has missing formula caches. Only explicit source inputs and independently derived requirements were imported.")
    line_issues = sum(bool(line["attributes"]["issues"]) for line in lines)
    if line_issues:
        issues.append(f"{line_issues} lines have stock, expiry, override or source-data issues; open line details before accepting this import.")
    if any(line["attributes"]["requirement_unknown"] for line in lines):
        issues.append("Some Pick lines lack Arrival requirements; unknown requirement placeholders must be corrected.")
    if any(line["outstanding"] > 0 for line in lines):
        issues.append("Verified retained plus supplied batches do not satisfy every line; not imported as complete.")
    if source_pf.get("INCOMPLETE"):
        issues.append(f"Pick & Fill still marks {source_pf['INCOMPLETE']} lines INCOMPLETE, despite completed Arrival assessments on some lines.")
    status = "complete" if all(l["assessment_state"] == "reviewed" and not l["outstanding"] for l in lines) and not source_pf.get("INCOMPLETE") and checked <= as_of and num(c(17)) in (None, band) else "assessing"
    cost = cells(wb["4. COST ANALYSIS"])
    fee = num(cost.get(15, {}).get("F"))
    if fee is None:
        issues.append("Assessment-fee cache missing; zero placeholder is not a reviewed financial amount.")
    ck = {"id": uid("check", digest), "template_id": uid("template", digest), "vessel": vessel, "client": client,
          "framework": framework, "category": category, "check_date": checked.isoformat(), "valid_until": valid_until.isoformat(),
          "crew": crew, "flag_state": text(c(6)) or None, "loyalty": c(18) is True,
          "job_type": text(c(16)) if text(c(16)) in ["Routine Refill", "Category Swap", "Restructure", "New Build"] else "Routine Refill",
          "assessment_fee": fee or 0, "status": status,
          "attributes": {"imported": True, "source_file": path, "source_hash": digest, "assessor": c(12),
                         "source_certificate_number": c(21), "source_crew_band": c(17), "source_job_proceeded": c(19),
                         "source_arrival_counts": dict(source_ac), "source_pick_counts": dict(source_pf), "issues": issues,
                         "review_required": True, "forecast_eligible": status == "complete", "financials_unverified": True,
                         "assessment_fee_unknown": fee is None,
                         "source_management_company": manager or None}, "lines": lines, "batches": batches}
    raw[path] = {"sha256": digest, "cached": {}, "formulas_and_inputs": {}}
    for name in ["1.CONFIG", "2. RECONCILIATION", "3. ARRIVAL CHECK", "5. PICK & FILL", "4. COST ANALYSIS", "QUOTE + INVOICE"]:
        if name in wb.sheetnames:
            raw[path]["cached"][name] = cells(wb[name])
            raw[path]["formulas_and_inputs"][name] = cells(fw[name])
    wb.close()
    fw.close()
    return ck


def bulk(table, records, types):
    if not records:
        return ""
    keys = list(types)
    js = [{k: r.get(k) for k in keys} for r in records]
    return f"INSERT INTO public.{table} ({','.join(keys)}) SELECT {','.join(keys)} FROM jsonb_to_recordset({literal(js)}::jsonb) AS x({','.join(k+' '+v for k,v in types.items())}) ON CONFLICT (id) DO NOTHING;"


def emit(check, folder, index):
    """Two independent atomic files per check; no cross-session temp objects."""
    h, tid, cid = check["attributes"]["source_hash"], check["template_id"], check["id"]
    label = re.sub(r"[^A-Za-z0-9]+", "-", check["vessel"]).strip("-").lower() + "-" + check["category"].lower().replace(" ", "-")
    template = {"id": tid, "name": f"Historical source: {check['vessel']} {check['category']}", "framework": check["framework"],
                "category": check["category"], "version": "source-" + h[:16], "published": False, "ever_published": True, "source_hash": h}
    template_cols = {"id": "uuid", "name": "text", "framework": "text", "category": "text", "version": "text", "published": "boolean", "ever_published": "boolean", "source_hash": "text"}
    template_lines = [{"id": l["template_item_id"], "template_id": tid, "source_code": l["source_code"],
                       "description": l["description"], "location": l["location"], "pack_description": l["pack_description"],
                       "baseline_packs": l["baseline_packs"], "scaling": l["scaling"], "unit_price": l["unit_price"], "attributes": l["attributes"]} for l in check["lines"]]
    types = {"id": "uuid", "template_id": "uuid", "source_code": "text", "description": "text", "location": "text", "pack_description": "text", "baseline_packs": "numeric", "scaling": "text", "unit_price": "numeric", "attributes": "jsonb"}
    # Entire source template is skipped after first import; reruns cannot restore
    # deleted lines or overwrite operator corrections.
    template_sql = "IF NOT EXISTS(SELECT 1 FROM public.kit_templates WHERE id=" + literal(tid) + ") THEN\n" + bulk("kit_templates", [template], template_cols) + "\n" + bulk("template_items", template_lines, types) + "\nEND IF;"
    clientid, vesselid = uid("client", check["client"].casefold()), uid("vessel", check["vessel"].casefold())
    clientattrs = {"provisional": True, "source": check["attributes"]["source_file"], "billing_identity_unconfirmed": True, "contact_details_missing": True}
    vesselattrs = {"imported": True, "source_file": check["attributes"]["source_file"], "client_identity_unconfirmed": True}
    setup = f"""SELECT id INTO client_value FROM public.clients WHERE lower(trim(name))=lower({literal(check['client'])}) ORDER BY id LIMIT 1;
IF client_value IS NULL THEN
 INSERT INTO public.clients(id,name,notes,attributes,legacy_id) VALUES ({literal(clientid)},{literal(check['client'])},'Imported workbook account; owner, billing entity and contact details require confirmation.',{literal(clientattrs)}::jsonb,{literal('completed-checks:client:'+check['client'])}) RETURNING id INTO client_value;
END IF;
SELECT id INTO vessel_value FROM public.vessels WHERE regexp_replace(upper(trim(name)),'^(M/Y|MY) +','','i')={literal(check['vessel'])} ORDER BY id LIMIT 1;
IF vessel_value IS NULL THEN
 INSERT INTO public.vessels(id,name,client_id,framework,flag_state,crew,loyalty,attributes,legacy_id) VALUES ({literal(vesselid)},{literal(check['vessel'])},client_value,{literal(check['framework'])},{literal(check['flag_state'])},{check['crew']},{literal(check['loyalty'])},{literal(vesselattrs)}::jsonb,{literal('completed-checks:vessel:'+check['vessel'])}) RETURNING id INTO vessel_value;
END IF;"""
    # Runtime UUID variables cannot be embedded inside recordset JSON.
    inscheck = f"INSERT INTO public.kit_checks(id,vessel_id,client_id,template_id,check_date,valid_until,crew,job_type,status,assessment_fee,loyalty,notes,attributes) VALUES ({literal(cid)},vessel_value,client_value,{literal(tid)},{literal(check['check_date'])}::date,{literal(check['valid_until'])}::date,{check['crew']},{literal(check['job_type'])},{literal(check['status'])},{check['assessment_fee']},{literal(check['loyalty'])},'Imported historical workbook. Review source issues before operational use.',{literal(check['attributes'])}::jsonb);"
    linerows = [{k: l[k] for k in ["id", "template_item_id", "source_code", "description", "location", "pack_description", "required_packs", "unit_price", "assessment_state", "kill_line"]} | {"check_id": cid} for l in check["lines"]]
    line_types = {"id": "uuid", "check_id": "uuid", "template_item_id": "uuid", "source_code": "text", "description": "text", "location": "text", "pack_description": "text", "required_packs": "numeric", "unit_price": "numeric", "assessment_state": "text", "kill_line": "boolean"}
    batch_types = {"id": "uuid", "check_item_id": "uuid", "kind": "text", "quantity": "integer", "expiry": "date", "no_expiry": "boolean", "notes": "text"}
    check_sql = f"IF NOT EXISTS(SELECT 1 FROM public.kit_checks WHERE id={literal(cid)}) THEN\n" + setup + "\n" + inscheck + "\n" + bulk("check_items", linerows, line_types) + "\n" + bulk("batches", check["batches"], batch_types) + f"\nINSERT INTO public.audit_events(action,record_id,details) VALUES ('import_historical_check',{literal(cid)},{literal({'source_hash':h,'source_file':check['attributes']['source_file']})}::jsonb);\nEND IF;"
    files = []
    for suffix, body in [("source", template_sql), ("check", check_sql)]:
        # Use a deterministic delimiter absent from input, avoiding user text $$.
        tag = "$mma_completed_import$"
        if tag in body:
            raise ValueError("Unexpected SQL delimiter in source")
        content = "-- PRIVATE business data. Requires 202611200002_check_edits.sql.\nBEGIN;\nSET LOCAL standard_conforming_strings=on;\nDO " + tag + "\nDECLARE client_value uuid; vessel_value uuid;\nBEGIN\n" + body + "\nEND;\n" + tag + ";\nCOMMIT;\n"
        name = f"{index:02d}-{label}-{suffix}.sql"
        index += 1
        (folder / name).write_bytes(content.encode("utf-8"))
        files.append({"file": name, "bytes": len(content.encode("utf-8")), "check_id": cid})
    return files


def source_vessel(path):
    folder = path.split('/')[2] if len(path.split('/')) > 2 else ''
    aliases = {"FAUDA CAT A & B": "FAUDA", "SHIMALI CAT B": "SHIMALI", "MALAHNE CAT": "MALAHNE", "ARIONAS CAT B 2026": "ARIONAS"}
    if folder in aliases:
        return aliases[folder]
    for prefix in ["Tahi Malta", "AVENTURA -", "ANDIAMO -"]:
        if folder.startswith(prefix):
            return prefix.split(' ')[0].upper()
    return folder.upper()


def emit_source_manifest(inventory, checks, folder, index, archive_hash):
    """Keep deferred legacy checks and every supporting file visible in the app."""
    selected = {c['attributes']['source_file']: c for c in checks}
    groups = {}
    for item in inventory:
        vessel = source_vessel(item['file'])
        if not vessel or vessel == "MY TEST":
            continue
        groups.setdefault(vessel, []).append(item)
    files = []
    for vessel, sources in groups.items():
        clientid = uid('client', vessel.casefold())
        attrs = {"provisional": True, "contact_details_missing": True, "billing_identity_unconfirmed": True, "billing_name_basis": "User requested vessel name as interim billing client"}
        body = f"SELECT id INTO client_value FROM public.clients WHERE lower(trim(name))=lower({literal(vessel)}) ORDER BY id LIMIT 1;\nIF client_value IS NULL THEN INSERT INTO public.clients(id,name,notes,attributes,legacy_id) VALUES ({literal(clientid)},{literal(vessel)},'Interim vessel-named billing account; contact and legal billing details require confirmation.',{literal(attrs)}::jsonb,{literal('completed-checks:client:'+vessel)}) RETURNING id INTO client_value; END IF;\n"
        for s in sources:
            current = selected.get(s['file'])
            status = 'imported' if current else 'superseded' if 'Superseded' in s['disposition'] else 'needs_review' if s['file'].lower().endswith(('.xlsx','.docx')) else 'supporting'
            sa = {"archive_sha256": archive_hash, "bytes": s['bytes'], "disposition": s['disposition'], "check_id": current['id'] if current else None,
                  "issues": current['attributes']['issues'] if current else ["Source retained; not mapped as verified current kit check."],
                  "legacy_or_auxiliary": not bool(current)}
            body += f"INSERT INTO public.import_sources(id,client_id,vessel_name,source_path,source_hash,status,attributes) VALUES ({literal(uid('source',s['sha256']+s['file']))},client_value,{literal(vessel)},{literal(s['file'])},{literal(s['sha256'])},{literal(status)},{literal(sa)}::jsonb) ON CONFLICT(id) DO NOTHING;\n"
        tag = '$mma_source_manifest$'
        if tag in body:
            raise ValueError('Source manifest delimiter collision')
        content = f"-- PRIVATE source manifest; requires 202611200002_check_edits.sql.\nBEGIN;\nSET LOCAL standard_conforming_strings=on;\nDO {tag}\nDECLARE client_value uuid;\nBEGIN\n{body}\nEND;\n{tag};\nCOMMIT;\n"
        name = f"{index:02d}-{re.sub(r'[^a-z0-9]+','-',vessel.lower())}-source-register.sql"
        index += 1
        (folder/name).write_bytes(content.encode('utf-8'))
        files.append({"file": name, "bytes": len(content.encode('utf-8')), "vessel": vessel})
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "private-import")
    parser.add_argument("--as-of", type=date.fromisoformat, default=date(2026, 11, 20))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    out = args.output / "completed-checks"
    out.mkdir(exist_ok=True)
    evidence, checks, inventory, files = {}, [], [], []
    with zipfile.ZipFile(args.archive) as archive:
        chosen = []
        for suffix in SELECTED:
            found = [n for n in archive.namelist() if n.endswith('/' + suffix)]
            if len(found) != 1:
                raise ValueError(f"Ambiguous/missing selected source: {suffix}")
            chosen.append(found[0])
        for info in archive.infolist():
            if info.is_dir():
                continue
            data = archive.read(info)
            reason = "Selected current new-method check" if info.filename in chosen else "Superseded/backup variant retained as evidence" if "/OLD/" in info.filename or "/for amy/" in info.filename else "Auxiliary, legacy-format or supporting document; retained source-only pending reviewed mapping"
            inventory.append({"file": info.filename, "bytes": info.file_size, "sha256": hashlib.sha256(data).hexdigest(), "disposition": reason})
        for path in chosen:
            check = prepare_check(path, archive.read(path), evidence, args.as_of)
            checks.append(check)
            files.extend(emit(check, out, len(files) + 1))
    archive_hash = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    files.extend(emit_source_manifest(inventory, checks, out, len(files)+1, archive_hash))
    allclients = {source_vessel(i['file']) for i in inventory} - {"", "MY TEST"}
    report = {"archive": str(args.archive), "archive_sha256": archive_hash, "as_of": args.as_of.isoformat(),
              "counts": {"checks": len(checks), "vessels": len({c['vessel'] for c in checks}), "clients": len(allclients), "source_records": len(inventory),
                         "lines": sum(len(c['lines']) for c in checks), "batches": sum(len(c['batches']) for c in checks)},
              "status_counts": dict(Counter(c['status'] for c in checks)), "files": files, "inventory": inventory,
              "checks": [{k: v for k, v in c.items() if k not in ('lines', 'batches')} | {"line_count": len(c['lines']), "batch_count": len(c['batches']), "lines_with_issues": sum(bool(l['attributes']['issues']) for l in c['lines'])} for c in checks],
              "limitations": ["Source client names, contact details, billing identity, quote approval and issued certificates are not inferred.",
                              "Legacy Malta and auxiliary kits remain source-only; file names are not proof of check date or completion.",
                              "Unquantified or ambiguous stock is retained in evidence and line attributes rather than invented as packs.",
                              "No master template is updated and no live database write occurs."]}
    (args.output / "completed-checks-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output / "completed-checks-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output / "completed-checks-data.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")
    issue_text = ["PRIVATE completed-check import review", "", "All billing accounts use vessel names as requested; no owner or legal billing entity is inferred.",
                  "All imported checks remain in assessment and require explicit import review. No quote approvals or certificates have been created.",
                  "Unquantified raw stock is not converted to packs. Full cached/source-formula evidence is retained privately.", ""]
    for c in checks:
        issue_text.extend([f"{c['vessel']} / {c['category']} / {c['check_date']}", f"Source: {c['attributes']['source_file']}",
                           f"{len(c['lines'])} lines; {len(c['batches'])} verified pack records; {sum(bool(l['attributes']['issues']) for l in c['lines'])} lines needing review."])
        issue_text.extend("- " + i for i in c['attributes']['issues'])
        for line in [l for l in c['lines'] if l['attributes']['issues']][:8]:
            issue_text.append(f"  Row {line['attributes']['source_row']} {line['source_code']}: " + "; ".join(line['attributes']['issues']))
        issue_text.append("")
    issue_text.extend(["Deferred legacy-only accounts: TAHI, ARIONAS, AVENTURA. Source manifests are visible in Imported sources; crew/check dates were not invented.",
                       "Other legacy/auxiliary kits (including first aid, sting, engine-room, galley, tender and ANDIAMO legacy inventory) remain source-only pending reviewed mapping.",
                       "Older/backup variants are inventoried, not duplicated as new checks. See the archive audit for date/header conflicts."])
    (args.output / "completed-checks-issues.txt").write_text("\n".join(issue_text)+"\n", encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(files, indent=2), encoding="utf-8")
    (out / "READ-ME.txt").write_text("PRIVATE historical workbook import.\nApply 202611200002_check_edits.sql first, after the earlier migrations.\nRun each numbered SQL file WHOLE in order; each is a standalone transaction.\nSource files precede their check files. Rerunning preserves existing edits.\nRead completed-checks-report.json before applying. No quote approval is invented.\nLegacy Malta/auxiliary inventory is staged as source evidence, not a verified completed check.\n\n" + "\n".join(f"{f['file']} ({f['bytes']:,} bytes)" for f in files), encoding="utf-8")
    print(json.dumps({**report['counts'], "statuses": report['status_counts'], "sql_files": len(files), "largest_sql_bytes": max(f['bytes'] for f in files)}, indent=2))


if __name__ == "__main__":
    main()
