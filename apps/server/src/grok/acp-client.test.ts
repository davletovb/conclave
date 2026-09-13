import { describe, expect, it } from "vitest";
import { GROK_AGENT_ARGS, permissionDenialResult } from "./acp-client.js";

describe("Grok ACP compatibility", () => {
  it("launches the documented agent stdio form without TUI/headless-only permission flags", () => {
    expect(GROK_AGENT_ARGS).toEqual(["agent", "stdio"]);
    expect(GROK_AGENT_ARGS).not.toContain("--deny");
    expect(GROK_AGENT_ARGS).not.toContain("--disallowed-tools");
  });

  it("selects reject-once for ACP permission requests", () => {
    expect(permissionDenialResult({
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    })).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "reject",
      },
    });
  });

  it("fails closed when the agent does not offer a reject option", () => {
    expect(permissionDenialResult({
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    })).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
