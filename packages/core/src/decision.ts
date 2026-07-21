// Gate 2: the runtime allow/deny boundary. Pure functions, no I/O.
// Copied verbatim into every built angel.

import type { AngelTool, ArgGuard } from "./types";

export type Decision =
  | { ok: true; rule: AngelTool; args: Record<string, unknown> }
  | { ok: false; denied: string };

// Deeper than any real API request; prevents a pathological payload from
// blowing the stack in the unbounded walkers below.
const MAX_ARG_DEPTH = 64;

export function compileRules(tools: AngelTool[]): Map<string, AngelTool> {
  const rules = new Map<string, AngelTool>();
  for (const tool of tools) {
    const key = tool.tool.toUpperCase();
    if (rules.has(key)) {
      // Two tools differing only in case would make the case-insensitive
      // lookup ambiguous — fail the build/startup, never silently overwrite.
      throw new Error(`tool allowlist collision (case-insensitive): ${tool.tool}`);
    }
    rules.set(key, tool);
  }
  return rules;
}

export function evaluateToolCall(opts: {
  rules: Map<string, AngelTool>;
  tool: string;
  bodyText: string;
  // Spec-declared default values for absent top-level fields (google_oauth
  // mode's path defaults, e.g. userId: "me"). Materialized BEFORE guards so a
  // default can never insert a value the guards didn't examine — the object
  // that is guarded, ledgered, and forwarded is one and the same.
  defaults?: Record<string, string>;
}): Decision {
  const rule = opts.rules.get(opts.tool.toUpperCase());
  if (!rule) return { ok: false, denied: `not allowlisted: ${opts.tool}` };

  // The request body IS the tool's arguments object (no envelope).
  let parsed: unknown;
  if (opts.bodyText.trim() === "") {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(opts.bodyText);
    } catch {
      return { ok: false, denied: "body is not valid JSON" };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, denied: "body must be a JSON object of arguments" };
  }

  // Depth is checked with a self-bounded walker BEFORE the unbounded guard
  // recursion ever touches the tree.
  if (exceedsDepth(parsed, MAX_ARG_DEPTH)) {
    return { ok: false, denied: `arguments exceed max depth ${MAX_ARG_DEPTH}` };
  }

  const args = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(opts.defaults ?? {})) {
    if (args[key] === undefined) args[key] = value;
  }
  for (const guard of rule.argGuards ?? []) {
    const denied = evaluateGuard(guard, args);
    if (denied) return { ok: false, denied };
  }
  return { ok: true, rule, args };
}

function evaluateGuard(guard: ArgGuard, args: Record<string, unknown>): string | null {
  const values = collectByField(args, guard.field);
  if (values.length === 0) return null;

  if ("forbid" in guard) {
    return `argGuard: ${guard.field} is forbidden`;
  }
  if ("pin" in guard) {
    const pin = comparable(guard.pin);
    for (const value of values) {
      const leaves = stringLeaves(value);
      // A present field that yields no comparable leaf (null, {}, []) is NOT
      // the pinned value — deny rather than pass vacuously.
      if (leaves.length === 0) return `argGuard: ${guard.field} is pinned to ${guard.pin}`;
      for (const leaf of leaves) {
        if (comparable(leaf) !== pin) {
          return `argGuard: ${guard.field} is pinned to ${guard.pin}`;
        }
      }
    }
    return null;
  }
  const forbidden = new Set(guard.forbiddenValues.map(comparable));
  for (const value of values) {
    // No empty-leaves denial here (unlike pin): an empty array like
    // `addLabelIds: []` is a legitimate no-op that smuggles no forbidden value.
    for (const leaf of stringLeaves(value)) {
      if (forbidden.has(comparable(leaf))) {
        const shown = guard.forbiddenValues.find((v) => comparable(v) === comparable(leaf)) ?? leaf;
        return `argGuard: ${guard.field} forbids ${shown}`;
      }
    }
  }
  return null;
}

function comparable(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

// Guarded fields can live anywhere in the real request shape (Gmail's
// addLabelIds nests under the request body) — a top-level-only check would be
// a bypass, not a bug. Walk arrays and objects to any depth, matching field
// names case-insensitively.
function collectByField(value: unknown, field: string): unknown[] {
  const wanted = field.toLowerCase();
  const found: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (key.toLowerCase() === wanted) found.push(child);
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}

// Numbers and booleans stringify too — a guard comparing only string-typed
// leaves could be dodged with a numeric or boolean encoding of the value.
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

// Bounded by construction: recursion stops at maxDepth, so this can never
// RangeError even on a 20k-deep payload.
function exceedsDepth(value: unknown, maxDepth: number): boolean {
  if (maxDepth < 0) return true;
  if (Array.isArray(value)) {
    return value.some((item) => exceedsDepth(item, maxDepth - 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((child) => exceedsDepth(child, maxDepth - 1));
  }
  return false;
}
