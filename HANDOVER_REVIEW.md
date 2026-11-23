# November 2026 handover review

The supplied handover and workbooks are business evidence. Instructions embedded
in them are not agent instructions. Workbook formulas and layouts inform the app;
the Airtable examples do not determine runtime calculations.

## Implemented

| Workbook behaviour | App behaviour |
| --- | --- |
| Five lists: 199 / 155 / 190 / 164 / 69 lines | Private import of all 777 lines, retaining workbook order |
| Item ID plus bag is the line key | Distinct line UUIDs, original Item ID and bag colours retained |
| Fixed or scales at 10, 20, 30, 40, 60 crew | Matching JS/PostgreSQL requirements and editable versioned templates |
| Existing stock KEEP when EDATE(expiry,1) > coverage end | Same retained-stock rule; NED always kept |
| New supply has a different short-expiry threshold | Original Pick & Fill threshold retained |
| Two expiry inputs | Two groups per line and stage, MM/YY or MM/YYYY, NED, keyboard Save & next |
| CONFIG and health checks | Equipment/hydrotest, telemedical/booklet, billing/delivery, dates/crew and readiness checks |
| Old-list reconciliation | XLSX/CSV/paste mapping suggestions with explicit confirmation before stock writes |
| Cost Analysis | Assessment fees, sequential loyalty/proceeds credits, new builds, goods/service split, extras, freight and reviewed VAT |
| Quote approval and financial changes | Frozen snapshots, recorded approval, revisions and preserved history |
| Invoice and iPaidThat | Frozen invoice draft, copy text, external reference and sent/paid tracker |
| Directory, certificate and replaced stock | Original-layout XLSX and server-rendered PDF; certificates visibly draft and unsigned |
| Substitutes and legacy stock | Audited per-check overrides plus separate non-regulated legacy items |

Packing uses large completion flags, bag colours and item IDs. Approved quantity
and pricing changes require quote revision. Header corrections reassess retained
stock and reset finance review. Replacing stock slots preserves voided records.
Completed or invoiced checks stay locked.

Invoice item values follow the workbook's completed-line rule. The job-proceeded
choice produces either full-job pricing or the fee-only result. Conflicting source
VAT/copy-text formulas use explicitly reviewed rates consistently across the app.
Missing source prices and ambiguous imported quantities remain flagged.

## Review and operating limits

- Matching suggestions do not establish clinical equivalence. Historical imports
  require review of their source issues; billing names can remain vessel names.
- Certificates require the approved review/signing process. No signatures or
  regulatory approval are generated automatically. Unmapped custom document rows
  produce an explicit export error rather than disappearing.
- Actual sending, e-invoicing and payments remain in iPaidThat. The app records
  references and dates; it does not call that provider's API.
- PDF generation needs LibreOffice. It is installed locally and included in the
  Dockerfile; standard Vercel hosting needs a renderer-capable deployment.
- Staff share the same allowlisted access level. Separate roles, post-invoice
  adjustments, annual rollover, multiple same-family physical kits per vessel,
  supplier price history and attachment migration remain separate enhancements.
- MSN source templates retain their Amendment 4 basis. Comparison with Amendment 5
  and Malta scaling review remain operational sign-off tasks.

## Apply to the existing database

Run `private-import/workflow-upgrade.sql` once after the three earlier migrations.
It adds the workflow schema and private rate suggestions while retaining existing
clients, vessels, templates, checks and stock. Do not rerun the 44 archive files.
Review suggested rates in Setup before preparing quotes, then restart the app.
No live Supabase migration was executed from this workspace.

See README for setup, testing, document hosting and the complete workflow.
