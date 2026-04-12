# cpa-agents

Concurrent Process Algebra for AI Agents.

`cpa-agents` combines three layers:
- process algebra (pi-calculus primitives for concurrency/communication)
- fork algebra (relational composition and paired derivations)
- operator algebra (practical control flow: rollback, retries, guards, timeout)

Designed for [Pi Harness](https://github.com/badlogic/pi-mono), [OpenClaw](https://github.com/openclaw/openclaw), and standalone TypeScript workflows.

## Install

```bash
npm install cpa-agents
```

## Quick start

```typescript
import { Scheduler, par, agentProcess } from "cpa-agents";

const scheduler = new Scheduler({ timeout: 60_000 });

const research = par(
  agentProcess(webSearchAgent, "latest React patterns"),
  agentProcess(codeSearchAgent, "auth middleware examples"),
);

const result = await scheduler.run("research", research);
```

## Why

Most agent harnesses implement orchestration with ad-hoc control flow and minimal runtime semantics. This library provides formal, typed primitives for:
- concurrent task execution
- explicit synchronization and communication
- fix-and-resume branching
- provenance and rollback-aware workflows

## Layer 1: Process algebra

| π-calculus | cpa-agents | What it does |
|---|---|---|
| `ā⟨v⟩.P` | `ch.send(v)` | Send value on channel, then continue |
| `a(x).P` | `ch.receive()` | Receive value from channel, then continue |
| `P \| Q` | `par(P, Q)` | Run P and Q concurrently |
| `P + Q` | `choice([...])` | Wait for first channel that fires |
| `ν(x).P` | `restrict(name, body)` | Create a fresh scoped channel |
| `!P` | `replicate(trigger, handler)` | Spawn new P for each incoming message |

Core runtime exports:
- `Channel`, `select`
- `par`, `seq`, `choice`, `branchFix`, `restrict`, `replicate`, `supervisor`
- `Scheduler`

### Branch-fix-continue

Pattern for "run -> detect error -> fix -> resume".

```typescript
import { branchFix, Scheduler } from "cpa-agents";

const workflow = branchFix<string>({
  name: "implement-feature",
  maxFixes: 3,

  main: (requestFix) => async (ctx) => {
    const code = await coder.invoke("add auth middleware", ctx.signal);
    const check = await linter.invoke(code, ctx.signal);

    if (!check.pass) {
      await requestFix(check.errors.join("; "));
    }

    return code;
  },

  fix: (reason) => async (ctx) => {
    await fixer.invoke(reason, ctx.signal);
  },
});

const scheduler = new Scheduler({ timeout: 60_000 });
const result = await scheduler.run("feature", workflow);
```

## Layer 2: Fork algebra (relations)

Fork algebra models relation composition and paired derivations over the same input.

```typescript
import { rel, fork, compose, meet, join, toProcess } from "cpa-agents";

const parse = rel("parse", async (input: string) => [input.trim()]);
const enrich = rel("enrich", async (input: string) => [`${input}:meta`]);
const validate = rel("validate", async (input: string) => [input.length > 0 ? "ok" : "bad"]);

const composed = compose(parse, enrich);
const paired = fork(enrich, validate);

const proc = toProcess(composed, "task payload", "all");
const run = await scheduler.run("fork-layer", proc);
```

Key exports:
- `rel`, `detRel`
- `compose`, `fork`, `forkN`
- `converse` (provenance mapping, not rollback)
- `meet`, `join`, `identity`, `empty`
- `proj1`, `proj2`, `domRestrict`, `ranRestrict`
- `toProcess`, `forkToProcess`, `verifyAxioms`

## Layer 3: Operator algebra (control flow)

Operator layer provides shell-style and reliability-focused control flow.

```typescript
import {
  and,
  or,
  pipe,
  saga,
  invertible,
  retryWithBackoff,
  timeout,
} from "cpa-agents";

const guardedDeploy = and(buildProcess, deployProcess); // A && B
const withFallback = or(primaryProcess, fallbackProcess); // A || B
const piped = pipe(fetchProcess, (data) => transformProcess(data)); // A | B

const transactional = saga([
  invertible(createBranch, deleteBranch),
  invertible(writeChanges, revertChanges),
  invertible(runChecks, cleanupChecks),
]);

const resilient = retryWithBackoff({
  process: timeout(30_000, transactional),
  maxAttempts: 3,
});
```

Key exports:
- `attempt`, `unwrap`
- `and`, `or`, `ifThenElse`, `pipe`, `pipeChain`
- `bg`, `waitAll`, `not`, `andChain`, `orChain`, `subshell`
- `invertible`, `runInvertible`, `saga`
- `guard`, `guardValue`, `timeout`, `retryWithBackoff`

## OpenClaw integration

```typescript
// ~/.openclaw/skills/cpa-agents/index.ts
import { createOpenClawSkill } from "cpa-agents/adapters/openclaw";
export default createOpenClawSkill();
```

Supported commands:
- `parallel`
- `branch-fix`
- `fan-out`
- `status`

Skill authoring docs are in `skills/cpa-agents/SKILL.md`.

## Pi Harness integration

```typescript
// .pi/extensions/cpa.ts
import { createPiCpaExtension } from "cpa-agents/adapters/pi";
export default createPiCpaExtension();
```

## Session tree and trace

Every scheduler run emits:
- `sessionTree` (hierarchical execution tree)
- `trace` (flat event list)

```typescript
const result = await scheduler.run("workflow", myProcess);

for (const node of result.sessionTree) {
  console.log(node.name, node.runId);
  for (const child of node.children) {
    console.log("  └─", child.name);
  }
}
```

## Development

```bash
npm run check
npm test
npm run coverage
```

## License

MIT
