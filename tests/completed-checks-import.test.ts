import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const parts = new URL("../private-import/completed-checks/", import.meta.url);
test("historical archive import preserves source evidence, requires review and safely reruns", { skip: !existsSync(new URL("manifest.json", parts)) }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    const migrationDir = new URL("../supabase/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).filter(f => f.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(filename, migrationDir), "utf8"));
    const manifest: { file: string; bytes: number }[] = JSON.parse(await readFile(new URL("manifest.json", parts), "utf8"));
    const sql = await Promise.all(manifest.map(async f => {
      const body = await readFile(new URL(f.file, parts), "utf8");
      assert.equal(Buffer.byteLength(body), f.bytes);
      assert.ok(f.bytes < 280_000, "every editor file stays below 280KB");
      return body;
    }));
    const run = async () => { for (const s of sql) await db.exec(s); };
    await run();
    const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*) as n from public.${table}`)).rows[0].n);
    assert.equal(await count("clients"), 16);
    assert.equal(await count("vessels"), 13);
    assert.equal(await count("kit_checks"), 14);
    assert.equal(await count("check_items"), 2302);
    assert.equal(await count("batches"), 419);
    assert.equal(await count("import_sources"), 83);
    assert.equal(await count("quotes"), 0, "source archive does not establish client quote approval");
    assert.equal((await db.query("select * from public.kit_checks where status='complete'")).rows.length, 0);
    assert.equal((await db.query("select * from public.kit_checks where attributes->>'review_required'='true'")).rows.length, 14);
    assert.equal((await db.query("select * from public.kit_templates where published")).rows.length, 0, "historical snapshots never replace current master lists");
    assert.equal((await db.query("select * from public.check_items where attributes->>'requirement_unknown'='true'")).rows.length, 3);
    const malahne = (await db.query<{ crew: number; attributes: { source_crew_band: number; issues: string[] } }>("select c.* from public.kit_checks c join public.vessels v on v.id=c.vessel_id where v.name='MALAHNE'")).rows[0];
    assert.equal(malahne.crew, 10);
    assert.equal(malahne.attributes.source_crew_band, 20);
    assert.ok(malahne.attributes.issues.some(i => i.includes("after archive review date")));
    assert.ok(malahne.attributes.issues.some(i => i.includes("cached band")));
    assert.equal((await db.query("select * from public.clients where name='EDMISTON'")).rows.length, 0, "management company is not inferred to be the billing client");
    for (const vessel of ["TAHI", "ARIONAS", "AVENTURA"]) {
      assert.equal((await db.query("select * from public.clients where name=$1", [vessel])).rows.length, 1);
      assert.ok((await db.query("select * from public.import_sources where vessel_name=$1 and status='needs_review'", [vessel])).rows.length > 0);
      assert.equal((await db.query("select * from public.vessels where name=$1", [vessel])).rows.length, 0, "missing dates/crew are not invented for legacy sources");
    }
    const item = (await db.query<{ id: string }>("select id from public.check_items order by id limit 1")).rows[0].id;
    await db.query("update public.check_items set description='Operator correction' where id=$1", [item]);
    await run();
    assert.equal(await count("kit_checks"), 14);
    assert.equal(await count("batches"), 419);
    assert.equal((await db.query<{ description: string }>("select description from public.check_items where id=$1", [item])).rows[0].description, "Operator correction");
    const check = (await db.query<{ id: string }>("select id from public.kit_checks order by id limit 1")).rows[0].id;
    await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-000000000001');
      insert into public.staff_members values ('00000000-0000-0000-0000-000000000001','Import tester');
      set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`);
    await assert.rejects(() => db.query("select public.workspace_command('create_quote',$1::jsonb)", [JSON.stringify({ check_id: check, assessment_fee: 0 })]), /imported workbook issues/);
    await db.exec("set request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';");
    assert.equal((await db.query("select * from public.import_sources")).rows.length, 0);
  } finally { await db.close(); }
});
