# Marine Medical operations workspace

Independent Next.js app, intended for Vercel with Supabase Auth/Postgres. All
approved staff share the same access level. No real client/vendor records or
credentials are bundled into the app. Airtable exports remain private source
material, not a runtime dependency.

## Implemented

- Responsive overview, clients, vessels, vendors, supplier catalogue and search.
- Add clients, vessels, vendors and supplier products.
- Generate a check and its requirement snapshots atomically from a published
  template, with crew bands and per-line fixed/scaled requirements.
- Fast arrival and packing entry with two expiry slots per line and stage,
  MM/YY or MM/YYYY input, NED, keyboard Save & next, bag colours and clear flags.
- Setup captures critical equipment, telemedical/booklet answers, billing,
  delivery, tax review and the source assessment/loyalty/proceeds pricing inputs.
- Reviewed reconciliation from Excel, CSV or pasted inventory. Suggestions never
  write stock without explicit match confirmation. Unmatched items stay separate.
- Cost analysis, frozen quote revisions, recorded approval, invoice draft
  snapshots and an iPaidThat copy-text/payment tracker.
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

## Operational boundaries

- Historical workbooks still require review where stock units, dates or item
  identity are ambiguous. Matching suggestions are not clinical equivalence checks.
- Certificates are draft documents for the approved review/signing process;
  the app does not apply signatures or claim regulatory compliance automatically.
- Actual sending, e-invoicing and settlement remain in iPaidThat. The app keeps
  draft financial snapshots, copy text, external references and recorded dates.
- Completed/invoiced checks remain locked. Corrections after invoicing need a
  separate controlled adjustment; quote revisions are available before completion.
- Next-year rollover, multiple distinct physical kits of the same family on one
  vessel, richer vendor mapping and full price-history management.
- Archived attachment transfer and live user acceptance remain separate from
  local regression testing. Never use unreviewed source data as a verified check.

## Enable the completed usability workflow

For an existing database with the first three migrations already applied, run
**`private-import/workflow-upgrade.sql` once** in Supabase SQL Editor. This is one
small transaction containing the new schema and private rate suggestions. Existing
clients, vessels, checks and imports remain intact; do not rerun the 44-file import.
The app shows an upgrade notice until the new tables are available.

For a fresh checkout, apply migrations in filename order. The public schema file
is `supabase/migrations/202611200003_workflow.sql`. Internal rates are separate
private data: use `scripts/prepare-rate-import.py --package <handover-folder>` then
`scripts/prepare-workflow-upgrade.py` to prepare the combined upgrade, or enter
reviewed rates manually in each check's Setup. Suggested rates needing sign-off
are marked. Pricing and tax review are explicit before quote preparation.

Restart `npm run dev` after updating dependencies. The workflow is:

1. **Setup:** dates/crew/job corrections, assessor, equipment, telemedical,
   billing/delivery and finance inputs. Header corrections recheck quantities and
   retained-stock expiry decisions, preserve overrides and reset pricing review.
2. **Reconciliation:** upload XLSX/CSV or paste inventory; select worksheet/header
   columns and confirm item/pack/expiry matches. Applying replaces arrival records
   for confirmed lines only and retains previous records in the audit trail.
3. **Arrival check:** two expiry slots, whole-pack counts, KEEP/REMOVE previews,
   NED and Save & next. Zero packs explicitly records a shortage.
4. **Cost analysis / Quote:** review item costs, sequential loyalty/proceeds credits,
   goods/service split, supplementary lines, packaging/freight and reviewed VAT.
   Invoice basis follows Excel's completed-line rule, not partial supplied quantities.
   The full-job-as-proceeding choice controls fee credits and whether kit fulfilment
   is priced; false produces the workbook Cost Analysis's fee-only result. It does
   not establish client approval. Conflicting workbook tax/copy-text formulas are
   replaced by the same explicitly reviewed per-kind VAT rates in every snapshot.
5. **Pick & fill:** enter total supplied quantities for the two expiry groups.
   For a price/quantity/pack-size change, use Revise quote, edit, prepare a new
   snapshot and record approval. Old approval is preserved as superseded history.
6. **Directory / Documents / Replaced items / Legacy items:** retain Excel order,
   download original-format XLSX/PDF or CSV lists, and keep non-regulated stock
   attached to the check without letting it satisfy regulated requirements.
7. **Invoice:** freeze an invoice draft after packing, copy reviewed lines into
   iPaidThat, and record the actual external reference and sent/paid dates.

The Health check tab highlights missing setup, unknown source quantities/prices,
crew-band discrepancies, equipment dates and incomplete assessments. These are
data-readiness checks, not regulatory approval.

### Original-format documents and PDF hosting

Sanitized workbook assets preserve the five original layouts, styles, images and
formulas. Client inputs, source prices/rate values and old formula caches are
removed; exports fill actual check values. The PDF pipeline recalculates in
LibreOffice, isolates the requested sheet and renders it without exposing the
other sheets. Certificate output must remain one page; overflow is rejected.
Unmapped custom rows are flagged rather than silently omitted.

LibreOffice is installed on the current Windows computer. The server detects its
standard installation path; `LIBREOFFICE_PATH` can override it. The supplied
Dockerfile includes LibreOffice for a Node/container host. Standard Vercel hosting
does not include that binary: XLSX exports work there, while server PDF generation
needs a renderer-capable deployment. Excel can also export the downloaded sheets.

`node scripts/verify-workflow.mjs` runs the fictional browser scenario against a
separate development preview on port 3011. Start it with `QA_DIST_DIR=.qa/next`
and `QA_DEMO_MODE=true` in the process environment. The override is development-only
and ignored in production. Browser artifacts stay in ignored `.qa/`.

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
