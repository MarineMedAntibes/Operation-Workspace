"use client";
import { useState } from "react";
import type { CheckPanelProps } from "./check-setup";
import { checkItemsInWorkbookOrder } from "@/lib/workbook-order";
import { expiryText, parseExpiryMonth } from "@/lib/check-workflow";
import { euros, quantities } from "@/lib/rules";
import type { LegacyItem } from "@/lib/types";

export function downloadCsv(filename:string,rows:unknown[][]){
 const text="\ufeff"+rows.map(row=>row.map(value=>{let s=String(value??"");if(/^[=+@\-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(",")).join("\r\n");
 const url=URL.createObjectURL(new Blob([text],{type:"text/csv;charset=utf-8"})),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function ReplacedItems({data,check}:CheckPanelProps){
 const lines=checkItemsInWorkbookOrder(data,check.id).filter(i=>quantities(i,data.batches).needed>0||data.batches.some(b=>b.check_item_id===i.id&&!b.voided_at&&b.kind==="removed"));
 const rows=lines.map(i=>{const q=quantities(i,data.batches);return[String(i.attributes?.item_id??i.source_code),i.description,i.location,q.kept,data.batches.filter(b=>b.check_item_id===i.id&&!b.voided_at&&b.kind==="removed").reduce((n,b)=>n+Number(b.quantity),0),q.needed,q.supplied,i.unit_price,q.needed*i.unit_price];});
 const headers=["Item ID","Item","Bag","Kept","Removed","Replacement packs","Supplied","Price / pack","Planned value"];
 return <section className="panel workflow-panel"><div className="section-heading"><div><h2>Replaced items</h2><p>Removed stock and planned replacement quantities, using this check’s saved prices.</p></div><button className="secondary" onClick={()=>downloadCsv("replaced-items.csv",[headers,...rows])}>Download replaced-items list</button></div><div className="table-wrap"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row,n)=><tr key={n}>{row.map((v,k)=><td key={k}>{k>=7?euros(Number(v)):v}</td>)}</tr>)}</tbody></table></div></section>;
}
export function LegacyItems({data,check,busy,command}:CheckPanelProps){
 const [editing,setEditing]=useState<LegacyItem|null>(null),[message,setMessage]=useState("");
 const records=data.legacy_items?.filter(i=>i.check_id===check.id)??[];
 return <section className="panel workflow-panel"><div className="section-heading"><div><h2>Legacy / non-regulated items</h2><p>Attached to this check, separate from the regulated kit requirements. These items do not satisfy a regulated line automatically.</p></div></div><form key={editing?.id??"new"} onSubmit={async e=>{e.preventDefault();const element=e.currentTarget,form=new FormData(element);try{const no_expiry=form.has("no_expiry");const payload={check_id:check.id,...(editing?{item_id:editing.id}:{}),description:String(form.get("description")),quantity:Number(form.get("quantity")),expiry:no_expiry?"":parseExpiryMonth(String(form.get("expiry"))),no_expiry,location:String(form.get("location")??""),notes:String(form.get("notes")??"")};if(await command("save_legacy_item",payload)){setEditing(null);element.reset();setMessage("Legacy item saved.");}}catch(err){setMessage(err instanceof Error?err.message:"Check entry");}}}>
 <fieldset disabled={busy||check.status==="complete"}><div className="workflow-form-grid">{[["description","Description",editing?.description??"","text"],["quantity","Quantity",editing?.quantity??1,"number"],["expiry","Expiry MM/YY or MM/YYYY",expiryText(editing?.expiry??null),"text"],["location","Bag / location",editing?.location??"","text"],["notes","Notes / source",editing?.notes??"","text"]].map(([name,label,value,type])=><label key={String(name)}>{label}<input name={String(name)} type={String(type)} defaultValue={String(value)} required={name==="description"||name==="quantity"} min={type==="number"?0:undefined}/></label>)}</div><label className="workflow-checkbox"><input name="no_expiry" type="checkbox" defaultChecked={editing?.no_expiry??false}/>No expiry (NED)</label><button className="primary">{editing?"Save changes":"Add legacy item"}</button>{editing&&<button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancel edit</button>}</fieldset></form>{message&&<p className="info" role="status">{message}</p>}
 <div className="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Expiry</th><th>Location / notes</th><th>Action</th></tr></thead><tbody>{records.map(i=><tr key={i.id}><td>{i.description}</td><td>{i.quantity}</td><td>{i.no_expiry?"NED":expiryText(i.expiry)}</td><td>{i.location}<small>{i.notes}</small></td><td>{check.status!=="complete"&&<><button className="secondary" onClick={()=>setEditing(i)}>Edit</button><button className="text-button" disabled={busy} onClick={()=>{if(window.confirm(`Remove ${i.description} from this check?`))void command("delete_legacy_item",{check_id:check.id,item_id:i.id});}}>Remove</button></>}</td></tr>)}</tbody></table></div>
 </section>;
}
export function DocumentsPanel({data,check,demo=false}:CheckPanelProps&{demo?:boolean}){
 const [status,setStatus]=useState(""),[loading,setLoading]=useState(false);
 async function download(format:"xlsx"|"pdf",sheet="all"){
  setStatus("");setLoading(true);
  try{
   let bytes:Blob,name:string;
   if(demo){if(format!=="xlsx")throw new Error("PDF rendering is available on the signed-in server. The fictional preview can download the Excel workbook.");throw new Error("Use a signed-in check to download the original Excel workbook.");}
   const response=await fetch(`/api/check-documents?check_id=${encodeURIComponent(check.id)}&format=${format}&sheet=${encodeURIComponent(sheet)}`);
   if(!response.ok){const result=await response.json();throw new Error(result.error??"Export failed");}
   bytes=await response.blob();name=`${data.vessels.find(v=>v.id===check.vessel_id)?.name??"kit"}-${sheet}-draft.${format}`;
   const url=URL.createObjectURL(bytes),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(err){setStatus(err instanceof Error?err.message:"Unable to export");}finally{setLoading(false);}
 }
 return <section className="panel workflow-panel"><div className="section-heading"><div><h2>Original Excel-format documents</h2><p>The workbook preserves the original sheet styles, bag colours, company branding, directory and certificate layout.</p></div></div><p className="info">Certificates are exported as DRAFT / NOT ISSUED. Review and sign the certificate in your approved process. Downloading does not issue or sign a certificate.</p><div className="workflow-actions"><button className="primary" disabled={loading} onClick={()=>void download("xlsx")}>Download complete Excel workbook</button>{[["directory","Kit directory PDF"],["certificate","Draft certificate PDF"],["replaced","Replaced items PDF"]].map(([sheet,label])=><button key={sheet} className="secondary" disabled={loading} onClick={()=>void download("pdf",sheet)}>{label}</button>)}</div><p>PDF uses the original Excel sheets rendered by LibreOffice on the server. If a renderer is unavailable, download the workbook and export the required sheet to PDF in Excel.</p>{status&&<p className="error" role="alert">{status}</p>}<details><summary>What is included?</summary><p>Configuration, reconciliation, arrival, cost analysis, quote and invoice, pick and fill, directory, draft certificate, replaced items, forecast and the attached legacy-items sheet. An export stops with an explanation if a custom line cannot be mapped to the original layout; it will not silently omit it.</p></details></section>;
}
