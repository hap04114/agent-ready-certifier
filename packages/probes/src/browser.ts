/**
 * Browser measurements for the Current pillar (no AI involved): where the PayPal button sits
 * relative to the first screen, and whether Pay Later messaging and the Venmo button render.
 */
import type { BrowserContext, Frame, Page } from "playwright-core";
import type { ControlFacts, StorefrontObservation } from "@certifier/truth";

export const DESKTOP = { width: 1280, height: 800 };

/**
 * Text PayPal shows in a Pay Later MESSAGE ("Pay in 4", "4 interest-free payments"). Not "Pay
 * Later" alone: that is also the label of the Pay Later funding button, which is not a message.
 */
export const PAY_LATER_TEXT = /pay in 4\b|interest-free payments|pay monthly with/i;

async function anyFrameText(frames: Frame[], pattern: RegExp): Promise<boolean> {
  for (const f of frames) {
    try {
      // biome-ignore lint/performance/useDomNodeTextContent: innerText is what a shopper sees.
      if (pattern.test(await f.evaluate(() => document.body?.innerText ?? ""))) return true;
    } catch {
      // detached or not ready
    }
  }
  return false;
}

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

/**
 * A5: runs inside the store's page. Collects raw naming facts for each visible interactive
 * control in the store's OWN document (PayPal's button/message iframes are PayPal's, so they are
 * skipped). Never reads what a user typed; plain code decides from these facts.
 */
export function collectControls(): ControlFacts[] {
  const sel = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="spinbutton"]';
  // biome-ignore lint/performance/useDomNodeTextContent: innerText is the visible text an agent or screen reader gets.
  const text = (el: Element | null | undefined) => (el ? ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : "");
  const out: ControlFacts[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel)).slice(0, 200)) {
    if (el.closest('.paypal-buttons, [id^="zoid-paypal"], [data-pp-message]')) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === "hidden" || cs.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type")?.toLowerCase() ?? undefined;
    const isField = tag === "input" || tag === "select" || tag === "textarea";
    const labels = isField ? Array.from((el as HTMLInputElement).labels ?? []) : [];
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const img = el.querySelector("img[alt], svg title, svg[aria-label]");
    out.push({
      tag,
      type,
      role: el.getAttribute("role") ?? undefined,
      ariaLabel: el.getAttribute("aria-label") ?? undefined,
      labelledbyText: ids.map((id) => text(document.getElementById(id))).join(" ") || undefined,
      labelText: labels.map((l) => text(l)).join(" ") || undefined,
      buttonValue: tag === "input" && ["submit", "button", "reset"].includes(type ?? "") ? (el as HTMLInputElement).value : undefined,
      alt: el.getAttribute("alt") ?? undefined,
      title: el.getAttribute("title") ?? undefined,
      placeholder: el.getAttribute("placeholder") ?? undefined,
      text: isField ? undefined : text(el),
      innerImgName: img ? (img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? img.textContent ?? undefined) : undefined,
      hint: `${tag}${el.id ? `#${el.id}` : el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : el.classList[0] ? `.${el.classList[0]}` : ""}${type && tag === "input" ? `[type=${type}]` : ""}`.slice(0, 60),
    });
  }
  return out;
}

/**
 * Run one of our functions inside the page. tsx/esbuild (keepNames) wraps named inner functions
 * in a `__name(...)` helper that does not exist in the browser, so define a no-op first.
 * (Found by running collectControls in a real browser: "__name is not defined".)
 */
export async function evaluateInPage<T>(page: Page, fn: () => T): Promise<T> {
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  return page.evaluate(fn);
}

/** A local Chromium-family browser (Edge or Chrome), for sites a cloud browser cannot reach (localhost staging). */
export async function launchLocalBrowser() {
  const { chromium } = await import("playwright-core");
  const { existsSync } = await import("node:fs");
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const executablePath = candidates.find((p) => existsSync(p));
  if (!executablePath) throw new Error("no local Edge or Chrome found");
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" } });
  return { browser, context, name: executablePath.toLowerCase().includes("edge") ? "local Edge" : "local Chrome" };
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
    // Pay Later messaging comes two ways: the separate messages component (its own iframe), or
    // the newer button-integrated message (Buttons({ message })) rendered INSIDE the buttons
    // iframe. PayPal's own standard-integration example uses the second; missing it was a false
    // alarm found by testing that example.
    const messageFrame = (await page.locator('iframe[title*="PayPal Message" i], iframe[name^="__zoid__paypal_message"], [data-pp-message] iframe').count().catch(() => 0)) > 0;
    const buttonMessage = await anyFrameText(frames.filter((f) => f.name().startsWith("__zoid__paypal_buttons")), PAY_LATER_TEXT);
    const payLaterMessageRendered = messageFrame || buttonMessage;
    const venmoButtonRendered = await anyFrame(frames, '[data-funding-source="venmo"]');
    const controls = await evaluateInPage(page, collectControls).catch(() => undefined);
    return {
      viewport: DESKTOP,
      paypalButton: box ? { top: box.y + scrollY, bottom: box.y + scrollY + box.height } : undefined,
      payLaterMessageRendered,
      venmoButtonRendered,
      controls,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
