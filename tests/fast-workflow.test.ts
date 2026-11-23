import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { parseExpiryMonth, workflowSchemas } from "../src/lib/check-workflow";
import { matchingCandidates, parseDelimited, reconciliationRows } from "../src/lib/reconciliation";
import { demoWorkspace } from "../src/lib/demo";

test("quick expiry entry accepts both formats and rejects malformed months",()=>{
 assert.equal(parseExpiryMonth("02/12"),"2012-02-01");assert.equal(parseExpiryMonth("02/2012"),"2012-02-01");assert.equal(parseExpiryMonth("2/28"),"2028-02-01");
 for(const input of ["13/28","00/2028","02/2","2028-02-12","unknown"])assert.throws(()=>parseExpiryMonth(input));
 assert.throws(()=>workflowSchemas.save_line_slots.parse({item_id:"test",phase:"arrival",slots:[1,2,3].map(()=>({quantity:1,no_expiry:true,expiry:""})),expected_batch_ids:[]}));
});
test("reconciliation preserves CSV quoting and produces suggestions without confirming mappings",()=>{
 const rows=reconciliationRows(parseDelimited('description,quantity,expiry,item ID,bag\n"Dressing, sterile",2,02/28,,First aid\n"Quoted ""item""",1,NED,,Bag'));
 assert.equal(rows[0].description,"Dressing, sterile");assert.equal(rows[1].description,'Quoted "item"');
 const data=demoWorkspace();const candidate=matchingCandidates({...rows[0],item_code:data.check_items[0].source_code},data.check_items);
 assert.ok(Array.isArray(candidate));assert.equal("confirmed" in rows[0],false);
 assert.throws(()=>parseDelimited('"unfinished'));
});
test("two-slot saves are atomic, preserve correction history and reject stale edits",async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  const dir=new URL("../supabase/migrations/",import.meta.url);for(const n of(await readdir(dir)).filter(n=>n.endsWith(".sql")).sort())await db.exec(await readFile(new URL(n,dir),"utf8"));
  const staff="00000000-0000-0000-0000-000000000001";await db.exec(`insert into auth.users values('${staff}');insert into public.staff_members values('${staff}','Tester');`);
  const id=async(sql:string,args:unknown[]=[]) => (await db.query<{id:string}>(sql,args)).rows[0].id;
  const client=await id("insert into public.clients(name)values('Fixture')returning id"),vessel=await id("insert into public.vessels(name,client_id,framework,crew)values('Fixture',$1,'MSN',10)returning id",[client]);
  const template=await id("insert into public.kit_templates(name,framework,category,version,published)values('Fixture','MSN','CAT B','test',true)returning id");
  const ti=await id("insert into public.template_items(template_id,source_code,description,baseline_packs,scaling,unit_price)values($1,'CODE','Fixture item',5,'band',10)returning id",[template]);
  const check=await id("insert into public.kit_checks(vessel_id,client_id,template_id,check_date,valid_until,crew,job_type)values($1,$2,$3,'2026-11-20','2027-11-20',10,'Routine Refill')returning id",[vessel,client,template]);
  const item=await id("insert into public.check_items(check_id,template_item_id,source_code,description,required_packs,unit_price)values($1,$2,'CODE','Fixture item',5,10)returning id",[check,ti]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${staff}';`);
  const run=async(action:string,payload:object)=>db.query("select public.workspace_command($1,$2::jsonb)",[action,JSON.stringify(payload)]);
  const payload={item_id:item,phase:"arrival",slots:[{quantity:2,expiry:"2028-02-01",no_expiry:false},{quantity:1,expiry:"2026-02-01",no_expiry:false}],expected_batch_ids:[],reviewed:true};
  await run("save_line_slots",payload);
  const rows=(await db.query<{id:string;kind:string}>("select id,kind from public.batches where voided_at is null")).rows;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.kind).sort(),["kept","removed"]);
  await assert.rejects(()=>run("save_line_slots",payload),/This line changed/);
  const expected_batch_ids=rows.map(r=>r.id);
  await assert.rejects(()=>run("save_line_slots",{...payload,expected_batch_ids,slots:[...payload.slots,{quantity:1,expiry:"2029-02-01",no_expiry:false}]}),/no more than two/);
  assert.equal((await db.query("select id from public.batches where voided_at is null")).rows.length,2);
  await run("save_line_slots",{...payload,expected_batch_ids,slots:[{quantity:3,expiry:"2028-02-01",no_expiry:false}]});
  assert.equal((await db.query("select id from public.batches where voided_at is not null")).rows.length,2);
  assert.equal(Number((await db.query<{kept:number;needed:number}>("select kept,needed from public.line_quantities where id=$1",[item])).rows[0].kept),3);
  const current=(await db.query<{id:string}>("select id from public.batches where voided_at is null")).rows;
  await run("reconcile_stock",{check_id:check,source_name:"Prior list",groups:[{item_id:item,slots:[{quantity:1,expiry:"2029-01-01",no_expiry:false}],expected_batch_ids:current.map(r=>r.id),source_rows:[{row:2,description:"Fixture item",quantity:1,expiry:"01/29"}]}]});
  assert.equal((await db.query<{assessment_state:string}>("select assessment_state from public.check_items where id=$1",[item])).rows[0].assessment_state,"unreviewed","matching stock must still be physically assessed");
  assert.ok((await db.query("select id from public.audit_events where action='save_line_slots' and details->'previous_batches' is not null")).rows.length>=2);
  await run("save_check_setup",{check_id:check,workflow:{finance:{standard_fee:100,assessment_fee_override:50,pricing_reviewed:true,tax_reviewed:true,extras:[]}}});
  await run("save_check_header",{check_id:check,check_date:"2026-11-25",valid_until:"2027-11-25",crew:20,job_type:"Routine Refill",loyalty:false,reason:"Corrected crew and check day"});
  const revised=(await db.query<{required_packs:number}>("select required_packs from public.check_items where id=$1",[item])).rows[0];assert.equal(Number(revised.required_packs),10);
  const review=(await db.query<{attributes:{workflow:{finance:Record<string,unknown>}}}>("select attributes from public.kit_checks where id=$1",[check])).rows[0].attributes.workflow.finance;
  assert.equal(review.pricing_reviewed,false);assert.equal(review.tax_reviewed,false);assert.equal(review.standard_fee,undefined);
  await assert.rejects(()=>run("save_line_slots",{...payload,expected_valid_until:"2027-11-20",expected_required_packs:5}),/settings changed/);

 }finally{await db.close();}
});
