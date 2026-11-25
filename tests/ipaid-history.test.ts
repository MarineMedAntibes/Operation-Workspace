import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { prepareIpaidWorkbook } from "../src/lib/ipaid-import";

test("iPaidThat import preserves source history and safely retries client linking", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    for (const name of ["202610270001_workspace.sql", "202611200001_templates.sql", "202611200002_check_edits.sql", "202611200003_workflow.sql", "202611250004_ipaid_history.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
    }
    const staff = "00000000-0000-0000-0000-000000000001";
    await db.exec(`insert into auth.users values ('${staff}'); insert into public.staff_members values ('${staff}','Staff');
      insert into public.clients(name,email,attributes) values ('Existing Contact','match@example.com','{"active_season":"2027"}');
      set role authenticated;`);
    const batch_id = "a".repeat(64);
    const input = prepareIpaidWorkbook([{ name: "Clients", rows: [
      ["Client ID", "Client name", "Email", "Review"],
      ["source-1", " Existing  Contact ", "MATCH@example.com"], ["source-2", "New Contact", "new@example.com"],
      ["source-3", "Needs review", "", "Source review"], ["source-4", "Existing Contact name variant", "match@example.com"],
    ] }, { name: "Documents", rows: [
      ["Client ID", "Client", "Type", "Number", "Issue date", "Total TTC", "Paid?", "Overdue?"],
      ["source-1", "Existing Contact", "Facture", "INV-1", "46000", "123,45", "Non", "Oui"],
      ["source-3", "Needs review", "Facture", "INV-1", "2026-02-10", "50", "Oui", "Non"],
    ] }]);
    assert.equal(input.reviewClients, 3, "shared emails are flagged for both rows");
    input.clients[0].review_reason = null;
    const command = (action: string, payload: object = {}) =>
      db.query("select public.workspace_ipaid_import($1,$2::jsonb)", [action, JSON.stringify({ batch_id, ...payload })]);
    await assert.rejects(command("start", { filename: "fictional.xlsx", clients: 4, documents: 2 }), /Staff access required/);
    await db.exec(`set request.jwt.claim.sub='${staff}';`);
    await command("start", { filename: "fictional.xlsx", clients: 4, documents: 2 });
    await command("clients", { rows: input.clients });
    await assert.rejects(command("finish"), /Import incomplete/);
    await command("documents", { rows: input.documents });
    await command("finish");
    await command("clients", { rows: input.clients });
    await command("finish");
    assert.deepEqual((await db.query("select name,attributes->>'active_season' as season from public.clients order by name")).rows,
      [{ name: "Existing Contact", season: "2027" }, { name: "New Contact", season: null }]);
    assert.equal((await db.query("select id from public.invoices")).rows.length, 0);
    assert.equal((await db.query("select id from public.kit_checks")).rows.length, 0);
    assert.equal((await db.query("select source_row from public.ipaid_document_history")).rows.length, 2);
    assert.equal((await db.query("select source_id from public.ipaid_client_history where client_id is null")).rows.length, 2);
    await command("create_client", { source_id: "source-3" });
    await assert.rejects(command("create_client", { source_id: "source-3" }), /already linked/);
  } finally { await db.close(); }
});
