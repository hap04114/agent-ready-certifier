/**
 * The browser agent loop: observe the active page, ask the model for one action (schema-validated
 * JSON), execute it with Playwright, repeat. The agent's own "done" is NOT a verdict; it only ends
 * the journey. Whether a purchase happened is decided later by the truth checker from PayPal records.
 */
import type { BrowserContext, Frame, Page } from "playwright-core";
import { type ChatMessage, type LlmConfig, askJson } from "@certifier/llm";
import { type AgentAction, type ElementInfo, type Observation, SYSTEM_PROMPT, agentAction, collectInFrame, orderIdsFromUrl, renderObservation } from "./observe.js";

export interface BuyerCredentials {
  email: string;
  password: string;
}

export interface JourneyStep {
  n: number;
  url: string;
  action: AgentAction["action"];
  element?: number;
  thought: string;
  error?: string;
}

export interface JourneyResult {
  outcome: "agent_done" | "agent_gave_up" | "step_limit" | "error";
  steps: JourneyStep[];
  /** PayPal order IDs seen in PayPal checkout URLs during the journey. */
  paypalOrderIds: string[];
  error?: string;
}

export interface JourneyOptions {
  context: BrowserContext;
  startUrl: string;
  mission: string;
  llm: LlmConfig;
  buyer: BuyerCredentials;
  /** Removes secrets from anything shown to the model. */
  scrub: (s: string) => string;
  maxSteps?: number;
  log?: (line: string) => void;
}

export async function runJourney(opts: JourneyOptions): Promise<JourneyResult> {
  const { context } = opts;
  const log = opts.log ?? (() => {});
  const orderIds = new Set<string>();
  const pages: Page[] = [];
  const track = (p: Page) => {
    pages.push(p);
    p.on("framenavigated", (f) => {
      for (const id of orderIdsFromUrl(f.url())) orderIds.add(id);
    });
  };
  context.on("page", track);
  context.on("request", (r) => {
    for (const id of orderIdsFromUrl(r.url())) orderIds.add(id);
  });

  const first = context.pages()[0] ?? (await context.newPage());
  track(first);

  const active = () => [...pages].reverse().find((p) => !p.isClosed()) ?? first;
  const steps: JourneyStep[] = [];
  const history: string[] = [];
  const max = opts.maxSteps ?? 30;

  try {
    await first.goto(opts.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let n = 1; n <= max; n++) {
      const page = active();
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const { obs, frames } = await observe(page);

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Mission: ${opts.mission}`,
            history.length ? `Your previous actions:\n${history.slice(-8).join("\n")}` : "",
            renderObservation(obs, opts.scrub),
            "Reply with the next action as JSON.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
      const act = await askJson(opts.llm, messages, agentAction);
      const step: JourneyStep = { n, url: opts.scrub(page.url()), action: act.action, element: act.element, thought: opts.scrub(act.thought) };
      log(`  [agent] ${n}. ${act.action}${act.element !== undefined ? ` #${act.element}` : ""} — ${step.thought}`);

      if (act.action === "done" || act.action === "give_up") {
        steps.push(step);
        return { outcome: act.action === "done" ? "agent_done" : "agent_gave_up", steps, paypalOrderIds: [...orderIds] };
      }
      try {
        await execute(page, frames, obs.elements, act, opts.buyer);
      } catch (err) {
        step.error = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 160) : "action failed";
      }
      steps.push(step);
      history.push(`${n}. ${act.action}${act.element !== undefined ? ` #${act.element}` : ""}${step.error ? ` (failed: ${step.error})` : ""}`);
    }
    return { outcome: "step_limit", steps, paypalOrderIds: [...orderIds] };
  } catch (err) {
    return { outcome: "error", steps, paypalOrderIds: [...orderIds], error: err instanceof Error ? opts.scrub(err.message.split("\n")[0]!) : "unknown" };
  } finally {
    context.off("page", track);
  }
}

async function observe(page: Page): Promise<{ obs: Observation; frames: Map<number, Frame> }> {
  const frames = new Map<number, Frame>();
  const elements: ElementInfo[] = [];
  let text = "";
  let next = 0;
  for (const frame of page.frames()) {
    try {
      const res = await frame.evaluate(collectInFrame, next);
      const name = frame === page.mainFrame() ? "main" : `frame ${hostOf(frame.url())}`;
      for (const e of res.elements) {
        elements.push({ ...e, frame: name });
        frames.set(e.id, frame);
      }
      next += res.elements.length;
      if (frame === page.mainFrame()) text = res.text;
    } catch {
      // Detached or inaccessible frame: skip it.
    }
  }
  return { obs: { url: page.url(), title: await page.title().catch(() => ""), elements, text }, frames };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "unknown";
  }
};

async function execute(page: Page, frames: Map<number, Frame>, elements: ElementInfo[], act: AgentAction, buyer: BuyerCredentials) {
  const needsElement = ["click", "type", "select", "fill_buyer_email", "fill_buyer_password"].includes(act.action);
  const frame = act.element !== undefined ? frames.get(act.element) : undefined;
  if (needsElement && (!frame || !elements.some((e) => e.id === act.element))) throw new Error(`no element #${act.element}`);
  const target = frame?.locator(`[data-cert-id="${act.element}"]`).first();
  switch (act.action) {
    case "click":
      await target!.click({ timeout: 10_000 });
      break;
    case "type":
      await target!.fill(act.text ?? "", { timeout: 10_000 });
      break;
    case "select":
      await target!.selectOption({ label: act.text ?? "" }, { timeout: 10_000 }).catch(() => target!.selectOption(act.text ?? "", { timeout: 10_000 }));
      break;
    // Credentials are filled by code. The model never sees or types them.
    case "fill_buyer_email":
      await target!.fill(buyer.email, { timeout: 10_000 });
      break;
    case "fill_buyer_password":
      await target!.fill(buyer.password, { timeout: 10_000 });
      break;
    case "press_enter":
      if (target) await target.press("Enter", { timeout: 10_000 });
      else await page.keyboard.press("Enter");
      break;
    case "scroll":
      await page.mouse.wheel(0, 700);
      break;
    case "wait":
      await page.waitForTimeout(3000);
      break;
  }
}
