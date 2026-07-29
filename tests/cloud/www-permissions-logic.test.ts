import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// EXECUTE (not grep) the Allowed Tools pane logic shipped in www/app.js. app.js
// is a browser classic script, so we evaluate it in a sandboxed VM with stubbed
// DOM/network globals (same technique the demo-view contract uses for the
// browser validator) and reach in for the pure helpers. This proves real
// behavior: tools are never dropped/duplicated, unknown app/group values still
// render, only Read-group tools are read-only, guard copy is never fabricated,
// and each availability state maps to the correct banner class.
type ToolConnection = { connectionId: string; identity: string; available: boolean };
type Tool = { name: string; app: string; group: string; guards: string[]; connections: ToolConnection[] };

// A minimal, INSPECTABLE DOM node the stubbed document.createElement returns, so
// the real render functions (element/providerLogo/renderProviderCard/…) build a
// tree we can walk and assert on — instead of the opaque catch-all proxy. It
// records exactly what app.js sets: className, textContent, innerHTML, the
// dataset object, setAttribute() attrs, and appended children.
interface StubNode {
  tag: string;
  className: string;
  children: unknown[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  type: string;
  innerHTML: string;
  textContent: string;
  append: (...kids: unknown[]) => StubNode;
  setAttribute: (name: string, value: unknown) => void;
}

function stubNode(tag: string): StubNode {
  const node: StubNode = {
    tag,
    className: "",
    children: [],
    attrs: {},
    dataset: {},
    type: "",
    innerHTML: "",
    textContent: "",
    append(...kids: unknown[]) {
      node.children.push(...kids);
      return node;
    },
    setAttribute(name: string, value: unknown) {
      node.attrs[name] = String(value);
    },
  };
  return node;
}

interface Helpers {
  groupToolsByApp: (tools: Tool[]) => Map<string, Map<string, Tool[]>>;
  isReadOnlyTool: (tool: Tool) => boolean;
  toolNameParts: (name: string) => { namespace: string; leaf: string };
  availabilityBannerState: (environment: unknown) => { paused: boolean; critical: boolean; count: number; total: number; deployed: boolean; noneAvailable: boolean };
  // The DOM-building Allowed Tools renderers, executed against the stub node
  // above. The setters reach the module-level demoState/activeAngelId/
  // activeEnvironment so a test can pin the selected Angel and environment.
  renderToolFolders: (tools: Tool[], options: { withControls: boolean }) => StubNode[];
  providerAccountFolders: (tools: Tool[]) => Array<{ app: string; connection: unknown; groups: unknown }>;
  activeEnvironmentApps: (angel?: unknown) => string[];
  // PR G front-door/back-office helpers, executed against the stub DOM.
  railItemNodes: () => StubNode[];
  gateDetailRows: (environment: unknown) => Array<{ term: string; value: string }>;
  environmentSubLine: (environmentName: string, environment: unknown) => string;
  setDemoState: (state: unknown) => void;
  setActiveAngel: (id: string) => void;
  setActiveEnvironment: (environment: string) => void;
}

function loadHelpers(): Helpers {
  const source = readFileSync(new URL("../../www/app.js", import.meta.url), "utf8");
  // A callable proxy that answers every property access/call with itself, so
  // app.js's top-level DOM wiring and async bootstrap IIFE run without a real DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anything: any = new Proxy(function () {}, { get: () => anything, apply: () => anything, construct: () => anything });
  // document.createElement / createTextNode return INSPECTABLE stub nodes (so the
  // render tree can be asserted); every other document access (querySelector,
  // addEventListener, documentElement, …) falls through to the catch-all proxy so
  // the top-level bootstrap wiring still runs without a real DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const documentStub: any = new Proxy(
    {
      createElement: (tag: string) => stubNode(tag),
      createTextNode: (text: unknown) => ({ tag: "#text", text: String(text), children: [] as unknown[] }),
    },
    { get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : anything) },
  );
  const context: Record<string, unknown> = {
    document: documentStub,
    window: anything,
    localStorage: anything,
    addEventListener: () => {},
    fetch: () => Promise.reject(new Error("no network in unit test")),
    console,
    URL,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}
