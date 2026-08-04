// The public demo page (docs-site/build.sh step 4) is the real dashboard shell
// copied verbatim over a generated fixture, with one injected script standing in
// for the Control worker. That only stays true if three things hold, and each of
// them breaks silently rather than loudly, so they are asserted here:
//
//   1. every path www/app.js reads is answered by the shim;
//   2. the shim refuses everything else — asserted by running it, not by
//      grepping it, because an earlier version read as if it refused and did
//      not;
//   3. the shell still has the shape build.sh rewrites.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const appJs = readFileSync(resolve(repoRoot, "www/app.js"), "utf8");
const indexHtml = readFileSync(resolve(repoRoot, "www/index.html"), "utf8");
const shimJs = readFileSync(resolve(repoRoot, "docs-site/public/demo/shim.js"), "utf8");

// Literal request paths in the dashboard: fetch("/api/...") and the
// fetchProvider("/api/...") helper that wraps it, in either quote style.
// Template-literal call sites (`/api/connections/${id}/revoke`) are all
// mutations, and mutations are refused rather than answered.
function literalApiPaths(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:fetch|guardedFetch|fetchProvider)\(\s*(["'])(\/api\/[^"']*)\1/g)) {
    found.add(match[2]!);
  }
  return [...found].sort();
}

function shimReadPaths(source: string): string[] {
  const block = source.match(/var READS = \{([\s\S]*?)\};/);
  expect(block).not.toBeNull();
  return [...block![1]!.matchAll(/"(\/api\/[^"]*)"/g)].map((m) => m[1]!).sort();
}

const FIXTURE = { state: { schema: "angelmcp.demo.v3" }, apps: ["app"], connections: ["conn"] };

interface Sealable { disabled: boolean; removed: string[]; removeAttribute(name: string): void }

// Enough of a browser for shim.js to install itself and be called. The stub
// records what reaches the network so a pass-through can be told from a refusal,
// records removeAttribute calls, and — importantly — resolves ONLY the selectors
// the shim is supposed to know about. An earlier version returned a live element
// for any selector, so renaming a form in www/index.html would have left the
// credential fields unsealed with this suite still green.
const STATIC_FORM_SELECTORS = ["#provider-app-form", "#connection-authorize-form"];

function loadShim(): {
  fetch: typeof fetch;
  passthrough: string[];
  sealed: Sealable[];
  formsFound: string[];
} {
  const passthrough: string[] = [];
  const sealed: Sealable[] = [];
  const formsFound: string[] = [];
  const field = (): Sealable => {
    const el: Sealable = {
      disabled: false,
      removed: [],
      removeAttribute(name: string) { this.removed.push(name); },
    };
    sealed.push(el);
    return el;
  };

  const nativeFetch = (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    passthrough.push(url);
    return Promise.resolve(new Response(JSON.stringify(FIXTURE), {
      headers: { "content-type": "application/json" },
    }));
  };

  const element = (fields: Sealable[] = []) => ({
    setAttribute: () => {},
    style: { cssText: "" },
    textContent: "",
    hidden: true,
    dataset: {} as Record<string, unknown>,
    querySelectorAll: () => fields,
  });

  const scope = {
    window: {
      fetch: nativeFetch as unknown as typeof fetch,
      location: new URL("https://docs.angelmcp.ai/demo/"),
    },
    location: new URL("https://docs.angelmcp.ai/demo/"),
    document: {
      readyState: "complete",
      createElement: () => element(),
      querySelector: (selector: string) => {
        if (!STATIC_FORM_SELECTORS.includes(selector)) return null;
        formsFound.push(selector);
        return element([field(), field(), field(), field()]);
      },
      getElementById: () => element(),
      addEventListener: () => {},
      head: { appendChild: () => {} },
      body: { firstChild: null, insertBefore: () => {} },
    },
    Response,
    URL,
    Promise,
  };

  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(scope), shimJs)(...Object.values(scope));
  return { fetch: scope.window.fetch, passthrough, sealed, formsFound };
}

describe("public demo shim — path coverage", () => {
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

  test("the shell still has the shape build.sh rewrites", () => {
    expect(indexHtml).toContain('href="/app.css"');
    expect(indexHtml).toContain('<script src="/app.js" defer></script>');
  });
});

describe("public demo shim — behaviour", () => {
  let shim: ReturnType<typeof loadShim>;
  beforeEach(() => { shim = loadShim(); });

  test("serves each read path from the fixture", async () => {
    for (const [path, key] of [
      ["/api/demo/state", "state"],
      ["/api/provider-apps", "apps"],
      ["/api/connections", "connections"],
    ] as const) {
      const response = await shim.fetch(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(FIXTURE[key] as never);
    }
  });

  test("refuses every mutation, whichever way it is spelled", async () => {
    const attempts: Array<Promise<Response>> = [
      shim.fetch("/api/demo/action", { method: "POST", body: "{}" }),
      shim.fetch("/api/connections/con_x/revoke", { method: "POST" }),
      shim.fetch("/api/connections/con_x", { method: "DELETE" }),
      shim.fetch("/api/provider-apps", { method: "POST", body: "{}" }),
      shim.fetch(new Request("https://docs.angelmcp.ai/api/demo/action", { method: "POST" })),
    ];
    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect((await response.json() as { error: string }).error).toContain("read-only demo");
    }
  });

  test("refuses an unmapped API read rather than passing it to the network", async () => {
    const response = await shim.fetch("/api/demo/reset");
    expect(response.status).toBe(403);
    expect(shim.passthrough).not.toContain("/api/demo/reset");
  });

  // The regression this file exists for: the first version forwarded anything
  // whose URL lacked "/api/", so a public page could reach the product's own
  // /v1/ management surface, or any third-party host, from the visitor's browser.
  test("refuses cross-origin requests, including the product's own surfaces", async () => {
    for (const url of [
      "https://angelmcp-control-demo.sam-633.workers.dev/v1/angels",
      "https://angelmcp-gateway-demo.sam-633.workers.dev/v1/a/x/y/production/mcp",
      "https://example.com/collect",
    ]) {
      const response = await shim.fetch(url);
      expect(response.status).toBe(403);
      expect(shim.passthrough).not.toContain(url);
    }
  });

  // Nothing reaches the network after installation — not even a same-origin
  // static path, which previously forwarded and left a redirect-to-cross-origin
  // route open and treated blob: URLs as same-origin.
  test("refuses same-origin requests outside the mapped reads", async () => {
    for (const url of ["/not-in-fixture", "/app.js", "blob:https://docs.angelmcp.ai/abc"]) {
      const response = await shim.fetch(url);
      expect(response.status).toBe(403);
      expect(shim.passthrough).not.toContain(url);
    }
  });

  test("accepts a URL object without throwing", async () => {
    const response = await shim.fetch(new URL("https://docs.angelmcp.ai/api/connections"));
    expect(response.status).toBe(200);
  });

  test("lets the fixture itself through to the network", () => {
    expect(shim.passthrough).toContain("fixture.json");
  });

  test("disables the static credential fields and drops their required flag", () => {
    // Both forms must have been located: the shim looking up a selector that no
    // longer exists in www/index.html is the silent failure this guards.
    expect(shim.formsFound.sort()).toEqual([...STATIC_FORM_SELECTORS].sort());
    expect(shim.sealed.length).toBe(STATIC_FORM_SELECTORS.length * 4);
    for (const el of shim.sealed) {
      expect(el.disabled).toBe(true);
      expect(el.removed).toContain("required");
    }
  });
});
