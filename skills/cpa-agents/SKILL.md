# CPA Agents for OpenClaw

**Skill version:** 2.1.0  
**Requires:** `cpa-agents@0.3.0` or newer

Use concurrent process algebra for multi-agent orchestration in OpenClaw: parallel execution,
branch-fix loops, model fan-out, retries, fallbacks, rollback sagas, and session-tree introspection.

## Install

### 1) Install library

```bash
npm install cpa-agents@0.3.0
```

### 2) Create skill entrypoint

```ts
import { createOpenClawSkill } from "cpa-agents/adapters/openclaw";

export default createOpenClawSkill();
```

The skill object exposes:

- `name` — `"cpa-agents"`
- `version` — library version from the installed package (e.g. `0.3.0`; distinct from this skill doc **2.1.0**)
- `skillMd` — embedded markdown reference
- `handleCommand(command, args, openclawCtx)` — runs CPA workflows

### 3) Host runtime (required)

Commands delegate to the OpenClaw host agent. Your skill host must provide:

```ts
interface OpenClawContext {
  session?: {
    id: string;
    appendEvent?: (event: TraceEvent) => void; // trace streaming
  };
  agent: {
    run: (
      task: string,
      opts?: { signal?: AbortSignal; model?: string }
    ) => Promise<{ output: string; errors?: string[] }>;
  };
}
```

- `agent.run()` is **required** for all skill commands.
- Return `{ errors: [...] }` from `run()` to signal fixable failures (used by `branch-fix`).
- `session.appendEvent` is optional but recommended for live trace trees.

### 4) Standalone factories (optional)

For custom workflows outside `handleCommand`, wire gateway helpers explicitly:

```ts
import { configureOpenClawBridge, openclawTool, workspaceAgent } from "cpa-agents/adapters/openclaw";

configureOpenClawBridge({
  runTool: async (tool, args, signal) => gateway.callTool(tool, args, { signal }),
  readMemory: async (key, signal) => gateway.readMemory(key, { signal }),
  writeMemory: async (input, signal) => gateway.writeMemory(input, { signal }),
});
```

Without `configureOpenClawBridge()` (or a per-factory `bridge` option), `openclawTool` and
`workspaceAgent` throw `"OpenClaw bridge not connected"`.

## Invoking commands

Call `skill.handleCommand(command, args, ctx)` with these command names:

| Command | Purpose |
|---|---|
| `parallel` | Run independent tasks concurrently |
| `branch-fix` | Run task, fix on errors, continue |
| `fan-out` | Same task across multiple models |
| `retry` | Exponential backoff + per-attempt timeout |
| `fallback` | Primary task with fallback on failure |
| `saga` | Multi-step workflow with rollback |
| `status` | Current session process tree |

Global default: `timeout` = `300000` ms (5 min) on any command that accepts it.

---

### `parallel`

```json
{
  "tasks": ["analyze failing tests", "draft fix proposal", "write migration notes"],
  "timeout": 300000
}
```

Returns merged parallel results via `SchedulerResult`.

---

### `branch-fix`

Run one task; if `agent.run()` returns `errors`, branch into a fix subprocess, then resume.

```json
{
  "task": "implement auth middleware and resolve lint issues",
  "timeout": 300000
}
```

Fix prompt sent to agent: `Fix the following issues: {errors joined by "; "}`.

---

### `fan-out`

Run the same task across multiple models and merge outputs.

```json
{
  "task": "propose API surface for agent orchestration",
  "models": ["claude-sonnet-4-20250514", "gpt-4o"],
  "timeout": 300000
}
```

If `models` is omitted, defaults to `["claude-sonnet-4-20250514", "gpt-4o"]`.

Merge shape: `{ results: string[], consensus: number }`.

---

### `retry`

Retry a task with exponential backoff and a per-attempt timeout.

```json
{
  "task": "fix flaky integration test",
  "model": "gpt-4o",
  "maxAttempts": 3,
  "initialDelayMs": 250,
  "stepTimeout": 60000,
  "timeout": 300000
}
```

Defaults: `maxAttempts=3`, `initialDelayMs=250`, `stepTimeout=60000`.

---

### `fallback`

Run fallback task if primary fails.

```json
{
  "primary": "run strict static analyzer",
  "fallback": "run lightweight linter",
  "model": "gpt-4o",
  "timeout": 300000
}
```

