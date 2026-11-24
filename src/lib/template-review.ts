import type { TemplateItem } from "./types";

export const templateCrewBands = [10, 20, 30, 40, 60] as const;

export function templateMaximumPacks(attributes: TemplateItem["attributes"]) {
  const maximum = attributes.maximum_packs;
  return typeof maximum === "number" && Number.isInteger(maximum) && maximum >= 0 ? maximum : undefined;
}

export function templatePriceKey(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

export function templateLineIssues(line: TemplateItem) {
  const issues: string[] = [];
  if (line.attributes.price_missing === true) issues.push("Missing sell price");
  if (line.attributes.requirement_unknown === true) issues.push("Missing quantity");
  if (line.scaling === "fixed" && !Number.isInteger(Number(line.baseline_packs))) issues.push("Fixed quantity must be whole packs");
  return issues;
}

export function isTemplateLineReviewed(line: TemplateItem) {
  return line.attributes.price_quantity_reviewed === true && templateLineIssues(line).length === 0;
}
