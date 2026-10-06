/**
 * Renders an HTML string to a PNG with Cloudflare Browser Rendering.
 *
 * One browser per render, closed right after. Browser time is billed while a
 * browser is open (10 free hours a month on Workers Paid, then $0.09/hour),
 * so keeping idle sessions alive would cost more than relaunching at
 * WildHeavy's volume. Each finished PNG is edge-cached by the caller.
 *
 * The page sets window.__WH_READY once fonts, photos and text fitting are
 * done, and window.__WH_FONTS_OK=false if the handwriting face fell back.
 * A card in the wrong font is treated as a failure, never shipped.
 */
import puppeteer from '@cloudflare/puppeteer';

export async function renderInBrowser(binding, html, width, height) {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction('window.__WH_READY === true', { timeout: 12000 });
    const fontsOk = await page.evaluate('window.__WH_FONTS_OK');
    if (!fontsOk) throw new Error('fonts_not_loaded');
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}
