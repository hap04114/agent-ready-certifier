import { describe, expect, it } from "vitest";
import { funnelStage, judgeR3 } from "./funnel.js";

const order = (status: string, captures: string[] = []) => ({ id: "O1", status, captures: captures.map((s, i) => ({ id: `C${i}`, status: s })) });
const store = (status: string) => ({ paypalOrderId: "O1", status, captureIds: [], refundIds: [], fulfilmentCount: 0, webhookEvents: [] });

describe("R3 agent checkout funnel", () => {
  it("places each journey at its furthest PROVEN stage", () => {
    expect(funnelStage({ reachedStore: false, agentOutcome: "error" })).toBe("none");
    expect(funnelStage({ reachedStore: true, agentOutcome: "step_limit" })).toBe("store");
    expect(funnelStage({ reachedStore: true, order: order("PAYER_ACTION_REQUIRED"), agentOutcome: "agent_gave_up" })).toBe("paypal_opened");
    expect(funnelStage({ reachedStore: true, order: order("APPROVED"), agentOutcome: "agent_done" })).toBe("approved");
    // Captured but the store never recorded it as paid: not a finished purchase.
    expect(funnelStage({ reachedStore: true, order: order("COMPLETED", ["COMPLETED"]), store: store("capturing"), agentOutcome: "agent_done" })).toBe("approved");
    expect(funnelStage({ reachedStore: true, order: order("COMPLETED", ["COMPLETED"]), store: store("paid"), agentOutcome: "agent_done" })).toBe("paid");
  });

  it("passes only on a paid order, whatever the agent claims", () => {
    expect(judgeR3({ reachedStore: true, order: order("COMPLETED", ["COMPLETED"]), store: store("paid"), agentOutcome: "step_limit" }).status).toBe("pass");
    const v = judgeR3({ reachedStore: true, agentOutcome: "agent_done" });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toContain("Furthest stage: store");
  });
});