---

### `saga`

Run steps sequentially; on failure, undo completed steps in reverse order.

```json
{
  "steps": ["create branch", "apply patch", "run validation"],
  "model": "gpt-4o",
  "timeout": 300000
}
```

Each undo step prompts: `Rollback/undo the effects of this step: {step}`.

---

### `status`

Return the CPA session tree for the current session.

```json
{}
```

Response includes `sessionTree` and `value.tree`. Use `sessionTreeToMarkdown` for display:

```ts
import { sessionTreeToMarkdown } from "cpa-agents/adapters/openclaw";

const md = sessionTreeToMarkdown(result.sessionTree);
```

---

## Trace export (JSONL)

Every `SchedulerResult` includes `trace` and `sessionTree`. For standalone workflows or
post-run persistence:

```ts
import { Scheduler, loadJsonlTree } from "cpa-agents";

const scheduler = new Scheduler();
const sink = scheduler.attachJsonl("./session.jsonl");

const result = await scheduler.run("workflow", myProcess);
await sink.close();

const tree = await loadJsonlTree("./session.jsonl");
```

In OpenClaw, prefer streaming via `session.appendEvent` during `handleCommand` runs.

## Advanced operators (library API)

Use these in custom TypeScript workflows via `cpa-agents` core exports.

### Undo / rollback (`invertible` + `saga`)

- `invertible(forward, undo)` — step plus compensating action
- `saga([...steps])` — forward order; undo in reverse on failure

```ts
import { invertible, saga } from "cpa-agents";

const workflow = saga([
  invertible(createBranch, deleteBranch),
  invertible(writeCode, revertCode),
  invertible(runValidation, cleanupValidation),
]);
```

The OpenClaw `saga` command wraps this pattern around `agent.run()`.

### Provenance (`converse`)

Relational provenance, not operational undo. Answers: which input(s) could produce this output?

```ts
import { rel, converse } from "cpa-agents";

const generate = rel("generate", async (prompt: string) => [prompt + "-out"]);
const provenance = converse(generate, async (output: string) => [
  output.replace("-out", ""),
]);
```

### Guarded flow (`guard`, `guardValue`, `ifThenElse`)

- `guard(...)` — block unsafe execution
- `guardValue(...)` — require a value to exist
- `ifThenElse(...)` — conditional routing

### Reliability (`retryWithBackoff`, `timeout`, `or`)

- `retryWithBackoff` — transient failure recovery
- `timeout(ms, process)` — bound execution time
- `or(primary, fallback)` — fallback routing (used by `fallback` command)

### Undo vs converse

| Mechanism | Use when |
|---|---|
| `invertible` + `saga` | You must reverse side effects |
| `converse` | Audit, lineage, explainability |

## Recommended prompts

- "Run parallel: audit security risks, propose patch plan, generate tests"
- "Branch-fix this refactor until no type errors remain"
- "Fan-out this architecture question across two models and compare"
- "Retry this flaky deploy check with backoff"
- "Fallback to lightweight linter if strict analyzer fails"
- "Execute as saga: create branch, patch files, validate — rollback on failure"
- "Show cpa status"
- "Show provenance: what input likely produced this output?"

## Troubleshooting

| Symptom | Fix |
|---|---|
| `OpenClaw bridge not connected` | Call `configureOpenClawBridge()` or pass `bridge` to factory helpers |
| Agent not invoked | Ensure `openclawCtx.agent.run` is wired in the skill host |
| Unknown command | Use: `parallel`, `branch-fix`, `fan-out`, `retry`, `fallback`, `saga`, `status` |
| Timeout | Increase `timeout` in command args (default 300000 ms) |
| Missing session events | Enable `session.appendEvent` in host context |
| Rollback did not occur | Wrap steps with `invertible(...)`; use `saga` command or operator |
| Empty status tree | Run a command in the same session first; `status` reflects the last active scheduler |
| Provenance unclear | Provide an explicit `inverseFn` when defining `converse(...)` |

## Related: Pi Coding Agent

Pi extension commands (`cpa:par`, `cpa:fix`, `cpa:tree`, `cpa:retry`, `cpa:fallback`, `cpa:saga`, `cpa:fan-out`)
use the same algebra via `createPiCpaExtension()` from `cpa-agents/adapters/pi`.
Requires `piCtx.agent.run()` — see package README.
