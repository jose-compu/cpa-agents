/**
 * cpa-agents — Concurrent Process Algebra for AI Agents
 *
 * A TypeScript library that applies π-calculus process algebra
 * to AI agent orchestration. Designed for Pi Harness and OpenClaw,
 * but usable standalone.
 *
 * Core concepts:
 * - Channel<T>: typed communication (π-calculus names)
 * - Process<T>: unit of computation
 * - par(P, Q): parallel composition (P | Q)
 * - seq(P, Q): sequential composition (P ; Q)
 * - choice([...branches]): external choice (P + Q)
 * - branchFix({ main, fix }): branch-to-fix-then-continue
 * - restrict(name, body): scoped channel creation (ν(x).P)
 * - replicate(trigger, handler): server pattern (!P)
 * - supervisor({ process, maxRetries }): error recovery
 *
 * Agent patterns:
 * - agentProcess(agent, input): lift an LLM call into a Process
 * - codeThenFix({ coder, checker, fixer }): code → check → fix loop
 * - fanOut({ agents, input, merge }): parallel multi-agent
 * - pipeline(a, input).then(b).build(): sequential chain
 * - handoff({ from, to }): channel-mediated agent transfer
 */

// Core primitives
export { Channel, freshId, select, type ChannelId, type SelectCase } from "./channel.js";

// Process algebra
export {
  type Process,
  type ProcessContext,
  type TraceEvent,
  type SessionNode,
  TraceCollector,
  par,
  seq,
  choice,
  branchFix,
  restrict,
  replicate,
  supervisor,
} from "./process.js";

// Agent wrappers
export {
  type AgentCall,
  type CheckResult,
  agentProcess,
  codeThenFix,
  fanOut,
  pipeline,
  PipelineBuilder,
  handoff,
} from "./agent.js";

// Scheduler
export { Scheduler, type SchedulerOpts, type SchedulerResult } from "./scheduler.js";

// Fork algebra (relational layer)
export {
  type Relation,
  type RelationFn,
  rel,
  detRel,
  compose,
  fork,
  forkN,
  converse,
  meet,
  join,
  identity,
  empty,
  proj1,
  proj2,
  domRestrict,
  ranRestrict,
  toProcess,
  forkToProcess,
  verifyAxioms,
} from "./fork-algebra.js";

// Operators (bash-style control flow + inverse/undo)
export {
  type Result,
  type BackgroundHandle,
  type Invertible,
  attempt,
  unwrap,
  and,
  or,
  ifThenElse,
  pipe,
  pipeChain,
  bg,
  not,
  waitAll,
  andChain,
  orChain,
  subshell,
  invertible,
  runInvertible,
  saga,
  guard,
  guardValue,
  timeout,
  retryWithBackoff,
} from "./operators.js";
