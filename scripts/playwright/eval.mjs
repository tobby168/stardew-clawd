#!/usr/bin/env node
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP(process.env.STARDEW_OFFICE_CDP ?? 'http://127.0.0.1:9222');
let page = null;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (!p.url().startsWith('devtools://')) { page = p; break; }
  }
  if (page) break;
}
if (!page) { console.error('no page'); process.exit(1); }
const expr = process.argv.slice(2).join(' ');
const result = await page.evaluate(expr);
console.log(JSON.stringify(result, null, 2));
await browser.close().catch(() => {});
