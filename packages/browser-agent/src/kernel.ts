/**
 * A Kernel cloud browser with a recording, connected to Playwright over CDP.
 * The recording (MP4) is evidence: it is downloaded to recordings/ (gitignored) and its
 * Kernel replay ID and view URL are returned for the report.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Kernel from "@onkernel/sdk";
import { type Browser, type BrowserContext, chromium } from "playwright-core";

export interface Recording {
  replayId: string;
  viewUrl?: string;
  file?: string;
}

export interface KernelSession {
  sessionId: string;
  liveViewUrl?: string;
  browser: Browser;
  context: BrowserContext;
  /** Stop the recording, save it, and delete the cloud browser. Always call this. */
  close(saveDir?: string): Promise<Recording | undefined>;
}

/** Resolve with `p`, or reject after `ms`. The underlying work is abandoned, never awaited forever. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
      timer.unref?.();
    }),
  ]);
}

export async function openKernelSession(apiKey: string, opts: { timeoutSeconds?: number; maxRecordingSeconds?: number } = {}): Promise<KernelSession> {
  const kernel = new Kernel({ apiKey });
  const kb = await kernel.browsers.create({ stealth: false, timeout_seconds: opts.timeoutSeconds ?? 900 });
  let replayId: string | undefined;
  try {
    replayId = (await kernel.browsers.replays.start(kb.session_id, { max_duration_in_seconds: opts.maxRecordingSeconds ?? 900 })).replay_id;
  } catch {
    // Recording is best effort; the journey still runs and the report says it is missing.
    replayId = undefined;
  }
  const browser = await chromium.connectOverCDP(kb.cdp_ws_url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // Cloud browsers can get localized PayPal pages (e.g. Portuguese); ask for English so the
  // agent sees the same wording on every run.
  await context.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" }).catch(() => {});

  return {
    sessionId: kb.session_id,
    liveViewUrl: kb.browser_live_view_url,
    browser,
    context,
    async close(saveDir) {
      let recording: Recording | undefined;
      // Every step is time-boxed: closing must never hold a run past its time limit, even when the
      // cloud browser has already died (seen in a benchmark run that hung for 90 minutes).
      await withTimeout(
        (async () => {
          if (!replayId) return;
          await kernel.browsers.replays.stop(replayId, { id_or_name: kb.session_id });
          const list = await kernel.browsers.replays.list(kb.session_id);
          const meta = list.find((r) => r.replay_id === replayId);
          recording = { replayId, viewUrl: meta?.replay_view_url };
          if (saveDir) {
            const res = await kernel.browsers.replays.download(replayId, { id_or_name: kb.session_id });
            if (res.ok) {
              await mkdir(saveDir, { recursive: true });
              const file = join(saveDir, `${replayId}.mp4`);
              await writeFile(file, Buffer.from(await res.arrayBuffer()));
              recording.file = file;
            }
          }
        })(),
        90_000,
      ).catch(() => {
        // Keep whatever recording info we have.
      });
      await withTimeout(browser.close(), 10_000).catch(() => {});
      await withTimeout(kernel.browsers.deleteByID(kb.session_id), 20_000).catch(() => {});
      return recording;
    },
  };
}
