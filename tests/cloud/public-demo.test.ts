// The public demo page (docs-site/build.sh step 4) is the real dashboard shell
// copied verbatim over a generated fixture, with one injected script standing in
// for the Control worker. That only stays true if three things hold, and each of
// them breaks silently rather than loudly, so they are asserted here:
//
//   1. every path www/app.js reads is answered by the shim;
//   2. the shell still has the shape build.sh rewrites;
//   3. the shim refuses everything else, so the page cannot mutate anything.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const appJs = readFileSync(resolve(repoRoot, "www/app.js"), "utf8");
const indexHtml = readFileSync(resolve(repoRoot, "www/index.html"), "utf8");
const shimJs = readFileSync(resolve(repoRoot, "docs-site/public/demo/shim.js"), "utf8");

// Literal request paths in the dashboard: fetch("/api/...") and the
// fetchProvider("/api/...") helper that wraps it. Template-literal call sites
// (`/api/connections/${id}/revoke`) are all mutations and are matched separately.
function literalApiPaths(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:fetch|fetchProvider)\(\s*"(\/api\/[^"]*)"/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

function shimReadPaths(source: string): string[] {
  const block = source.match(/var READS = \{([\s\S]*?)\};/);
  expect(block).not.toBeNull();
  return [...block![1]!.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]!).sort();
}

describe("public demo shim", () => {
  test("answers every literal API path the dashboard fetches", () => {
    const dashboard = literalApiPaths(appJs);
    const answered = shimReadPaths(shimJs);
    // Mutation paths are deliberately unanswered — they must be refused, not
    // served — so the shim only has to cover the ones the dashboard reads.
    const mutationOnly = new Set(["/api/demo/action", "/api/connections/authorize"]);
    const reads = dashboard.filter((path) => !mutationOnly.has(path));

    expect(reads.length).toBeGreaterThan(0);
    for (const path of reads) {
      expect(answered).toContain(path);
    }
  });

  test("answers nothing the dashboard does not ask for", () => {
    for (const path of shimReadPaths(shimJs)) {
      expect(literalApiPaths(appJs)).toContain(path);
    }
  });

  test("refuses non-GET requests rather than serving them", () => {
    expect(shimJs).toContain('method === "GET"');
    expect(shimJs).toContain("403");
  });

  test("the shell still has the shape build.sh rewrites", () => {
    expect(indexHtml).toContain('href="/app.css"');
    expect(indexHtml).toContain('<script src="/app.js" defer></script>');
  });
});
