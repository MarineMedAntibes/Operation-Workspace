import { NextResponse } from "next/server";
import { loadWorkspace } from "@/lib/workspace";
import { supabase } from "@/lib/supabase";
import { parseCommand } from "@/lib/commands";
import { ZodError } from "zod";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // Next can report an internal URL when the browser uses a different local host.
  const sameOrigin = origin && (origin === new URL(request.url).origin ||
    (request.headers.get("sec-fetch-site") === "same-origin" && /^https?:\/\//.test(origin)));
  if (!sameOrigin) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const command = parseCommand(await request.json());
    const db = await supabase();
    const { data: { user } } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    if (command.action === "delete_template" || (command.action === "save_template_item" && "share_price" in command.payload && command.payload.share_price)) {
      const { error } = await db.from("template_sell_prices").select("item_key").limit(0);
      if (error?.code === "PGRST205" || error?.code === "42P01") {
        return NextResponse.json({ error: "Apply the template shared prices migration in Supabase before using this action." }, { status: 503 });
      }
    }
    const directoryCommand = command.action.startsWith("update_") ||
      (command.action === "create_vessel" && ("new_client" in command.payload || !("client_id" in command.payload) || !command.payload.client_id));
    const cappedLine = command.action === "save_template_item" && "attributes" in command.payload &&
      command.payload.attributes && Object.hasOwn(command.payload.attributes, "maximum_packs");
    const { error } = cappedLine
      ? await db.rpc("save_capped_template_item", { payload: command.payload })
      : await db.rpc(directoryCommand ? "workspace_directory_command" : "workspace_command", command);
    if (cappedLine && error?.code === "PGRST202") {
      return NextResponse.json({ error: "Apply the template quantity caps migration in Supabase before saving a cap." }, { status: 503 });
    }
    if (directoryCommand && error?.code === "PGRST202") {
      return NextResponse.json({ error: "Apply the directory edits migration in Supabase before saving this change." }, { status: 503 });
    }
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
    return NextResponse.json(await loadWorkspace({ db, user }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Unable to save." }, { status: 400 });
  }
}
