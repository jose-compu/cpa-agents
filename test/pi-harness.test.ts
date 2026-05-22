import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  configurePiBridge,
  createPiBridgeFromAgent,
  createPiCpaExtension,
  type PiAgentRuntime,
  type PiHostContext,
  piSubAgent,
  piTool,
} from "../src/adapters/pi-harness.js";
import { VERSION } from "../src/version.js";

function mockAgent(
  impl?: (task: string, model?: string) => { output: string; errors?: string[] }
): PiAgentRuntime {
  return {
    run: async (task, opts) => {
      if (impl) return impl(task, opts?.model);
      return { output: `done: ${task}` };
    },
  };
}

function mockPiCtx(agent: PiAgentRuntime, id = "s1"): PiHostContext {
  const events: unknown[] = [];
  return {
    session: {
      id,
      appendEvent: (event) => {
        events.push(event);
      },
    },
    log: () => {},
    agent,
  };
}

describe("pi-harness adapter", () => {
  afterEach(() => {
    configurePiBridge(undefined);
  });

  it("piTool throws when bridge is not connected", async () => {
    const tool = piTool<string, string>({
      name: "lint",
      tool: "lint",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: string) => raw,
    });

    await assert.rejects(
      () => tool.invoke("input", new AbortController().signal),
      /Pi bridge not connected/
    );
  });

  it("piSubAgent throws when bridge is not connected", async () => {
    const sub = piSubAgent<string>({
      name: "child",
      prompt: "do work",
      parseResult: (out: string) => out,
    });

    await assert.rejects(
      () => sub.invoke(undefined, new AbortController().signal),
      /Pi bridge not connected/
    );
  });

  it("piTool and piSubAgent work when bridge is configured", async () => {
    configurePiBridge({
      runSubAgent: async ({ prompt }) => `sub:${prompt}`,
      runTool: async ({ tool, args }) => JSON.stringify({ tool, args }),
    });

    const tool = piTool<string, string>({
      name: "lint",
      tool: "lint",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: string) => raw,
    });
    assert.equal(await tool.invoke("x", new AbortController().signal), '{"tool":"lint","args":{"input":"x"}}');

    const sub = piSubAgent<string>({
      name: "child",
      prompt: "do work",
      parseResult: (out: string) => out,
    });
    assert.equal(await sub.invoke(undefined, new AbortController().signal), "sub:do work");
  });

  it("createPiBridgeFromAgent maps agent.run to bridge", async () => {
    const bridge = createPiBridgeFromAgent({
      run: async (task) => ({ output: `agent:${task}` }),
    });
    const sub = piSubAgent<string>({
      name: "child",
      prompt: "hello",
      parseResult: (out) => out,
      bridge,
    });
    assert.equal(await sub.invoke(undefined, new AbortController().signal), "agent:hello");
  });

  it("creates extension metadata and command handlers", async () => {
    const ext = createPiCpaExtension();
    assert.equal(ext.name, "cpa-agents");
    assert.equal(ext.version, VERSION);
    assert.ok(ext.commands["cpa:par"].description.includes("parallel"));
    assert.ok(ext.commands["cpa:fix"].description.includes("fix-on-error"));
    assert.ok(ext.commands["cpa:tree"].description.includes("session tree"));
    assert.ok(ext.commands["cpa:retry"].description.includes("Retry"));
    assert.ok(ext.commands["cpa:fallback"].description.includes("fallback"));
    assert.ok(ext.commands["cpa:saga"].description.includes("rollback"));
    assert.ok(ext.commands["cpa:fan-out"].description.includes("models"));
  });

  it("extension commands require piCtx.agent", async () => {
    const ext = createPiCpaExtension();
    await assert.rejects(
      () => ext.commands["cpa:par"].handler("task-a | task-b", {}),
      /agent runtime not connected/
    );
  });

  it("cpa:par runs tasks through piCtx.agent", async () => {
    const ext = createPiCpaExtension();
    const calls: string[] = [];
    const ctx = mockPiCtx(
      mockAgent((task) => {
        calls.push(task);
        return { output: task };
      })
    );

    const parResult = await ext.commands["cpa:par"].handler("task-a | task-b", ctx);
    assert.equal(parResult.success, true);
    assert.deepEqual(calls.sort(), ["task-a", "task-b"]);
  });

  it("cpa:par handles spaced and empty segments defensively", async () => {
    const ext = createPiCpaExtension();
    const ctx = mockPiCtx(mockAgent());
    const parResult = await ext.commands["cpa:par"].handler("  task-a  |   | task-c ", ctx);

    assert.equal(parResult.success, true);
    if (parResult.success) {
      assert.deepEqual(parResult.value, ["done: task-a", "done: task-c"]);
    }
  });

  it("cpa:fix runs branch-fix through piCtx.agent", async () => {
    const ext = createPiCpaExtension();
    let fixCalled = false;
    const ctx = mockPiCtx(
      mockAgent((task) => {
        if (task.startsWith("Fix the following issues:")) {
          fixCalled = true;
          return { output: "fixed" };
        }
        if (task === "ship feature") {
          return { output: "draft", errors: ["lint"] };
        }
        return { output: task };
      })
    );

    const fixResult = await ext.commands["cpa:fix"].handler("ship feature", ctx);
    assert.equal(fixResult.success, true);
    assert.ok(fixCalled);
    if (fixResult.success) {
      assert.equal(fixResult.value, "draft");
    }
  });

  it("cpa:tree returns markdown for the last run", async () => {
    const ext = createPiCpaExtension();
    const ctx = mockPiCtx(mockAgent());

    await ext.commands["cpa:par"].handler("task-a | task-b", ctx);
    const treeResult = await ext.commands["cpa:tree"].handler("", ctx);

    assert.ok(Array.isArray(treeResult.tree));
    assert.ok(treeResult.tree.length > 0);
    assert.ok(treeResult.markdown.includes("par"));
  });

  it("pi wrappers expose expected names", () => {
    const tool = piTool<string, string>({
      name: "lint",
      tool: "lint",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: string) => raw,
    });
    assert.equal(tool.name, "pi:lint");

    const sub = piSubAgent<string>({
      name: "child",
      prompt: "work",
      parseResult: (out: string) => out,
    });
    assert.equal(sub.name, "pi:subagent:child");
  });

  it("operator-like commands run through piCtx.agent", async () => {
    const ext = createPiCpaExtension();
    const ctx = mockPiCtx(
      mockAgent((task) => {
        if (task === "always fail") throw new Error("boom");
        return { output: task };
      })
    );

    const retry = await ext.commands["cpa:retry"].handler("retry task", ctx);
    assert.equal(retry.success, true);

    const fallback = await ext.commands["cpa:fallback"].handler(
      "always fail || fallback task",
      ctx
    );
    assert.equal(fallback.success, true);
    if (fallback.success) {
      assert.equal(fallback.value, "fallback task");
    }

    const saga = await ext.commands["cpa:saga"].handler("step-a | step-b", ctx);
    assert.equal(saga.success, true);
  });
});
