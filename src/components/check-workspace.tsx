"use client";
import DraftForm from "./draft-form";
import { useState } from "react";
import CheckSetup, { CheckHeaderEditor, type CheckPanelProps } from "./check-setup";
import CheckReconciliation from "./check-reconciliation";
import FastCheckLines from "./fast-check-lines";
import { CostAnalysis, InvoicePanel, QuotePanel } from "./check-finance";
import { DocumentsPanel, LegacyItems, ReplacedItems, downloadCsv } from "./check-documents";
import { checkItemsInWorkbookOrder } from "@/lib/workbook-order";
import { equipmentStatus, expiryText } from "@/lib/check-workflow";
import { quantities } from "@/lib/rules";
import type { CheckItem } from "@/lib/types";

type Props=CheckPanelProps&{tab:string;setTab:(tab:string)=>void;edit:(item:CheckItem)=>void;demo:boolean};
const tabs=["Setup","Reconciliation","Assessment","Cost analysis","Quote","Pick & pack","Directory","Documents","Replaced items","Legacy items","Invoice","Health check"];
export default function CheckWorkspace(props:Props){
 const {data,check,busy,command,tab,setTab}=props,[revision,setRevision]=useState(false);
 const lines=checkItemsInWorkbookOrder(data,check.id),assessed=lines.filter(i=>i.assessment_state!=="unreviewed").length,packed=lines.filter(i=>quantities(i,data.batches).outstanding===0&&i.assessment_state!=="unreviewed").length;
 const active=data.quotes.find(q=>q.check_id===check.id&&!q.superseded_at),workflow=check.attributes?.workflow as Record<string,unknown>|undefined;
 const issues:{message:string;action:string}[]=[];
 if(!workflow?.assessor)issues.push({message:"Assessor has not been entered.",action:"Setup"});
 if(!workflow?.billing_name||!workflow?.delivery_location||workflow?.client_type==="Unknown"||workflow?.tva_status==="Unknown")issues.push({message:"Review billing, client type, tax status and delivery details.",action:"Setup"});
 if(!workflow?.certificate_number)issues.push({message:"Certificate reference is not assigned. Certificate exports remain drafts.",action:"Setup"});
 if(check.attributes?.review_required)issues.push({message:"Imported source issues still need review.",action:"Assessment"});
 const invalid=lines.filter(i=>i.attributes?.requirement_unknown||i.attributes?.price_missing);
 if(invalid.length)issues.push({message:`${invalid.length} lines have unknown quantities or prices.`,action:"Assessment"});
 if(assessed!==lines.length)issues.push({message:`${lines.length-assessed} arrival lines are not assessed.`,action:"Assessment"});
 const template=data.kit_templates.find(t=>t.id===check.template_id);
 if(!template||!lines.length)issues.push({message:"The check template or its lines are missing.",action:"Health check"});
 if(check.attributes?.source_crew_band&&Number(check.attributes.source_crew_band)!==[10,20,30,40,60].find(b=>b>=check.crew))issues.push({message:"Imported source crew band differs from the recorded crew count. Review the source quantities.",action:"Assessment"});
 const equipment=Array.isArray(workflow?.critical_equipment)?workflow.critical_equipment as {name:string;present:string;expiry:string;hydrotest:string}[]:[];
 if(equipment.length!==3)issues.push({message:"Critical equipment has not been recorded.",action:"Setup"});
 for(const item of equipment){const status=equipmentStatus(item,new Date().toLocaleDateString("en-CA"));if(status!=="In date"&&status!=="Not on board")issues.push({message:`${item.name}: ${status}.`,action:"Setup"});}
 const revisionAllowed=["packing","awaiting_approval"].includes(check.status)&&!data.invoices?.some(i=>i.check_id===check.id);
 if(data.workflow_ready===false)return <section className="panel workflow-panel"><div className="section-heading"><div><h2>Database upgrade required</h2><p>The new workflow is installed locally. Apply the prepared workflow-upgrade.sql file in Supabase before entering assessments or preparing financial documents.</p><p>Existing clients, checks and stock records are retained; their import files do not need to be rerun.</p></div></div></section>;
 return <div className="check-workspace"><div className="workflow-progress"><div><span>Arrival assessed</span><b>{assessed} / {lines.length}</b></div><div><span>Quote</span><b>{active?.status==="approved"?"Approved":active?"Awaiting approval":"Not prepared"}</b></div><div><span>Packing complete</span><b>{packed} / {lines.length}</b></div><button className={`health-button ${issues.length?"health-review":"health-ready"}`} onClick={()=>setTab("Health check")}>{issues.length?`${issues.length} health checks to review`:"Health checks clear"}</button></div>
 {revisionAllowed&&<div className="revision-bar"><span>Need to override quantities, pack size or prices? Reopen assessment and prepare a revised quote; previous approval stays in history.</span><button className="secondary" disabled={busy} onClick={()=>setRevision(!revision)}>Revise quote</button></div>}{revision&&<DraftForm busy={busy} className="revision-bar" onSubmit={async e=>{e.preventDefault();if(await command("revise_quote",{check_id:check.id,reason:String(new FormData(e.currentTarget).get("reason")??"")})){setRevision(false);setTab("Assessment");}}}><label>Revision reason<input name="reason" required/></label><button className="primary" disabled={busy}>Reopen assessment</button></DraftForm>}
 <div className="tabs workflow-tabs" role="tablist" aria-label="Kit check workflow">{tabs.map(name=><button key={name} role="tab" aria-selected={tab===name} onClick={()=>setTab(name)}>{name==="Assessment"?"Arrival check":name==="Pick & pack"?"Pick & fill":name}</button>)}</div>
 {tab==="Setup"&&<><CheckHeaderEditor {...props}/><CheckSetup key={check.id+JSON.stringify(check.attributes?.workflow)} {...props}/></>}
 {tab==="Reconciliation"&&<CheckReconciliation key={check.id} {...props}/>}
 {(tab==="Assessment"||tab==="Pick & pack")&&<><FastCheckLines {...props} phase={tab==="Assessment"?"arrival":"supply"}/>{tab==="Assessment"&&<div className="workflow-actions"><button className="primary" disabled={busy||assessed!==lines.length} onClick={()=>setTab("Cost analysis")}>Review cost analysis</button><button className="secondary" onClick={()=>setTab("Setup")}>Configuration</button></div>}</>}
 {tab==="Cost analysis"&&<CostAnalysis {...props}/>}{tab==="Quote"&&<QuotePanel {...props}/>}{tab==="Invoice"&&<InvoicePanel {...props}/>}{tab==="Legacy items"&&<LegacyItems {...props}/>}{tab==="Replaced items"&&<ReplacedItems {...props}/>}{tab==="Documents"&&<DocumentsPanel {...props}/>}
 {tab==="Directory"&&<section className="panel workflow-panel"><div className="section-heading"><div><h2>Kit directory</h2><p>Retained and supplied packs, in Excel line order. Use Documents for the original formatted workbook and PDF.</p></div><button className="secondary" onClick={()=>setTab("Documents")}>Formatted documents</button></div><div className="table-wrap"><table><thead><tr><th>Item ID / medicine</th><th>Bag</th><th>Final packs</th><th>Expiries</th><th>Notes</th></tr></thead><tbody>{lines.map(item=>{const batches=data.batches.filter(b=>b.check_item_id===item.id&&!b.voided_at&&b.kind!=="removed");return <tr key={item.id}><td><span className="item-code">{String(item.attributes?.item_id??item.source_code)}</span><strong>{item.description}</strong><small>{String(item.attributes?.dose_route??"")}</small></td><td>{item.location}</td><td>{quantities(item,data.batches).final}</td><td>{batches.map(b=>`${b.quantity} × ${b.no_expiry?"NED":expiryText(b.expiry)}`).join("; ")||"No stock recorded"}</td><td>{String(item.attributes?.override_reason??"")}</td></tr>;})}</tbody></table></div><div className="workflow-actions"><button className="secondary" onClick={()=>downloadCsv("kit-directory.csv",[["Item ID","Description","Bag","Final packs"],...lines.map(i=>[String(i.attributes?.item_id??i.source_code),i.description,i.location,quantities(i,data.batches).final])])}>Download directory CSV</button></div></section>}
 {tab==="Health check"&&<section className="panel workflow-panel"><div className="section-heading"><div><h2>Template and check health</h2><p>Data readiness checks. A clear list is not a regulatory certificate or proof of clinical equivalence.</p></div></div>{issues.length?issues.map((issue,n)=><div className="health-issue" key={n}><span>{issue.message}</span><button className="secondary" onClick={()=>setTab(issue.action)}>Review</button></div>):<p className="notice">All displayed data-readiness checks are clear.</p>}<p className="info">Source metadata and calculated quantities are retained on each check. Signed certificate issuance and actual sending through iPaidThat remain explicit external steps.</p></section>}
 </div>;
}
