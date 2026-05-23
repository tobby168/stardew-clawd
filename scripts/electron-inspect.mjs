import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    if (p.url().startsWith('http')) { page = p; break; }
  }
  if (page) break;
}
if (!page) { console.error('renderer page not found'); process.exit(2); }
console.log('attached to:', page.url());

await page.waitForTimeout(800);

// Inspect React props/state for the session list — read through React fiber.
const sessionsAndCam = await page.evaluate(() => {
  const root = document.getElementById('root');
  // Drill into React's fiber to find the App's sessions.
  // @ts-ignore
  const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
  // @ts-ignore
  let fiber = root[key]?.stateNode?.current;
  // Walk to find the App component
  const seen = new Set();
  function findApp(node, depth = 0) {
    if (!node || depth > 20 || seen.has(node)) return null;
    seen.add(node);
    if (node.memoizedProps && Array.isArray(node.memoizedProps.sessions)) {
      return node;
    }
    return findApp(node.child, depth+1) || findApp(node.sibling, depth+1);
  }
  // try child traversal
  const summary = {
    cam: window.__camera?.(),
    sessions: null,
    workerCount: 0,
  };
  try {
    const appNode = findApp(fiber, 0);
    if (appNode?.memoizedProps?.sessions) {
      const sessions = appNode.memoizedProps.sessions;
      summary.sessions = sessions.map((s) => ({ id: s.sessionId, deskId: s.deskId, activity: s.activity }));
      summary.workerCount = sessions.length;
    }
  } catch (e) { summary.err = String(e); }
  return summary;
});
console.log('STATE:', JSON.stringify(sessionsAndCam, null, 2));

writeFileSync('/tmp/electron-bundles.png', await page.screenshot());

await browser.close();
