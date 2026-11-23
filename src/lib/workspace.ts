import "server-only";
import { supabase } from "./supabase";
import type { Workspace } from "./types";
export async function loadWorkspace(): Promise<Workspace> {
  const db = await supabase();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error("Sign in required.");
  const { data: staff, error } = await db.from("staff_members").select("id").eq("id", user.id).maybeSingle();
  if (error || !staff) throw new Error("Your account has not been granted staff access.");
  const names: (keyof Workspace)[] = ["clients", "vessels", "vendors", "vendor_products", "kit_templates", "template_items", "kit_checks", "check_items", "batches", "quotes", "import_sources", "pricing_rules", "legacy_items", "invoices"];
  let workflowReady=true;
  const entries = await Promise.all(names.map(async (name) => {
    const rows: unknown[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(name).select("*").order("id").range(offset, offset + 499);
      if (error && ["import_sources", "pricing_rules", "legacy_items", "invoices"].includes(name) && ["42P01", "PGRST205"].includes(error.code)) {if(name!=="import_sources")workflowReady=false;return [name, []];}
      if (error) throw new Error(`Unable to load ${name}: ${error.message}`);
      rows.push(...(name === "batches" ? data.filter(row => !row.voided_at) : data));
      if (data.length < 500) break;
    }
    return [name, rows];
  }));
  return {...Object.fromEntries(entries),workflow_ready:workflowReady} as Workspace;
}
