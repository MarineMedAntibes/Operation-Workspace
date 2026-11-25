import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const recovery = new URL("../private-import/recover-andiamo.sql", import.meta.url);
test("Andiamo recovery creates missing source before check and safely reruns", {skip: !existsSync(recovery)}, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter(n => n.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(name,dir),"utf8"));
    const original = await readFile(new URL("../private-import/completed-checks/22-andiamo-cat-b-check.sql",import.meta.url),"utf8");
    await assert.rejects(() => db.exec(original), /kit_checks_template_id_fkey/);
    await db.exec("rollback;");
    const sql = await readFile(recovery,"utf8");
    assert.ok(Buffer.byteLength(sql)<280_000);
    await db.exec(sql);
    const count = async (table:string) => Number((await db.query<{n:number}>(`select count(*) as n from public.${table}`)).rows[0].n);
    assert.equal(await count("kit_templates"),1);
    assert.equal(await count("template_items"),155);
    assert.equal(await count("kit_checks"),1);
    assert.equal(await count("check_items"),155);
    await db.exec(sql);
    assert.equal(await count("kit_checks"),1);
    assert.equal(await count("check_items"),155);
  } finally { await db.close(); }
});
