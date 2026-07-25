// Derives the reviewed adapter registry data from an adapter directory's
// two source files: adapter.yaml (curated contract) and openapi.angel.yaml
// (narrowed spec). Pure functions of those strings — no filesystem — so the
// codegen script and tests share one implementation. Ported behaviorally from
// the legacy comparison compiler per ADR 0004 (no shared source).

import { parse as parseYaml } from "yaml";
import { sha256Hex } from "./crypto";
import type { CredentialKind } from "./domain";

export interface HttpRequestTemplate {
  kind: "http";
  method: string;
  pathTemplate: string;
  pathParams: string[];
  pathDefaults: Record<string, string>;
  queryParams: string[];
  hasBody: boolean;
}

export interface DerivedOperation {
  request: HttpRequestTemplate;
  scopes: string[];
}

export interface DerivedAdapter {
  provider: string;
  adapter: string;
  credential: CredentialKind;
  origin: string;
  source: string;
  sourceDigest: string;
  scopeRanking: string[];
  operations: Record<string, DerivedOperation>;
}

export async function deriveAdapter(input: {
  provider: string;
  adapterYaml: string;
  specYaml: string;
}): Promise<DerivedAdapter> {
  // The digest is a content pin, not a checkout pin — normalize line endings
  // so LF and CRLF copies of the same reviewed spec derive one identity.
  const specYaml = input.specYaml.replace(/\r\n/g, "\n");
  const meta = parseYaml(input.adapterYaml) as Record<string, unknown>;
  const adapter = requireText(meta.adapter, "adapter.yaml adapter");
  const credential = requireText(meta.credential, "adapter.yaml credential") as CredentialKind;
  const origin = requireText(meta.origin, "adapter.yaml origin");
  const source = requireText(meta.source, "adapter.yaml source");
  const scopeRanking = requireTextList(meta.scopeRanking, "adapter.yaml scopeRanking");

  const spec = parseYaml(specYaml) as Record<string, unknown>;
  requireSpecOrigin(spec, origin);

  const operations: Record<string, DerivedOperation> = {};
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, member] of Object.entries(pathItem)) {
      const op = member as {
        operationId?: unknown;
        parameters?: { name: string; in: string; schema?: { default?: unknown } }[];
        requestBody?: unknown;
        security?: unknown;
      };
      if (typeof member !== "object" || member === null || typeof op.operationId !== "string") continue;
      const id = op.operationId;
      if (operations[id]) throw new Error(`duplicate operationId in spec: ${id}`);
      operations[id] = {
        request: requestTemplate(id, path, method, op),
        scopes: operationScopes(id, op.security),
      };
    }
  }

  return {
    provider: input.provider,
    adapter,
    credential,
    origin,
    source,
    sourceDigest: `sha256:${await sha256Hex(specYaml)}`,
    scopeRanking,
    operations,
  };
}

function requestTemplate(
  id: string,
  path: string,
  method: string,
  op: { parameters?: { name: string; in: string; schema?: { default?: unknown } }[]; requestBody?: unknown },
): HttpRequestTemplate {
  const pathParams: string[] = [];
  const pathDefaults: Record<string, string> = {};
  const queryParams: string[] = [];
  for (const param of op.parameters ?? []) {
    if (param.in === "path") {
      pathParams.push(param.name);
      const fallback = param.schema?.default;
      if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") {
        pathDefaults[param.name] = String(fallback);
      }
    } else if (param.in === "query") queryParams.push(param.name);
    else throw new Error(`${id}: unsupported parameter location "${param.in}" (${param.name})`);
  }
  // Every {placeholder} must be a declared path parameter, or the runtime
  // would send literal braces upstream.
  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const declared = new Set(pathParams);
  for (const name of placeholders) {
    if (!declared.has(name)) throw new Error(`${id}: path placeholder {${name}} has no declared path parameter`);
  }
  if (pathParams.length !== placeholders.length) {
    throw new Error(`${id}: declared path parameters don't match path placeholders`);
  }
  return {
    kind: "http",
    method: method.toUpperCase(),
    pathTemplate: path,
    pathParams,
    pathDefaults,
    queryParams: [...queryParams].sort(),
    hasBody: op.requestBody !== undefined,
  };
}

// Silent empty or partial scopes would surface only when a later compile
// finds no ranked cover — fail at derivation instead, where the spec is
// under review.
function operationScopes(id: string, security: unknown): string[] {
  if (!Array.isArray(security) || security.length !== 1) {
    throw new Error(`${id}: security must be exactly one requirement entry`);
  }
  const entry = security[0] as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== 1 || keys[0] !== "oauth2" || !Array.isArray(entry.oauth2)) {
    throw new Error(`${id}: security entry must declare exactly oauth2 scopes`);
  }
  return [...(entry.oauth2 as string[])].sort();
}

// The access token is only ever sent to the reviewed origin, so the curated
// origin and the narrowed spec's server must agree exactly.
function requireSpecOrigin(spec: Record<string, unknown>, origin: string): void {
  const servers = spec.servers;
  const first = Array.isArray(servers) ? (servers[0] as { url?: unknown } | undefined) : undefined;
  if (!first || typeof first.url !== "string") throw new Error("narrowed spec needs servers[0].url");
  const url = new URL(first.url);
  if (url.protocol !== "https:") throw new Error(`servers[0].url must be https: got ${first.url}`);
  if (url.origin !== origin) {
    throw new Error(`adapter origin ${origin} must match spec servers origin ${url.origin}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `servers[0].url must not carry a base path: ${first.url} — derived pathTemplates would lose it`,
    );
  }
}

// The generated registry is shared, module-level data; compiled artifacts
// alias its templates, so it must be immutable at runtime, not just in types.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

// The smallest consent that covers every tool: fewest scopes first, then the
// narrowest by curated ranking. Scopes outside the ranking (full-access or
// functionally restricted ones) are never selected automatically — a toolbox
// they alone could cover fails compilation and forces a curation decision.
export function selectRequiredScopes(input: {
  tools: string[];
  operations: Record<string, { scopes: string[] }>;
  scopeRanking: string[];
}): string[] {
  const rank = new Map(input.scopeRanking.map((scope, index) => [scope, index]));
  const alternatives = input.tools.map((tool) => {
    const op = input.operations[tool];
    if (!op) throw new Error(`unknown operation: ${tool}`);
    const ranked = op.scopes.filter((scope) => rank.has(scope));
    if (ranked.length === 0) throw new Error(`no ranked scope covers ${tool}`);
    return new Set(ranked);
  });

  // Exhaustive search over ranked-scope subsets; candidate pools are tiny
  // (Google APIs list well under a dozen ranked scopes per provider).
  const pool = input.scopeRanking.filter((scope) => alternatives.some((set) => set.has(scope)));
  let best: string[] | undefined;
  let bestRankSum = Infinity;
  const limit = 1 << pool.length;
  for (let mask = 1; mask < limit; mask++) {
    const subset = pool.filter((_, index) => mask & (1 << index));
    if (best && subset.length > best.length) continue;
    if (!alternatives.every((set) => subset.some((scope) => set.has(scope)))) continue;
    const rankSum = subset.reduce((sum, scope) => sum + rank.get(scope)!, 0);
    if (!best || subset.length < best.length || rankSum < bestRankSum) {
      best = subset;
      bestRankSum = rankSum;
    }
  }
  if (!best) throw new Error(`no ranked scope subset covers tools: ${input.tools.join(", ")}`);
  return [...best].sort();
}

function requireText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
  return value;
}

function requireTextList(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} must be a non-empty list`);
  return value.map((item) => requireText(item, at));
}
