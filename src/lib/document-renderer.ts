import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

const execute=promisify(execFile);
export const documentSheets={directory:"6.KIT DIRECTORY",certificate:"7.CERTIFICATE",replaced:"REPLACED ITEMS"} as const;
export function selectDocumentSheet(bytes:Uint8Array,sheet:keyof typeof documentSheets):Uint8Array{
 const zip=unzipSync(bytes);let workbook=strFromU8(zip["xl/workbook.xml"]),selected=-1,index=0,selectedTag="";
 workbook=workbook.replace(/<sheet\b[^>]*\/>/g,tag=>{
  const name=tag.match(/\bname="([^"]*)"/)?.[1];
  const visible=name===documentSheets[sheet];if(visible)selected=index;index++;
  const cleaned=tag.replace(/\s+state="[^"]*"/,"");
  if(visible)selectedTag=cleaned;
  return visible?cleaned:"";
 });
 if(selected<0)throw new Error("Requested original worksheet is unavailable.");
 workbook=workbook.replace(/<workbookView\b[^>]*\/>/g,tag=>tag.replace(/\s+(activeTab|firstSheet)="[^"]*"/g,"").replace(/\/>$/,' activeTab="0" firstSheet="0"/>'));
 workbook=workbook.replace(/<definedName\b([^>]*)>[\s\S]*?<\/definedName>/g,(tag,attributes:string)=>{
  const local=attributes.match(/\blocalSheetId="(\d+)"/)?.[1];
  return local===String(selected)?tag.replace(/localSheetId="\d+"/,'localSheetId="0"'):"";
 });
 {
  // Excel's fitToPage=true with omitted dimensions means a single page in the
  // supplied template. State those dimensions explicitly for LibreOffice.
  const rels=strFromU8(zip["xl/_rels/workbook.xml.rels"]);
  const tag=selectedTag;
  const relation=tag.match(/\br:id="([^"]+)"/)?.[1];
  const relationship=[...rels.matchAll(/<Relationship\b[^>]*\/>/g)].find(m=>m[0].includes(`Id="${relation}"`))?.[0];
  const target=relationship?.match(/\bTarget="([^"]+)"/)?.[1];
  if(target){const path=target.startsWith("/")?target.slice(1):"xl/"+target;let xml=strFromU8(zip[path]);
   // Values were recalculated in the complete workbook before other sheets were
   // removed. Retain those values without leaving broken cross-sheet formulas.
   xml=xml.replace(/<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/g,"");
   if(sheet==="certificate")xml=xml.replace(/<pageSetup\b[^>]*\/>/,tag=>tag.replace(/\s+(fitToWidth|fitToHeight)="[^"]*"/g,"").replace(/\/>$/,' fitToWidth="1" fitToHeight="1"/>'));
   zip[path]=strToU8(xml);
  }
 }
 zip["xl/workbook.xml"]=strToU8(workbook);return zipSync(zip,{level:6});
}
export async function findRenderer():Promise<string|null>{
 const paths=[process.env.LIBREOFFICE_PATH,...(process.platform==="win32"?["C:\\Program Files\\LibreOffice\\program\\soffice.com","C:\\Program Files\\LibreOffice\\program\\soffice.exe"]:["/usr/bin/libreoffice","/usr/bin/soffice","/opt/homebrew/bin/soffice","/Applications/LibreOffice.app/Contents/MacOS/soffice"])];
 for(const path of paths)if(path){try{await access(path);return path;}catch{/* try next installed path */}}
 return null;
}
let conversions=0;
export async function renderDocumentPdf(workbook:Uint8Array,sheet:keyof typeof documentSheets):Promise<Uint8Array>{
 const renderer=await findRenderer();
 if(!renderer)throw new Error("PDF renderer is not installed on this server. Download the Excel workbook and export the required sheet to PDF, or configure LIBREOFFICE_PATH.");
 if(conversions>=2)throw new Error("Two documents are already rendering. Please retry shortly.");
 conversions++;let directory:string|undefined;
 try{
  directory=await mkdtemp(join(tmpdir(),"mma-document-"));
  const source=join(directory,"document.xlsx"),calculated=join(directory,"calculated"),selected=join(directory,"selected");
  await mkdir(calculated);await mkdir(selected);await writeFile(source,workbook);
  const profile=`-env:UserInstallation=${pathToFileURL(join(directory,"profile")).href}`;
  await execute(renderer,[profile,"--headless","--convert-to","xlsx:Calc MS Excel 2007 XML","--outdir",calculated,source],{timeout:90000,windowsHide:true,maxBuffer:1024*1024});
  const values=await readFile(join(calculated,"document.xlsx"));
  const selectedFile=join(selected,"document.xlsx");await writeFile(selectedFile,selectDocumentSheet(values,sheet));
  await execute(renderer,[profile,"--headless","--convert-to","pdf:calc_pdf_Export","--outdir",directory,selectedFile],{timeout:90000,windowsHide:true,maxBuffer:1024*1024});
  const pdf=await readFile(join(directory,"document.pdf"));
  if(pdf.subarray(0,5).toString()!=="%PDF-")throw new Error("The renderer did not produce a valid PDF.");
  if(sheet==="certificate"&&(await PDFDocument.load(pdf)).getPageCount()!==1)throw new Error(`The certificate renders on ${(await PDFDocument.load(pdf)).getPageCount()} pages instead of its required single page. Review the layout and text in Excel; no certificate PDF was released.`);
  return pdf;
 }finally{conversions--;if(directory){if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("mma-document-"))throw new Error("Unexpected document cleanup directory.");await rm(directory,{recursive:true,force:true});}}
}
