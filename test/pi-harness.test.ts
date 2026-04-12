import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPiCpaExtension,
  piSubAgent,
  piTool,
} from "../src/adapters/pi-harness.js";

describe("pi-harness adapter", () => {
  it("piTool throws when bridge is not connected", async () => {
    const tool = piTool<string, string>({
      name: "lint",
      tool: "lint",
      buildArgs: (input: string) => ({ input }),
      parseResult: (raw: string) => raw,
    });

    await assert.rejects(
      () => tool.invoke("input", new AbortController().signal),
      /RPC bridge not connected/
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
      /sub-agent bridge not connected/
    );
  });

  it("creates extension metadata and command handlers", async () => {
    const ext = createPiCpaExtension();
    assert.equal(ext.name, "cpa-agents");
    assert.equal(ext.version, "0.1.0");

    const logLines: string[] = [];
    const piCtx = {
      log: (msg: string) => {
        logLines.push(msg);
      },
    };

    const treeResult = await ext.commands["cpa:tree"].handler("", piCtx);
    assert.deepEqual(treeResult, { message: "Session tree display (see trace output)" });

    const fixResult = await ext.commands["cpa:fix"].handler("implement x", piCtx);
    assert.equal(fixResult.success, true);
    if (fixResult.success) {
      assert.equal(typeof fixResult.value, "string");
      assert.ok(fixResult.value.includes("implement x"));
    }

    const parResult = await ext.commands["cpa:par"].handler("task-a | task-b", piCtx);
    assert.equal(parResult.success, false);
    if (!parResult.success) {
      assert.ok(parResult.error.message.includes("bridge not connected"));
    }
    assert.ok(logLines.length > 0);
  });
});
