import "server-only";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Workspace } from "./types";
type VerifiedSession = { db: Awaited<ReturnType<typeof supabase>>; user: User };

export async function loadWorkspace(session?: VerifiedSession): Promise<Workspace> {
  const db = session?.db ?? await supabase();
  const user = session?.user ?? (await db.auth.getUser()).data.user;
  if (!user) throw new Error("Sign in required.");
  const { data: staff, error } = await db.from("staff_members").select("name").eq("id", user.id).maybeSingle();
  if (error || !staff) throw new Error("Your account has not been granted staff access.");
  const names: (keyof Workspace)[] = ["clients", "vessels", "vendors", "vendor_products", "kit_templates", "template_items", "kit_checks", "check_items", "batches", "quotes", "import_sources", "pricing_rules", "legacy_items", "invoices", "template_sell_prices"];
  let workflowReady=true;
  const entries = await Promise.all(names.map(async (name) => {
    const rows: unknown[] = [];
    for (let offset = 0; ; offset += 500) {
      const query = db.from(name).select("*");
      const ordered = name === "template_sell_prices" ? query.order("item_key").order("pack_key") : query.order("id");
      const { data, error } = await ordered.range(offset, offset + 499);
      if (error && name === "template_sell_prices" && ["42P01", "PGRST205"].includes(error.code)) return [name, undefined];
      if (error && ["import_sources", "pricing_rules", "legacy_items", "invoices"].includes(name) && ["42P01", "PGRST205"].includes(error.code)) {if(name!=="import_sources")workflowReady=false;return [name, []];}
      if (error) throw new Error(`Unable to load ${name}: ${error.message}`);
      rows.push(...(name === "batches" ? data.filter(row => !row.voided_at) : data));
      if (data.length < 500) break;
    }
    return [name, rows];
  }));
  return { ...Object.fromEntries(entries), workflow_ready: workflowReady, staff_profile: { name: staff.name, email: user.email } } as Workspace;
}