;globalThis.__h = {
  groupToolsByApp, isReadOnlyTool, toolNameParts, availabilityBannerState,
  renderToolFolders, providerAccountFolders, activeEnvironmentApps,
  railItemNodes, gateDetailRows, environmentSubLine,
  setDemoState: (state) => { demoState = state; },
  setActiveAngel: (id) => { activeAngelId = id; },
  setActiveEnvironment: (environment) => { activeEnvironment = environment; },
};`,
    context,
    { filename: "app.js" },
  );
  const helpers = context.__h as Helpers | undefined;
  if (!helpers || typeof helpers.groupToolsByApp !== "function" || typeof helpers.renderToolFolders !== "function") {
    throw new Error("app.js did not expose the Allowed Tools helpers");
  }
  return helpers;
}

// Depth-first collect every StubNode under a rendered tree (text nodes carry no
// className and are skipped for class filtering).
function collectNodes(root: unknown, out: StubNode[] = []): StubNode[] {
  if (root && typeof root === "object" && "className" in (root as Record<string, unknown>) && Array.isArray((root as StubNode).children)) {
    const node = root as StubNode;
    out.push(node);
    for (const child of node.children) collectNodes(child, out);
  }
  return out;
}

function hasClass(node: StubNode, cls: string): boolean {
  return typeof node.className === "string" && node.className.split(/\s+/).includes(cls);
}

const h = loadHelpers();

function tool(name: string, app: string, group: string, guards: string[]): Tool {
  return { name, app, group, guards, connections: [{ connectionId: "c1", identity: "i1", available: true }] };
}

// Flatten the cross-realm Map<app, Map<group, Tool[]>> into a plain, assertable
// shape of tool NAMES so duplication and drops are both visible.
function flatten(apps: Map<string, Map<string, Tool[]>>): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [app, groups] of apps) {
    out[app] = {};
    for (const [group, tools] of groups) out[app][group] = tools.map((t) => t.name);
  }
  return out;
}

describe("Allowed Tools grouping / read-only / guard-copy helpers", () => {
  // Representative tools include a guarded Read, an unguarded Read, a Use tool,
  // and a tool with an UNKNOWN app AND UNKNOWN group — none may vanish.
  const tools: Tool[] = [
    tool("docs.documents.get", "Google Docs", "Read", []),
    tool("gmail.users.drafts.create", "Gmail", "Use", []),
    tool("gmail.users.messages.get", "Gmail", "Read", []),
    tool("gmail.users.messages.list", "Gmail", "Read", ["maxResults pinned to 5"]),
    tool("mystery.tool.run", "Salesforce", "Automate", ["region forbidden"]),
  ];

  test("groups by real app then group with no tool dropped or duplicated", () => {
    const grouped = flatten(h.groupToolsByApp(tools));
    expect(grouped).toEqual({
      "Google Docs": { Read: ["docs.documents.get"] },
      Gmail: {
        Use: ["gmail.users.drafts.create"],
        Read: ["gmail.users.messages.get", "gmail.users.messages.list"],
      },
      // An unknown app AND an unknown group still produce a folder — the tool is
      // rendered, not silently dropped.
      Salesforce: { Automate: ["mystery.tool.run"] },
    });

    // Count in === count out, and every input name appears exactly once.
    const outNames = Object.values(grouped).flatMap((groups) => Object.values(groups).flat());
    expect(outNames).toHaveLength(tools.length);
    expect(new Set(outNames).size).toBe(tools.length);
    expect([...outNames].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  test("empty tool list yields an empty catalog (no phantom folders)", () => {
    expect(flatten(h.groupToolsByApp([]))).toEqual({});
  });

  test("ONLY Read-group tools are read-only; Use / unknown groups are not", () => {
    expect(h.isReadOnlyTool(tool("x", "Gmail", "Read", []))).toBe(true);
    expect(h.isReadOnlyTool(tool("x", "Gmail", "Use", []))).toBe(false);
    expect(h.isReadOnlyTool(tool("x", "Salesforce", "Automate", []))).toBe(false);
    // Every Read tool in the representative set is read-only; nothing else is.
    for (const t of tools) expect(h.isReadOnlyTool(t)).toBe(t.group === "Read");
  });

  test("tool-name split: namespace recedes, leaf verb is highlighted — never fabricated", () => {
    // A dotted name splits after the LAST dot: everything up to and including it is
    // the receding namespace (.t-ns), the final segment is the highlighted leaf (.t-leaf).
    expect(h.toolNameParts("gmail.users.messages.list")).toEqual({
      namespace: "gmail.users.messages.",
      leaf: "list",
    });
    expect(h.toolNameParts("docs.documents.get")).toEqual({
      namespace: "docs.documents.",
      leaf: "get",
    });
    // A bare (dot-free) name is all leaf, no namespace — nothing invented.
    expect(h.toolNameParts("likePost")).toEqual({ namespace: "", leaf: "likePost" });
    // The two parts always recompose to the exact original name (no characters
    // dropped, added, or reordered) for every representative tool.
    for (const t of tools) {
      const { namespace, leaf } = h.toolNameParts(t.name);
      expect(namespace + leaf).toBe(t.name);
    }
  });
});

describe("availability banner state → class mapping", () => {
  function makeEnv(overrides: Record<string, unknown> = {}): unknown {
    return {
      version: 1,
      digest: "sha256:abc",
      deploymentId: "dep_1",
      keyFingerprint: "fp_1",
      gateAlignment: { installation: "aligned", availability: "aligned" },
      pendingAvailabilityRepair: null,
      availability: { defaultEnabled: true, overrides: {}, revision: 0 },
      bindings: [],
      tools: [],
      lifecycle: [],
      ...overrides,
    };
  }
  function toolWith(available: boolean[]): Tool {
    return {
      name: "t",
      app: "Gmail",
      group: "Read",
      guards: [],
      connections: available.map((a, i) => ({ connectionId: `c${i}`, identity: `i${i}`, available: a })),
    };
  }

  test("healthy (deployed, all available, gates aligned): calm — neither paused nor critical", () => {
    const s = h.availabilityBannerState(makeEnv({ tools: [toolWith([true, true])] }));
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: false, critical: false });
  });

  test("partial (some available): loud WARN — paused but not critical/danger", () => {
    const s = h.availabilityBannerState(makeEnv({ tools: [toolWith([true, false])] }));
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: true, critical: false });
  });

  test("frozen (none available): DANGER — paused and critical", () => {
    const s = h.availabilityBannerState(makeEnv({ tools: [toolWith([false, false])] }));
    expect(s.noneAvailable).toBe(true);
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: true, critical: true });
  });

  test("gate drift (installation mismatched): DANGER — paused and critical", () => {
    const s = h.availabilityBannerState(makeEnv({
      tools: [toolWith([true, true])],
      gateAlignment: { installation: "mismatched", availability: "aligned" },
    }));
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: true, critical: true });
  });

  test("pending repair: DANGER — paused and critical", () => {
    const s = h.availabilityBannerState(makeEnv({
      tools: [toolWith([true, true])],
      pendingAvailabilityRepair: { action: "resume_all" },
    }));
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: true, critical: true });
  });

  test("not deployed: WARN only — paused but never danger", () => {
    const s = h.availabilityBannerState(makeEnv({ version: null, deploymentId: null, tools: [toolWith([false])] }));
    expect(s.deployed).toBe(false);
    expect({ paused: s.paused, critical: s.critical }).toEqual({ paused: true, critical: false });
  });
});

// A tool bound to a set of Connections, in one environment.
function boundTool(name: string, app: string, group: string, connectionIds: string[], guards: string[] = []): Tool {
  return {
    name,
    app,
    group,
    guards,
    connections: connectionIds.map((id) => ({ connectionId: id, identity: `${id}-identity`, available: true })),
  };
}

describe("Allowed Tools renderers are EXECUTED against a stub DOM (never grepped)", () => {
  const angel = {
    id: "a1",
    name: "Golden Assistant",
    connections: [
      { id: "conn-personal", label: "personal-google" },
      { id: "conn-work", label: "work-google" },
    ],
    environments: {
      production: {
        tools: [
          boundTool("docs.documents.get", "Google Docs", "Read", ["conn-personal"]),
          boundTool("gmail.users.messages.list", "Gmail", "Read", ["conn-personal", "conn-work"], ["maxResults pinned to 5"]),
          boundTool("gmail.users.drafts.create", "Gmail", "Use", ["conn-work"]),
        ],
      },
      preview: { tools: [] },
    },
  };
  const prodTools = angel.environments.production.tools;

  function pinProduction() {
    h.setDemoState({ angels: [angel] });
    h.setActiveAngel("a1");
    h.setActiveEnvironment("production");
  }

  test("live mode emits provider:account cards whose toggles carry data-tool + data-connection-id", () => {
    pinProduction();
    const cards = h.renderToolFolders(prodTools, { withControls: true });

    // One card per DISTINCT (provider, Connection) pair — Docs·personal,
    // Gmail·personal, Gmail·work. A renderer that drops the provider cards would
    // leave this empty and fail here.
    const providerCards = cards.filter((card) => hasClass(card, "mprov"));
    expect(providerCards.length).toBe(3);
    expect(cards.length).toBe(3);

    // Every rendered toggle scopes to exactly ONE tool and ONE Connection: it
    // carries both data-tool and data-connection-id, and a pause/resume action.
    const nodes = cards.flatMap((card) => collectNodes(card));
    const toggles = nodes.filter((node) => hasClass(node, "tog"));
    // list is bound to two Connections (2 toggles), get + create one each ⇒ 4.
    expect(toggles.length).toBe(4);
    for (const toggle of toggles) {
      expect(toggle.dataset.tool, "toggle carries data-tool").toBeTruthy();
      expect(toggle.dataset.connectionId, "toggle carries data-connection-id (dataset)").toBeTruthy();
      expect(toggle.attrs["data-connection-id"], "toggle carries data-connection-id (attribute)").toBeTruthy();
      expect(toggle.dataset.action === "pause_tool" || toggle.dataset.action === "resume_tool").toBe(true);
    }
    // The exact (tool, Connection) targets rendered — no tool silently dropped.
    const targets = toggles.map((t) => `${t.dataset.tool}@${t.dataset.connectionId}`).sort();
    expect(targets).toEqual([
      "docs.documents.get@conn-personal",
      "gmail.users.drafts.create@conn-work",
      "gmail.users.messages.list@conn-personal",
      "gmail.users.messages.list@conn-work",
    ]);
  });

  test("explainer mode emits the same card/group/tool structure with ZERO toggle controls", () => {
    pinProduction();
    const cards = h.renderToolFolders(prodTools, { withControls: false });

    // Same component shell: provider cards, group rows, and tool rows all present.
    const nodes = cards.flatMap((card) => collectNodes(card));
    expect(cards.filter((card) => hasClass(card, "mprov")).length).toBeGreaterThan(0);
    expect(nodes.filter((node) => hasClass(node, "mgrp")).length).toBeGreaterThan(0);
    expect(nodes.filter((node) => hasClass(node, "mtool")).length).toBeGreaterThan(0);

    // …but not a single availability toggle: the explainer is read-only.
    expect(nodes.filter((node) => hasClass(node, "tog")).length).toBe(0);
  });
});

describe("Angel header providers derive from the ACTIVE environment only", () => {
  // Production deploys Docs only; preview additionally deploys Gmail. Production
  // must NEVER surface Gmail in its header logos/charter.
  const angel = {
    id: "a1",
    name: "Golden Assistant",
    connections: [{ id: "conn-personal", label: "personal-google" }],
    environments: {
      production: { tools: [boundTool("docs.documents.get", "Google Docs", "Read", ["conn-personal"])] },
      preview: {
        tools: [
          boundTool("docs.documents.get", "Google Docs", "Read", ["conn-personal"]),
          boundTool("gmail.users.messages.list", "Gmail", "Read", ["conn-personal"]),
        ],
      },
    },
  };

  test("production shows Docs only; switching to preview updates to Docs + Gmail", () => {
    h.setDemoState({ angels: [angel] });
    h.setActiveAngel("a1");

    h.setActiveEnvironment("production");
    expect(h.activeEnvironmentApps()).toEqual(["Google Docs"]);

    h.setActiveEnvironment("preview");
    expect(h.activeEnvironmentApps()).toEqual(["Gmail", "Google Docs"]);
  });

  test("an environment with no active Version yields no logos (honest empty, never fabricated)", () => {
    const undeployed = {
      id: "a2",
      name: "Fresh Angel",
      connections: [],
      environments: { production: { tools: [] }, preview: { tools: [] } },
    };
    h.setDemoState({ angels: [undeployed] });
    h.setActiveAngel("a2");
    h.setActiveEnvironment("production");
    expect(h.activeEnvironmentApps()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR G — "front door vs back office": the prototype rail card, a quiet header
// sub line WITHOUT the sha, and the gate/availability mechanical detail
// relocated into Settings. All EXECUTED against the stub DOM (never grepped).
// ---------------------------------------------------------------------------

describe("PR G: angel rail rows render the prototype .rail-item idiom from REAL state", () => {
  const fleet = {
    angels: [
      { id: "a1", name: "gmail-inbox-zero", enabled: true },
      { id: "a2", name: "paused-angel", enabled: false },
      { id: "a3", name: "gcal-admin", enabled: true },
    ],
  };

  test("one row per angel, in order, each a .rail-item carrying data-angel-id", () => {
    h.setDemoState(fleet);
    h.setActiveAngel("a1");
    const rows = h.railItemNodes();
    expect(rows.length).toBe(3);
    for (const row of rows) expect(hasClass(row, "rail-item")).toBe(true);
    expect(rows.map((r) => r.dataset.angelId)).toEqual(["a1", "a2", "a3"]);
    // The visible name is the real angel name (never invented).
    const names = rows.map((r) => (r.children[1] as StubNode).textContent);
    expect(names).toEqual(["gmail-inbox-zero", "paused-angel", "gcal-admin"]);
  });

  test("the .dot-led live/paused class tracks the REAL angel.enabled state", () => {
    h.setDemoState(fleet);
    h.setActiveAngel("a1");
    const dots = h.railItemNodes().map((row) => row.children[0] as StubNode);
    // enabled → live, disabled → paused. No angel's dot lies about its state.
    expect(dots.map((dot) => hasClass(dot, "live"))).toEqual([true, false, true]);
    expect(dots.map((dot) => hasClass(dot, "paused"))).toEqual([false, true, false]);
  });

  test("ONLY the active angel's row is .sel", () => {
    h.setDemoState(fleet);
    h.setActiveAngel("a2");
    const rows = h.railItemNodes();
    expect(rows.map((r) => hasClass(r, "sel"))).toEqual([false, true, false]);
    // Re-selecting moves the .sel marker; it never sticks to two rows.
    h.setActiveAngel("a3");
    expect(h.railItemNodes().map((r) => hasClass(r, "sel"))).toEqual([false, false, true]);
  });
});

describe("PR G: the header sub line is quiet — environment + Version, never a sha", () => {
  test("renders `<Environment> · Version N` with no digest on the front door", () => {
    expect(h.environmentSubLine("Production", { version: 1, digest: "sha256:deadbeefcafef00d" }))
      .toBe("Production · Version 1");
    expect(h.environmentSubLine("Preview", { version: 4, digest: "sha256:0123456789abcdef" }))
      .toBe("Preview · Version 4");
  });

  test("never leaks the sha/digest onto the header, for any digest value", () => {
    for (const digest of ["sha256:deadbeefcafef00d", "sha256:0000", "sha256:ffffffffffffffff"]) {
      const line = h.environmentSubLine("Production", { version: 2, digest });
      expect(line).not.toContain("sha256");
      expect(line).not.toContain(digest);
    }
  });

  test("an undeployed environment stays honest (no active Version), still no sha", () => {
    const line = h.environmentSubLine("Preview", { version: null, digest: null });
    expect(line).toBe("Preview · No active Version");
    expect(line).not.toContain("sha256");
  });
});

describe("PR G: Settings carries the gate/availability mechanical detail (relocated off the front door)", () => {
  function env(overrides: Record<string, unknown> = {}): unknown {
    return {
      version: 1,
      digest: "sha256:abc",
      deploymentId: "dep_1",
      keyFingerprint: "fp_1",
      gateAlignment: { installation: "aligned", availability: "aligned" },
      pendingAvailabilityRepair: null,
      availability: { defaultEnabled: true, overrides: {}, revision: 3 },
      bindings: [],
      tools: [],
      lifecycle: [],
      ...overrides,
    };
  }
  function toolWith(available: boolean[]): Tool {
    return {
      name: "t",
      app: "Gmail",
      group: "Read",
      guards: [],
      connections: available.map((a, i) => ({ connectionId: `c${i}`, identity: `i${i}`, available: a })),
    };
  }
  function asMap(rows: Array<{ term: string; value: string }>): Record<string, string> {
    return Object.fromEntries(rows.map((r) => [r.term, r.value]));
  }

  test("healthy + exact: gate alignment Exact, full N/N bindings, real availability revision", () => {
    const rows = asMap(h.gateDetailRows(env({ tools: [toolWith([true, true])] })));
    expect(rows["Gate alignment"]).toBe("Exact");
    expect(rows["Bindings available"]).toBe("2 / 2");
    // The real revision from state (3), not a fabricated 0.
    expect(rows["Availability revision"]).toBe("3");
  });

  test("partial availability reports Partial + the real available count", () => {
    const rows = asMap(h.gateDetailRows(env({ tools: [toolWith([true, false])] })));
    expect(rows["Gate alignment"]).toBe("Partial");
    expect(rows["Bindings available"]).toBe("1 / 2");
  });

  test("frozen (none available) reports Frozen, not a red front-door alarm", () => {
    const rows = asMap(h.gateDetailRows(env({ tools: [toolWith([false, false])] })));
    expect(rows["Gate alignment"]).toBe("Frozen");
    expect(rows["Bindings available"]).toBe("0 / 2");
  });

  test("gate drift names the mismatched gate(s) honestly", () => {
    const rows = asMap(h.gateDetailRows(env({
      tools: [toolWith([true, true])],
      gateAlignment: { installation: "mismatched", availability: "aligned" },
      availability: { defaultEnabled: true, overrides: {}, revision: 7 },
    })));
    expect(rows["Gate alignment"]).toBe("installation mismatched");
    expect(rows["Availability revision"]).toBe("7");
  });

  test("an undeployed environment reports Not deployed (never Exact)", () => {
    const rows = asMap(h.gateDetailRows(env({ version: null, deploymentId: null, tools: [toolWith([false])] })));
    expect(rows["Gate alignment"]).toBe("Not deployed");
  });
});
