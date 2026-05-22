import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_MD,
  configureOpenClawBridge,
  createOpenClawSkill,
  openclawTool,
  sessionTreeToMarkdown,
  workspaceAgent,
} from "../src/adapters/openclaw.js";
import { VERSION } from "../src/version.js";

describe("openclaw adapter", () => {
  afterEach(() => {
    configureOpenClawBridge(undefined);
  });
  it("exports expected skill markdown content", () => {
    assert.ok(SKILL_MD.includes("cpa:parallel"));
    assert.ok(SKILL_MD.includes("## Install"));
  });

  it("exposes consistent wrapper names and skill metadata", () => {
    const tool = openclawTool<string, string>({
      name: "search",
      tool: "search",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: unknown) => String(raw),
    });
    assert.equal(tool.name, "openclaw:search");

    const wa = workspaceAgent({ name: "memory" });
    assert.equal(wa.readMemory.name, "workspace:read:memory");
    assert.equal(wa.writeMemory.name, "workspace:write:memory");

    const skill = createOpenClawSkill();
    assert.equal(skill.name, "cpa-agents");
    assert.equal(skill.version, VERSION);
    assert.ok(skill.skillMd.includes("cpa:branch-fix"));
  });

  it("openclawTool throws when bridge is not connected", async () => {
    const tool = openclawTool<string, string>({
      name: "search",
      tool: "search",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: unknown) => String(raw),
    });

    await assert.rejects(
      () => tool.invoke("q", new AbortController().signal),
      /OpenClaw bridge not connected/
    );
  });

  it("openclawTool and workspaceAgent work when bridge is configured", async () => {
    configureOpenClawBridge({
      runTool: async (_tool, args) => args,
      readMemory: async (key) => `value:${key}`,
      writeMemory: async () => {},
    });

    const tool = openclawTool<string, string>({
      name: "search",
      tool: "search",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: unknown) => String(raw),
    });
    assert.equal(await tool.invoke("q", new AbortController().signal), "[object Object]");

    const agent = workspaceAgent({ name: "memory" });
    assert.equal(await agent.readMemory.invoke("key", new AbortController().signal), "value:key");
    await agent.writeMemory.invoke({ key: "k", value: "v" }, new AbortController().signal);
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

  it("branch-fix does not call fixer when agent returns no errors", async () => {
    const calls: string[] = [];
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s-no-fix" },
      agent: {
        run: async (task: string) => {
          calls.push(task);
          return { output: "clean", errors: [] as string[] };
        },
      },
    };

    const result = await skill.handleCommand(
      "branch-fix",
      { task: "clean task" },
      ctx
    );

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.value, "clean");
    }
    assert.deepEqual(calls, ["clean task"]);
  });

  it("fan-out uses default models when models arg is missing", async () => {
    const calledModels: string[] = [];
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s-default-models" },
      agent: {
        run: async (_task: string, opts?: { signal?: AbortSignal; model?: string }) => {
          if (opts?.model) calledModels.push(opts.model);
          return { output: `out:${opts?.model ?? "none"}` };
        },
      },
    };

    const result = await skill.handleCommand(
      "fan-out",
      { task: "compare defaults" },
      ctx
    );

    assert.equal(result.success, true);
    if (result.success) {
      const value = result.value as { results: string[]; consensus: number };
      assert.equal(value.consensus, 2);
    }
    assert.deepEqual(calledModels, ["claude-sonnet-4-20250514", "gpt-4o"]);
  });

  it("retry command retries and eventually succeeds", async () => {
    let attempts = 0;
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s-retry" },
      agent: {
        run: async (_task: string) => {
          attempts++;
          if (attempts < 3) {
            return { output: "bad", errors: ["transient"] };
          }
          return { output: "ok" };
        },
      },
    };

    const result = await skill.handleCommand(
      "retry",
      { task: "flaky", maxAttempts: 4, initialDelayMs: 1, stepTimeout: 2000 },
      ctx
    );

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.value, "ok");
    }
    assert.equal(attempts, 3);
  });

  it("fallback command runs fallback when primary fails", async () => {
    const calls: string[] = [];
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s-fallback" },
      agent: {
        run: async (task: string) => {
          calls.push(task);
          if (task === "primary-task") {
            return { output: "bad", errors: ["fail"] };
          }
          return { output: "fallback-ok" };
        },
      },
    };

    const result = await skill.handleCommand(
      "fallback",
      { primary: "primary-task", fallback: "fallback-task" },
      ctx
    );

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.value, "fallback-ok");
    }
    assert.deepEqual(calls, ["primary-task", "fallback-task"]);
  });

  it("saga command triggers rollback when a step fails", async () => {
    const calls: string[] = [];
    const skill = createOpenClawSkill();
    const ctx = {
      session: { id: "s-saga" },
      agent: {
        run: async (task: string) => {
          calls.push(task);
          if (task === "step-2") {
            return { output: "bad", errors: ["boom"] };
          }
          return { output: "ok" };
        },
      },
    };

    const result = await skill.handleCommand(
      "saga",
      { steps: ["step-1", "step-2"] },
      ctx
    );

    assert.equal(result.success, false);
    assert.ok(calls.includes("step-1"));
    assert.ok(calls.includes("step-2"));
    assert.ok(calls.some((c) => c.includes("Rollback/undo the effects of this step: step-1")));
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

  it("renders error and running statuses in markdown tree", () => {
    const markdown = sessionTreeToMarkdown([
      {
        runId: "root",
        name: "root-node",
        events: [{ type: "error", runId: "root", error: "boom", ts: 1 }],
        children: [
          {
            runId: "child",
            name: "child-node",
            events: [{ type: "spawn", runId: "child", name: "child", ts: 2 }],
            children: [],
          },
        ],
      },
    ]);

    assert.ok(markdown.includes("root-node"));
    assert.ok(markdown.includes("[error]"));
    assert.ok(markdown.includes("child-node"));
    assert.ok(markdown.includes("[running]"));
  });
});
