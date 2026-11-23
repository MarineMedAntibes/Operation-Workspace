import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { loadWorkspace } from "@/lib/workspace";
import { buildWorkbookExport } from "@/lib/workbook-export";
import { renderDocumentPdf, documentSheets } from "@/lib/document-renderer";

export const runtime="nodejs";
export const maxDuration=120;
export async function GET(request:Request){
 const url=new URL(request.url),checkId=url.searchParams.get("check_id"),format=url.searchParams.get("format")??"xlsx",sheet=url.searchParams.get("sheet")??"directory";
 if(!checkId||!["xlsx","pdf"].includes(format)||(format==="pdf"&&!Object.hasOwn(documentSheets,sheet)))return NextResponse.json({error:"Choose a check and a supported document format."},{status:400});
 try{
  const db=await supabase();const {data:{user}}=await db.auth.getUser();
  if(!user)return NextResponse.json({error:"Sign in required."},{status:401});
  const data=await loadWorkspace();if(!data.kit_checks.some(c=>c.id===checkId))return NextResponse.json({error:"Kit check not found."},{status:404});
  let bytes=await buildWorkbookExport({data,checkId});
  if(format==="pdf")bytes=await renderDocumentPdf(bytes,sheet as keyof typeof documentSheets);
  return new Response(new Uint8Array(bytes),{headers:{"Content-Type":format==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="kit-check-${format==="pdf"?sheet:"workbook"}-draft.${format}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
 }catch(error){const message=error instanceof Error?error.message:"Document export failed.";return NextResponse.json({error:message},{status:message.includes("renderer is not installed")?503:400,headers:{"Cache-Control":"no-store"}});}
}
