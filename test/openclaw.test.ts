import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_MD,
  createOpenClawSkill,
  openclawTool,
  sessionTreeToMarkdown,
  workspaceAgent,
} from "../src/adapters/openclaw.js";

describe("openclaw adapter", () => {
  it("exports expected skill markdown content", () => {
    assert.ok(SKILL_MD.includes("cpa:parallel"));
    assert.ok(SKILL_MD.includes("branch-fix-continue"));
  });

  it("openclawTool throws when gateway is not connected", async () => {
    const tool = openclawTool<string, string>({
      name: "search",
      tool: "search",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: unknown) => String(raw),
    });

    await assert.rejects(
      () => tool.invoke("q", new AbortController().signal),
      /Gateway not connected/
    );
  });

  it("workspaceAgent read and write methods throw when disconnected", async () => {
    const agent = workspaceAgent({ name: "memory" });
    const signal = new AbortController().signal;

    await assert.rejects(() => agent.readMemory.invoke("key", signal), /bridge not connected/);
    await assert.rejects(
      () => agent.writeMemory.invoke({ key: "k", value: "v" }, signal),
      /bridge not connected/
    );
  });

  it("handles parallel, branch-fix, fan-out and status commands", async () => {
    const events: unknown[] = [];
    const calls: Array<{ task: string; model?: string }> = [];

    const skill = createOpenClawSkill();
    const ctx = {
      session: {
        id: "s1",
        appendEvent: (event: unknown) => {
          events.push(event);
        },
      },
      agent: {
        run: async (task: string, opts?: { signal?: AbortSignal; model?: string }) => {
          calls.push({ task, model: opts?.model });
          if (task.startsWith("Fix the following issues:")) {
            return { output: "fixed" };
          }
          if (task === "make branch fix") {
            return { output: "draft", errors: ["lint"] };
          }
          return { output: `${task}:${opts?.model ?? "default"}` };
        },
      },
    };

    const parallel = await skill.handleCommand(
      "parallel",
      { tasks: ["t1", "t2"] },
      ctx
    );
    assert.equal(parallel.success, true);
    if (parallel.success) {
      assert.ok(Array.isArray(parallel.value));
      assert.equal((parallel.value as Array<unknown>).length, 2);
    }

    const branchFix = await skill.handleCommand(
      "branch-fix",
      { task: "make branch fix" },
      ctx
    );
    assert.equal(branchFix.success, true);
    if (branchFix.success) {
      assert.equal(branchFix.value, "draft");
    }

    const fanOut = await skill.handleCommand(
      "fan-out",
      { task: "compare", models: ["m1", "m2"] },
      ctx
    );
    assert.equal(fanOut.success, true);
    if (fanOut.success) {
      const value = fanOut.value as { results: string[]; consensus: number };
      assert.equal(value.consensus, 2);
      assert.equal(value.results.length, 2);
    }

    const status = await skill.handleCommand("status", {}, ctx);
    assert.equal(status.success, true);

    assert.ok(events.length > 0);
    assert.ok(calls.some((c) => c.task.startsWith("Fix the following issues:")));
  });

  it("throws for unknown command", async () => {
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s2" },
      agent: {
        run: async () => ({ output: "ok" }),
      },
    };

    await assert.rejects(
      () => skill.handleCommand("unknown", {}, ctx),
      /Unknown CPA command/
    );
  });

  it("renders session tree markdown", () => {
    const markdown = sessionTreeToMarkdown([
      {
        runId: "r1",
        name: "root",
        events: [
          { type: "branch", runId: "r1", chosen: "a", alternatives: ["a", "b"], ts: 1 },
          { type: "fix_start", runId: "r1", reason: "err", ts: 2 },
          { type: "done", runId: "r1", ts: 3 },
        ],
        children: [],
      },
    ]);

    assert.ok(markdown.includes("root"));
    assert.ok(markdown.includes('Branch: chose "a"'));
    assert.ok(markdown.includes("Fix started: err"));
  });
});
