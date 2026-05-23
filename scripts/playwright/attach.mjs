#!/usr/bin/env node
/*
 * Attach to the running Electron dev instance via its remote-debugging-port
 * (CDP) and run a small operation: --screenshot saves a PNG; --logs dumps
 * recent console output; --hire fires the Hire Worker flow; --inspect dumps
 * the rendered scene state. Used by Claude during iteration — not a runtime
 * dependency.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP_URL = process.env.STARDEW_OFFICE_CDP ?? 'http://127.0.0.1:9222';

async function pickRendererPage(browser) {
  // Electron exposes the main window context as the first "page" target.
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const t = (await p.title()) ?? '';
      const u = p.url() ?? '';
      if (u.startsWith('devtools://')) continue;
      if (t === 'Stardew Clawd' || u.includes('localhost:5173')) return p;
    }
  }
  // Fallback: first non-devtools page.
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('devtools://')) return p;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const op = args[0] ?? '--screenshot';

  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await pickRendererPage(browser);
  if (!page) {
    console.error('no renderer page found');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  switch (op) {
    case '--screenshot': {
      const out = resolve(args[1] ?? '/tmp/stardew-clawd.png');
      const buf = await page.screenshot({ fullPage: false });
      writeFileSync(out, buf);
      console.log(out);
      break;
    }
    case '--logs': {
      // Print accumulated console messages collected over a brief listen window.
      // (Playwright doesn't give us historical console; we just capture future logs for N seconds.)
      const N = Number(args[1] ?? 4);
      const lines = [];
      page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => lines.push(`[error] ${e.message}`));
      await page.waitForTimeout(N * 1000);
      console.log(lines.join('\n'));
      break;
    }
    case '--inspect': {
      const state = await page.evaluate(() => {
        const titlebar = document.querySelector('.titlebar')?.textContent ?? '';
        const sceneCanvas = document.querySelector('.scene-pane canvas');
        const panelH2 = document.querySelector('.side-panel h2')?.textContent ?? '';
        const transcriptCount = document.querySelectorAll('.transcript-entry').length;
        const hasApproval = !!document.querySelector('.approval-banner');
        return {
          titlebar: titlebar.replace(/\s+/g, ' ').trim(),
          canvas: sceneCanvas ? { w: sceneCanvas.width, h: sceneCanvas.height } : null,
          panelTitle: panelH2,
          transcriptCount,
          hasApproval,
        };
      });
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    case '--hire': {
      const cwd = args[1] ?? process.cwd();
      const prompt = args[2] ?? 'list the files in this directory and tell me what this project is';
      // Open the hire modal.
      await page.click('.hire-btn');
      // Wait for modal to render.
      await page.waitForSelector('.modal input');
      // Fill cwd (first input) and prompt (textarea).
      await page.fill('.modal input', cwd);
      await page.fill('.modal textarea', prompt);
      await page.click('.modal button:has-text("HIRE")');
      console.log(`hired worker in ${cwd}`);
      break;
    }
    case '--approve': {
      // Click ALLOW in the first visible approval banner.
      const found = await page.$('.approval-banner button.allow');
      if (!found) {
        console.log('no pending approval');
        break;
      }
      await found.click();
      console.log('approved');
      break;
    }
    case '--deny': {
      const found = await page.$('.approval-banner button.deny');
      if (!found) {
        console.log('no pending approval');
        break;
      }
      await found.click();
      console.log('denied');
      break;
    }
    default:
      console.error(`unknown op: ${op}`);
      console.error(
        `usage: node scripts/playwright/attach.mjs [--screenshot|--logs|--inspect|--hire|--approve|--deny] [args...]`,
      );
      process.exit(2);
  }

  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
