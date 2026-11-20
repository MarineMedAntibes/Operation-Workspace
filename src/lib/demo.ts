import type { Workspace } from "./types";
import { applyDemoCommand, type Action } from "./commands";
import { addMonths, quantities } from "./rules";

export const DEMO_STORAGE_KEY = "marine-medical-preview-v2";

export function demoWorkspace({ includeExamples = true } = {}): Workspace {
  let data: Workspace = {
    clients: [{ id: "client-demo", name: "Example Yacht Management", email: "office@example.com", phone: null, billing_address: null, notes: "Fictional preview data" }],
    vessels: [{ id: "vessel-demo", name: "Northern Light", client_id: "client-demo", framework: "MSN", flag_state: "UK", crew: 12, loyalty: false }],
    vendors: [{ id: "vendor-demo", name: "Example Medical Supply", email: null, phone: null, notes: "Fictional supplier" }],
    vendor_products: [{ id: "vp-demo", vendor_id: "vendor-demo", description: "Sterile dressing", sku: "DEMO-01", pack_description: "Pack of 10", price: 12 }],
    kit_templates: [{ id: "template-demo", name: "Demonstration kit", framework: "MSN", category: "CAT B", version: "Preview only", published: true }],
    template_items: [
      { id: "ti-1", template_id: "template-demo", source_code: "DEMO-01", description: "Sterile dressings", location: "First aid bag", pack_description: "Pack of 10", baseline_packs: 1, scaling: "band", unit_price: 18, attributes: {} },
      { id: "ti-2", template_id: "template-demo", source_code: "DEMO-02", description: "Disposable examination gloves", location: "Equipment bag", pack_description: "Box of 100", baseline_packs: 1, scaling: "fixed", unit_price: 12, attributes: {} },
      { id: "ti-3", template_id: "template-demo", source_code: "DEMO-03", description: "Digital thermometer", location: "Equipment bag", pack_description: "Each", baseline_packs: 1, scaling: "fixed", unit_price: 22, attributes: {} },
    ],
    kit_checks: [], check_items: [], batches: [], quotes: [],
  };
  if (!includeExamples) return data;

  data.clients.push(
    { id: "client-harbour", name: "Harbour & Helm Management", email: "operations@harbour-helm.example.com", phone: null, billing_address: "Antibes, France (fictional)", notes: "Coordinates annual servicing for Blue Meridian and Calypso." },
    { id: "client-private", name: "Morgan Ellis", email: "morgan@example.com", phone: null, billing_address: "Nice, France (fictional)", notes: "Private owner. Usually collects the kit in person." },
    { id: "client-horizon", name: "Horizon Charter Services", email: "fleet@horizon.example.com", phone: null, billing_address: "Cannes, France (fictional)", notes: "Multiple vessels; deliveries may arrive in separate stages." },
    { id: "client-coastal", name: "Coastal Passage Yachts", email: "office@coastal-passage.example.com", phone: null, billing_address: "Monaco (fictional)", notes: "New client; vessel ready for its first check." },
  );
  data.vessels.push(
    { id: "vessel-blue", name: "Blue Meridian", client_id: "client-harbour", framework: "MSN", flag_state: "Cayman Islands", crew: 10, loyalty: true },
    { id: "vessel-calypso", name: "Calypso", client_id: "client-harbour", framework: "MSN", flag_state: "UK", crew: 18, loyalty: false },
    { id: "vessel-solstice", name: "Solstice", client_id: "client-private", framework: "MSN", flag_state: "UK", crew: 8, loyalty: false },
    { id: "vessel-aurora", name: "Aurora", client_id: "client-horizon", framework: "MSN", flag_state: "UK", crew: 24, loyalty: true },
    { id: "vessel-tide", name: "Tide Runner", client_id: "client-horizon", framework: "MSN", flag_state: "UK", crew: 12, loyalty: false },
    { id: "vessel-fairwind", name: "Fairwind", client_id: "client-coastal", framework: "MSN", flag_state: "UK", crew: 6, loyalty: false },
  );
  data.vendors.push(
    { id: "vendor-harbour", name: "Harbour First Aid Supplies", email: "orders@harbour-firstaid.example.com", phone: null, notes: "Fictional supplier · dressings and consumables." },
    { id: "vendor-coast", name: "Coastline Clinical Equipment", email: "sales@coastline.example.com", phone: null, notes: "Fictional supplier · diagnostic equipment." },
    { id: "vendor-port", name: "Portside Safety Stores", email: "orders@portside.example.com", phone: null, notes: "Fictional supplier · bags, signage and accessories." },
  );
  const products = [
    ["vendor-demo", "Disposable examination gloves", "GL-100", "Box of 100", 8.5],
    ["vendor-demo", "Digital thermometer", "TH-01", "Each", 15],
    ["vendor-demo", "Sterile gauze swabs", "GS-50", "Pack of 50", 7.2],
    ["vendor-harbour", "Sterile dressings", "DR-10", "Pack of 10", 10.8],
    ["vendor-harbour", "Conforming bandages", "CB-12", "Pack of 12", 11],
    ["vendor-harbour", "Triangular bandages", "TB-06", "Pack of 6", 9.5],
    ["vendor-harbour", "Adhesive tape", "AT-06", "Pack of 6 rolls", 8],
    ["vendor-harbour", "Sterile saline eyewash", "EW-02", "Pack of 2 bottles", 6.4],
    ["vendor-coast", "Digital thermometer", "DGT-100", "Each", 16.5],
    ["vendor-coast", "Pulse oximeter", "OX-01", "Each", 29],
    ["vendor-coast", "Manual blood pressure monitor", "BP-01", "Each", 39],
    ["vendor-coast", "Diagnostic penlight", "PL-02", "Pack of 2", 7],
    ["vendor-coast", "Trauma shears", "TS-01", "Each", 5.6],
    ["vendor-port", "Medical equipment bag", "BAG-01", "Each", 45],
    ["vendor-port", "Waterproof document sleeve", "DOC-05", "Pack of 5", 12],
    ["vendor-port", "First aid signage", "SIGN-01", "Each", 4.5],
    ["vendor-port", "Emergency foil blanket", "FB-05", "Pack of 5", 11.5],
  ] as const;
  products.forEach(([vendor_id, description, sku, pack_description, price], index) => {
    data.vendor_products.push({ id: `vp-example-${index}`, vendor_id, description, sku, pack_description, price });
  });

  data.kit_templates[0].name = "MSN Cat B · demonstration";
  data.kit_templates.push({ id: "template-demo-a", name: "MSN Cat A · demonstration", framework: "MSN", category: "CAT A", version: "Preview only", published: true });
  const largerKit = [
    ["DEMO-A-01", "Sterile dressings", "First aid bag", "Pack of 10", 2, "band", 18],
    ["DEMO-A-02", "Disposable examination gloves", "Equipment bag", "Box of 100", 1, "fixed", 12],
    ["DEMO-A-03", "Digital thermometer", "Equipment bag", "Each", 1, "fixed", 22],
    ["DEMO-A-04", "Conforming bandages", "First aid bag", "Pack of 12", 1, "band", 19],
    ["DEMO-A-05", "Sterile saline eyewash", "First aid bag", "Pack of 2 bottles", 1, "band", 14],
    ["DEMO-A-06", "Trauma shears", "Equipment bag", "Each", 1, "fixed", 10],
  ] as const;
  largerKit.forEach(([source_code, description, location, pack_description, baseline_packs, scaling, unit_price], index) => {
    data.template_items.push({ id: `ti-a-${index}`, template_id: "template-demo-a", source_code, description, location, pack_description, baseline_packs, scaling, unit_price, attributes: { demonstration: true } });
  });

  // Use the same commands as the preview UI so the examples obey its workflow.
  function command(action: Action, payload: Record<string, unknown>) {
    data = applyDemoCommand(data, { action, payload });
  }
  function start(vessel_id: string, template_id: string, check_date: string) {
    command("create_check", { vessel_id, template_id, check_date, job_type: "Routine Refill" });
    return data.kit_checks.at(-1)!.id;
  }
  const lines = (checkId: string) => data.check_items.filter((i) => i.check_id === checkId);
  function quote(checkId: string, assessmentFee: number, approved = false) {
    for (const item of lines(checkId)) command("mark_assessed", { item_id: item.id, state: "reviewed" });
    command("create_quote", { check_id: checkId, assessment_fee: assessmentFee });
    if (approved) command("approve_quote", { check_id: checkId });
  }

  const northern = start("vessel-demo", "template-demo", "2026-10-27");
  command("add_batch", { item_id: lines(northern)[0].id, quantity: 1, expiry: "2028-01-01", notes: "Existing dressing pack retained after physical count." });
  command("add_batch", { item_id: lines(northern)[0].id, quantity: 1, expiry: "2026-08-01", notes: "Old pack removed during assessment." });
  command("mark_assessed", { item_id: lines(northern)[0].id, state: "reviewed" });

  const blue = start("vessel-blue", "template-demo", "2026-10-25");
  command("add_batch", { item_id: lines(blue)[2].id, quantity: 1, no_expiry: true, notes: "Existing thermometer checked and retained." });
  quote(blue, 75);

  const calypso = start("vessel-calypso", "template-demo-a", "2026-10-22");
  command("add_batch", { item_id: lines(calypso)[0].id, quantity: 1, expiry: "2028-01-01", notes: "Retained from last year's kit." });
  quote(calypso, 150, true);
  command("add_batch", { item_id: lines(calypso)[0].id, quantity: 1, expiry: "2028-06-01", notes: "First delivery · packed Monday." });
  command("add_batch", { item_id: lines(calypso)[0].id, quantity: 1, expiry: "2028-09-01", notes: "Second delivery · packed Tuesday. One pack still outstanding." });
  command("add_batch", { item_id: lines(calypso)[1].id, quantity: 1, no_expiry: true, notes: "Packed from available supplies." });

  const aurora = start("vessel-aurora", "template-demo-a", "2026-10-20");
  quote(aurora, 190, true);

  // Shorter-lived new batches are accepted by the intended supply rule. They
  // expire before the next visit, making the default forecast visibly useful.
  for (const [vesselId, templateId, date, fee] of [
    ["vessel-solstice", "template-demo", "2026-09-18", 100],
    ["vessel-tide", "template-demo-a", "2026-10-12", 150],
  ] as const) {
    const checkId = start(vesselId, templateId, date);
    const check = data.kit_checks.find((c) => c.id === checkId)!;
    command("add_batch", { item_id: lines(checkId)[2].id, quantity: 1, no_expiry: true, notes: "Existing serviceable thermometer retained." });
    quote(checkId, fee, true);
    for (const [index, item] of lines(checkId).entries()) {
      const outstanding = quantities(item, data.batches).outstanding;
      if (!outstanding) continue;
      if (index === 0 || item.description === "Sterile saline eyewash") {
        command("add_batch", { item_id: item.id, quantity: 1, expiry: addMonths(check.valid_until, -1).slice(0, 7) + "-01", notes: "Included in next year's replacement forecast." });
        if (outstanding > 1) command("add_batch", { item_id: item.id, quantity: outstanding - 1, expiry: "2029-01-01", notes: "Later-expiry batch; retained beyond next year's visit." });
      } else command("add_batch", { item_id: item.id, quantity: outstanding, no_expiry: true, notes: "Supplied equipment/consumables with no expiry in this fictional example." });
    }
    command("finish", { check_id: checkId });
  }

  // Give repeated example deliveries distinct timestamps without depending on
  // the viewer's current clock. Session edits still use their actual save time.
  data.batches.forEach((batch, index) => {
    const item = data.check_items.find((i) => i.id === batch.check_item_id)!;
    const check = data.kit_checks.find((c) => c.id === item.check_id)!;
    batch.created_at = `${check.check_date}T${String(8 + index % 8).padStart(2, "0")}:00:00.000Z`;
  });
  data.quotes.forEach((q) => { q.created_at = `${data.kit_checks.find((c) => c.id === q.check_id)!.check_date}T10:00:00.000Z`; });
  return data;
}
