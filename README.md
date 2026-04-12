# cpa-agents

Concurrent Process Algebra for AI Agents. Applies π-calculus process algebra to agent orchestration in [Pi Harness](https://github.com/badlogic/pi-mono) and [OpenClaw](https://github.com/openclaw/openclaw).

## Why

AI agent harnesses have ad-hoc concurrency: spawn a subprocess, hope it works, manually wire results back. Pi Harness has session trees with branching. OpenClaw has a ReAct loop with skills. Neither has a formal model for what happens when agent tasks run concurrently, need to communicate, or branch to fix errors before continuing.

This library gives you that model. The primitives come from Robin Milner's π-calculus — the same theory behind BPMN, BPEL, and every serious workflow engine — but adapted for the specific patterns AI coding agents actually use.

## Core concepts

| π-calculus | cpa-agents | What it does |
|---|---|---|
| `ā⟨v⟩.P` | `ch.send(v)` | Send value on channel, then continue |
| `a(x).P` | `ch.receive()` | Receive value from channel, then continue |
| `P \| Q` | `par(P, Q)` | Run P and Q concurrently |
| `P + Q` | `choice([...])` | Wait for first channel that fires |
| `ν(x).P` | `restrict(name, body)` | Create a fresh scoped channel |
| `!P` | `replicate(trigger, handler)` | Spawn new P for each incoming message |

## Usage

### Branch-fix-continue (the tree pattern)

The pattern you see in Pi Harness session trees: coding along, hitting a lint error, branching to fix it, then resuming.

```typescript
import { branchFix, Scheduler } from 'cpa-agents';

const workflow = branchFix<string>({
  name: 'implement-feature',
  maxFixes: 3,

  main: (requestFix) => async (ctx) => {
    const code = await coder.invoke('add auth middleware', ctx.signal);
    const check = await linter.invoke(code, ctx.signal);

    if (!check.pass) {
      // Branch: pause main, run fix, then continue here
      await requestFix(check.errors.join('; '));
    }

    return code;
  },

  fix: (reason) => async (ctx) => {
    await fixer.invoke(reason, ctx.signal);
  },
});

const scheduler = new Scheduler({ timeout: 60_000 });
const result = await scheduler.run('feature', workflow);
// result.sessionTree shows the full branch history
```

### Parallel agents

```typescript
import { par, agentProcess } from 'cpa-agents';

const research = par(
  agentProcess(webSearchAgent, 'latest React patterns'),
  agentProcess(codeSearchAgent, 'auth middleware examples'),
  agentProcess(docSearchAgent, 'project conventions'),
);

const [web, code, docs] = await scheduler.run('research', research);
```

### Channel communication between agents

```typescript
import { Channel, restrict, par } from 'cpa-agents';

const workflow = restrict<CodeReview, void>('review-ch', (ch) =>
  par(
    // Agent 1: write code, send for review
    async (ctx) => {
      const code = await coder.invoke(task, ctx.signal);
      await ch.send({ code, file: 'auth.ts' });
    },
    // Agent 2: receive code, review it
    async (ctx) => {
      const review = await ch.receive();
      await reviewer.invoke(review, ctx.signal);
    },
  )
);
```

### Pi Harness integration

```typescript
// .pi/extensions/cpa.ts
import { createPiCpaExtension } from 'cpa-agents/adapters/pi';
export default createPiCpaExtension();

// Then in Pi:
// /cpa:par implement auth | write tests | update docs
// /cpa:fix refactor the database layer
// /cpa:tree
```

### OpenClaw integration

```typescript
// ~/.openclaw/skills/cpa-agents/index.ts
import { createOpenClawSkill } from 'cpa-agents/adapters/openclaw';
export default createOpenClawSkill();

// Then via any messaging channel:
// "Run these tasks in parallel: research competitors, draft blog post"
// "Fix the auth module — branch and fix any type errors"
```

## Session tree

Every process execution produces a session tree — a record of all spawns, branches, fixes, and completions. This maps directly to Pi Harness's `/tree` view and OpenClaw's session logs.

```typescript
const result = await scheduler.run('workflow', myProcess);

for (const node of result.sessionTree) {
  console.log(node.name, node.runId);
  for (const child of node.children) {
    console.log('  └─', child.name);
  }
}
```

The trace is also available as a flat event log via `scheduler.getTrace()`, suitable for serialization to OpenClaw's workspace files or Pi's session JSONL format.

## Design decisions

**Synchronous rendezvous channels**, not buffered queues. A `send` blocks until a `receive` matches it. This is the π-calculus default and prevents the subtle bugs you get when messages pile up in buffers unobserved.

**Cooperative scheduling** via async/await, not preemptive. LLM calls are inherently async and long-running. The scheduler doesn't need to timeslice — it just needs to manage the dependency graph.

**Typed channels**. `Channel<T>` carries values of type T. This catches mismatched agent interfaces at compile time rather than runtime.

**Trace-first**. Every operation emits trace events. The session tree isn't reconstructed after the fact — it's built as processes execute, so you can inspect it mid-run.

## License

MIT
