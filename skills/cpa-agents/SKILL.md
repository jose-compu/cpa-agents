# CPA Agents for OpenClaw

Orchestrate complex agent workflows with concurrent process algebra patterns:
parallel work, branch-fix loops, fan-out comparison, and session-aware status.

## Install the library

```bash
npm install cpa-agents
```

## Skill entrypoint

Create your skill entry file:

```ts
import { createOpenClawSkill } from "cpa-agents/adapters/openclaw";

export default createOpenClawSkill();
```

## Runtime requirements

- OpenClaw Gateway running and reachable.
- Skill runtime supports async command handlers.
- Session context should expose `appendEvent` for trace capture.

## Available commands

### `parallel`

Run independent tasks concurrently.

Input:

```json
{
  "tasks": [
    "analyze failing tests",
    "draft fix proposal",
    "write migration notes"
  ],
  "timeout": 300000
}
```

### `branch-fix`

Run one task; if errors appear, branch to fix, then continue.

Input:

```json
{
  "task": "implement auth middleware and resolve lint issues",
  "timeout": 300000
}
```

### `fan-out`

Send one task to multiple models and merge outputs.

Input:

```json
{
  "task": "propose API surface for agent orchestration",
  "models": ["model-a", "model-b"],
  "timeout": 300000
}
```

### `status`

Return current session process tree/status.

Input:

```json
{}
```

## Prompt examples

- "Run parallel: audit security risks, propose patch plan, generate tests"
- "Branch-fix this refactor until no type errors remain"
- "Fan-out this architecture question across two models and compare"
- "Show cpa status"

## Troubleshooting

- Gateway not connected:
  - Start OpenClaw Gateway and retry.
- Unknown command:
  - Use one of: `parallel`, `branch-fix`, `fan-out`, `status`.
- Timeout errors:
  - Increase `timeout` in command args.
- Empty status/events:
  - Confirm session context is set and `appendEvent` is enabled.
