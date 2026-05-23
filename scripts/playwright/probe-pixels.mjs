import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
  if (!p.url().startsWith('devtools://')) { page = p; break; }
}
if (page) {
  const out = await page.evaluate(() => {
    const canvas = document.querySelector('.scene-pane canvas');
    if (!canvas) return { err: 'no canvas' };
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(canvas, 0, 0);
    // Sample full canvas in 60x60 tiles for color distribution
    const W = canvas.width, H = canvas.height;
    const samples = [];
    for (let y = 0; y < H; y += 60) for (let x = 0; x < W; x += 60) {
      const d = tmp.getContext('2d').getImageData(x, y, 1, 1).data;
      samples.push({ x, y, r: d[0], g: d[1], b: d[2] });
    }
    // Look for white pixels (worker shirt is white)
    const whites = samples.filter(s => s.r > 200 && s.g > 200 && s.b > 200);
    return { width: W, height: H, sampleCount: samples.length, whitePixelTiles: whites.length, whites: whites.slice(0, 6) };
  });
  console.log(JSON.stringify(out, null, 2));
}
await browser.close();
