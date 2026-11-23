import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
await mkdir(".qa",{recursive:true});
const browser=await chromium.launch({channel:"msedge",headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on("pageerror",e=>errors.push(e.message));page.on("dialog",dialog=>dialog.accept());
try{
 await page.goto(process.env.QA_URL??"http://127.0.0.1:3011",{waitUntil:"networkidle"});
 await page.getByRole("navigation",{name:"Main navigation"}).getByRole("button",{name:/Kit checks/}).click();
 await page.getByRole("button",{name:"Northern Light",exact:true}).click();
 await page.getByRole("tab",{name:"Setup",exact:true}).click();
 await page.getByLabel("Assessor",{exact:true}).fill("Example Assessor");
 await page.getByLabel("Certificate number / reference").fill("QA-DRAFT");
 await page.getByLabel("Client type",{exact:true}).selectOption("B2C");
 await page.getByLabel("Vessel tax status").selectOption("PRIVATE");
 await page.getByLabel("Delivery location / country").fill("France");
 await page.getByLabel("Standard assessment fee (€)",{exact:true}).fill("100");
 await page.getByLabel("Loyalty discount (%)",{exact:true}).fill("0");
 await page.getByLabel("Proceeds credit after loyalty (%)").fill("0");
 await page.getByLabel(/Price the full job as proceeding/).check();
 await page.getByLabel(/Assessment rates and any new-build price reviewed/).check();
 await page.getByLabel(/Goods, service and freight tax treatment reviewed/).check();
 await page.getByRole("button",{name:"Save configuration",exact:true}).first().click();
 await expect(page.getByText("Changes saved.",{exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Reconciliation",exact:true}).click();
 await page.locator("textarea").fill("description,quantity,expiry,item ID,bag\nSterile dressings,1,02/2029,DEMO-01,First aid bag");
 await page.getByRole("button",{name:"Preview pasted rows"}).click();
 await expect(page.getByRole("button",{name:"Apply 0 confirmed matches"})).toBeDisabled();
 await page.getByLabel("Identity, packs and expiry checked").check();
 await page.getByRole("button",{name:"Apply 1 confirmed matches"}).click();
 await expect(page.getByRole("button",{name:"Apply 0 confirmed matches"})).toBeDisabled();
 await page.getByRole("tab",{name:"Legacy items",exact:true}).click();
 await page.getByLabel("Description",{exact:true}).fill("Example bridge extra");
 await page.getByLabel("No expiry (NED)",{exact:true}).check();
 await page.getByRole("button",{name:"Add legacy item"}).click();
 await expect(page.getByRole("cell",{name:"Example bridge extra",exact:true})).toBeVisible();
 await page.getByRole("tab",{name:"Arrival check",exact:true}).click();
 const cards=page.locator("[data-fast-row]");const count=await cards.count();
 for(let n=0;n<count;n++){
  const card=cards.nth(n);await card.locator('input[type="number"]').nth(0).fill("0");await card.locator('input[type="number"]').nth(1).fill("0");
  await card.getByRole("button",{name:"Save & next",exact:true}).click();await expect(card.locator(".complete-flag")).toHaveText("ASSESSED");
 }
 await page.screenshot({path:".qa/arrival-desktop.png",fullPage:true});
 await page.getByRole("tab",{name:"Cost analysis",exact:true}).click();
 await page.getByRole("button",{name:"Prepare quote snapshot"}).click();
 await page.getByRole("button",{name:"Record client approval"}).click();
 for(let n=0;n<count;n++){
  const card=cards.nth(n),quantity=await card.locator(".line-metrics span").filter({hasText:"To add"}).locator("b").innerText();
  await card.locator('input[type="number"]').nth(0).fill(quantity);await card.locator('input[placeholder="02/28"]').nth(0).fill("02/29");
  await card.getByRole("button",{name:"Save packing & next"}).click();await expect(card.locator(".complete-flag")).toHaveText("PACKED");
 }
 await page.getByRole("button",{name:"Revise quote",exact:true}).click();await page.getByLabel("Revision reason").fill("Example sourcing change");await page.getByRole("button",{name:"Reopen assessment"}).click();
 await cards.nth(0).getByRole("button",{name:"Substitute / quantity / price"}).click();
 const dialog=page.getByRole("dialog");await dialog.getByLabel(/Substitute product/).fill("Example alternative dressing");await dialog.getByLabel(/Reviewed sell price per pack/).fill("19");await dialog.getByLabel("Reason for change / client request").fill("Example sourcing adjustment");await dialog.getByRole("button",{name:/Save and continue/}).click();
 await page.getByRole("tab",{name:"Cost analysis",exact:true}).click();await page.getByRole("button",{name:"Prepare quote snapshot"}).click();await page.getByRole("button",{name:"Record client approval"}).click();
 await page.getByRole("button",{name:"Finish medical packing"}).click();
 await page.getByRole("tab",{name:"Invoice",exact:true}).click();const number="QA-"+Date.now();await page.getByLabel("Invoice number",{exact:true}).fill(number);await page.getByRole("button",{name:"Freeze invoice draft"}).click();
 await page.getByLabel("Invoice sent",{exact:true}).fill("2026-11-20");await page.getByLabel("Invoice paid",{exact:true}).fill("2026-11-20");await page.getByRole("button",{name:"Save tracker"}).click();await expect(page.getByText(new RegExp(number+" · paid"))).toBeVisible();
 await page.getByRole("tab",{name:"Quote",exact:true}).click();await expect(page.getByText(/Previous revisions \(1\)/)).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.getByRole("tab",{name:"Arrival check",exact:true}).click();await page.screenshot({path:".qa/arrival-mobile.png",fullPage:true});
 assertNoErrors();console.log(JSON.stringify({result:"passed",check_lines:count,reconciliation:"confirmed only",quote_revision:"preserved",invoice_tracker:"paid",screenshots:[".qa/arrival-desktop.png",".qa/arrival-mobile.png"]}));
}catch(error){await page.screenshot({path:".qa/workflow-failure.png",fullPage:true});throw error;}finally{await browser.close();}
function assertNoErrors(){if(errors.length)throw new Error(errors.join("\n"));}
