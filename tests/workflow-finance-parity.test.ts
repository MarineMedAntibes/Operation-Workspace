import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { calculateFinance, type FinanceResult } from "../src/lib/finance";
import type { KitCheck, Workspace } from "../src/lib/types";

const staff="00000000-0000-0000-0000-000000000001";
const totals = ["assessment_fee","items_subtotal","goods_net","service_net","extras_net","coolbox_net","shipping_net","handling_net","subtotal","vat","total"] as const;

async function fixture(upgrade?:string) {
  const db=new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  const migrations=new URL("../supabase/migrations/",import.meta.url);
  for(const name of (await readdir(migrations)).filter(n=>n.endsWith(".sql")&&(!upgrade||!n.endsWith("003_workflow.sql"))).sort()) await db.exec(await readFile(new URL(name,migrations),"utf8"));
  await db.exec(`insert into auth.users values('${staff}');insert into public.staff_members values('${staff}','Finance tester');`);
  const id=async(sql:string,args:unknown[]=[]) => (await db.query<{id:string}>(sql,args)).rows[0].id;
  const client=await id("insert into public.clients(name) values ('Finance fixture') returning id");
  const vessel=await id("insert into public.vessels(name,client_id,framework,crew) values ('Finance fixture',$1,'MSN',10) returning id",[client]);
  const template=await id("insert into public.kit_templates(name,framework,category,version,published) values ('Finance fixture','MSN','CAT B','test',true) returning id");
  const ti1=await id("insert into public.template_items(template_id,source_code,description,baseline_packs,scaling,unit_price) values ($1,'ONE','First',3,'fixed',10) returning id",[template]);
  const ti2=await id("insert into public.template_items(template_id,source_code,description,baseline_packs,scaling,unit_price) values ($1,'TWO','Second',2,'fixed',20) returning id",[template]);
  const checkId=await id("insert into public.kit_checks(vessel_id,client_id,template_id,check_date,valid_until,crew,job_type,status,loyalty) values ($1,$2,$3,'2026-11-20','2027-11-20',10,'Restructure','assessing',true) returning id",[vessel,client,template]);
  const one=await id("insert into public.check_items(check_id,template_item_id,source_code,description,required_packs,unit_price,assessment_state) values ($1,$2,'ONE','Partly packed',3,10,'reviewed') returning id",[checkId,ti1]);
  const two=await id("insert into public.check_items(check_id,template_item_id,source_code,description,required_packs,unit_price,assessment_state) values ($1,$2,'TWO','Packed',2,20,'reviewed') returning id",[checkId,ti2]);
  await db.query("insert into public.batches(check_item_id,kind,quantity,no_expiry) values ($1,'kept',1,true),($1,'supplied',1,true),($2,'supplied',2,true)",[one,two]);
  const settings:Record<string,unknown>={standard_fee:100,loyalty_discount_percent:50,proceeds_credit_percent:50,job_proceeded:true,goods_share_percent:40,goods_vat_percent:0,service_vat_percent:20,shipping_vat_percent:10,tax_reviewed:true,extras:[{id:"extra",description:"Client request",kind:"goods",quantity:2,unit_price:5}],coolbox:20,shipping:3,handling:2};
  const save=async()=>{await db.query("update public.kit_checks set attributes=jsonb_build_object('workflow',jsonb_build_object('finance',$1::jsonb)) where id=$2",[JSON.stringify(settings),checkId]);};
  await save();
  const data=async():Promise<Workspace>=>{
    const names=["clients","vessels","vendors","vendor_products","kit_templates","template_items","kit_checks","check_items","batches","quotes","pricing_rules"];
    const entries=await Promise.all(names.map(async name=>[name,(await db.query(`select * from public.${name}`)).rows]));
    return Object.fromEntries(entries) as Workspace;
  };
  const compare=async(mode:"quote"|"invoice")=>{
    const workspace=await data();
    const check=workspace.kit_checks.find(c=>c.id===checkId)!;
    const js=calculateFinance(workspace,check,mode);
    const sql=(await db.query<{value:FinanceResult}>("select public.finance_snapshot($1,$2) as value",[checkId,mode==="invoice"])).rows[0].value;
    for(const key of totals) assert.equal(Number(sql[key]),js[key],`${mode} ${key} agrees with browser preview`);
    assert.equal(sql.tax_reviewed,js.tax_reviewed);
    assert.equal(sql.pricing_missing,js.pricing_missing,"missing-pricing gate agrees with preview");
    return {js,sql};
  };
  const command=async(action:string,payload:object)=>(await db.query<{id:string}>("select public.workspace_command($1,$2::jsonb) as id",[action,JSON.stringify(payload)])).rows[0].id;
  const login=async()=>{await db.exec(`set role authenticated;set request.jwt.claim.sub='${staff}';`);};
  if(upgrade)await db.exec(upgrade);
  return {db,settings,checkId,one,two,save,data,compare,command,login};
}

test("prepared private upgrade retains existing checks and stock and imports rate suggestions",async(t)=>{
  const upgrade=await readFile(new URL("../private-import/workflow-upgrade.sql",import.meta.url),"utf8").catch(()=>null);
  if(!upgrade){t.skip("Private rate import is intentionally absent from public checkouts.");return;}
  const f=await fixture(upgrade);
  try{
    assert.equal((await f.db.query("select id from public.kit_checks")).rows.length,1);
    assert.equal((await f.db.query("select id from public.check_items")).rows.length,2);
    assert.equal((await f.db.query("select id from public.batches where voided_at is null")).rows.length,3);
    assert.equal((await f.db.query("select id from public.pricing_rules")).rows.length,100);
    await f.compare("quote");
  }finally{await f.db.close();}
});

