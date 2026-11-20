import type { CheckItem, Workspace } from "./types";

type Attributes = Record<string, unknown> | undefined;

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Normalize all imports to the Arrival worksheet's row numbering. A saved
// explicit sort_order is zero-based; Arrival/source rows start at 3, Pick at 2.
export function workbookPosition(attributes: Attributes): number | undefined {
  const explicit = number(attributes?.sort_order);
  if (explicit !== undefined) return explicit + 3;
  const arrival = number(attributes?.source_arrival_row);
  if (arrival !== undefined) return arrival;
  const source = number(attributes?.source_row);
  if (source !== undefined) return source;
  const pick = number(attributes?.source_pick_row);
  return pick === undefined ? undefined : pick + 1;
}

export function inWorkbookOrder<T extends { attributes?: Record<string, unknown> }>(
  rows: readonly T[],
  fallback?: (row: T) => Attributes,
): T[] {
  return rows.map((row, index) => ({ row, index, position: workbookPosition(row.attributes) ?? workbookPosition(fallback?.(row)) ?? Infinity }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ row }) => row);
}

export function checkItemsInWorkbookOrder(data: Workspace, checkId: string | null): CheckItem[] {
  const templates = new Map(data.template_items.map((item) => [item.id, item.attributes]));
  return inWorkbookOrder(data.check_items.filter((item) => item.check_id === checkId), (item) => templates.get(item.template_item_id));
}
