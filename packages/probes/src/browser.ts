/**
 * Browser measurements for the Current pillar (no AI involved): where the PayPal button sits
 * relative to the first screen, and whether Pay Later messaging and the Venmo button render.
 */
import type { BrowserContext, Frame } from "playwright-core";
import type { StorefrontObservation } from "@certifier/truth";

export const DESKTOP = { width: 1280, height: 800 };

async function anyFrame(frames: Frame[], selector: string): Promise<boolean> {
  for (const f of frames) {
    try {
      if ((await f.locator(selector).count()) > 0) return true;
    } catch {
      // detached frame
    }
  }
  return false;
}

export async function measureStorefront(context: BrowserContext, url: string): Promise<NonNullable<StorefrontObservation["rendered"]>> {
  const page = await context.newPage();
  try {
    await page.setViewportSize(DESKTOP);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // The PayPal SDK renders buttons inside iframes from paypal.com.
    const buttonFrame = page.locator('iframe[src*="paypal.com"][title*="PayPal" i], .paypal-buttons iframe, iframe[name^="__zoid__paypal_buttons"]').first();
    await buttonFrame.waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const box = await buttonFrame.boundingBox().catch(() => null);
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
    const frames = page.frames();
    const payLaterMessageRendered =
      (await page.locator('iframe[title*="PayPal Message" i], iframe[name^="__zoid__paypal_message"], [data-pp-message] iframe').count().catch(() => 0)) > 0;
    const venmoButtonRendered = await anyFrame(frames, '[data-funding-source="venmo"]');
    return {
      viewport: DESKTOP,
      paypalButton: box ? { top: box.y + scrollY, bottom: box.y + scrollY + box.height } : undefined,
      payLaterMessageRendered,
      venmoButtonRendered,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