test("Postgres finance snapshots match browser quote/invoice totals for credits, tax, extras, overrides and new builds",async()=>{
  const f=await fixture();
  try{
    await f.compare("quote"); await f.compare("invoice");
    f.settings.job_proceeded=false; await f.save();
    const noProceed=await f.compare("quote"); assert.equal(noProceed.sql.subtotal,50);
    f.settings.job_proceeded=true;f.settings.assessment_fee_override=0;await f.save();await f.compare("quote");
    delete f.settings.assessment_fee_override;
    await f.db.query("update public.check_items set unit_price=0.335,required_packs=case when id=$1 then 2 else 1 end where check_id=$2",[f.one,f.checkId]);
    await f.save();const fractions=await f.compare("quote");assert.equal(fractions.sql.items_subtotal,0.67);
    await f.db.query("update public.kit_checks set job_type='New Build' where id=$1",[f.checkId]);
    f.settings.new_build_kit_price=1000.235;await f.save();
    const newBuild=await f.compare("quote");assert.equal(newBuild.sql.assessment_fee,0);assert.equal(newBuild.sql.items_subtotal,1000.24);
  }finally{await f.db.close();}
});

test("database and preview agree on missing configuration and proposed pricing-rule review",async()=>{
  const f=await fixture();
  try{
    delete f.settings.job_proceeded;await f.save();assert.equal((await f.compare("quote")).sql.pricing_missing,true);
    f.settings.job_proceeded=true;delete f.settings.proceeds_credit_percent;await f.save();assert.equal((await f.compare("quote")).sql.pricing_missing,true);
    f.settings.proceeds_credit_percent=50;delete f.settings.standard_fee;await f.save();assert.equal((await f.compare("quote")).sql.pricing_missing,true);
    const template=(await f.db.query<{framework:string;category:string}>("select framework,category from public.kit_templates limit 1")).rows[0];
    await f.db.query("insert into public.pricing_rules(framework,category,crew_band,job_type,standard_fee,member_discount_percent,proceeds_credit_percent,new_build_kit_price,review_required) values ($1,$2,10,'Restructure',100,50,50,null,true)",[template.framework,template.category]);
    await f.compare("quote");
    f.settings.pricing_reviewed=true;await f.save();assert.equal((await f.compare("quote")).sql.pricing_missing,false);
    await f.db.query("update public.kit_checks set job_type='New Build' where id=$1",[f.checkId]);
    f.settings.new_build_kit_price=1000;delete f.settings.pricing_reviewed;await f.save();
    assert.equal((await f.compare("quote")).sql.pricing_missing,false,"an explicit reviewed setup price is sufficient without a matching rule");
  }finally{await f.db.close();}
});

test("staff workflow gates finance snapshots, fixes approved pricing and creates invoice only after complete packing",async()=>{
  const f=await fixture();
  try{
    const originalData=await f.data();const originalCheck=originalData.kit_checks[0];
    await f.login();
    await assert.rejects(()=>f.db.query("select public.finance_snapshot($1,false)",[f.checkId]),/permission denied/);
    f.settings.tax_reviewed=false;
    await f.command("save_check_setup",{check_id:f.checkId,workflow:{finance:f.settings}});
    await assert.rejects(()=>f.command("prepare_quote",{check_id:f.checkId}),/Review tax/);
    f.settings.tax_reviewed=true;
    Object.assign(f.settings,{tax_notes:"Fixture: reviewed zero goods VAT",pricing_reviewed:true});
    await f.command("save_check_setup",{check_id:f.checkId,workflow:{finance:f.settings}});
    await f.command("prepare_quote",{check_id:f.checkId});
    const quote=(await f.db.query<{financials:FinanceResult}>("select financials from public.quotes where check_id=$1 and superseded_at is null",[f.checkId])).rows[0];
    for(const key of totals) assert.equal(Number(quote.financials[key]),calculateFinance(originalData,originalCheck,"quote")[key]);
    await assert.rejects(()=>f.command("save_check_setup",{check_id:f.checkId,workflow:{finance:{...f.settings,shipping:999}}}),/Revise the quote/);
    await f.command("approve_quote",{check_id:f.checkId});
    await assert.rejects(()=>f.command("create_invoice",{check_id:f.checkId,invoice_number:"FINANCE-TEST-001"}),/Finish packing/);
    await f.command("add_batch",{item_id:f.one,quantity:1,no_expiry:true});
    await f.command("finish",{check_id:f.checkId});
    await f.command("create_invoice",{check_id:f.checkId,invoice_number:"FINANCE-TEST-001"});
    const currentData=await f.data();
    const expected=calculateFinance(currentData,currentData.kit_checks.find(c=>c.id===f.checkId)!,"invoice");
    const invoice=(await f.db.query<{financials:FinanceResult}>("select financials from public.invoices where check_id=$1",[f.checkId])).rows[0];
    for(const key of totals) assert.equal(Number(invoice.financials[key]),expected[key]);
    await assert.rejects(()=>f.db.query("update public.invoices set status='paid' where check_id=$1",[f.checkId]),/permission denied/);
  }finally{await f.db.close();}
});
