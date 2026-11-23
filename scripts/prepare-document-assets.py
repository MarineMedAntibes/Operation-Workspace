"""Prepare privacy-cleared, original-format XLSX document assets.

Reads the authoritative blank handover templates. No completed client workbook
is copied. Original ZIP parts, drawings, images, styles and formulas are retained;
per-check constants, formula caches, all source prices and confidential RATE TABLE
numbers are removed. Runtime export fills reviewed workspace values.
"""
import argparse
from collections import OrderedDict
from pathlib import Path
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET

import openpyxl

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SOURCES = [
    ("MMA_MSN_CAT_A_KitCheck_TEMPLATE_v9_NEW_FORMAT.xlsx", "msn-cat-a.xlsx", "MSN", "CAT A"),
    ("MMA_MSN_CAT_B_KitCheck_TEMPLATE_v27d.xlsx", "msn-cat-b.xlsx", "MSN", "CAT B"),
    ("MMA_MALTA_CAT_A_KitCheck_TEMPLATE_v2.xlsx", "malta-cat-a.xlsx", "Malta", "CAT A"),
    ("MMA_MALTA_CAT_B_KitCheck_TEMPLATE_v3.xlsx", "malta-cat-b.xlsx", "Malta", "CAT B"),
    ("MMA_CAT_C_PLUS_ALL_REG_KitCheck_TEMPLATE_v3.xlsx", "all-cat-c-plus.xlsx", "ALL", "CAT C PLUS"),
]


def rgb(cell):
    colour = cell.fill.fgColor
    return "#" + colour.rgb[-6:] if colour.type == "rgb" and colour.rgb[-6:] != "000000" else None


def sheet_paths(z):
    rels = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    result = {}
    for sh in ET.fromstring(z.read("xl/workbook.xml")).findall(f"{{{S}}}sheets/{{{S}}}sheet"):
        target = rels[sh.attrib[f"{{{REL}}}id"]]
        result[sh.attrib["name"]] = target.lstrip("/") if target.startswith("/") else "xl/" + target
    return result


def clear_constant(sheet, address):
    m = re.match(r"([A-Z]+)(\d+)", address)
    col, row = m[1], int(m[2])
    if sheet == "1.CONFIG":
        return address in {"C5", "C6", "C8", "C10", "C12", "C21", "C32", "C33", "C34", "J26", "J28", "K26", "K28"} or (26 <= row <= 28 and col in "CDEF")
    if sheet == "2. RECONCILIATION":
        return 7 <= row <= 300 and col in "BCDEFGHIJKLM"
    if sheet == "3. ARRIVAL CHECK":
        return row >= 3 and (col in "KLMNOPQRSWXYZ")
    if sheet == "5. PICK & FILL":
        return row >= 2 and col in {"G", "H", "I", "J", "K", "P", "Q", "R", "S", "AG"}
    if sheet == "NON-REG - LEGACY ITEMS":
        return row >= 8 and col in "BCDEFGHI"
    if sheet == "RATE TABLE":
        return address in {"B4", "D4", "A28", "A29", "A38"} or (row >= 10 and col in "BCDEF")
    if sheet == "4. COST ANALYSIS":
        return 8 <= row <= 71 and col in {"F", "H", "I"}
    return False


