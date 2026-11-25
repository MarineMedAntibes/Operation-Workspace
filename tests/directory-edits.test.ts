import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("staff can edit directory records and link a new contact atomically", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    const staff = "00000000-0000-0000-0000-000000000001";
    await db.exec(`insert into auth.users values ('${staff}');
      insert into public.staff_members values ('${staff}','Staff'); set role authenticated;`);
    async function command(action: string, payload: object, standard = false) {
      const rpc = standard ? "workspace_command" : "workspace_directory_command";
      return (await db.query<{ id: string }>(`select public.${rpc}($1, $2::jsonb) as id`, [action, JSON.stringify(payload)])).rows[0].id;
    }
    const vesselFields = { name: "Vessel", framework: "MSN", crew: 10 };
    await assert.rejects(command("create_vessel", vesselFields), /Staff access required/);
    await db.exec(`set request.jwt.claim.sub='${staff}'`);
    const vessel = await command("create_vessel", vesselFields);
    assert.equal((await db.query<{ client_id: string | null }>("select client_id from public.vessels where id=$1", [vessel])).rows[0].client_id, null);
    await assert.rejects(command("update_vessel", { ...vesselFields, id: vessel, crew: 61, new_client: { name: "Rolled back" } }), /violates check constraint/);
    assert.equal((await db.query("select id from public.clients")).rows.length, 0);
    await command("update_vessel", { ...vesselFields, id: vessel, new_client: { name: "Management" } });
    const { client_id } = (await db.query<{ client_id: string }>("select client_id from public.vessels where id=$1", [vessel])).rows[0];
    await command("update_client", { id: client_id, name: "Management Co", active_season: "2027" });
    assert.deepEqual((await db.query("select name, attributes from public.clients")).rows, [{ name: "Management Co", attributes: { active_season: "2027" } }]);
    const vendor = await command("create_vendor", { name: "Vendor" }, true);
    await command("update_vendor", { id: vendor, name: "Updated Vendor" });
    await db.exec("reset role");
    const imported = (await db.query<{ id: string }>(
      "insert into public.vendor_products(description, attributes) values ('Imported product', '{\"mma_article_number\":\"MMA-000001\"}') returning id",
    )).rows[0].id;
    await db.exec("set role authenticated");
    const product = await command("create_vendor_product", { vendor_id: vendor, description: "Product", price: 10 }, true);
    await command("update_vendor_product", { id: product, vendor_id: vendor, description: "Updated Product", price: null });
    assert.deepEqual((await db.query("select description, price, attributes from public.vendor_products where id=$1", [product])).rows,
      [{ description: "Updated Product", price: null, attributes: { review_required: true } }]);
    const items = await db.query<{ catalogue_item_id: string | null; imported_id: string | null }>(
      "select catalogue_item_id, attributes->>'mma_article_number' as imported_id from public.vendor_products order by description",
    );
    assert.deepEqual(items.rows, [{ catalogue_item_id: null, imported_id: "MMA-000001" }, { catalogue_item_id: "MMA-000002", imported_id: null }]);
    async function catalogue(action: string, payload: object) {
      return (await db.query<{ id: string }>("select public.workspace_catalogue_command($1,$2::jsonb) as id", [action, JSON.stringify(payload)])).rows[0].id;
    }
    const code = { framework: "MSN", code: "Item 01", role: "preferred" };
    await catalogue("save_catalogue_product_code", { ...code, product_id: product });
    await assert.rejects(catalogue("save_catalogue_product_code", { ...code, code: "  item  01  ", product_id: imported }), /already has a preferred/);
    const alternative = await catalogue("save_catalogue_product_code", { ...code, product_id: imported, role: "alternative" });
    await catalogue("save_catalogue_product_code", { ...code, framework: "Malta", product_id: imported });
    await catalogue("unlink_catalogue_product_code", { link_id: alternative });
    assert.equal((await db.query("select id from public.catalogue_product_codes")).rows.length, 2);
    assert.equal((await db.query("select id from public.vendor_products")).rows.length, 2);
  } finally {
    await db.close();
  }
});
