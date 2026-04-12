/**
 * Fork Algebra layer for cpa-agents
 *
 * Fork algebras extend relation algebras with a fork operator that pairs
 * two relations:
 *
 *   R: A -> B,  S: A -> C   =>   R∇S: A -> BxC
 */

import { type Process, type ProcessContext, par } from "./process.js";

export type RelationFn<A, B> = (input: A) => Promise<B[]>;

export interface Relation<A, B> {
  readonly name: string;
  readonly fn: RelationFn<A, B>;
}

export function rel<A, B>(name: string, fn: RelationFn<A, B>): Relation<A, B> {
  return { name, fn };
}

export function detRel<A, B>(
  name: string,
  fn: (input: A) => Promise<B>
): Relation<A, B> {
  return { name, fn: async (a) => [await fn(a)] };
}

export function compose<A, B, C>(
  r: Relation<A, B>,
  s: Relation<B, C>
): Relation<A, C> {
  return {
    name: `${r.name};${s.name}`,
    fn: async (a) => {
      const bs = await r.fn(a);
      const results: C[] = [];
      for (const b of bs) {
        const cs = await s.fn(b);
        results.push(...cs);
      }
      return results;
    },
  };
}

export function fork<A, B, C>(
  r: Relation<A, B>,
  s: Relation<A, C>
): Relation<A, [B, C]> {
  return {
    name: `${r.name}∇${s.name}`,
    fn: async (a) => {
      const [bs, cs] = await Promise.all([r.fn(a), s.fn(a)]);
      const pairs: [B, C][] = [];
      for (const b of bs) {
        for (const c of cs) {
          pairs.push([b, c]);
        }
      }
      return pairs;
    },
  };
}

export function forkN<A>(...relations: Relation<A, any>[]): Relation<A, any[]> {
  return {
    name: relations.map((r) => r.name).join("∇"),
    fn: async (a) => {
      const allResults = await Promise.all(relations.map((r) => r.fn(a)));
      return cartesian(allResults);
    },
  };
}

export function converse<A, B>(
  r: Relation<A, B>,
  inverseFn: RelationFn<B, A>
): Relation<B, A> {
  return {
    name: `${r.name}⁻¹`,
    fn: inverseFn,
  };
}

export function meet<A, B>(
  r: Relation<A, B>,
  s: Relation<A, B>,
  eq: (b1: B, b2: B) => boolean = (a, b) => a === b
): Relation<A, B> {
  return {
    name: `${r.name}∩${s.name}`,
    fn: async (a) => {
      const [rResults, sResults] = await Promise.all([r.fn(a), s.fn(a)]);
      return rResults.filter((rb) => sResults.some((sb) => eq(rb, sb)));
    },
  };
}

export function join<A, B>(
  r: Relation<A, B>,
  s: Relation<A, B>,
  dedup?: (b1: B, b2: B) => boolean
): Relation<A, B> {
  return {
    name: `${r.name}∪${s.name}`,
    fn: async (a) => {
      const [rResults, sResults] = await Promise.all([r.fn(a), s.fn(a)]);
      const combined = [...rResults, ...sResults];
      if (!dedup) return combined;
      return combined.filter(
        (b, i) => combined.findIndex((other) => dedup(b, other)) === i
      );
    },
  };
}

export function identity<A>(name = "id"): Relation<A, A> {
  return { name, fn: async (a) => [a] };
}

export function empty<A, B>(name = "∅"): Relation<A, B> {
  return { name, fn: async () => [] };
}

export function proj1<B, C>(name = "π₁"): Relation<[B, C], B> {
  return { name, fn: async ([b, _c]) => [b] };
}

export function proj2<B, C>(name = "π₂"): Relation<[B, C], C> {
  return { name, fn: async ([_b, c]) => [c] };
}

export function domRestrict<A, B>(
  guard: Relation<A, A>,
  body: Relation<A, B>
): Relation<A, B> {
  return {
    name: `${guard.name}◁${body.name}`,
    fn: async (a) => {
      const guardResult = await guard.fn(a);
      if (guardResult.length === 0) return [];
      const results: B[] = [];
      for (const ga of guardResult) {
        results.push(...(await body.fn(ga)));
      }
      return results;
    },
  };
}

export function ranRestrict<A, B>(
  body: Relation<A, B>,
  filter: Relation<B, any>
): Relation<A, B> {
  return {
    name: `${body.name}▷${filter.name}`,
    fn: async (a) => {
      const bs = await body.fn(a);
      const kept: B[] = [];
      for (const b of bs) {
        const filterResult = await filter.fn(b);
        if (filterResult.length > 0) kept.push(b);
      }
      return kept;
    },
  };
}

export function toProcess<A, B>(
  relation: Relation<A, B>,
  input: A,
  mode: "first" | "all" = "first"
): Process<B | B[]> {
  return async (ctx: ProcessContext) => {
    ctx.trace.emit({
      type: "spawn",
      runId: ctx.runId,
      parentId: ctx.parentId,
      name: `rel:${relation.name}`,
      ts: Date.now(),
    });

    const results = await relation.fn(input);

    ctx.trace.emit({
      type: "done",
      runId: ctx.runId,
      ts: Date.now(),
    });

    if (mode === "first") {
      if (results.length === 0) {
        throw new Error(`Relation ${relation.name} produced no results`);
      }
      return results[0];
    }
    return results;
  };
}

export function forkToProcess<A, B, C>(
  r: Relation<A, B>,
  s: Relation<A, C>,
  input: A
): Process<[B[], C[]]> {
  return par(
    async (ctx) => {
      ctx.trace.emit({
        type: "spawn",
        runId: ctx.runId,
        parentId: ctx.parentId,
        name: `fork-left:${r.name}`,
        ts: Date.now(),
      });
      const result = await r.fn(input);
      ctx.trace.emit({ type: "done", runId: ctx.runId, ts: Date.now() });
      return result;
    },
    async (ctx) => {
      ctx.trace.emit({
        type: "spawn",
        runId: ctx.runId,
        parentId: ctx.parentId,
        name: `fork-right:${s.name}`,
        ts: Date.now(),
      });
      const result = await s.fn(input);
      ctx.trace.emit({ type: "done", runId: ctx.runId, ts: Date.now() });
      return result;
    }
  );
}

export async function verifyAxioms<A, B, C>(
  r: Relation<A, B>,
  s: Relation<A, C>,
  testInputs: A[],
  eqB: (a: B, b: B) => boolean = (a, b) => a === b,
  eqC: (a: C, b: C) => boolean = (a, b) => a === b
): Promise<{ passed: boolean; failures: string[] }> {
  const failures: string[] = [];

  for (const input of testInputs) {
    const forked = fork(r, s);
    const forkedResults = await forked.fn(input);
    const rResults = await r.fn(input);
    const sResults = await s.fn(input);

    const proj1Results = forkedResults.map(([b, _c]) => b);
    for (const p of proj1Results) {
      if (!rResults.some((rb) => eqB(rb, p))) {
        failures.push(
          `Fork-projection π₁ failed for input ${String(input)}: got ${String(p)} not in R`
        );
      }
    }

    const proj2Results = forkedResults.map(([_b, c]) => c);
    for (const p of proj2Results) {
      if (!sResults.some((sc) => eqC(sc, p))) {
        failures.push(
          `Fork-projection π₂ failed for input ${String(input)}: got ${String(p)} not in S`
        );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

function cartesian(arrays: any[][]): any[][] {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesian(rest);
  return first.flatMap((x) => restProduct.map((r) => [x, ...r]));
}
