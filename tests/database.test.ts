import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("Postgres migration, staff-only access, quote gate and atomic staged packing", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;`);
    await db.exec(await readFile(new URL("../supabase/migrations/202610270001_workspace.sql", import.meta.url), "utf8"));
    const staff = "00000000-0000-0000-0000-000000000001";
    const outsider = "00000000-0000-0000-0000-000000000002";
    await db.exec(`insert into auth.users values ('${staff}'),('${outsider}'); insert into public.staff_members values ('${staff}','Test Staff');`);
    const template = (await db.query<{ id: string }>(`insert into public.kit_templates(name,framework,category,version,published) values ('Test','MSN','CAT B','v1',true) returning id`)).rows[0].id;
    await db.query(`insert into public.template_items(template_id,source_code,description,baseline_packs,scaling,unit_price) values ($1,'TEST','Test equipment',2,'fixed',10)`, [template]);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${outsider}';`);
    assert.equal((await db.query("select * from public.kit_templates")).rows.length, 0);
    await assert.rejects(() => db.query("select public.workspace_command('create_client',$1::jsonb)", [JSON.stringify({ name: "Not allowed" })]), /Staff access required/);
    await db.exec(`set request.jwt.claim.sub='${staff}';`);
    const command = async (action: string, payload: object) => (await db.query<{ id: string }>("select public.workspace_command($1,$2::jsonb) as id", [action, JSON.stringify(payload)])).rows[0].id;
    const client = await command("create_client", { name: "Test Client" });
    const vessel = await command("create_vessel", { name: "Test Vessel", client_id: client, framework: "MSN", crew: 10 });
    const check = await command("create_check", { vessel_id: vessel, template_id: template, check_date: "2026-09-18", job_type: "Routine Refill" });
    const item = (await db.query<{ id: string }>("select id from public.check_items where check_id=$1", [check])).rows[0].id;
    await assert.rejects(() => db.query("update public.kit_checks set status='complete' where id=$1", [check]), /permission denied/);
    await assert.rejects(() => command("create_quote", { check_id: check, assessment_fee: 0 }), /Review every assessment/);
    await command("mark_assessed", { item_id: item, state: "reviewed" });
    await command("create_quote", { check_id: check, assessment_fee: 15 });
    assert.equal(Number((await db.query<{ subtotal: number }>("select subtotal from public.quotes")).rows[0].subtotal), 35);
    await assert.rejects(() => command("add_batch", { item_id: item, quantity: 1, no_expiry: true }), /locked/);
    await command("approve_quote", { check_id: check });
    await assert.rejects(() => command("add_batch", { item_id: item, quantity: 3, no_expiry: true }), /exceeds/);
    assert.equal((await db.query("select * from public.batches")).rows.length, 0);
    await command("add_batch", { item_id: item, quantity: 1, expiry: "2028-01-01" });
    await assert.rejects(() => command("finish", { check_id: check }), /Outstanding/);
    await command("add_batch", { item_id: item, quantity: 1, no_expiry: true });
    await command("finish", { check_id: check });
    assert.equal((await db.query<{ status: string }>("select status from public.kit_checks where id=$1", [check])).rows[0].status, "complete");
    await db.exec(`set request.jwt.claim.sub='${outsider}';`);
    assert.equal((await db.query("select * from public.clients")).rows.length, 0);
    assert.equal((await db.query("select * from public.line_quantities")).rows.length, 0);
    const seedFile = new URL("../private-import/seed.sql", import.meta.url);
    if (existsSync(seedFile)) {
      await db.exec("reset role;");
      await db.exec(await readFile(seedFile, "utf8"));
      const report = JSON.parse(await readFile(new URL("../private-import/report.json", import.meta.url), "utf8"));
      for (const [table, count] of Object.entries(report.prepared_counts)) {
        const testOffset = ["clients", "vessels", "kit_templates", "template_items"].includes(table) ? 1 : 0;
        const actual = (await db.query<{ count: number }>(`select count(*)::integer as count from public.${table}`)).rows[0].count;
        assert.equal(actual, Number(count) + testOffset, `Private import count mismatch: ${table}`);
      }
    }
  } finally { await db.close(); }
});
