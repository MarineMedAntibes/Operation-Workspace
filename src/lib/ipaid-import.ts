type Sheet = { name: string; rows: string[][] };
type SourceFields = Record<string, string>;
export type IpaidClient = {
  source_id: string; name: string; email: string | null; phone: string | null; address: string | null;
  review_reason: string | null; details: SourceFields;
};
export type IpaidDocument = {
  source_row: number; source_id: string; client_name: string; kind: string; number: string; label: string | null; status: string | null;
  issued_on: string | null; total_ex_vat: string | null; vat: string | null; total_inc_vat: string | null;
  paid: boolean | null; overdue: boolean | null; details: SourceFields;
};

function records(sheets: Sheet[], name: string, required: string[]) {
  const sheet = sheets.find(sheet => sheet.name.toLowerCase() === name.toLowerCase());
  if (!sheet || required.some(field => !sheet.rows[0]?.includes(field))) throw new Error(`Missing required columns in the ${name} sheet.`);
  const [headers, ...rows] = sheet.rows;
  return rows.flatMap((row, index) => row.some(value => value.trim()) ? [{
    row: index + 2,
    fields: Object.fromEntries(headers.flatMap((header, column) => header && row[column]?.trim() ? [[header, row[column].trim()]] : [])),
  }] : []);
}

function occurrences(values: string[]) {
  const counts = new Map<string, number>();
  for (const key of values) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const key = (value?: string) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const validEmail = (value?: string) => !!value && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
const docKey = (fields: SourceFields) => JSON.stringify([key(fields.Type), key(fields.Number)]);
const boolean = (value?: string) => /^(oui|yes|true|1)$/i.test(value ?? "") ? true : /^(non|no|false|0)$/i.test(value ?? "") ? false : null;

function date(value?: string) {
  if (!value) return null;
  const raw = /^\d{5}(?:\.\d+)?$/.test(value)
    ? new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(value)) * 86_400_000).toISOString().slice(0, 10) : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(raw + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function amount(value?: string) {
  if (!value) return null;
  const plain = value.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(plain) ? plain : null;
}

export function prepareIpaidWorkbook(sheets: Sheet[]) {
  const clientRows = records(sheets, "Clients", ["Client ID", "Client name", "Email"]);
  const documentRows = records(sheets, "Documents", ["Client ID", "Client", "Type", "Number", "Issue date", "Total TTC"]);
  if (!clientRows.length || clientRows.length > 25_000 || documentRows.length > 50_000) throw new Error("Unexpected workbook size.");
  const clientIds = occurrences(clientRows.map(({ fields }) => fields["Client ID"]));
  const names = occurrences(clientRows.map(({ fields }) => key(fields["Client name"])));
  const emails = occurrences(clientRows.map(({ fields }) => key(fields.Email)));
  const references = occurrences(documentRows.map(({ fields }) => docKey(fields)));
  const clients: IpaidClient[] = clientRows.map(({ row, fields }) => {
    const id = fields["Client ID"];
    const name = fields["Client name"];
    if (!id || !name || clientIds.get(id) !== 1) throw new Error(`Clients row ${row} needs a unique client ID and name.`);
    const email = validEmail(fields.Email) ? fields.Email : null;
    const reasons = [
      (fields.Review || fields["Dup group"]) && "Source duplicate/review flag",
      (names.get(key(name)) ?? 0) > 1 && "Repeated source name",
      (emails.get(key(email ?? undefined)) ?? 0) > 1 && "Shared source email",
      !email && "Missing or invalid primary email",
      fields["Email issues"] && "Source email issue",
    ].filter(Boolean);
    return {
      source_id: id, name, email, phone: fields.Phone || null,
      address: [fields.Address, [fields.Postcode, fields.City].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
      review_reason: reasons.join("; ") || null, details: fields,
    };
  });
  const docs: IpaidDocument[] = documentRows.map(({ row, fields }) => {
    const sourceId = fields["Client ID"];
    if (!clientIds.has(sourceId) || !fields.Type || !fields.Number) throw new Error(`Documents row ${row} has an unknown client, missing type or missing number.`);
    const details = { ...fields };
    if ((references.get(docKey(fields)) ?? 0) > 1) details["Import review"] = "Document reference reused in the source export";
    const issued_on = date(fields["Issue date"]);
    if (!issued_on || (fields["Total TTC"] && amount(fields["Total TTC"]) === null)) {
      details["Import review"] = [details["Import review"], "Date or total needs review"].filter(Boolean).join("; ");
    }
    return {
      source_row: row, source_id: sourceId, client_name: fields.Client || clients.find(client => client.source_id === sourceId)!.name,
      kind: fields.Type, number: fields.Number, label: fields.Label || null, status: fields.Status || null, issued_on,
      total_ex_vat: amount(fields["Total HT"]), vat: amount(fields.VAT), total_inc_vat: amount(fields["Total TTC"]),
      paid: boolean(fields["Paid?"]), overdue: boolean(fields["Overdue?"]), details,
    };
  });
  return { clients, documents: docs, reviewClients: clients.filter(client => client.review_reason).length,
    reviewDocuments: docs.filter(document => document.details["Import review"]).length };
}