def sanitise_sheet(xml, sheet, audit):
    def cell(match):
        opening, body, ending = match.groups()
        address = re.search(r'\br="([A-Z]+\d+)"', opening)[1]
        if re.search(r"<f(?:\s|>)", body):
            return opening + re.sub(r"<v(?:\s[^>]*)?>.*?</v>", "", body, flags=re.S) + ending
        if clear_constant(sheet, address):
            # Static column headings in the finance/rate grids must survive;
            # confidential values are numeric, not these descriptive labels.
            if sheet in {"4. COST ANALYSIS", "RATE TABLE"} and ("<is>" in body or 't="s"' in opening) and address not in {"B4", "D4", "A28", "A29", "A38"}:
                return opening + body + ending
            if re.search(r"<(?:v|is)(?:\s|>)", body):
                audit.setdefault("cleared_constants", {}).setdefault(sheet, []).append(address)
            return re.sub(r'\s+t="[^"]*"', "", opening) + ending
        if sheet == "4. COST ANALYSIS" and address == "B60":
            body = re.sub(r"\s*-\s*20\s*EUR", "", body, flags=re.I)
        return opening + body + ending
    return re.sub(r"(<c\b[^>]*>)(.*?)(</c>)", cell, xml, flags=re.S)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("assets/workbook-templates"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    references, colour_map, audits = [], OrderedDict(), []
    for filename, output, framework, category in SOURCES:
        source = args.package / "02_Kit_Check_Templates" / filename
        w = openpyxl.load_workbook(source, data_only=False)
        arrival, directory = w["3. ARRIVAL CHECK"], w["6.KIT DIRECTORY"]
        directory_keys = {}
        for r in range(10, directory.max_row + 1):
            iid = directory.cell(r, 2).value
            if not isinstance(iid, str) or iid.startswith("=") or "[" not in iid:
                continue
            key = directory.cell(r, 16).value
            directory_keys.setdefault(iid, []).append({"row": r, "label": directory.cell(r, 11).value, "colour": rgb(directory.cell(r, 11)), "key": key})
        lines, bags = [], OrderedDict()
        for row in range(3, arrival.max_row + 1):
            iid, location = arrival.cell(row, 3).value, arrival.cell(row, 2).value
            if not iid or not arrival.cell(row, 5).value:
                continue
            key = str(iid) + "|" + str(location or "")
            options = directory_keys.get(iid, [])
            kd = next((d for d in options if d["key"] == key), options[0] if options else {})
            colour = kd.get("colour") or rgb(arrival.cell(row, 2)) or "#17365D"
            lines.append({"item_id": iid, "location": location or "", "line_key": key, "arrival_row": row, "pick_row": row - 1, "directory_row": kd.get("row"), "colour": colour})
            bags.setdefault(location or "", {"location": location or "", "label": kd.get("label") or location or "", "colour": colour})
            colour_map.setdefault(location or "", colour)
        ref = {"file": output, "source_filename": filename, "framework": framework, "category": category, "lines": lines, "bags": list(bags.values()), "sheets": {}}
        for name in ["1.CONFIG", "6.KIT DIRECTORY", "7.CERTIFICATE", "REPLACED ITEMS", "NON-REG - LEGACY ITEMS"]:
            s = w[name]
            ref["sheets"][name] = {"print_area": list(s.print_area), "orientation": s.page_setup.orientation, "paper_size": s.page_setup.paperSize, "images": len(s._images), "merged_cells": [str(m) for m in s.merged_cells]}
        audit = {"file": output, "source_hash": hashlib.sha256(source.read_bytes()).hexdigest(), "policy": "Source prices, confidential rate numbers, per-check constants and formula caches removed; drawings/formulas/styles retained."}
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(args.output / output, "w", zipfile.ZIP_DEFLATED) as result:
            sheets = {v: k for k, v in sheet_paths(original).items()}
            for item in original.infolist():
                data = original.read(item.filename)
                if item.filename in sheets:
                    data = sanitise_sheet(data.decode("utf-8"), sheets[item.filename], audit).encode("utf-8")
                elif item.filename == "xl/workbook.xml":
                    xml = data.decode("utf-8")
                    xml = re.sub(r"<calcPr\b[^>]*/>", '<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/>', xml)
                    data = xml.encode("utf-8")
                elif item.filename == "docProps/core.xml":
                    xml = data.decode("utf-8")
                    xml = re.sub(r"<(?:dc:creator|cp:lastModifiedBy|dcterms:created|dcterms:modified|cp:lastPrinted)\b[^>]*>.*?</(?:dc:creator|cp:lastModifiedBy|dcterms:created|dcterms:modified|cp:lastPrinted)>", "", xml)
                    data = xml.encode("utf-8")
                result.writestr(item, data)
        ref["sha256"] = hashlib.sha256((args.output / output).read_bytes()).hexdigest()
        references.append(ref)
        audits.append(audit)
    (args.output / "manifest.json").write_text(json.dumps(references, ensure_ascii=False, indent=2), encoding="utf-8")
    Path("src/lib/bag-colours.json").write_text(json.dumps(colour_map, ensure_ascii=False, indent=2), encoding="utf-8")
    Path("private-import/document-layout-reference.json").write_text(json.dumps({"templates": references, "privacy_audit": audits, "renderer": {"excel_found": False, "libreoffice_found": False, "pdf_available": False}}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"templates": len(references), "lines": sum(len(r["lines"]) for r in references), "bytes": sum((args.output / r["file"]).stat().st_size for r in references)}, indent=2))


if __name__ == "__main__":
    main()
