import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { strFromU8, unzipSync } from "fflate";
import { findRenderer, renderDocumentPdf, selectDocumentSheet } from "../src/lib/document-renderer";
import { patchWorksheetCells } from "../src/lib/workbook-export";

const source=new URL("../assets/workbook-templates/msn-cat-b.xlsx",import.meta.url);
test("PDF selection preserves original workbook parts and exposes only the requested sheet",async()=>{
 const bytes=await readFile(source),original=unzipSync(bytes),selected=unzipSync(selectDocumentSheet(bytes,"certificate"));
 assert.deepEqual(selected["xl/styles.xml"],original["xl/styles.xml"]);
 const workbook=strFromU8(selected["xl/workbook.xml"]);
 const visible=[...workbook.matchAll(/<sheet\b[^>]*\/>/g)].filter(m=>!m[0].includes('state="hidden"'));
 assert.equal(visible.length,1);assert.ok(visible[0][0].includes('name="7.CERTIFICATE"'));
});
test("installed LibreOffice renders the original certificate on one page and the directory as PDF",{timeout:120000},async t=>{
 if(!await findRenderer()){t.skip("LibreOffice is not installed in this test environment");return;}
 const sourceBytes=await readFile(source);
 const certificate=await renderDocumentPdf(sourceBytes,"certificate");
 assert.equal((await PDFDocument.load(certificate)).getPageCount(),1);
 const directory=await renderDocumentPdf(sourceBytes,"directory");
 assert.ok((await PDFDocument.load(directory)).getPageCount()>=1);
 const replaced=await renderDocumentPdf(sourceBytes,"replaced");
 assert.ok((await PDFDocument.load(replaced)).getPageCount()>=1);
 assert.ok(patchWorksheetCells('<worksheet><sheetData><row r="1"><c r="A1" s="1"/></row></sheetData></worksheet>',{A1:"Example"}).includes("Example"));
});
