import type { Batch, CheckItem } from "./types";

export function crewBand(crew: number) {
  if (!Number.isInteger(crew) || crew < 1 || crew > 60) throw new Error("Crew must be between 1 and 60.");
  return [10, 20, 30, 40, 60].find((band) => crew <= band)!;
}
export function requiredPacks(baseline: number, scaling: "fixed" | "band", crew: number) {
  if (!Number.isFinite(baseline) || baseline < 0) throw new Error("Invalid baseline quantity.");
  const band = crewBand(crew);
  return scaling === "fixed" ? baseline : Math.round(baseline * band / 10);
}
export function addMonths(date: string, months: number) {
  const parsed = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Invalid date.");
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const last = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
  parsed.setUTCDate(Math.min(day, last));
  return parsed.toISOString().slice(0, 10);
}
export function keepExisting(expiry: string | null, noExpiry: boolean, validUntil: string) {
  if (noExpiry) return true;
  if (!expiry) throw new Error("Enter an expiry or explicitly select no expiry.");
  return addMonths(expiry, 1) > validUntil;
}
export function validSupplyExpiry(expiry: string | null, noExpiry: boolean, validUntil: string) {
  if (noExpiry) return true;
  return !!expiry && addMonths(expiry, 1) > addMonths(validUntil, -1);
}
export function quantities(item: CheckItem, batches: Batch[]) {
  const own = batches.filter((b) => b.check_item_id === item.id);
  const kept = own.filter((b) => b.kind === "kept").reduce((s, b) => s + Number(b.quantity), 0);
  const supplied = own.filter((b) => b.kind === "supplied").reduce((s, b) => s + Number(b.quantity), 0);
  const needed = item.assessment_state === "not_applicable" || item.kill_line ? 0 : Math.max(0, Number(item.required_packs) - kept);
  return { kept, supplied, needed, outstanding: Math.max(0, needed - supplied), final: kept + supplied };
}
export const euros = (amount: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(amount);
