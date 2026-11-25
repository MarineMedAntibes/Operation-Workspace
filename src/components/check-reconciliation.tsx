"use client";
import { DraftActions, useDraftHistory } from "./draft-history";
import { useState } from "react";
import { matchingCandidates, parseDelimited, readXlsxSheets, reconciliationRows, reconciliationExpiry, type ReconciliationRow } from "@/lib/reconciliation";
import { activeBatches, type StockSlot } from "@/lib/check-workflow";
import { checkItemsInWorkbookOrder } from "@/lib/workbook-order";
import type { CheckPanelProps } from "./check-setup";

export default function CheckReconciliation({data,check,busy,command}:CheckPanelProps){
 const history=useDraftHistory({
  paste:"",name:"Pasted inventory",sheets:[] as {name:string;rows:string[][]}[],sheet:0,skip:0,
  columns:{description:0,quantity:1,expiry:2,item_code:3,location:4},
  rows:[] as ReconciliationRow[],matches:{} as Record<number,string>,confirmed:{} as Record<number,boolean>,
 });
 const [error,setError]=useState("");
 const {paste,name,sheets,sheet,skip,columns,rows,matches,confirmed}=history.value;
 const items=checkItemsInWorkbookOrder(data,check.id),count=rows.filter(r=>confirmed[r.row]&&matches[r.row]).length;
 function edit(patch:Partial<typeof history.value>){history.edit(current=>({...current,...patch}));setError("");}
 function preview(source:string[][],patch:Partial<typeof history.value>={}){
  try{
   const parsed=reconciliationRows(source);
   edit({...patch,rows:parsed,matches:Object.fromEntries(parsed.map(r=>[r.row,matchingCandidates(r,items)[0]?.item.id??""])),confirmed:{}});
  }catch(err){setError(err instanceof Error?err.message:"Unable to read inventory");}
 }
 function editRow(row:number,patch:Partial<ReconciliationRow>){
  edit({rows:rows.map(r=>r.row===row?{...r,...patch}:r),confirmed:{...confirmed,[row]:false}});
 }
 async function apply(){if(busy||check.status!=="assessing"||!count)return;try{
  const groups=new Map<string,{item_id:string;slots:StockSlot[];expected_batch_ids:string[];source_rows:{row:number;description:string;quantity:number;expiry:string}[]}>();
  for(const row of rows.filter(r=>confirmed[r.row]&&matches[r.row])){
    const item=items.find(i=>i.id===matches[row.row])!;const quantity=Number(row.quantity);
    if(!row.quantity.trim()||!Number.isInteger(quantity)||quantity<0)throw new Error(`Row ${row.row}: confirm a whole number of packs. Do not treat units as packs.`);
    const expiry=quantity?reconciliationExpiry(row.expiry):{expiry:"",no_expiry:false};
    const group=groups.get(item.id)??{item_id:item.id,slots:[],expected_batch_ids:activeBatches(data,item,"arrival").map(b=>b.id),source_rows:[]};
    if(quantity){const existing=group.slots.find(s=>s.expiry===expiry.expiry&&s.no_expiry===expiry.no_expiry);if(existing)existing.quantity+=quantity;else group.slots.push({quantity,...expiry});}
    if(group.slots.length>2)throw new Error(`${item.description}: more than two expiry groups. Review and split the source inventory before applying.`);
    group.source_rows.push({row:row.row,description:row.description,quantity,expiry:row.expiry});groups.set(item.id,group);
  }
  if(!groups.size)throw new Error("Confirm at least one match first.");
  if(!window.confirm("Replace arrival stock for the confirmed matched lines? Other lines stay unchanged. You will still verify these lines in Arrival check."))return;
  if(await command("reconcile_stock",{check_id:check.id,source_name:name,groups:[...groups.values()]})){history.reset({...history.value,rows:rows.filter(r=>!confirmed[r.row]),confirmed:{}});setError("");}
 }catch(err){setError(err instanceof Error?err.message:"Check mappings");}}
 return <section className="panel workflow-panel" onKeyDown={event=>{
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){event.preventDefault();void apply();}
 }}><div className="section-heading"><div><h2>Reconcile previous inventory</h2><p>Upload Excel/CSV or paste inventory, review suggested matches, then explicitly confirm each item. Confirm quantity in packs, strength, bag and expiry before applying.</p></div></div>
 <p className="info">Suggestions assist matching; they do not establish equivalent medicines or approve substitutions. Existing arrival records for confirmed lines are replaced and retained in the audit history. Unmatched rows stay in this preview until you close or refresh it.</p>
 <div className="workflow-actions"><DraftActions {...history} busy={busy} label="Inventory reconciliation draft"
  saveLabel={`Save ${count} confirmed matches`} saveDisabled={!count||check.status!=="assessing"} onSave={()=>void apply()}/></div>
 <fieldset disabled={busy}>
 <div className="workflow-form-grid"><label>Source name<input value={name} onChange={e=>edit({name:e.target.value})}/></label><label>Upload previous list<input type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;e.currentTarget.value="";try{if(file.size>10_000_000)throw new Error("Use files smaller than 10 MB.");if(file.name.toLowerCase().endsWith(".xlsx")){const result=readXlsxSheets(new Uint8Array(await file.arrayBuffer()));edit({name:file.name,sheets:result,sheet:0,rows:[],matches:{},confirmed:{}});}else{const text=await file.text();preview(parseDelimited(text),{name:file.name,paste:text,sheets:[],sheet:0});}}catch(err){setError(err instanceof Error?err.message:"Unable to open file");}}}/></label>
 {sheets.length>0&&<><label>Worksheet<select value={sheet} onChange={e=>edit({sheet:Number(e.target.value)})}>{sheets.map((s,n)=><option key={n} value={n}>{s.name}</option>)}</select></label><label>Skip title rows before column headings<input type="number" value={skip} min="0" onChange={e=>edit({skip:Number(e.target.value)})}/></label><button className="secondary" onClick={()=>preview([["description","quantity","expiry","item ID","bag"],...sheets[sheet].rows.slice(skip+1).map(row=>[row[columns.description]??"",row[columns.quantity]??"",row[columns.expiry]??"",row[columns.item_code]??"",row[columns.location]??""])])}>Preview worksheet</button>{Object.entries(columns).map(([key,value])=><label key={key}>{key.replaceAll("_"," ")} column<select value={value} onChange={e=>edit({columns:{...columns,[key]:Number(e.target.value)}})}>{Array.from({length:Math.max(5,sheets[sheet].rows[skip]?.length??0)},(_,n)=><option key={n} value={n}>{n+1}: {sheets[sheet].rows[skip]?.[n]??"(empty)"}</option>)}</select></label>)}<details><summary>First worksheet rows</summary><pre>{sheets[sheet].rows.slice(skip,skip+8).map(r=>r.join(" | ")).join("\n")}</pre></details></>}
 </div><label className="paste-inventory">Paste CSV or tab-separated columns: description, quantity, expiry, item ID (optional), bag (optional)<textarea rows={5} value={paste} onChange={e=>edit({paste:e.target.value})} placeholder={'description,quantity,expiry,item ID,bag\nSterile dressing,2,02/2028,,First aid bag'}/></label><div className="workflow-actions"><button className="secondary" onClick={()=>{try{preview(parseDelimited(paste));}catch(err){setError(String(err));}}}>Preview pasted rows</button></div>
 {error&&<p className="error" role="alert">{error}</p>}<div className="table-wrap"><table><thead><tr><th>Previous inventory</th><th>Packs / expiry</th><th>Match to this check</th><th>Confirm</th></tr></thead><tbody>{rows.map(row=>{const candidates=matchingCandidates(row,items);return <tr key={row.row}><td><strong>{row.description}</strong><small>Source row {row.row} · {row.item_code} · {row.location}</small></td><td><input aria-label={`Packs row ${row.row}`} value={row.quantity} onChange={e=>{editRow(row.row,{quantity:e.target.value});}}/><input aria-label={`Expiry row ${row.row}`} value={row.expiry} placeholder="MM/YY or NED" onChange={e=>{editRow(row.row,{expiry:e.target.value});}}/></td><td><select aria-label={`Match row ${row.row}`} value={matches[row.row]??""} onChange={e=>{edit({matches:{...matches,[row.row]:e.target.value},confirmed:{...confirmed,[row.row]:false}});}}><option value="">Unmatched / retain for review</option>{items.map(item=><option key={item.id} value={item.id}>{String(item.attributes?.item_id??item.source_code)} · {item.description} · {item.location}</option>)}</select><small>{candidates.find(c=>c.item.id===matches[row.row])?.reason??"Manually selected match"}</small>{!matches[row.row]&&<small>For a non-regulated item, use the Legacy items tab after reviewing it.</small>}</td><td><label><input type="checkbox" checked={!!confirmed[row.row]} disabled={!matches[row.row]} onChange={e=>edit({confirmed:{...confirmed,[row.row]:e.target.checked}})}/>Identity, packs and expiry checked</label></td></tr>;})}</tbody></table></div>
 </fieldset></section>;
}
