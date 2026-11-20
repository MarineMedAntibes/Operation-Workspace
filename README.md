# Marine Medical workspace — first working slice

Independent Next.js app, intended for Vercel with Supabase Auth/Postgres. All
approved staff share the same access level. No real client/vendor records or
credentials are bundled into the app. Airtable exports remain private source
material, not a runtime dependency.

## Implemented

- Responsive overview, clients, vessels, vendors, supplier catalogue and search.
- Add clients, vessels, vendors and supplier products.
- Generate a check and its requirement snapshots atomically from a published
  template, with crew bands and per-line fixed/scaled requirements.
- Record multiple existing batches, expiry decisions and explicit line review.
- Prepare a **net pilot quote**, record client approval and unlock packing.
- Record partial supply over multiple sessions; block excess supply and premature
  completion. Working directory shows retained plus supplied stock.
- Forecast from the latest completed medical check per vessel/framework/category,
  with a month filter, separate visit/coverage horizons, no consumption assumption,
  and saved-price estimates.
- Staff allowlist, row-level security, server validation, transactional database
  commands, and an audit record for each successful command.
- Templates workspace: clone or create drafts, edit/add/delete lines, preview all
  five crew bands, publish and retire versions. Published/used versions are frozen;
  new checks snapshot their line metadata, quantities and prices.
- Per-check Kill Line stops restocking while preserving retained stock. Template
  NED and storage flags are carried into checks; NED defaults batch entry to no expiry.
- Per-check line editing and substitute descriptions, with required reasons and
  original values retained in the audit trail. Assessment quantity/price changes
  never edit a master template. Packing keeps approved quantity, pack and price
  fixed; completed checks stay locked.
- Reviewed archive import preparation, source-file register and visible import
  issues. Vessel names can be interim billing client names without inferring owners.

## Still to implement before operational use

- Client/vessel editing, batch corrections/reversals, reopening completed checks
  with quote revisions, and assessed not-applicable controls in UI.
- Legacy-format reconciliation and resolution of ambiguous quantities, expiries
  and source dates. Imported workbook snapshots require explicit review before
  operational use; source files do not establish quote approval or certification.
- Additional equipment/oxygen inspections and service dates.
- Automatic assessment/loyalty/proceeds pricing, new-build pricing, extras,
  tax, shipping/packaging, customer-ready quotes, quote revisions and invoices.
  The source price book remains in the reference archive; the pilot explicitly
  asks for a reviewed net assessment fee instead of guessing.
- Certificate issuance, signatures, unique numbering, stored document snapshots,
  PDFs and pickup/shipping tracking. A printable working directory is included;
  **medical packing complete is not overall compliance or certificate issuance**.
- Next-year rollover, multiple distinct physical kits of the same family on one
  vessel, richer vendor mapping and full price-history management.
- Storage transfer of archived attachments, live Supabase integration verification,
  live user acceptance and browser/device QA.

## Local fictional preview

```powershell
# Run from this repository's root directory.
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open the URL printed by Next.js. With no Supabase credentials, `DEMO_MODE=true`
enables a development-only preview with fictional records: 5 clients, 7 vessels,
4 vendors, 18 supplier catalogue products and 6 checks. The shortened demonstration
templates are illustrative and do not represent complete regulatory kit lists.

Try these examples:

| Vessel | Starting point | What to try |
| --- | --- | --- |
| Northern Light | Partly assessed | Review retained/expired dressing batches, add more existing stock and confirm the remaining lines. |
| Blue Meridian | Awaiting approval | Review its net quote and record approval to unlock packing. |
| Calypso | Partly packed | Expand batch records to see separate deliveries, then supply outstanding quantities. |
| Aurora | Approved, awaiting packing | Start recording the first supplied batches. |
| Solstice | Medical packing complete | Open its working directory and see next September's replacements in Forecast. |
| Tide Runner | Medical packing complete | Inspect retained/new stock and next October's replacement estimates. |
| Fairwind | No check yet | Start a new check from either demonstration template. |

Changes persist
only in sessionStorage; Reset preview removes them. Demo mode is never served
in production, even if the variable is set. A production app without Supabase
configuration shows a setup message, not a public demo or private records.

## Connect Supabase

1. Create a new Supabase project. Apply
   `supabase/migrations/202610270001_workspace.sql` as the database owner.
   Avoid applying it blindly to a project that already has conflicting tables.
2. Set these in `.env.local` and later in Vercel environment variables:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   ```

