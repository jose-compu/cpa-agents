import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { par } from "../src/process.js";
import { Scheduler } from "../src/scheduler.js";
import {
  parseJsonl,
  serializeTraceEvents,
  eventsToSessionTree,
  loadJsonl,
  loadJsonlTree,
  traceEventToJsonl,
} from "../src/jsonl.js";

describe("jsonl", () => {
  it("serializes and parses a trace event", () => {
    const event = {
      type: "spawn" as const,
      runId: "root_0",
      name: "workflow",
      ts: 1,
    };

    const line = traceEventToJsonl(event);
    assert.equal(line.endsWith("\n"), true);

    const parsed = parseJsonl(line);
    assert.deepEqual(parsed, [event]);
  });

  it("round-trips trace events through serializeTraceEvents", () => {
    const events = [
      { type: "spawn" as const, runId: "root_0", name: "root", ts: 1 },
      { type: "spawn" as const, runId: "par_1", parentId: "root_0", name: "par[0]", ts: 2 },
      { type: "done" as const, runId: "par_1", ts: 3 },
      { type: "done" as const, runId: "root_0", ts: 4 },
    ];

    const roundTripped = parseJsonl(serializeTraceEvents(events));
    assert.deepEqual(roundTripped, events);
  });

  it("rebuilds a session tree from events", () => {
    const events = [
      { type: "spawn" as const, runId: "root_0", name: "root", ts: 1 },
      { type: "spawn" as const, runId: "par_1", parentId: "root_0", name: "par[0]", ts: 2 },
      { type: "done" as const, runId: "par_1", ts: 3 },
    ];

    const tree = eventsToSessionTree(events);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, "root");
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].name, "par[0]");
  });

  it("scheduler attachJsonl writes events and loadJsonlTree reconstructs tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpa-jsonl-"));
    const path = join(dir, "session.jsonl");

    try {
      const scheduler = new Scheduler();
      const sink = scheduler.attachJsonl(path);

      const result = await scheduler.run(
        "jsonl-run",
        par(
          async () => 1,
          async () => 2
        )
      );

      await sink.close();

      assert.ok(result.success);
      const file = await readFile(path, "utf8");
      assert.ok(file.includes('"type":"spawn"'));
      assert.ok(file.includes("jsonl-run"));

      const loadedEvents = await loadJsonl(path);
      assert.ok(loadedEvents.length >= 3);

      const loadedTree = await loadJsonlTree(path);
      assert.equal(loadedTree[0].name, "jsonl-run");
      assert.ok(loadedTree[0].children.length >= 2);

      assert.deepEqual(
        loadedTree.map((n) => n.name),
        result.sessionTree.map((n) => n.name)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
