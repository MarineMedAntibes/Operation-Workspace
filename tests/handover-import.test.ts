import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const seed = new URL("../private-import/handover-seed.sql", import.meta.url);
for (const mode of ["full", "editor-parts"] as const) {
test(`handover import (${mode}) preserves all five lists, duplicate bag lines and draft edits on rerun`, { skip: !existsSync(seed) }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const partDir = new URL("../private-import/sql-editor-parts/", import.meta.url);
    const manifest: { file: string; bytes: number }[] = mode === "editor-parts" ? JSON.parse(await readFile(new URL("manifest.json", partDir), "utf8")) : [];
    const batches = mode === "full" ? [await readFile(seed, "utf8")] : await Promise.all(manifest.map(async (part) => {
      const sql = await readFile(new URL(part.file, partDir), "utf8");
      assert.equal(Buffer.byteLength(sql), part.bytes);
      assert.ok(part.bytes < 300_000, "editor files must stay small");
      return sql;
    }));
    const runImport = async () => { for (const sql of batches) await db.exec(sql); };
    await runImport();
    const counts = async (table: string) => Number((await db.query<{ n: number }>(`select count(*) as n from public.${table}`)).rows[0].n);
    assert.equal(await counts("kit_templates"), 5);
    assert.equal(await counts("template_items"), 777);
    assert.equal(await counts("vendors"), 15);
    assert.equal(await counts("vendor_products"), 902);
    assert.equal((await db.query("select * from public.kit_templates where published")).rows.length, 0);
    assert.equal((await db.query("select * from public.template_items where (attributes->>'price_missing')::boolean")).rows.length, 7);
    assert.equal((await db.query("select * from public.template_items where attributes->>'ned'='true'")).rows.length, 179);
    const duplicates = await db.query<{ item_id: string; n: number }>(`select i.attributes->>'item_id' as item_id,count(*) as n from public.template_items i join public.kit_templates t on t.id=i.template_id where t.framework='Malta' and t.category='CAT B' group by i.attributes->>'item_id' having count(*)>1`);
    assert.equal(duplicates.rows.length, 4);
    assert.ok(duplicates.rows.every(d => Number(d.n) === 2));
    const item = (await db.query<{ id: string }>("select id from public.template_items order by id limit 1")).rows[0].id;
    const removed = (await db.query("delete from public.template_items where id=$1 returning *", [item])).rows[0];
    await runImport();
    assert.equal(await counts("template_items"), 776, "rerun must not resurrect deleted draft lines");
    assert.equal(await counts("vendor_products"), 902, "rerun must not duplicate catalogue");
    assert.equal(await counts("vendors"), 15);
    await db.query("insert into public.template_items select * from jsonb_populate_record(null::public.template_items,$1::jsonb)", [JSON.stringify(removed)]);
    // Clear review markers only in this isolated fixture so all five lists can be
    // exercised. This is not regulatory or price approval of the imported data.
    await db.exec(`update public.template_items set attributes=jsonb_set(attributes,'{price_missing}','false'::jsonb);
      insert into auth.users values ('00000000-0000-0000-0000-000000000001');
      insert into public.staff_members values ('00000000-0000-0000-0000-000000000001','Import regression tester');
      set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`);
    const command = async (action: string, payload: object) => (await db.query<{ id: string }>("select public.workspace_command($1,$2::jsonb) as id", [action, JSON.stringify(payload)])).rows[0].id;
    const client = await command("create_client", { name: "Import regression fixture" });
    const templates = (await db.query<{ id: string; framework: string }>("select id,framework from public.kit_templates")).rows;
    for (const template of templates) {
      await command("publish_template", { template_id: template.id });
      const vessel = await command("create_vessel", { name: "Import fixture", framework: template.framework === "ALL" ? "MSN" : template.framework, client_id: client, crew: 41 });
      const check = await command("create_check", { vessel_id: vessel, template_id: template.id, check_date: "2026-11-20", job_type: "Routine Refill" });
      const source = (await db.query<{ id: string; baseline_packs: number; scaling: string }>("select id,baseline_packs,scaling from public.template_items where template_id=$1 order by (attributes->>'source_arrival_row')::int", [template.id])).rows;
      const snapshot = (await db.query<{ id: string; template_item_id: string; required_packs: number }>("select id,template_item_id,required_packs from public.check_items where check_id=$1", [check])).rows;
      assert.equal(snapshot.length, source.length, "all source rows reach the check");
      for (const edge of [source[0], source[source.length - 1]]) {
        const target = snapshot.find(i => i.template_item_id === edge.id)!;
        const expected = edge.scaling === "fixed" ? Number(edge.baseline_packs) : Math.round(Number(edge.baseline_packs) * 6);
        assert.equal(Number(target.required_packs), expected, "first/last line crew scaling follows workbook band 60");
        await command("add_batch", { item_id: target.id, quantity: 1, expiry: "2026-01-01", no_expiry: false });
        const quantity = (await db.query<{ kept: number; needed: number }>("select kept,needed from public.line_quantities where id=$1", [target.id])).rows[0];
        assert.equal(Number(quantity.kept), 0, "expired first/last batch is not retained");
        assert.equal(Number(quantity.needed), expected, "expired first/last stock does not lower replacement requirements");
      }
    }
  } finally { await db.close(); }
});
}