3. Create/invite staff accounts using Supabase Auth. Password sign-in is used in
   this slice; create test credentials through the dashboard or the Auth admin
   tools. The in-app invite/reset flow is not yet implemented. Never put a secret
   or service-role key into a NEXT_PUBLIC variable.
4. Grant each staff account workspace access as database owner:

   ```sql
   insert into public.staff_members (id, name)
   values ('UUID_FROM_AUTH_USERS', 'Staff name');
   ```

   Auth accounts not listed here cannot read or mutate workspace data. This is
   shared organization access, not per-user record ownership. Anonymous access
   is disabled. Do not enable unrestricted public signup as an access mechanism.

5. Disable DEMO_MODE or leave it unset. Restart the local server after changing
   environment variables, sign in, and verify the real database connection.

## Prepare and review initial data

### November handover: current templates and vendor catalogue

For the current five Excel templates, use the handover import instead of the old
two-template Airtable seed. Do not load both reference-data seeds into a fresh DB.
The handover's Airtable exports are examples, not live client or vessel data.

1. On an existing app database, run only the additive migration
   `supabase/migrations/202611200001_templates.sql` as database owner. On a fresh
   database, run `202610270001_workspace.sql` first, then the new migration.
2. Run the prepared private `private-import/handover-seed.sql` in Supabase SQL
   Editor as database owner. Read `private-import/handover-report.json` first.
   This contains five draft templates (777 lines), vendor records and 902 catalogue
   entries. It does not import clients, vessels or completed assessments.
   If the full SQL exceeds the editor limit, use the numbered SQL files listed in
   `private-import/sql-editor-parts/READ-ME.txt` instead, in order. Each file is a
   complete transaction; run each file whole and wait for success before the next.
   These parts keep all app fields and omit only redundant raw worksheet-cell
   copies retained in the full seed and source workbooks. Do not run both formats.
3. Restart the app and open **Templates**. Review each imported version and its
   source metadata, then publish it. Seven workbook lines have missing sell prices:
   these are flagged and publication is blocked until a reviewed price is entered.
   A zero entered explicitly is accepted; missing source prices are never inferred
   from vendor costs.
4. To revise a published list, choose **New template / version**, clone it, give
   the draft a unique version identifier, edit and publish. Publication replaces
   the active version in that framework/category. Existing checks stay unchanged.

To regenerate the private import from an extracted package:

```powershell
python scripts/import-handover.py --package "C:\path\to\MMA_Kit_Check_Developer_Handover_Package"
```

The importer reads stored workbook constants and formulas separately, verifies
the expected Arrival/Pick line alignment, and preserves duplicate Item IDs with
distinct line keys. Pack costs and unit costs remain separate. Source hashes,
original IDs, sheet rows, statutory sections and source cells are retained for
traceability. Vendor catalogue matching is source metadata, not a substitute for
reviewed product selection or regulatory sign-off.

The workbook data retains its stated regulatory basis. It has not been promoted
to MSN Amendment 5 or otherwise certified as current by this import. See
`HANDOVER_REVIEW.md` for the workflow comparison and remaining differences.

### Older Airtable preparation (superseded reference-data path)

From the parent of the app directory (the legacy private archive layout):

```powershell
python web/scripts/prepare-import.py
```

This reads `airtable-export/` and `template-reference.json`, writes private
`web/private-import/seed.sql` and `report.json`, and never connects to a service.
The output directory must be new. Initial preparation produced 7 clients,
2 vessels, 16 vendors, 902 supplier products, 2 MSN templates and 354 template
lines. Raw source IDs are retained for CRM/catalogue traceability; deterministic
UUIDs make an unchanged seed safe to rerun without duplicating rows. Rerunning
does not update existing records or overwrite staff edits.

