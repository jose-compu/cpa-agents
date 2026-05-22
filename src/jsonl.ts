/**
 * JSONL trace serialization for session trees.
 */

import { readFile, appendFile } from "node:fs/promises";
import {
  type TraceEvent,
  type SessionNode,
  TraceCollector,
} from "./process.js";

/** Serialize a single trace event as one JSONL line. */
export function traceEventToJsonl(event: TraceEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Parse JSONL content into trace events. */
export function parseJsonl(content: string): TraceEvent[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

/** Serialize an array of trace events to JSONL. */
export function serializeTraceEvents(events: TraceEvent[]): string {
  return events.map((e) => traceEventToJsonl(e).trimEnd()).join("\n") + "\n";
}

/** Rebuild a session tree from a flat trace event list. */
export function eventsToSessionTree(events: TraceEvent[]): SessionNode[] {
  const collector = new TraceCollector();
  for (const event of events) {
    collector.emit(event);
  }
  return collector.toTree();
}

/** Load trace events from a JSONL file. */
export async function loadJsonl(path: string): Promise<TraceEvent[]> {
  const content = await readFile(path, "utf8");
  return parseJsonl(content);
}

/** Load a session tree from a JSONL file. */
export async function loadJsonlTree(path: string): Promise<SessionNode[]> {
  return eventsToSessionTree(await loadJsonl(path));
}

/** Append trace events to a JSONL file as they arrive. */
export class JsonlTraceSink {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(event: TraceEvent): void {
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.path, traceEventToJsonl(event), "utf8")
    );
  }

  async close(): Promise<void> {
    await this.writeChain;
  }
}
