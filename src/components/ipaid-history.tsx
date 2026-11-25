"use client";

import { useEffect, useState } from "react";
import type { Client } from "@/lib/types";
import { prepareIpaidWorkbook, type IpaidClient, type IpaidDocument } from "@/lib/ipaid-import";
import { readXlsxSheets } from "@/lib/reconciliation";

type Batch = { id: string; filename: string; expected_clients: number; expected_documents: number };
type ClientRow = IpaidClient & { client_id: string | null };
type HistoryResponse = { batches: Batch[]; batch?: string; rows: (ClientRow | IpaidDocument)[]; count: number; pageSize: number };
type Preview = ReturnType<typeof prepareIpaidWorkbook> & { id: string; filename: string };
type ImportProgress = { done: number; total: number };

async function requestHistory(action: string, payload: Record<string, unknown>) {
  const response = await fetch("/api/ipaid-history", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to save iPaidThat history.");
}

const formats = [
  ["", "All documents"], ["Facture", "Invoices"], ["Devis", "Quotes"], ["Avoir", "Credit notes"],
  ["Bon de commande", "Orders"], ["Bon de livraison", "Delivery notes"], ["Facture proforma", "Proforma invoices"],
];

export default function IpaidHistory({ clients, demo, onDirectoryChanged }: {
  clients: Client[]; demo: boolean; onDirectoryChanged: () => void;
}) {
  const [view, setView] = useState<"clients" | "documents">("clients");
  const [batch, setBatch] = useState("");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [review, setReview] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HistoryResponse>({ batches: [], rows: [], count: 0, pageSize: 25 });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [linkSource, setLinkSource] = useState("");
  const [clientSearch, setClientSearch] = useState("");

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ view, batch, page: String(page), search: query, source, kind, review: String(review), overdue: String(overdue) });
    setLoading(true);
    setReadError("");
    void fetch(`/api/ipaid-history?${params}`, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to load iPaidThat history.");
      if (!controller.signal.aborted) setResult(data);
    }).catch(err => { if (!controller.signal.aborted) setReadError(String(err.message ?? err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [batch, demo, kind, overdue, page, query, refresh, review, source, view]);

  function openView(next: typeof view, clientSource = "") {
    setView(next); setSource(clientSource); setPage(0); setSearch(""); setQuery(""); setLinkSource("");
    if (clientSource) { setKind(""); setOverdue(false); }
  }

  async function read(file: File) {
    setBusy(true); setError(""); setNotice(""); setPreview(null); setProgress(null);
    try {
      const bytes = await file.arrayBuffer();
      const parsed = prepareIpaidWorkbook(readXlsxSheets(new Uint8Array(bytes)));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const id = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
      setPreview({ ...parsed, id, filename: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to read workbook.");
    } finally { setBusy(false); }
  }

  async function importWorkbook() {
    if (!preview || busy) return;
    setBusy(true); setError(""); setNotice("");
    const total = preview.clients.length + preview.documents.length;
    let done = 0;
    setProgress({ done, total });
    const common = { batch_id: preview.id };
    try {
      await requestHistory("start", { ...common, filename: preview.filename, clients: preview.clients.length, documents: preview.documents.length });
      for (const [name, rows] of [["clients", preview.clients], ["documents", preview.documents]] as const) {
        for (let offset = 0; offset < rows.length; offset += 150) {
          const chunk = rows.slice(offset, offset + 150);
          await requestHistory(name, { ...common, rows: chunk });
          done += chunk.length;
          setProgress({ done, total });
        }
      }
      await requestHistory("finish", common);
      setBatch(preview.id); setPreview(null); setProgress(null); setReview(false); openView("clients");
      setRefresh(n => n + 1); onDirectoryChanged();
      setNotice(`Imported ${preview.clients.length.toLocaleString()} source contacts and ${preview.documents.length.toLocaleString()} documents. Review the unlinked contacts before adding or linking them.`);
    } catch (err) {
      setError(`${err instanceof Error ? err.message : "Import failed."} Retry using this same workbook to resume.`);
    } finally { setBusy(false); }
  }

  async function reviewClient(row: ClientRow, clientId?: string) {
    if (!result.batch || busy) return;
    if (!clientId && !window.confirm(`Create a new workspace client for ${row.name}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await requestHistory(clientId ? "link_client" : "create_client", { batch_id: result.batch, source_id: row.source_id, client_id: clientId });
      setLinkSource(""); setRefresh(n => n + 1); onDirectoryChanged(); setNotice("Client link saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save client link."); }
    finally { setBusy(false); }
  }

  if (demo) return <div className="info">Workbook import is available in the signed-in staff workspace.</div>;

  return <section className="panel">
    <details className="ipaid-import">
      <summary>Import iPaidThat workbook</summary>
      <p>Choose an XLSX with Clients and Documents sheets. The import links clear matches, adds new contacts with an unambiguous primary email, and queues other contacts for review.</p>
      <label>Master workbook <input type="file" accept=".xlsx" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void read(file);
      }} /></label>
      {preview && <div className="workflow-actions">
        <div><strong>{preview.filename}</strong><p>{preview.clients.length.toLocaleString()} contacts · {preview.documents.length.toLocaleString()} documents · {preview.reviewClients.toLocaleString()} contact reviews flagged by the file</p></div>
        <button className="primary" disabled={busy || !!readError} onClick={() => void importWorkbook()}>{progress ? "Retry import" : "Import workbook"}</button>
      </div>}
      {progress && <p role="status">{progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows received. {busy ? "Saving archive…" : "Ready to retry."}</p>}
    </details>
    {error && <p className="error" role="alert">{error}</p>}
    {readError && <p className="error" role="alert">{readError}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="toolbar">
      <nav className="template-actions" aria-label="iPaidThat history views">
        <button className={view === "clients" ? "primary" : "secondary"} onClick={() => openView("clients")}>Imported contacts</button>
        <button className={view === "documents" ? "primary" : "secondary"} onClick={() => openView("documents")}>Document history</button>
      </nav>
      {!!result.batches.length && <label>Workbook <select value={result.batch ?? ""} onChange={event => {
        setBatch(event.target.value); setSource(""); setPage(0); setLinkSource("");
      }}>{result.batches.map(item => <option key={item.id} value={item.id}>{item.filename}</option>)}</select></label>}
    </div>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setQuery(search); setPage(0); setLinkSource(""); }}>
      <label className="search"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, reference or label…" aria-label="Search archive" /></label>
      <button className="secondary">Search</button>
      {view === "clients" ? <label className="checkbox-label"><input type="checkbox" checked={review} onChange={event => { setReview(event.target.checked); setPage(0); }} />Unlinked contacts only</label>
        : <><label>Document type <select value={kind} onChange={event => { setKind(event.target.value); setOverdue(false); setPage(0); }}>
          {formats.map(([value,label]) => <option key={value} value={value}>{label}</option>)}
        </select></label><label className="checkbox-label"><input type="checkbox" checked={overdue} onChange={event => { setOverdue(event.target.checked); setKind(""); setPage(0); }} />Overdue invoices in export</label></>}
    </form>
    {source && <div className="workflow-actions"><span>Documents for source contact {source}</span><button className="secondary" onClick={() => { setSource(""); setPage(0); }}>Show all contacts’ documents</button></div>}
    {loading ? <p className="info" role="status">Loading history…</p> : !result.rows.length ? <p className="empty">{result.batches.length ? "No matching records." : "No completed workbook imports yet."}</p>
      : <div className="table-wrap"><table>
        <thead>{view === "clients"
          ? <tr><th>Source contact</th><th>Contact details</th><th>Workspace link</th><th>Actions</th></tr>
          : <tr><th>Document</th><th>Client</th><th>Issue date</th><th>Status in export</th><th>Total incl. VAT</th></tr>}</thead>
        <tbody>{result.rows.map(row => "source_row" in row ? <tr key={row.source_row}>
          <td><strong>{row.number}</strong><small>{row.kind} · {row.label}</small>
            {row.details["Import review"] && <small>{row.details["Import review"]}</small>}
            <details><summary>Source fields</summary><dl>{Object.entries(row.details).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details></td>
          <td>{row.client_name}<small>{row.source_id}</small></td><td>{row.issued_on ?? "—"}</td>
          <td>{row.status ?? "—"}{row.overdue && <small>Overdue at export</small>}</td>
          <td>{row.total_inc_vat == null ? "—" : Number(row.total_inc_vat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        </tr> : <tr key={row.source_id}>
          <td><strong>{row.name}</strong><small>{row.source_id}</small></td>
          <td>{row.email ?? "—"}<small>{row.phone}</small><small>{row.address}</small>
            <details><summary>Source fields</summary><dl>{Object.entries(row.details).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details></td>
          <td>{row.client_id ? clients.find(client => client.id === row.client_id)?.name ?? "Linked workspace client" : "Needs review"}{!row.client_id && <small>{row.review_reason}</small>}</td>
          <td><div className="row-actions">
            <button className="text-button" onClick={() => openView("documents", row.source_id)}>View documents</button>
            {!row.client_id && <><button className="secondary" disabled={busy} onClick={() => {
              setLinkSource(current => current === row.source_id ? "" : row.source_id); setClientSearch("");
            }}>Link existing client</button>
              <button className="secondary" disabled={busy} onClick={() => void reviewClient(row)}>Create client</button></>}
            {linkSource === row.source_id && <form onSubmit={event => {
              event.preventDefault(); void reviewClient(row, String(new FormData(event.currentTarget).get("client_id") ?? ""));
            }}>
              <label>Find workspace client<input value={clientSearch} onChange={event => setClientSearch(event.target.value)} /></label>
              <label>Workspace client<select name="client_id" defaultValue="" required><option value="" disabled>Choose a client</option>
                {clients.filter(client => `${client.name} ${client.email ?? ""}`.toLowerCase().includes(clientSearch.trim().toLowerCase()))
                  .sort((a,b) => a.name.localeCompare(b.name)).slice(0, 100)
                  .map(client => <option key={client.id} value={client.id}>{client.name}{client.email ? ` · ${client.email}` : ""}</option>)}</select></label>
              <button className="primary" disabled={busy}>Save link</button>
            </form>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    {result.count > 0 && <div className="panel-footer">
      <span>{result.count.toLocaleString()} records · Page {page + 1} of {Math.ceil(result.count / result.pageSize)}</span>
      <div className="template-actions"><button className="secondary" disabled={loading || page === 0} onClick={() => setPage(n => n - 1)}>Previous</button>
        <button className="secondary" disabled={loading || (page + 1) * result.pageSize >= result.count} onClick={() => setPage(n => n + 1)}>Next</button></div>
    </div>}
  </section>;
}
