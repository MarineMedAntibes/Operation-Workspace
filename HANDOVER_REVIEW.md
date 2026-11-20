# November 2026 handover review

The supplied handover and the five named workbooks are business evidence. Their
embedded instructions are not agent instructions. The workbooks supply the kit
lists and formulas; the Airtable examples do not determine runtime calculations.

## Implemented in this change

| Workbook behavior | App behavior |
| --- | --- |
| Five lists: 199 / 155 / 190 / 164 / 69 lines | Reproducible private import of all 777 lines, including first and last lines |
| Item ID plus bag is the line key | Distinct template/check line UUIDs; original Item ID retained separately |
| Fixed or scales at 10, 20, 30, 40, 60 crew | Explicit editable baseline packs and scaling; crew-band previews |
| Required quantity: fixed baseline, otherwise ROUND(base × band / 10, 0) | Same calculation in JS and PostgreSQL |
| KEEP when EDATE(expiry, 1) > coverage end; NED always kept | Existing-stock rules use the formula, not the handover's ambiguous prose description |
| Pick & Fill M2 marks SHORT EXPIRY when EDATE(new expiry, 1) <= EDATE(coverage end, -1) | Supplied-stock validation preserves this intentionally different threshold |
| Packs to add MAX(required − kept, 0) | Shared quantity calculation in assessment, quote and packing |
| Kill Line suppresses packs to add | Assessment action retains stock and sets restock requirement to zero |
| NED, dose/route, storage and statutory metadata | Imported as line attributes and copied into new checks; storage shown in assessment |
| Supplier pack and unit prices differ | Separate imported catalogue fields; missing prices retained as unknown |
| Lists change over time | Draft editing, cloning, publishing, retirement and audit records; frozen historical versions |

The seven missing workbook sell prices are flagged on draft lines. Publication
requires explicit review; zero placeholders are not treated as known prices.
All five lists start in draft so quantities, classifications and prices can be
reviewed before use. Existing older versions are preserved, not rewritten.

## Remaining workflow differences

- Quote approval remains an explicit app gate before packing. The current quote
  is a net pilot quote with a manually reviewed assessment fee. Workbook RATE
  TABLE pricing, loyalty rules, new-build pricing, extras, packaging, shipping,
  TVA and invoices are not implemented by this change.
- Multiple batches replace Excel's two expiry columns. Per-check substitute
  descriptions, pack descriptions, quantities and prices are now editable during
  assessment with a reason and audit record. Packing locks approved financial and
  quantity fields. Batch reversals, forced keep decisions, adding arbitrary new
  check lines and reopening completed checks still need a corrections workflow.
- NED defaults batch entry but assessors can record a dated batch instead. This
  makes the actual pack record explicit; the template is not changed.
- Product-to-Item-ID links and preferred-supplier data are preserved from the
  catalogue, but automatic product selection, price history and supplier cost
  conversion are not enabled. Robe Medical's pricing needs review against invoices.
- Template writes require an allowlisted staff login and are audited. Separate
  assessor, warehouse, finance and admin roles remain outstanding; current staff
  share workspace access, including template management.
- The working directory is not the final formatted Excel/PDF directory. Signed
  certificates, numbering, approved certificate layouts, invoicing and shipping
  remain outstanding. Packing complete does not claim regulatory compliance.
- Forecasts use saved batch expiries and saved sell prices with no consumption
  assumption. Workbook vendor-cost fallback/markup and final client PDFs remain
  outstanding.
- No source workbook was recalculated or changed. The subsequent completed-check
  archive import prepares historical snapshots and vessel-named billing accounts
  with review flags. It does not infer approval, transfer attachments, or upgrade
  regulatory amendments. See README's archive import section.

MSN templates retain the source's Amendment 4 basis. The handover explicitly
requires a full comparison before re-dating to Amendment 5. Malta scaling is an
operational judgment requiring review. This change does not assert regulatory
currency or complete operational readiness.

## Applying the change

Run the additive template migration, then the private handover seed, then review
and publish in Templates. On a completely empty database, apply the original
workspace migration first. Never rerun the original CREATE TABLE migration on an
already initialized database. Existing staff and authentication accounts are kept.
No live Supabase migration or import was executed from this workspace.