Review the report and SQL before applying the seed as database owner. Missing or
ambiguous data is reported, not silently filled with invented relationships.
Older records, existing operational checks, reference tables and attachments stay
in the original archive until their reviewed migration is implemented.

Never commit `private-import/`, `airtable-export/` or environment files. The root
`.gitignore` excludes them. The seed contains real business data and is not served
by Next.js. It is separate from the shareable schema migration and demo fixtures.

## Importing the completed-check archive

The supplied `OneDrive_2026-11-20.zip` contains current workbooks, older variants,
supporting documents and legacy inventories. The prepared import is private and
has not been applied to live Supabase from this workspace.

1. Apply **only** `supabase/migrations/202611200002_check_edits.sql` after the two
   earlier migrations. Do not rerun the earlier CREATE TABLE migrations.
2. Read `private-import/completed-checks-issues.txt` and
   `private-import/completed-checks-report.json`.
3. Run the numbered files listed in
   `private-import/completed-checks/READ-ME.txt`, in order, in Supabase SQL Editor.
   Each file is a standalone transaction under 280 KB. The offline
   `IMPORT-HELPER.html` in that directory provides a copy button for each file;
   it does not connect to Supabase or verify execution.
4. Refresh the app. Inspect **Clients**, **Kit checks** and **Import review**.
   Each imported check shows its source and outstanding issues. Record the import
   review with a reason; resolve unknown line quantities/prices explicitly before
   preparing a quote. Acknowledgment does not manufacture missing stock or approvals.

The import prepares 16 vessel-named billing clients, 13 vessels and 14
current-format checks with 2,302 lines and 419 unambiguous batch records. Fauda has
separate CAT A and CAT B checks. All 14 checks remain in assessment because source
evidence is incomplete or conflicting. No approved quotes or certificates are
invented. Historical source-specific templates stay frozen and unpublished;
they do not replace the current master lists. Matching existing clients/vessels
are reused without overwriting operator changes; reruns skip imported checks.

Tahi, Arionas and Aventura get billing accounts and source-register records. Their
legacy sheets lack enough unambiguous date/crew/line mapping to create verified
current-format checks. Supporting PDFs/DOCX and auxiliary first-aid/oxygen files
are registered as sources; binary attachments are not uploaded or served by the app.

To regenerate (requires Python `openpyxl`):

```powershell
python scripts/import-completed-checks.py --archive "C:\path\to\OneDrive_2026-11-20.zip"
python scripts/make-import-helper.py private-import/completed-checks
```

For a substitute, open a check in **Assessment** or **Pick & pack**, then choose
**Edit / substitute** on the line. Enter the alternate product and reason (sourcing
issue, client request, etc.). Leave the alternate description blank to restore the
original description. During packing, the approved pack size, quantity and price
remain fixed and the saved quote snapshot is unchanged. Quantity/price revisions
after approval and corrections to completed checks need a separate revision flow.

## Vercel

Push only the reviewed source to a private Git repository. Create a Vercel project
with **Root Directory `.`** (the repository root), framework **Next.js**, and build command
`npm run build`. Set the Supabase variables for each intended environment. Keep
preview deployments on a separate test Supabase project rather than write to
production client data. Configure the production Site URL in Supabase Auth.

No Vercel deployment or live Supabase changes have been made by this build.
The Sites skill was consulted, but this app deliberately uses the user's requested
Vercel/Supabase architecture rather than Sites hosting.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

The tests exercise real PostgreSQL in a local PGlite instance with Supabase Auth
stubs, including staff access/RLS, direct-write rejection, transactional workflow,
quote approval and partial packing. If private seed files exist, the same test
loads them and verifies prepared counts. This does not replace a live Supabase
test, concurrency testing or user acceptance. Rule tests cover calendar boundaries,
crew scaling and the fictional end-to-end workflow.
