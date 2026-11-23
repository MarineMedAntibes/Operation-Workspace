import type { CheckItem } from "./types";
import { unzipSync, strFromU8 } from "fflate";
import { parseExpiryMonth } from "./check-workflow";

export type ReconciliationRow = { row: number; description: string; quantity: string; expiry: string; item_code: string; location: string };
export function parseDelimited(input: string): string[][] {
  const separator=input.includes("\t")?"\t":",";
  const rows:string[][]=[]; let row:string[]=[],cell="",quoted=false;
  for(let n=0;n<input.length;n++){
    const c=input[n];
    if(c==='"'){if(quoted&&input[n+1]==='"'){cell+='"';n++;}else quoted=!quoted;}
    else if(c===separator&&!quoted){row.push(cell);cell="";}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&input[n+1]==='\n')n++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell="";}
    else cell+=c;
  }
  if(quoted)throw new Error("A quoted CSV field is not closed.");
  row.push(cell);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
const normalize=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export function reconciliationRows(rows:string[][]):ReconciliationRow[]{
  if(rows.length>2000)throw new Error("Import up to 2,000 source rows at a time.");
  const names=rows[0]?.map(normalize)??[];
  const aliases={description:["description","item description","medicine dose","item","product","medicine"],quantity:["quantity","qty","packs","pack quantity","quantity in kit"],expiry:["expiry","expiry date","exp","expiration","expiry 1"],item_code:["item id","reg code","code","item code"],location:["bag","location","bag location"]};
  const index=(key:keyof typeof aliases)=>names.findIndex(n=>aliases[key].includes(n));
  const description=index("description"); const header=description>=0;
  return rows.slice(header?1:0).map((cells,n)=>{
    const get=(key:keyof typeof aliases,fallback:number)=>String(cells[header?index(key):fallback]??"").trim();
    return {row:n+(header?2:1),description:get("description",0),quantity:get("quantity",1),expiry:get("expiry",2),item_code:get("item_code",3),location:get("location",4)};
  }).filter(r=>r.description||r.item_code);
}
export function matchingCandidates(row:ReconciliationRow,items:CheckItem[]):{item:CheckItem;score:number;reason:string}[]{
  const input=normalize(row.description), words=new Set(input.split(" ").filter(w=>w.length>2));
  return items.map(item=>{
    const code=String(item.attributes?.item_id??item.source_code.split("|")[0]);
    if(row.item_code&&normalize(row.item_code)===normalize(code))return{item,score:1,reason:"Exact item ID; verify bag, strength and pack size"};
    const description=normalize(String(item.attributes?.original_description??item.description));
    if(input&&input===description)return{item,score:.95,reason:"Same description; confirm strength and pack size"};
    const tokens=new Set(description.split(" ").filter(w=>w.length>2));
    const overlap=[...words].filter(w=>tokens.has(w)).length;
    const union=new Set([...words,...tokens]).size;
    return{item,score:union?overlap/union:0,reason:"Description similarity only — confirm item identity"};
  }).filter(c=>c.score>.15).sort((a,b)=>b.score-a.score).slice(0,5);
}
export function reconciliationExpiry(value:string):{expiry:string;no_expiry:boolean}{
  if(/^(ned|no expiry)$/i.test(value.trim()))return{expiry:"",no_expiry:true};
  if(/^\d{5}(?:\.\d+)?$/.test(value.trim())){
    const date=new Date(Date.UTC(1899,11,30)+Number(value)*86400000);
    return{expiry:date.toISOString().slice(0,7)+"-01",no_expiry:false};
  }
  return{expiry:parseExpiryMonth(value),no_expiry:false};
}

// XLSX stays in the browser. Only explicitly confirmed mappings reach Supabase.
export function readXlsxSheets(bytes:Uint8Array):{name:string;rows:string[][]}[]{
  if(bytes.length>10_000_000)throw new Error("Use a workbook smaller than 10 MB.");
  let uncompressed=0,count=0;
  const zip=unzipSync(bytes, {filter:entry=>{uncompressed+=entry.originalSize;count++;if(uncompressed>40_000_000||entry.originalSize>25_000_000||count>5000)throw new Error("This workbook expands beyond the browser import limit.");return true;}});
  if(Object.values(zip).reduce((n,v)=>n+v.length,0)>40_000_000)throw new Error("This workbook is too large to reconcile in the browser.");
  const xml=(name:string)=>{if(!zip[name])throw new Error(`Workbook part missing: ${name}`);return new DOMParser().parseFromString(strFromU8(zip[name]),"application/xml");};
  const elements=(node:Document|Element,name:string)=>Array.from(node.getElementsByTagNameNS("*",name));
  const shared=zip["xl/sharedStrings.xml"]?elements(xml("xl/sharedStrings.xml"),"si").map(si=>elements(si,"t").map(t=>t.textContent??"").join("")):[];
  const rels=new Map(elements(xml("xl/_rels/workbook.xml.rels"),"Relationship").map(r=>[r.getAttribute("Id"),r.getAttribute("Target")??""]));
  return elements(xml("xl/workbook.xml"),"sheet").map(sheet=>{
    const rel=sheet.getAttribute("r:id"),target=rels.get(rel)??"";
    const path=target.startsWith("/")?target.slice(1):"xl/"+target.replace(/^\.\//,"");
    const rows=elements(xml(path),"row").map(row=>{
      const cells:string[]=[];
      for(const c of elements(row,"c")){
        const col=(c.getAttribute("r")??"A1").match(/^[A-Z]+/)?.[0]??"A";
        const index=[...col].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;
        const raw=elements(c,"v")[0]?.textContent??"";
        cells[index]=c.getAttribute("t")==="s"?shared[Number(raw)]??"":c.getAttribute("t")==="inlineStr"?elements(c,"t").map(t=>t.textContent??"").join(""):raw;
      }
      return Array.from({length:cells.length},(_,n)=>cells[n]??"");
    });return{name:sheet.getAttribute("name")??"Sheet",rows};
  });
}
