"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Action } from "@/lib/commands";
import { catalogueCodeKey, catalogueItemId } from "@/lib/catalogue";
import { euros } from "@/lib/rules";
import type { CatalogueFramework, CatalogueProductCode, VendorProduct, Workspace } from "@/lib/types";
import { inWorkbookOrder } from "@/lib/workbook-order";
import DraftForm from "./draft-form";

type View = "Products" | CatalogueFramework;
type Editor = { productId?: string; framework: CatalogueFramework; code?: string; link?: CatalogueProductCode };
type Props = {
  data: Workspace;
  demo: boolean;
  busy: boolean;
  search: string;
  setSearch: (value: string) => void;
  editProduct: (product?: VendorProduct) => void;
  command: (action: Action, payload: Record<string, unknown>) => Promise<boolean | undefined>;
};

export default function CataloguePage({ data, demo, busy, search, setSearch, editProduct, command }: Props) {
  const [view, setView] = useState<View>("Products");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [framework, setFramework] = useState<CatalogueFramework>("MSN");
  const [productSearch, setProductSearch] = useState("");
  const formHeading = useRef<HTMLHeadingElement>(null);
  const ready = demo || data.catalogue_product_codes !== undefined;
  const links = data.catalogue_product_codes ?? [];
  const products = new Map(data.vendor_products.map(product => [product.id, product]));
  const vendors = new Map(data.vendors.map(vendor => [vendor.id, vendor.name]));
  const templates = new Map(data.kit_templates.filter(template => template.published || !template.ever_published).map(template => [template.id, template]));
  const codeLists: Record<CatalogueFramework, Map<string, { code: string; description?: string; positions: Set<string>; links: CatalogueProductCode[] }>> = {
    MSN: new Map(), Malta: new Map(),
  };
  const byProduct = new Map<string, CatalogueProductCode[]>();
  for (const line of inWorkbookOrder(data.template_items)) {
    const template = templates.get(line.template_id);
    if (template?.framework !== "MSN" && template?.framework !== "Malta") continue;
    const code = String(line.attributes.item_id || line.source_code).trim();
    const key = catalogueCodeKey(code);
    const list = codeLists[template.framework];
    const entry = list.get(key) ?? { code, description: line.description, positions: new Set<string>(), links: [] };
    const sourceRow = line.attributes.source_arrival_row;
    const reference = String(line.attributes.reg_code ?? "").trim();
    entry.positions.add([template.name, template.version, line.location, sourceRow == null ? "" : `row ${sourceRow}`, reference].filter(Boolean).join(" · "));
    list.set(key, entry);
  }
  for (const link of links) {
    const list = codeLists[link.framework];
    const entry = list.get(link.code_key) ?? { code: link.code, positions: new Set<string>(), links: [] };
    entry.links.push(link);
    list.set(link.code_key, entry);
    const productLinks = byProduct.get(link.product_id) ?? [];
    productLinks.push(link);
    byProduct.set(link.product_id, productLinks);
  }

  function productLabel(product: VendorProduct) {
    return [catalogueItemId(product), product.description, vendors.get(product.vendor_id ?? ""), product.sku, product.pack_description].filter(Boolean).join(" · ");
  }

  function openEditor(next: Editor) {
    setFramework(next.framework);
    setProductSearch("");
    setEditor(next);
  }

  useEffect(() => { if (editor) formHeading.current?.focus(); }, [editor]);

  async function save(form: FormData) {
    if (!editor) return;
    if (await command("save_catalogue_product_code", {
      product_id: editor.productId ?? form.get("product_id"),
      framework: editor.link?.framework ?? form.get("framework"),
      code: editor.link?.code ?? form.get("code"),
      role: form.get("role"),
    })) setEditor(null);
  }

  function editLink(link: CatalogueProductCode) {
    openEditor({ framework: link.framework, productId: link.product_id, code: link.code, link });
  }

  const matches = (value: string) => value.toLowerCase().includes(search.trim().toLowerCase());
  const matchingProducts = inWorkbookOrder(data.vendor_products).filter(product => matches([
    productLabel(product), product.attributes?.matched_item_ids, ...(byProduct.get(product.id) ?? []).map(link => `${link.framework} ${link.code}`),
  ].join(" ")));
  const matchingCodes = view === "Products" ? [] : [...codeLists[view].values()]
    .filter(entry => matches([entry.code, entry.description, ...entry.positions,
      ...entry.links.map(link => products.get(link.product_id)).filter((product): product is VendorProduct => !!product).map(productLabel),
    ].join(" ")))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  return <section className="panel catalogue-panel">
    <div className="toolbar catalogue-toolbar">
      <nav className="template-actions" aria-label="Catalogue views">
        {(["Products", "MSN", "Malta"] as const).map(next => <button key={next} type="button"
          className={next === view ? "primary" : "secondary"} aria-pressed={next === view}
          onClick={() => { setView(next); setSearch(""); setEditor(null); }}>
          {next === "Products" ? "Vendor products" : `${next} codes`}
        </button>)}
      </nav>
      <button className="secondary" disabled={busy} onClick={() => editProduct()}><Plus size={16} />Add product</button>
    </div>
    <div className="toolbar">
      <label className="search"><input value={search} onChange={event => setSearch(event.target.value)}
        aria-label={view === "Products" ? "Search vendor products" : "Search template codes"}
        placeholder={view === "Products" ? "Search item ID, product or supplier…" : "Search code, item or position…"} /></label>
      {view !== "Products" && ready && <button className="secondary" disabled={busy} onClick={() => openEditor({ framework: view })}>Link a product to a code</button>}
    </div>
    {!ready && <p className="info">Apply the catalogue item codes migration to assign item IDs and save product links.</p>}
    {editor && <DraftForm key={JSON.stringify(editor)} busy={busy} className="template-form" onDraftChange={form => {
      if (!editor.link) setFramework(new FormData(form).get("framework") === "Malta" ? "Malta" : "MSN");
    }} onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)); }}>
      <h2 ref={formHeading} tabIndex={-1}>{editor.link ? "Edit product link" : "Link product to template code"}</h2>
      {editor.productId && products.get(editor.productId)
        ? <p>{productLabel(products.get(editor.productId)!)}</p>
        : <><label>Find a product<input value={productSearch} onChange={event => setProductSearch(event.target.value)} /></label>
          <label>Vendor product<select aria-label="Vendor product" name="product_id" required defaultValue="">
            <option value="" disabled>Choose a product</option>
            {[...products.values()].filter(product => productLabel(product).toLowerCase().includes(productSearch.trim().toLowerCase()))
              .sort((a,b) => a.description.localeCompare(b.description))
              .map(product => <option value={product.id} key={product.id}>{productLabel(product)}</option>)}
          </select></label></>}
      {editor.link ? <p>{editor.link.framework} · {editor.link.code}</p> : <>
        <label>Code list<select name="framework" defaultValue={editor.framework}><option>MSN</option><option>Malta</option></select></label>
        <label>Template item code<input name="code" list="catalogue-code-options" defaultValue={editor.code ?? ""} required maxLength={250} /></label>
        <datalist id="catalogue-code-options">{[...codeLists[framework].values()].map(entry =>
          <option key={entry.code} value={entry.code}>{entry.description}</option>)}</datalist>
      </>}
      <label>Product role<select name="role" defaultValue={editor.link?.role ?? "alternative"}><option value="alternative">Alternative</option><option value="preferred">Preferred</option></select></label>
      <div className="template-actions">
        <button className="primary" disabled={busy}>Save link</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
        {editor.link && <button className="text-button" type="button" disabled={busy} onClick={async () => {
          if (editor.link && window.confirm("Remove this product link from the code list?") &&
            await command("unlink_catalogue_product_code", { link_id: editor.link.id })) setEditor(null);
        }}>Remove link</button>}
      </div>
    </DraftForm>}
    {view === "Products" ? <div className="table-wrap"><table>
      <thead><tr><th>Product / Item ID</th><th>Vendor / SKU</th><th>Pack / pricing basis</th><th>Price per pack</th><th>Price per unit</th><th>Code links</th><th>Actions</th></tr></thead>
      <tbody>{matchingProducts.map(product => <tr key={product.id}>
        <td><strong>{product.description}</strong><small>{catalogueItemId(product) || "Item ID unassigned"}</small></td>
        <td>{vendors.get(product.vendor_id ?? "") ?? "Unassigned"}<small>{product.sku ?? "—"}</small></td>
        <td>{product.pack_description || "—"}<small>{String(product.attributes?.pricing_basis ?? "Per pack")}</small></td>
        <td>{product.price == null ? "Not set" : euros(product.price)}{product.attributes?.review_required === true && <small>Review pricing</small>}</td>
        <td>{product.attributes?.unit_price == null ? "Not set" : euros(Number(product.attributes.unit_price))}</td>
        <td>{(byProduct.get(product.id) ?? []).map(link => <div key={link.id}><button className="text-button" disabled={busy} onClick={() => editLink(link)}>{link.framework} · {link.code}</button><small>{link.role === "preferred" ? "Preferred" : "Alternative"}</small></div>)}
          {Boolean(product.attributes?.matched_item_ids) && <small>Imported references · {String(product.attributes?.matched_item_ids)}</small>}</td>
        <td><div className="row-actions"><button className="secondary" aria-label={`Edit ${product.description}`} onClick={() => editProduct(product)}>Edit</button>
          {ready && <><button className="text-button" disabled={busy} onClick={() => openEditor({ framework: "MSN", productId: product.id })}>Link code</button>
            {!catalogueItemId(product) && <button className="text-button" disabled={busy}
              onClick={() => void command("assign_catalogue_item_id", { product_id: product.id })}>Assign Item ID</button>}</>}
        </div></td>
      </tr>)}</tbody>
    </table>{!matchingProducts.length && <p className="empty">No matching vendor products.</p>}</div>
      : <div className="table-wrap"><table>
        <thead><tr><th>Template item code</th><th>Positions in templates</th><th>Preferred product and alternatives</th><th>Actions</th></tr></thead>
        <tbody>{matchingCodes.map(entry => <tr key={catalogueCodeKey(entry.code)}>
          <td><strong>{entry.code}</strong><small>{entry.description}</small></td>
          <td>{entry.positions.size ? [...entry.positions].map(position => <small key={position}>{position}</small>) : "No template position recorded"}</td>
          <td>{[...entry.links].sort((a,b) => b.role.localeCompare(a.role)).map(link => {
            const product = products.get(link.product_id);
            return product && <div key={link.id}><button className="text-button" disabled={busy} onClick={() => editLink(link)}>{productLabel(product)}</button>
              <small>{link.role === "preferred" ? "Preferred" : "Alternative"}</small></div>;
          })}{!entry.links.length && "No reviewed product links"}</td>
          <td>{ready && <button className="secondary" disabled={busy} onClick={() => openEditor({ framework: view, code: entry.code })}>Link product</button>}</td>
        </tr>)}</tbody>
      </table>{!matchingCodes.length && <p className="empty">No matching codes.</p>}</div>}
  </section>;
}
