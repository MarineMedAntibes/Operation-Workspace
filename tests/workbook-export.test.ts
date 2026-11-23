import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { buildWorkbookExport, patchWorksheetCells } from "../src/lib/workbook-export";
import type { Workspace } from "../src/lib/types";

function fixture(): Workspace {
  return {
    clients: [{id:"client",name:"Example vessel account",email:null,phone:null,billing_address:null,notes:null}],
    vessels: [{id:"vessel",client_id:"client",name:"Example <Vessel>",framework:"MSN",flag_state:"UK",crew:10,loyalty:false}],
    vendors:[],vendor_products:[],
    kit_templates:[{id:"template",name:"MSN B",framework:"MSN",category:"CAT B",version:"v1",published:true}],
    template_items:[{id:"template-line",template_id:"template",source_code:"MSN1a1 (CAT B) [M]|Medication Bag - Cardiovascular",description:"Original item",location:"Medication Bag - Cardiovascular",pack_description:"10 per pack",baseline_packs:2,scaling:"fixed",unit_price:18,attributes:{}}],
    kit_checks:[{id:"check",client_id:"client",vessel_id:"vessel",template_id:"template",check_date:"2026-11-20",valid_until:"2027-11-20",crew:10,job_type:"Routine Refill",status:"packing",notes:"",assessment_fee:40,loyalty:false,attributes:{workflow:{assessor:"Example Assessor",telemedical_customer:"Yes",finance:{standard_fee:40,loyalty_discount_percent:0,proceeds_credit_percent:0,job_proceeded:true,goods_share_percent:40,goods_vat_percent:20,service_vat_percent:20,shipping_vat_percent:20,tax_reviewed:true,pricing_reviewed:true,shipping:5,coolbox:0,handling:0,extras:[]}}}}],
    check_items:[{id:"line",check_id:"check",template_item_id:"template-line",source_code:"MSN1a1 (CAT B) [M]|Medication Bag - Cardiovascular",description:"Alternative & item",location:"Medication Bag - Cardiovascular",pack_description:"10 per pack",required_packs:2,unit_price:18,assessment_state:"reviewed",attributes:{item_id:"MSN1a1 (CAT B) [M]",original_description:"Original item",substitute_description:"Alternative & item",override_reason:"Client request"}}],
    batches:[{id:"old",check_item_id:"line",kind:"kept",quantity:1,expiry:"2028-01-01",no_expiry:false,notes:"",created_at:"2026-11-20"},{id:"new",check_item_id:"line",kind:"supplied",quantity:1,expiry:"2029-01-01",no_expiry:false,notes:"",created_at:"2026-11-20"},{id:"void",check_item_id:"line",kind:"supplied",quantity:100,expiry:"2025-01-01",no_expiry:false,notes:"",created_at:"2026-11-20",voided_at:"2026-11-20"}],
    quotes:[],legacy_items:[{id:"legacy",check_id:"check",description:"Private extra",quantity:1,expiry:null,no_expiry:true,location:"Bridge",notes:"Non-regulated"}],
  };
}

test("original-format XLSX export retains styles, images and formulas while filling safe draft data", async () => {
  const data=fixture();
  const source=unzipSync(await readFile(new URL("../assets/workbook-templates/msn-cat-b.xlsx",import.meta.url)));
  const output=unzipSync(await buildWorkbookExport({data,checkId:"check"}));
  assert.deepEqual(Object.keys(output).sort(),Object.keys(source).sort());
  for (const name of Object.keys(source).filter(n=>n.startsWith("xl/media/") || n==="xl/styles.xml" || n.startsWith("xl/drawings/"))) assert.deepEqual(output[name],source[name],`Original layout asset changed: ${name}`);
  assert.ok(strFromU8(output["xl/worksheets/sheet1.xml"]).includes("Example &lt;Vessel&gt;"));
  assert.ok(strFromU8(output["xl/worksheets/sheet1.xml"]).includes("Example Assessor"));
  assert.ok(strFromU8(output["xl/worksheets/sheet3.xml"]).includes("Alternative &amp; item"));
  assert.ok(strFromU8(output["xl/worksheets/sheet3.xml"]).includes("Client request"));
  assert.ok(strFromU8(output["xl/worksheets/sheet6.xml"]).includes("<f>"),"Pick formulas must survive");
  assert.ok(strFromU8(output["xl/worksheets/sheet8.xml"]).includes("DRAFT CERTIFICATE OF CONFORMITY - NOT ISSUED"));
  assert.ok(strFromU8(output["xl/workbook.xml"]).includes('fullCalcOnLoad="1"'));
  assert.ok(strFromU8(output["xl/worksheets/sheet11.xml"]).includes("Private extra"));
  assert.equal(data.check_items[0].description,"Alternative & item");
});

test("XLSX export refuses to silently omit unmapped custom lines or a third expiry", async () => {
  const unknown=fixture();unknown.check_items[0].location="Unknown bag";
  await assert.rejects(()=>buildWorkbookExport({data:unknown,checkId:"check"}),/no matching line/);
  const extra=fixture();extra.batches.push({id:"extra",check_item_id:"line",kind:"supplied",quantity:1,expiry:"2030-01-01",no_expiry:false,notes:"",created_at:"2026-11-20"});
  extra.batches.push({id:"third",check_item_id:"line",kind:"supplied",quantity:1,expiry:"2031-01-01",no_expiry:false,notes:"",created_at:"2026-11-20"});
  await assert.rejects(()=>buildWorkbookExport({data:extra,checkId:"check"}),/more than two expiry groups/);
});

test("cell patching preserves styles and cached formulas, and escapes user XML", () => {
  const xml='<worksheet><sheetData><row r="1"><c r="A1" s="7"><f>B1+1</f><v>2</v></c><c r="B1" s="8"/></row></sheetData></worksheet>';
  const output=patchWorksheetCells(patchWorksheetCells(xml,{A1:42},true),{B1:'<script> & "client"'});
  assert.ok(output.includes('<c r="A1" s="7"><f>B1+1</f><v>42</v></c>'));
  assert.ok(output.includes('r="B1" s="8" t="inlineStr"'));
  assert.ok(output.includes("&lt;script&gt; &amp; &quot;client&quot;"));
});
