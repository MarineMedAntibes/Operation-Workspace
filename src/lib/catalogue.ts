import type { VendorProduct, Workspace } from "./types";

export function catalogueItemId(product: VendorProduct) {
  return product.catalogue_item_id ?? String(product.attributes?.mma_article_number ?? "").trim();
}

export function catalogueCodeKey(code: string) {
  return code.trim().replace(/\s+/g, " ").toLowerCase();
}

export function demoCatalogueItemId(data: Workspace) {
  const reserved = new Set(data.vendor_products.map(product => catalogueItemId(product).toUpperCase()));
  for (let number = 1; ; number++) {
    const id = `MMA-${String(number).padStart(6, "0")}`;
    if (!reserved.has(id)) return id;
  }
}
