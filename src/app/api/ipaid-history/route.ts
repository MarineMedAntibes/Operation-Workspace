import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
const actions = new Set(["start", "clients", "documents", "finish", "link_client", "create_client"]);
const batchPattern = /^[0-9a-f]{64}$/;
const pageSize = 25;

async function staffDatabase() {
  const db = await supabase();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data: staff } = await db.from("staff_members").select("id").eq("id", user.id).maybeSingle();
  return staff ? db : null;
}

export async function GET(request: Request) {
  const db = await staffDatabase();
  if (!db) return response({ error: "Staff access required." }, 403);
  const params = new URL(request.url).searchParams;
  const { data: batches, error: listError } = await db.from("ipaid_imports")
    .select("id,filename,completed_at,expected_clients,expected_documents")
    .not("completed_at", "is", null).order("completed_at", { ascending: false });
  if (listError) return response({ error: ["42P01", "PGRST205"].includes(listError.code)
    ? "Apply the iPaidThat history migration in Supabase to enable this page." : listError.message }, 400);
  const batch = batches.find(batch => batch.id === params.get("batch")) ?? batches[0];
  if (!batch) return response({ batches, rows: [], count: 0, pageSize });
  const pageValue = Number(params.get("page"));
  const page = Number.isSafeInteger(pageValue) ? Math.max(0, Math.min(pageValue, 2000)) : 0;
  const from = page * pageSize;
  const isClients = params.get("view") === "clients";
  const search = (params.get("search") ?? "").trim().slice(0, 250).replace(/[\\%_]/g, "\\$&");
  const code = (params.get("source") ?? "").slice(0, 250);
  const kind = (params.get("kind") ?? "").slice(0, 100);
  let query = db.from(isClients ? "ipaid_client_history" : "ipaid_document_history")
    .select("*", { count: "exact" }).eq("batch_id", batch.id);
  if (search) query = query.ilike("search_text", `%${search}%`);
  if (isClients && params.get("review") === "true") query = query.is("client_id", null);
  if (!isClients && code) query = query.eq("source_id", code);
  if (!isClients && kind) query = query.eq("kind", kind);
  if (!isClients && params.get("overdue") === "true") query = query.eq("overdue", true).eq("kind", "Facture");
  const ordered = isClients ? query.order("name").order("source_id") : query.order("issued_on", { ascending: false, nullsFirst: false }).order("source_row");
  const { data: rows, count, error } = await ordered.range(from, from + pageSize - 1);
  if (error) return response({ error: error.message }, 400);
  return response({ batches, batch: batch.id, rows, count, pageSize });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || (origin !== new URL(request.url).origin && request.headers.get("sec-fetch-site") !== "same-origin")) {
    return response({ error: "Invalid request origin." }, 403);
  }
  const db = await staffDatabase();
  if (!db) return response({ error: "Staff access required." }, 403);
  let input;
  try { input = await request.json(); }
  catch { return response({ error: "Invalid import request." }, 400); }
  const { action, payload } = input ?? {};
  if (!actions.has(action) || !payload || !batchPattern.test(payload.batch_id ?? "")) {
    return response({ error: "Invalid import request." }, 400);
  }
  const { error } = await db.rpc("workspace_ipaid_import", { action, payload });
  if (error) return response({ error: error.code === "PGRST202"
    ? "Apply the iPaidThat history migration before importing." : error.message }, 400);
  return response({ ok: true });
}
