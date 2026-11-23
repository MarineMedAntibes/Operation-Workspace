import { NextResponse } from "next/server";
import { loadWorkspace } from "@/lib/workspace";
import { supabase } from "@/lib/supabase";
import { parseCommand } from "@/lib/commands";
import { ZodError } from "zod";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const command = parseCommand(await request.json());
    const db = await supabase();
    const { data: { user } } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    const { error } = await db.rpc("workspace_command", command);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if(command.action==="save_line_slots"&&request.headers.get("X-Workspace-Partial")==="line"){
      const {item_id}=command.payload as {item_id:string};
      const [{data:item,error:itemError},{data:batches,error:batchError}]=await Promise.all([
        db.from("check_items").select("*").eq("id",item_id).single(),
        db.from("batches").select("*").eq("check_item_id",item_id).is("voided_at",null),
      ]);
      if(itemError||batchError)throw new Error("Saved, but this line could not refresh. Reload before editing again.");
      return NextResponse.json({partial:"line",item,batches},{headers:{"Cache-Control":"no-store"}});
    }
    return NextResponse.json(await loadWorkspace(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Unable to save." }, { status: 400 });
  }
}
