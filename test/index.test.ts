import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

describe("index exports", () => {
  it("re-exports core API symbols", () => {
    assert.equal(typeof api.Channel, "function");
    assert.equal(typeof api.par, "function");
    assert.equal(typeof api.seq, "function");
    assert.equal(typeof api.choice, "function");
    assert.equal(typeof api.branchFix, "function");
    assert.equal(typeof api.restrict, "function");
    assert.equal(typeof api.replicate, "function");
    assert.equal(typeof api.supervisor, "function");
    assert.equal(typeof api.Scheduler, "function");
    assert.equal(typeof api.agentProcess, "function");
    assert.equal(typeof api.codeThenFix, "function");
    assert.equal(typeof api.fanOut, "function");
    assert.equal(typeof api.pipeline, "function");
    assert.equal(typeof api.handoff, "function");
    assert.equal(typeof api.parseJsonl, "function");
    assert.equal(typeof api.loadJsonlTree, "function");
    assert.equal(typeof api.eventsToSessionTree, "function");
  });
});
