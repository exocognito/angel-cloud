import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const www = join(import.meta.dir, "../../www");

function source(name: string): string {
  const path = join(www, name);
  expect(existsSync(path), `${name} must be shipped in the cloud repo www`).toBe(true);
  return readFileSync(path, "utf8");
}

describe("Angel Cloud deployable demo UI contract", () => {
  test("ships a split, dependency-free application shell", () => {
    const html = source("index.html");
    expect(html).toContain('<link rel="stylesheet" href="/app.css"');
    expect(html).toContain('<script src="/app.js" defer');
    expect(html).toContain('id="app"');
    expect(html).toContain('id="blocking-error"');
  });

  // Helper: slice out the innerHTML of a <nav> by its opening tag.
  function navBlock(html: string, openTag: string): string {
    const start = html.indexOf(openTag);
    expect(start, `${openTag} must exist`).toBeGreaterThanOrEqual(0);
    const from = html.indexOf(">", start) + 1;
    const end = html.indexOf("</nav>", from);
    expect(end, `${openTag} must close`).toBeGreaterThan(from);
    return html.slice(from, end);
  }

  // Helper: STRUCTURALLY parse EVERY <button> in a fragment — its attributes
  // (regardless of order) and its text label (nested elements stripped). This
  // counts every button, so an extra/missing tab or a stray button is caught,
  // and attributes after data-route/data-pane cannot hide a button.
  function parseButtons(fragment: string): Array<{ route: string | null; pane: string | null; label: string; raw: string }> {
    return [...fragment.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => {
      const attrs = m[1]!;
      const inner = m[2]!;
      return {
        route: /\bdata-route="([^"]*)"/.exec(attrs)?.[1] ?? null,
        pane: /\bdata-pane="([^"]*)"/.exec(attrs)?.[1] ?? null,
        label: inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
        raw: m[0]!,
      };
    });
  }

  // Helper: slice the markup of one top-level screen (data-screen="name") up to
  // the next screen (or end of document), so per-screen placement can be pinned.
  function screenBlock(html: string, screen: string): string {
    const marker = `data-screen="${screen}"`;
    const start = html.indexOf(marker);
    expect(start, `screen ${screen} must exist`).toBeGreaterThanOrEqual(0);
    const next = html.indexOf('class="screen"', start + marker.length);
    return html.slice(start, next === -1 ? html.length : next);
  }

  // Helper: extract one top-level `function name(...) { ... }` declaration from
  // the real app.js source by brace-matching, so its ACTUAL shipped logic can be
  // executed in a DOM-free sandbox (no jsdom/happy-dom — no-new-deps policy).
  function extractFunction(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start, `function ${name} must exist`).toBeGreaterThanOrEqual(0);
    const braceStart = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  }

  // Instantiate the named pure functions from app.js source in an isolated
  // scope. `preamble` supplies any free identifiers they close over (as harmless
  // stand-ins), so the real branching logic runs without a browser.
  function loadPure(src: string, names: string[], preamble = ""): Record<string, (...args: unknown[]) => unknown> {
    const defs = names.map((name) => extractFunction(src, name)).join("\n");
    return new Function(`${preamble}\n${defs}\nreturn { ${names.join(", ")} };`)() as Record<string, (...args: unknown[]) => unknown>;
  }

  // Angel fixtures for executing the health logic against representative shapes.
  const alignedEnv = () => ({ gateAlignment: { installation: "aligned", availability: "aligned" }, pendingAvailabilityRepair: null });
  const healthyAngel = () => ({ enabled: true, environments: { preview: alignedEnv(), production: alignedEnv() } });
  const driftedAngel = () => ({ enabled: true, environments: { preview: alignedEnv(), production: { gateAlignment: { installation: "aligned", availability: "mismatched" }, pendingAvailabilityRepair: null } } });
  const pendingRepairAngel = () => ({ enabled: true, environments: { preview: { ...alignedEnv(), pendingAvailabilityRepair: { action: "pause_all" } }, production: alignedEnv() } });
  const disabledAngel = () => ({ enabled: false, environments: { preview: alignedEnv(), production: alignedEnv() } });

  test("exposes exactly the WP-IA top-level and per-angel surfaces", () => {
    const html = source("index.html");

    // Top-level nav is EXACTLY 3 route buttons: Home | Angels | Connections.
    const primary = parseButtons(navBlock(html, '<nav class="primary-nav"'));
    expect(primary).toHaveLength(3);
    expect(primary.every((b) => b.route !== null && b.pane === null)).toBe(true);
    expect(primary.map((b) => [b.route, b.label])).toEqual([
      ["home", "Home"],
      ["angel", "Angels"],
      ["connections", "Connections"],
    ]);

    // Per-angel subnav is EXACTLY 4 pane buttons, in order.
    const subnav = parseButtons(navBlock(html, '<nav class="subnav"'));
    expect(subnav).toHaveLength(4);
    expect(subnav.every((b) => b.pane !== null && b.route === null)).toBe(true);
    expect(subnav.map((b) => [b.pane, b.label])).toEqual([
      ["permissions", "Allowed Tools"],
      ["keys", "Agent Keys"],
      ["activity", "Activity"],
      ["settings", "Settings"],
    ]);

    // Every subnav pane has EXACTLY one matching pane-section container, and
    // there are no extra/orphan sections.
    const sectionKeys = [...html.matchAll(/data-pane-section="([^"]+)"/g)].map((m) => m[1]);
    expect(sectionKeys).toHaveLength(4);
    expect([...sectionKeys].sort()).toEqual(["activity", "keys", "permissions", "settings"]);
    expect([...sectionKeys].sort()).toEqual([...subnav.map((b) => b.pane!)].sort());

    // The notification dot sits on the Activity tab and is the ONLY one.
    expect(html.match(/id="version-notification"/g)?.length).toBe(1);
    const activityTab = subnav.find((b) => b.pane === "activity")!;
    expect(activityTab.raw).toContain('<span class="notification-dot" id="version-notification" hidden></span>');
    for (const other of subnav.filter((b) => b.pane !== "activity")) {
      expect(other.raw).not.toContain("notification-dot");
    }

    // Retired surfaces: no Versions tab/section, no per-angel Connections tab/section.
    expect(subnav.some((b) => b.pane === "versions")).toBe(false);
    expect(subnav.some((b) => b.pane === "connections")).toBe(false);
    expect(sectionKeys).not.toContain("versions");
    expect(sectionKeys).not.toContain("connections");
    // Old subnav labels are gone (renamed, not merely re-ordered).
    expect(subnav.some((b) => b.label === "Permissions")).toBe(false);
    expect(subnav.some((b) => b.label === "MCP & Keys")).toBe(false);
    expect(subnav.some((b) => b.label.startsWith("Versions"))).toBe(false);
    // Top-level Connections is an account screen, never described as per-Angel.
    expect(html).toContain('data-screen="connections"');
    expect(html).not.toContain("available to this Angel");
    // The false hardcoded empty-states must NOT live in static markup; the real
    // account custody lists are rendered from live /api/provider-apps and
    // /api/connections data.
    expect(html).not.toContain("No Google Connections are stored.");
    expect(html).not.toContain("No Provider Apps are stored.");

    // WP2 relocates account custody OFF Home and onto the top-level Connections
    // page. The custody management surface (both forms, both live lists, and the
    // shared status line) lives under the Connections screen; Home no longer
    // carries it, so Home can focus on the Angel health story.
    const connectionsScreen = screenBlock(html, "connections");
    for (const id of ["provider-app-form", "connection-authorize-form", "provider-app-list", "provider-connection-list", "custody-status"]) {
      expect(connectionsScreen, `Connections screen hosts #${id}`).toContain(`id="${id}"`);
    }
    const homeScreen = screenBlock(html, "home");
    expect(homeScreen).not.toContain("custody-panel");
    expect(homeScreen).not.toContain("provider-app-form");
    expect(homeScreen).not.toContain('id="custody-status"');
    // The retired WP-IA clone container is gone.
    expect(html).not.toContain('id="account-connection-list"');

    for (const excluded of ["Pricing", "Catalog", "New angel", "Policy editor", "Account switcher"]) {
      expect(html).not.toContain(excluded);
    }
    expect(html).toContain("Signed in");
    expect(html).not.toContain("public demo");
  });

  test("renders the top-level Connections screen from real account custody data", () => {
    const js = source("app.js");
    // WP2: the Connections page IS the account custody management surface,
    // rendered first-class from the same /api/provider-apps and /api/connections
    // sources — never a hardcoded or cloned list — so it can never assert a false
    // count. renderProviderCustody paints both live lists directly on the page.
    expect(js).toContain("function renderProviderCustody()");
    expect(js).toContain('document.querySelector("#provider-app-list")');
    expect(js).toContain('document.querySelector("#provider-connection-list")');
    // Both live lists refresh whenever custody (re)loads.
    const custody = js.slice(js.indexOf("async function loadProviderCustody"), js.indexOf("function renderProviderCustody"));
    expect(custody).toContain("renderProviderCustody();");
    // The WP-IA clone embryo (renderAccountConnections / #account-connection-list)
    // is retired in favour of the first-class render.
    expect(js).not.toContain("renderAccountConnections");
    expect(js).not.toContain("account-connection-list");
    // The empty-state strings are produced ONLY by the live custody render (shown
    // solely when there are genuinely zero apps/connections), never hardcoded.
    expect(js.match(/No Google Connections are stored\./g)?.length).toBe(1);
    expect(js.match(/No Provider Apps are stored\./g)?.length).toBe(1);
  });

  test("surfaces custody load failures on the top-level Connections screen", () => {
    const js = source("app.js");
    // A single shared status signal is surfaced on the Connections page — not a
    // second bespoke error path.
    expect(js).toContain("function reportCustodyStatus(message, ok)");
    const reporter = js.slice(js.indexOf("function reportCustodyStatus"), js.indexOf("async function startProviderAuthorization"));
    expect(reporter).toContain('document.querySelector("#custody-status")');
    expect(reporter).toContain('document.querySelector("#provider-connection-list")');
    // On failure the live Connection list is replaced with the failure message,
    // so the page never goes blank/stale or shows a false empty state. The guard
    // is the pure custodyStatusPatch (unit-tested below), not an inline literal.
    expect(reporter).toContain("const patch = custodyStatusPatch(ok, message)");
    expect(reporter).toContain('replaceChildren(element("p", "form-note", patch.listReplacement))');

    // Both success and failure of the custody load route THROUGH the shared
    // signal; the load path no longer pokes #custody-status directly.
    const custody = js.slice(js.indexOf("async function loadProviderCustody"), js.indexOf("function renderProviderCustody"));
    expect(custody).toContain('reportCustodyStatus("Provider custody is healthy.", true)');
    expect(custody).toContain("reportCustodyStatus(errorMessage(error), false)");
    expect(custody).not.toContain('#custody-status").textContent =');
  });

  test("routes the WP-IA skeleton, keeping Connections reachable at zero Angels", () => {
    const js = source("app.js");

    // applyNavigation() treats the active route AS the screen, so the top-level
    // connections screen is a first-class screen alongside home and angel.
    expect(js).toContain("const screen = activeRoute;");

    // navigate(): connections is handled BEFORE the zero-Angel guard, so it is
    // reachable with no Angels; the guard only blocks the per-Angel route.
    const nav = js.slice(js.indexOf("function navigate(route)"), js.indexOf("function renderBlockingError"));
    expect(nav).toContain('} else if (route === "connections") {');
    expect(nav.indexOf('route === "connections"'))
      .toBeLessThan(nav.indexOf("demoState?.angels.length === 0"));
    expect(nav).toContain('["permissions", "keys", "activity", "settings"].includes(route)');
    expect(nav).not.toContain('"versions"');

    // Only the Angels nav-item is disabled when there are no Angels; the JS
    // never selects or disables the Connections route, so it stays reachable.
    expect(js).toContain("angelNavigation.disabled = demoState.angels.length === 0;");
    expect(js).not.toContain('data-route="connections"');

    // The top-level Connections screen is account-scoped: it must NOT be driven
    // by the per-Angel renderConnections() (which needs a selected Angel and is
    // skipped by the zero-Angel early return in render()).
    expect(js).not.toContain("renderConnections();");

    // Settings ships as a stub; the retired Versions render stays but unreferenced.
    expect(js).toContain("function renderSettings()");
    expect(js).not.toContain("renderVersions();");
  });

  test("renders Angels from one exact Account aggregate", () => {
    const html = source("index.html");
    const js = source("app.js");
    expect(html).toContain('id="angel-list"');
    expect(html).toContain('id="angel-rail-list"');
    expect(js).toContain('root.schema !== "angelmcp.demo.v4"');
    expect(js).not.toContain('angelmcp.demo.v2');
    expect(js).toContain('const root = exact(value, ["schema", "account", "angels"]');
    expect(js).toContain('angels: list(root.angels, "response.angels", validateAngel)');
    expect(js).toContain("function selectedAngel() {");
    expect(js).toContain("activeAngelId");
  });

  test("keeps custody usable before the Account has its first Angel", () => {
    const js = source("app.js");
    expect(js).not.toContain("COMPARISON_ANGEL_IDS");
    expect(js).toContain("if (demoState.angels.length === 0) {");
    expect(js).toContain("No Angels are deployed yet");
    expect(js).toContain("activeAngelId = demoState.angels[0]?.id;");
  });

  test("folds binding→Connection mapping into provider cards without exposing runtime refs", () => {
    const html = source("index.html");
    const js = source("app.js");
    // PR D retires the dedicated Active bindings panel: the requirement → Connection
    // nickname + account now rides on each provider:account card head (.ps2).
    expect(html).not.toContain("Active bindings");
    expect(html).not.toContain('id="environment-bindings"');
    expect(js).not.toContain("renderEnvironmentBindings");
    // The producer still validates bindings as first-class state (unchanged).
    expect(js).toContain('bindings: list(environment.bindings, `${path}.bindings`, validateBinding)');
    // Cards read the Connection nickname (label) + the account identity — never the
    // opaque runtime connectionRef.
    const folders = extractFunction(js, "providerAccountFolders");
    expect(folders).toContain("connectionById(angel, binding.connectionId).label");
    expect(folders).toContain("binding.identity");
    expect(js).toContain("connectionId");
    expect(js).not.toContain("connectionRef");
  });

  test("targets one tool and Connection, while pause all remains environment-wide", () => {
    const js = source("app.js");
    expect(js).toContain('data-connection-id');
    expect(js).toContain("function renderConnectionToggle(tool, connection)");
    expect(js).toContain("action.dataset.connectionId");
    expect(js).toContain("performAction(action.dataset.action, action.dataset.tool, action.dataset.connectionId)");
    expect(js).toContain("...(connectionId ? { connectionId } : {})");
  });

  test("submits the exact staged deployment, digest, and production bindings for promotion", () => {
    const js = source("app.js");
    expect(js).toContain("stagedDeploymentId: ready.stagedDeploymentId");
    expect(js).toContain("expectedDigest: ready.expectedDigest");
    expect(js).toContain("bindings: ready.bindings");
    expect(js).toContain("angelId: selectedAngel().id");
    expect(js).toContain('element("h3", "", "Production bindings")');
    expect(js).toContain("renderBindingMap(ready.bindings)");
  });

  test("loads normalized state and sends only the five authorized demo actions", () => {
    const js = source("app.js");
    expect(js).toContain('guardedFetch("/api/demo/state"');
    expect(js).toContain('guardedFetch("/api/demo/action"');
    expect(js).toContain('method: "POST"');
    expect(js).toContain("JSON.stringify(body)");
    for (const action of ["promote", "pause_all", "resume_all", "pause_tool", "resume_tool"]) {
      expect(js).toContain(`"${action}"`);
    }
    expect(js).not.toMatch(/fallback|mockState|fixtureState/i);
  });

  test("uses the sign-in session for owner state and actions without a demo bearer", () => {
    const js = source("app.js");
    expect(js).toContain('guardedFetch("/api/demo/state", {');
    expect(js).toContain('guardedFetch("/api/demo/action", {');
    // Every guarded request goes through one place, so a session expiring
    // mid-visit sends the person to sign in rather than showing a raw 401 on
    // whichever request happened to be in flight.
    expect(js).not.toMatch(/await fetch\("\/api\//);
    expect(js).toContain('window.location.replace("/sign-in.html")');
    expect(js).not.toMatch(/demo[_-]?action[_-]?token|sessionStorage|window\.location\.hash|authorization:\s*`Bearer/);
    expect(js).toContain('control.disabled = busy || availabilityBlocked');
  });

  test("stops redirecting when the refusal says the session names no Account", () => {
    // The Control half of this contract is pinned in control-multi-tenant.test.ts.
    // Signing in again cannot fix a session that carries no Account, so sending
    // that person to /sign-in.html returns them to the same refusal for ever.
    // Both sides key off these two literals and nothing but the strings joins
    // them, so each side asserts the other's.
    const js = source("app.js");
    expect(js).toContain('response.headers.get("x-angel-session") === "no-account"');
    // The guard reads the header BEFORE the redirect, or the loop survives the
    // check that was meant to end it.
    const guard = js.indexOf('response.headers.get("x-angel-session") === "no-account"');
    const redirect = js.indexOf('window.location.replace("/sign-in.html")');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(redirect);
  });

  test("provides session-authenticated Provider custody controls without browser bearer tokens", () => {
    const html = source("index.html");
    const js = source("app.js");
    for (const marker of ["provider-app-form", "connection-authorize-form", "provider-app-list", "provider-connection-list", "Reauthorize", "Revoke", "Remove"]) {
      expect(html + js).toContain(marker);
    }
    expect(js).toContain('fetchProvider("/api/provider-apps"');
    expect(js).toContain('fetchProvider("/api/connections"');
    expect(html).toContain('<select name="providerAppId"');
    expect(html).toContain('id="provider-app-selector"');
    expect(html).toContain('name="nickname"');
    expect(html).not.toContain('name="connectionId"');
    expect(html).not.toContain("Connection ID");
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("App nickname");
    expect(html).not.toContain("App nickname / ID");
    expect(js).toContain('provider: "google"');
    expect(js).toContain('body: JSON.stringify({ providerAppId, nickname })');
    const providerSubmit = js.slice(
      js.indexOf('document.querySelector("#provider-app-form")'),
      js.indexOf('document.querySelector("#connection-authorize-form")'),
    );
    expect(providerSubmit.indexOf("form.reset();")).toBeLessThan(providerSubmit.indexOf('await fetchProvider("/api/provider-apps"'));
    const providerFetcher = js.slice(js.indexOf("async function fetchProvider"), js.indexOf("let providerApps"));
    expect(providerFetcher).not.toContain("authorization");
    expect(js).not.toContain("managementToken");
  });

  test("keeps opaque custody IDs in action values while rendering only safe identity", () => {
    const js = source("app.js");
    const custodyRenderer = js.slice(js.indexOf("function renderProviderCustody"), js.indexOf("async function startProviderAuthorization"));
    expect(custodyRenderer).toContain("app.displayName");
    expect(custodyRenderer).toContain("app.clientIdSuffix");
    expect(custodyRenderer).toContain("connection.nickname");
    expect(custodyRenderer).toContain("connection.displayName");
    expect(custodyRenderer).toContain("connection.grantedScopes");
    expect(custodyRenderer).toContain("connection.health");
    expect(custodyRenderer).toContain("option.value = app.id");
    expect(custodyRenderer).not.toMatch(/element\([^\n]*app\.id|`[^`]*\$\{app\.id\}/);
    expect(custodyRenderer).not.toMatch(/element\([^\n]*connection\.id|`[^`]*\$\{connection\.id\}/);
    expect(custodyRenderer).toContain("dataset.connectionId = connection.id");
  });

  test("fails closed on network, HTTP, JSON, and schema errors", () => {
    const js = source("app.js");
    expect(js).toContain("validateDemoState");
    expect(js).toContain("response.ok");
    expect(js).toContain("Demo state unavailable");
    expect(js).toContain("Demo action failed");
    expect(js).toContain("Invalid demo state");
    expect(js).toContain("renderBlockingError");
    expect(js).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*return\s+[{[]/s);
  });

  test("keeps exact promotion, environment isolation, and opaque key identity visible", () => {
    const html = source("index.html");
    const js = source("app.js");
    expect(html).toContain("Promote exact staged Version");
    expect(html).toContain('data-environment="preview"');
    expect(html).toContain('data-environment="production"');
    expect(js).toContain("keyFingerprint");
    expect(js).toContain("The production key fingerprint stays stable across promotions.");
    expect(js).not.toMatch(/api[_-]?key\s*[:=]|clientSecret\s*:\s*["']|ak_[a-z0-9]/i);
  });

  test("the environment switcher is keyboard-accessible: real buttons with names, not spans", () => {
    const html = source("index.html");
    const js = source("app.js");
    // Slice the environment .seg control by its id.
    const segStart = html.indexOf('id="environment-seg"');
    expect(segStart, "environment-seg exists").toBeGreaterThanOrEqual(0);
    const segEnd = html.indexOf("</div>", segStart);
    const seg = html.slice(segStart, segEnd);
    // The group is labelled for assistive tech.
    expect(seg).toContain('role="group"');
    expect(seg).toContain('aria-label="Environment"');
    // Each environment is a REAL, focusable <button type="button"> — never a span.
    expect(seg).not.toContain("<span");
    const segButtons = [...seg.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
      attrs: m[1]!,
      label: m[2]!.replace(/<[^>]*>/g, "").trim(),
    }));
    expect(segButtons).toHaveLength(2);
    for (const button of segButtons) {
      expect(button.attrs).toContain('type="button"');
      expect(/\bdata-environment="(preview|production)"/.test(button.attrs)).toBe(true);
      expect(/\baria-pressed="(true|false)"/.test(button.attrs)).toBe(true);
    }
    // Accessible names come from the visible button text.
    expect(segButtons.map((b) => b.label).sort()).toEqual(["Preview", "Production"]);
    // The renderer keeps aria-pressed in sync with the active environment (so the
    // toggle exposes its state, not just a visual .on class).
    const seam = js.slice(js.indexOf("function renderEnvironmentSeam()"), js.indexOf("function renderConnectionToggle"));
    expect(seam).toContain('tab.setAttribute("aria-pressed", String(on))');
  });

  test("distinguishes gate drift from a converged frozen or exact environment", () => {
    const js = source("app.js");
    expect(js).toContain('oneOf(alignment.installation, ["aligned", "mismatched"]');
    expect(js).toContain('oneOf(alignment.availability, ["aligned", "mismatched"]');
    expect(js).toContain('`${capitalize(activeEnvironment)} gates need repair`');
    expect(js).toContain('gateAlignment.installation === "aligned"');
    expect(js).toContain('gateAlignment.availability === "aligned"');
    expect(js).toContain("const fullyConverged = gatesAligned && pendingRepair === null");
    expect(js).toContain('`${capitalize(activeEnvironment)} repair needs completion`');
    expect(js).toContain('"Pending availability repair must be retried."');
    expect(js).toContain('fullyConverged ? deploymentStatus : "Repairing"');
    expect(js).toContain("pendingAvailabilityRepair");
    expect(js).toContain("repair.dataset.action = pendingRepair.action");
    expect(js).toContain("repair.dataset.tool = pendingRepair.tool");
    expect(js).toContain('if ("connectionId" in pendingRepair) repair.dataset.connectionId = pendingRepair.connectionId');
    expect(js).toContain('repair.dataset.repairAction = ""');
    expect(js).toContain("control.dataset.availabilityAction !== undefined");
    expect(js).toContain('environment.gateAlignment.installation !== "aligned"');
    expect(js).toContain('environment.gateAlignment.availability !== "aligned"');
  });

  test("never presents an undeployed environment as live, frozen, or exact", () => {
    const js = source("app.js");
    expect(js).toContain("environment.version !== null && environment.deploymentId !== null");
    expect(js).toContain('`${capitalize(activeEnvironment)} is not deployed`');
    expect(js).toContain('"No Version is deployed to this environment."');
    expect(js).toContain('deployed ? alignedStatus : "Not deployed"');
  });

  test("renders the selected environment endpoint and requires the public gate receipt", () => {
    const js = source("app.js");
    expect(js).toContain('angel.endpoints?.[activeEnvironment]');
    expect(js).not.toContain("location.origin");
    expect(js).not.toContain("new URL(");
    expect(js).toContain('validateReceipt(event.gateway, `${path}.gateway`, false)');
    expect(js).toContain('validateReceipt(event.broker, `${path}.broker`, true)');
  });

  test("Agent Keys pane is recomposed to the prototype tok-cards and named-key CRUD", () => {
    const html = source("index.html");
    const js = source("app.js");
    // The pane is a single mount the renderer owns; the old single-fingerprint
    // explainer markup is gone (endpoint/keys are built from the demo view).
    expect(html).toContain('data-pane-section="keys"');
    expect(html).toContain('id="keys-host"');
    expect(html).not.toContain("key-explainer");
    expect(html).not.toContain("key-grid");
    // Two tok-cards: the MCP endpoint (real per-environment endpoint) and the
    // Agent keys list.
    expect(js).toContain('element("div", "tok-card")');
    expect(js).toContain('"MCP endpoint"');
    expect(js).toContain('"Agent keys"');
    // Per-key actions are Rotate + Revoke wired to the key id + action; existing
    // keys deliberately have NO Copy (a fingerprint copy is useless for auth and
    // plaintext is unavailable post-mint).
    expect(js).toContain('keyActionButton("rotate_key"');
    expect(js).toContain('keyActionButton("revoke_key"');
    expect(js).toContain("button.dataset.keyId = keyId");
    // The one-time plaintext reveal exposes Copy; it is never stored client-side
    // beyond the render and is dropped on navigation.
    expect(js).toContain('dataset.keyAction = "copy_plaintext"');
    expect(js).toContain("Save it now — it will not be shown again.");
    expect(js).toContain("resetKeysPaneTransient()");
    // Mutations reuse the demo action idiom; copy uses the clipboard API, never
    // the deprecated execCommand.
    expect(js).toContain('guardedFetch("/api/demo/action"');
    expect(js).toContain("navigator.clipboard.writeText");
    expect(js).not.toContain("execCommand");
    // The masked fingerprint is an honest suffix, not a fabricated key_live_ prefix.
    expect(js).toContain("function maskFingerprint");
    expect(js).not.toContain("key_live_");
  });

  test("v3 validator requires first-class endpoints and per-environment lifecycle", () => {
    const js = source("app.js");
    // endpoints is now a required first-class field on every angel (no optional bypass).
    expect(js).toContain('"endpoints"');
    expect(js).not.toContain('Object.hasOwn(angelValue, "endpoints")');
    expect(js).toContain('endpoints: {');
    // Endpoints must validate as absolute http(s) URLs, not merely non-empty strings.
    expect(js).toContain('httpUrl(endpoints.preview,');
    expect(js).toContain('httpUrl(endpoints.production,');
    expect(js).toContain("const HTTP_URL_PATTERN =");
    // lifecycle is validated per environment with strict preview/production separation.
    expect(js).toContain("validateLifecycleEvent");
    expect(js).toContain('lifecycle: list(environment.lifecycle,');
    expect(js).toContain('validateEnvironment(environments.preview, `${path}.environments.preview`, "preview")');
    expect(js).toContain('validateEnvironment(environments.production, `${path}.environments.production`, "production")');
    // real-vs-derived discriminator: derived events must carry a null timestamp.
    expect(js).toContain('["recorded", "derived"]');
  });

  test("preserves the accepted visual system and a 390px responsive contract", () => {
    const css = source("app.css");
    for (const token of ["#17150f", "#23201a", "#423d30", "#3a76a8", "#5ba272", "#cc9a4e"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain('@media (max-width: 390px)');
    expect(css).toContain("SFMono-Regular");
    // PR F — Custody Connection rows are the .conn-row grid (logo · identity ·
    // status / scopes · actions) that stacks at the narrow breakpoint; granted
    // scopes render as wrapping .cap chips that break long Google scope URLs;
    // grid cells shrink below content (min-width: 0).
    expect(css).toContain('grid-template-areas: "logo identity status" "logo scopes actions"');
    expect(css).toMatch(/\.conn-scopes \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.conn-scopes \.cap \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.conn-identity \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.conn-scopes \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.conn-actions \{[^}]*min-width: 0;/);
    // The stacked layout must live in the narrow media block.
    const narrowBlock = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (max-width: 390px)"));
    expect(narrowBlock).toContain('grid-template-areas: "logo identity" "logo status" "scopes scopes" "actions actions"');
  });

  test("PR F: renders custody lists in the prototype .acctwrap/.acct-row/.conn-row idiom", () => {
    const js = source("app.js");
    const custodyRenderer = js.slice(js.indexOf("function renderProviderCustody"), js.indexOf("async function startProviderAuthorization"));
    // Both lists render as .acctwrap cards preceded by a .cfg-h section label.
    expect(custodyRenderer).toContain('element("div", "cfg-h", "Provider Apps")');
    expect(custodyRenderer).toContain('element("div", "cfg-h", "Connections")');
    expect(custodyRenderer.match(/element\("div", "acctwrap"\)/g)?.length).toBe(2);
    // Provider App rows use the flat prototype .acct-row (plogo · name · mono meta),
    // with a NEUTRAL Google plate (providerLogo letters the provider — no fake mark).
    expect(custodyRenderer).toContain('const row = element("div", "acct-row");');
    expect(custodyRenderer).toContain("row.append(providerLogo(app.provider, \"sm\"))");
    expect(custodyRenderer).toContain('element("span", "an", app.displayName)');
    expect(custodyRenderer).toContain("Client ID ending ${app.clientIdSuffix}");
    // Connection rows are the richer .conn-row: neutral plate, identity, a
    // .pill.live health badge, scopes, and the .btn.sm lifecycle actions.
    expect(custodyRenderer).toContain('const row = element("div", "conn-row");');
    expect(custodyRenderer).toContain("row.append(providerLogo(connection.provider, \"sm\"))");
    expect(custodyRenderer).toContain('const identity = element("div", "conn-identity");');
    expect(custodyRenderer).toContain('`pill ${live ? "live" : "paused"}`');
    expect(custodyRenderer).toContain('health.append(element("span", "led")');
    expect(custodyRenderer).toContain("row.append(identity, health, scopes, actions)");
    // The lifecycle actions are compact .btn.sm buttons; Remove is the .stop variant.
    expect(custodyRenderer).toContain('["reauthorize", "Reauthorize", ""]');
    expect(custodyRenderer).toContain('["revoke", "Revoke", ""]');
    expect(custodyRenderer).toContain('["remove", "Remove", " stop"]');
    expect(custodyRenderer).toContain('element("button", `btn sm${variant}`, label)');
  });

  test("PR F: renders granted scopes as accessible, non-lossy .cap chips", () => {
    const js = source("app.js");
    const custodyRenderer = js.slice(js.indexOf("function renderProviderCustody"), js.indexOf("async function startProviderAuthorization"));
    // Scopes are an accessible group of compact mono .cap chips; each chip shows
    // the truncated scopeLabel but keeps the FULL scope URL as its title, so the
    // display transform is never lossy.
    expect(custodyRenderer).toContain('const scopes = element("div", "conn-scopes");');
    expect(custodyRenderer).toContain('scopes.setAttribute("role", "group")');
    expect(custodyRenderer).toContain('scopes.setAttribute("aria-label", "Granted scopes")');
    expect(custodyRenderer).toContain("connection.grantedScopes.map((scope) => {");
    expect(custodyRenderer).toContain('const chip = element("span", "cap", scopeLabel(scope));');
    expect(custodyRenderer).toContain("chip.title = scope;");
  });

  // EXECUTE the scope-truncation so it stays readable AND never lossy: a Google
  // API scope URL collapses to its leaf, everything else passes through whole.
  test("EXECUTES scopeLabel() so scope truncation is readable and never lossy", () => {
    const { scopeLabel } = loadPure(source("app.js"), ["scopeLabel"]) as {
      scopeLabel: (scope: unknown) => string;
    };
    // Google API scope URLs collapse to their readable leaf.
    expect(scopeLabel("https://www.googleapis.com/auth/gmail.readonly")).toBe("gmail.readonly");
    expect(scopeLabel("https://www.googleapis.com/auth/documents.readonly")).toBe("documents.readonly");
    // Bare consent scopes pass through unchanged.
    expect(scopeLabel("openid")).toBe("openid");
    expect(scopeLabel("email")).toBe("email");
    // An unknown provider URL is NOT truncated — the prefix must match exactly, so
    // no information is silently dropped from a scope the label rule doesn't know.
    expect(scopeLabel("https://www.example.com/auth/secret")).toBe("https://www.example.com/auth/secret");
    expect(scopeLabel("https://mail.google.com/")).toBe("https://mail.google.com/");
    // Degenerate inputs are safe and never throw or emit an empty label.
    expect(scopeLabel("https://www.googleapis.com/auth/")).toBe("https://www.googleapis.com/auth/");
    expect(scopeLabel("")).toBe("");
    expect(scopeLabel(null)).toBe("");
    expect(scopeLabel(undefined)).toBe("");
  });

  // EXECUTE the connection row so the action → connection-id dataset wiring is
  // proven live, not merely pinned by source string: deleting a dataset
  // assignment (which would leave every button inert) must FAIL this test.
  test("EXECUTES renderConnectionRow() so each action button carries the exact action + connection id", () => {
    const preamble =
      "const document = { createTextNode: (t) => ({ textNode: String(t) }) };\n"
      + "function element(tag, className, content){ return { tag, className: className || \"\", textContent: content === undefined ? \"\" : String(content), dataset: {}, attrs: {}, kids: [], append(...n){ this.kids.push(...n); }, setAttribute(k, v){ this.attrs[k] = v; } }; }\n"
      + "function providerLogo(app, size){ return element(\"span\", \"plogo \" + (size || \"\")); }\n"
      + "function capitalize(s){ return String(s); }";
    const { renderConnectionRow } = loadPure(source("app.js"), ["scopeLabel", "renderConnectionRow"], preamble) as {
      renderConnectionRow: (connection: unknown) => { kids: unknown[] };
    };
    const connection = {
      id: "con_opaque_7",
      nickname: "family-inbox",
      displayName: "sam@example.test",
      provider: "google",
      grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      health: "healthy",
    };
    const row = renderConnectionRow(connection);
    // Collect every node with a connection-action from the rendered tree.
    const collect = (pred: (n: any) => boolean) => {
      const out: any[] = [];
      (function walk(node: any) {
        if (!node || typeof node !== "object") return;
        if (pred(node)) out.push(node);
        for (const kid of node.kids ?? []) walk(kid);
      })(row);
      return out;
    };
    const buttons = collect((n) => n.dataset && n.dataset.connectionAction !== undefined);
    // Exactly the three lifecycle actions, in order, each labelled and wired to
    // the SAME opaque connection id — the identity a stub renderer would drop.
    expect(buttons.map((b) => b.dataset.connectionAction)).toEqual(["reauthorize", "revoke", "remove"]);
    expect(buttons.map((b) => b.textContent)).toEqual(["Reauthorize", "Revoke", "Remove"]);
    for (const button of buttons) expect(button.dataset.connectionId).toBe("con_opaque_7");
    // Remove is the destructive .stop variant.
    expect(buttons.find((b) => b.dataset.connectionAction === "remove")!.className).toBe("btn sm stop");
    // Scope chips truncate for reading but keep the FULL scope as their title.
    const chips = collect((n) => n.className === "cap");
    expect(chips.map((c) => c.textContent)).toEqual(["openid", "gmail.readonly"]);
    expect(chips.map((c) => c.title)).toEqual(["openid", "https://www.googleapis.com/auth/gmail.readonly"]);
    // The row exposes exactly one polite live region for inline feedback.
    const feedbacks = collect((n) => n.className === "conn-feedback");
    expect(feedbacks).toHaveLength(1);
    expect(feedbacks[0].attrs["aria-live"]).toBe("polite");
  });

  // EXECUTE the action handler across its real branches: disable-during-flight,
  // the per-row guard against concurrent mutations, restore/loud-failure, and the
  // detached-row fallback to the shared status line. The fetch/mutate boundary is
  // stubbed — no network — so a regression in any branch fails here.
  test("EXECUTES runConnectionAction() for disable/guard/restore/failure without a network", async () => {
    const preamble =
      "const document = { querySelector: (s) => globalThis.__hooks.doc(s) };\n"
      + "function errorMessage(e){ return e instanceof Error ? e.message : String(e); }\n"
      + "function mutateConnection(id, action){ return globalThis.__hooks.mutate(id, action); }";
    // extractFunction() slices from `function name(`, dropping the leading
    // `async`, so rebuild the async function expression explicitly (its body uses
    // await). This runs the REAL shipped handler, just with the mutate/DOM
    // boundary stubbed via globalThis.__hooks.
    const runConnectionAction = new Function(
      `${preamble}\nreturn async ${extractFunction(source("app.js"), "runConnectionAction")};`,
    )() as (button: unknown) => Promise<void>;
    const makeRow = () => {
      const feedback = { className: "conn-feedback", textContent: "", isConnected: true };
      const buttons = ["reauthorize", "revoke", "remove"].map((action) => ({
        dataset: { connectionAction: action, connectionId: "con_opaque_7" },
        disabled: false,
        isConnected: true,
        closest: (_: string) => row,
      }));
      const row: any = {
        dataset: {} as Record<string, string>,
        querySelector: (sel: string) => (sel === ".conn-feedback" ? feedback : null),
        querySelectorAll: (_: string) => buttons.slice(),
      };
      return { row, feedback, buttons };
    };

    // 1) Disable-during-flight: pressing Revoke locks the row and disables ALL of
    //    its action buttons; on success (revoke re-renders → row detached) nothing
    //    is restored and the busy lock is released.
    {
      const { row, feedback, buttons } = makeRow();
      let resolve!: () => void;
      (globalThis as any).__hooks = { mutate: () => new Promise<void>((r) => { resolve = r; }), doc: () => ({}) };
      const pending = runConnectionAction(buttons[1]);
      expect(buttons.every((b) => b.disabled)).toBe(true); // ALL disabled, not just Revoke
      expect(feedback.className).toBe("conn-feedback busy");
      expect(row.dataset.busy).toBe("true");
      feedback.isConnected = false; // a concurrent success re-render detaches the row
      buttons.forEach((b) => { b.isConnected = false; });
      resolve();
      await pending;
      expect(row.dataset.busy).toBeUndefined();
    }

    // 2) Per-row guard: a second press while the row is busy is ignored — no
    //    concurrent mutation is dispatched.
    {
      const { buttons } = makeRow();
      let calls = 0;
      (globalThis as any).__hooks = { mutate: () => { calls += 1; return new Promise<void>(() => {}); }, doc: () => ({}) };
      void runConnectionAction(buttons[1]); // Revoke — stays in flight
      void runConnectionAction(buttons[2]); // Remove — must be dropped by the guard
      expect(calls).toBe(1);
      expect(buttons.every((b) => b.disabled)).toBe(true);
    }

    // 3) Loud failure with the row still attached: the button set is restored and
    //    the error is written into THIS row's feedback slot (not the status line).
    {
      const { row, feedback, buttons } = makeRow();
      (globalThis as any).__hooks = {
        mutate: () => Promise.reject(new Error("Broker down")),
        doc: () => { throw new Error("status line must not be touched while the row is attached"); },
      };
      await runConnectionAction(buttons[1]);
      expect(feedback.className).toBe("conn-feedback fail");
      expect(feedback.textContent).toBe("Broker down");
      expect(buttons.every((b) => !b.disabled)).toBe(true); // restored in finally
      expect(row.dataset.busy).toBeUndefined();
    }

    // 4) Detached row on failure: a concurrent re-render removed the live region,
    //    so the failure falls back to the shared #custody-status line — never lost.
    {
      const { feedback, buttons } = makeRow();
      feedback.isConnected = false;
      const statusEl = { textContent: "" };
      (globalThis as any).__hooks = {
        mutate: () => Promise.reject(new Error("Broker down")),
        doc: (s: string) => { expect(s).toBe("#custody-status"); return statusEl; },
      };
      await runConnectionAction(buttons[1]);
      expect(statusEl.textContent).toBe("Broker down");
    }
    delete (globalThis as any).__hooks;
  });

  test("ships the sanctioned light/dark theme toggle with an AA-contrast warn token", () => {
    const html = source("index.html");
    const js = source("app.js");
    const css = source("app.css");
    // The manual theme toggle is WP0's sanctioned addition (Decision 2a): keep it wired.
    expect(html).toContain('id="theme-toggle"');
    expect(js).toContain("angelmcp-theme");
    expect(js).toContain('document.documentElement.setAttribute("data-theme"');
    // Light-mode degraded-state text must clear WCAG AA (4.5:1); #a9762a was only 3.37:1.
    expect(css).toContain("--warn: #8a5e17;");
    expect(css).not.toContain("--warn: #a9762a;");
    // theme-color selects the FIRST matching meta in tree order, so the manual
    // override must be inserted before the OS-scoped metas, never appended last.
    expect(html).toContain("scoped.parentNode.insertBefore(meta, scoped)");
    expect(js).toContain("scoped.parentNode.insertBefore(chrome, scoped)");
  });

  // WP1/PR D — the Allowed Tools pane recomposes the allowlist into the prototype's
  // provider:account cards (.mprov) → group rows (.mgrp) → one-line tool rows
  // (.mtool), surfaces the read-only badge on the provider head, and keeps the
  // availability banner loud. Everything asserted here must derive from real
  // demo-state fields (tool.app, tool.group, tool.connections) — never fabricated.
  test("PR D recomposes the Allowed Tools pane into prototype provider/group/tool cards", () => {
    const js = source("app.js");
    const css = source("app.css");
    // The DOM is built by ONE shared renderer; the live Allowed Tools pane
    // delegates to it (WITH controls). Structural assertions therefore inspect the
    // shared renderer and its helpers, not the pane's inline body.
    const permissions = extractFunction(js, "renderPermissions");
    const folders = extractFunction(js, "renderToolFolders");
    const card = extractFunction(js, "renderProviderCard");
    const group = extractFunction(js, "renderToolGroup");

    // The catalog groups tools by the REAL tool.app then tool.group fields — a
    // two-level app → group tree, not a flat list of every tool.
    expect(js).toContain("function groupToolsByApp(tools)");
    expect(js).toContain("apps.get(tool.app)");
    expect(js).toContain("groups.get(tool.group)");
    // The live pane routes its real tools THROUGH the shared renderer.
    expect(permissions).toContain("renderToolFolders(environment.tools, { withControls: true })");
    // Live: one card per provider:account pair; explainer: one card per app.
    expect(folders).toContain("providerAccountFolders(tools)");
    expect(folders).toContain("groupToolsByApp(tools)");
    expect(js).toContain("function providerAccountFolders(tools)");

    // Provider cards, group rows, and tool rows render with the prototype classes.
    expect(card).toContain('"mprov open"');
    expect(card).toContain('"mprov-head"');
    expect(group).toContain('"mgrp-head"');
    expect(group).toContain("renderToolRow(tool");

    // Read-only is derived ONLY from the real group field (get/list ⇒ "Read"); a
    // fully read-only provider carries the head .ro-badge (not per-tool badges).
    expect(js).toContain("function isReadOnlyTool(tool)");
    expect(js).toContain('return tool.group === "Read";');
    expect(card).toContain("every(isReadOnlyTool)");
    expect(card).toContain('"ro-badge"');
    // The group count reads "N read" for a read-only group, "N allowed" otherwise.
    expect(group).toContain('readOnly ? "read" : "allowed"');

    // Tool names are coloured via the pure toolNameParts split (namespace / leaf).
    expect(js).toContain("function toolNameParts(name)");
    expect(js).toContain('"t-ns"');
    expect(js).toContain('"t-leaf"');

    // The per-(tool, Connection) toggle wiring is preserved in the WITH-controls
    // path, and the toggle itself renders as the prototype .tog switch.
    const toolRow = extractFunction(js, "renderToolRow");
    expect(toolRow).toContain("renderConnectionToggle(tool, binding)");
    const toggle = extractFunction(js, "renderConnectionToggle");
    expect(toggle).toContain("dataset");
    expect(toggle).toContain('tog sm');

    // The prototype component classes the pane relies on ship in the CSS layer.
    for (const cls of [".mprov", ".mprov-head", ".mgrp-head", ".mtool", ".ro-badge", ".t-leaf"]) {
      expect(css).toContain(cls);
    }
  });

  test("WP1 keeps the availability banner loud with warn and danger tokens", () => {
    const js = source("app.js");
    const css = source("app.css");
    const permissions = js.slice(js.indexOf("function renderPermissions()"), js.indexOf("function renderVersions()"));

    // Partial availability keeps the warn treatment; the most degraded states
    // (frozen, gate drift, pending repair) escalate to a distinct danger
    // treatment so degraded states never blend into the calm palette.
    expect(permissions).toContain('banner.classList.toggle("paused"');
    expect(permissions).toContain('banner.classList.toggle("state-banner-critical"');
    // The escalation is driven by real state, not cosmetics.
    expect(permissions).toContain("noneAvailable");
    expect(permissions).toContain("pendingRepair");

    // CSS reuses the existing WP0 warn/danger tokens (no softened/new colors):
    // the loud critical banner is one rule that pulls --danger and a left accent.
    expect(css).toMatch(/\.state-banner\.state-banner-critical \{[^}]*var\(--danger\)[^}]*\}/);
    expect(css).toMatch(/\.state-banner\.state-banner-critical \{[^}]*border-left[^}]*\}/);
    // The warn (partial) treatment still exists and is not softened.
    expect(css).toContain("--warn: #8a5e17;");
    expect(css).toContain(".state-banner.paused");
  });

  // --------------------------------------------------------------------------
  // WP-B: Activity = pulse + decision inbox (three environment-scoped strata)
  // --------------------------------------------------------------------------

  test("WP-B: Activity is a decision inbox with three environment-scoped strata", () => {
    const html = source("index.html");
    const js = source("app.js");
    // Pinned decision card + deploys/versions stratum + hits/rejects stratum all
    // live INSIDE the activity pane-section (WP-B owns only pane content).
    const activityStart = html.indexOf('data-pane-section="activity"');
    const activityEnd = html.indexOf('data-pane-section="settings"');
    expect(activityStart).toBeGreaterThan(0);
    expect(activityEnd).toBeGreaterThan(activityStart);
    const activityPane = html.slice(activityStart, activityEnd);
    expect(activityPane).toContain('id="decision-card"');
    expect(activityPane).toContain('id="lifecycle-list"');
    expect(activityPane).toContain('id="activity-list"');
    // renderActivity orchestrates all three strata; each stratum has its own fn.
    const renderActivity = js.slice(js.indexOf("function renderActivity()"), js.indexOf("function capitalize("));
    expect(renderActivity).toContain("renderDecisionCard()");
    expect(renderActivity).toContain("renderLifecycle()");
    expect(renderActivity).toContain("renderRequestFeed()");
    expect(js).toContain("function renderDecisionCard()");
    expect(js).toContain("function renderLifecycle()");
    expect(js).toContain("function renderRequestFeed()");
  });

  test("WP-B: the pinned decision card reuses the real promotion and repair controls", () => {
    const html = source("index.html");
    const js = source("app.js");
    const card = js.slice(js.indexOf("function renderDecisionCard()"), js.indexOf("function renderLifecycle()"));
    // Promotion decision reuses the exact staged deployment, digest and bindings —
    // via the shared promote-action-template and renderBindingMap, not a new form.
    expect(card).toContain('document.querySelector("#promote-action-template").content.firstElementChild.cloneNode(true)');
    expect(card).toContain("renderBindingMap(ready.bindings)");
    // The gate-repair decision reuses the same data-action / data-repair-action
    // contract the availability banner uses, so the existing handler still fires.
    expect(card).toContain("button.dataset.action = repair.action");
    expect(card).toContain('button.dataset.repairAction = ""');
    // The promote button label ships once, in the shared template.
    expect(html).toContain("Promote exact staged Version");
  });

  test("WP-B: lifecycle renders in `order` sequence with no fabricated timestamp", () => {
    const js = source("app.js");
    const lifecycle = js.slice(js.indexOf("function renderLifecycle()"), js.indexOf("function renderRequestFeed()"));
    // Ordering is the integer `order` field, ascending — the only trustworthy signal.
    expect(lifecycle).toContain("sort((left, right) => left.order - right.order)");
    expect(lifecycle).toContain("event.order + 1");
    // A derived event's null `at` is never rendered as a time; only a genuine
    // recorded event shows its ISO `at`, everything else is labelled un-timed.
    expect(lifecycle).toContain('event.source === "recorded" && event.at !== null');
    expect(lifecycle).toContain("time not recorded");
    // No fabricated relative or absolute time anywhere in the lifecycle render.
    expect(lifecycle).not.toMatch(/ago|toLocaleString|toLocaleTimeString|Date\.now|new Date\(/);
  });

  test("WP-B: every Activity stratum stays strictly scoped to the active environment", () => {
    const html = source("index.html");
    const js = source("app.js");
    // Deploys/versions stratum reads only the active environment's lifecycle array.
    const lifecycle = js.slice(js.indexOf("function renderLifecycle()"), js.indexOf("function renderRequestFeed()"));
    expect(lifecycle).toContain("selectedAngel().environments[activeEnvironment].lifecycle");
    // Hits/rejects stratum filters requests to the active environment.
    const feed = js.slice(js.indexOf("function renderRequestFeed()"), js.indexOf("function renderActivity()"));
    expect(feed).toContain("event.environment === activeEnvironment");
    // The staged→production promotion is a production-only decision, never shown
    // in the preview feed, so preview and production decisions never interleave.
    const card = js.slice(js.indexOf("function renderDecisionCard()"), js.indexOf("function renderLifecycle()"));
    expect(card).toContain('activeEnvironment === "production" && ready !== null');
    // Separation copy is preserved verbatim.
    expect(html).toContain("Preview and production Activity never mix.");
  });

  test("WP-B: the Activity notification dot reflects the real needs-decision signal, not a fabricated count", () => {
    const html = source("index.html");
    const js = source("app.js");
    // The dot lives on the Activity tab (WP-IA) and stays a dot, never a number.
    const subnav = navBlock(html, '<nav class="subnav"');
    expect(subnav).toContain('<span class="notification-dot" id="version-notification" hidden></span>');
    // It is toggled from the genuine readyForProduction signal — no fabricated count.
    expect(js).toContain('document.querySelector("#version-notification").hidden = angel.readyForProduction === null');
    expect(js).not.toContain('version-notification").textContent');
  });

  test("WP-B: a pending gate repair outranks promotion so no failing promote is shown", () => {
    const js = source("app.js");
    const card = js.slice(js.indexOf("function renderDecisionCard()"), js.indexOf("function renderLifecycle()"));
    // The repair branch is evaluated BEFORE the promote branch, so a production
    // that is BOTH promotable (readyForProduction) and repair-pending renders the
    // repair action — never an enabled promote (the backend 409s a promote while
    // an availability repair is pending).
    const repairBranch = card.indexOf("if (repair !== null) {");
    const promoteTemplate = card.indexOf("#promote-action-template");
    const promoteBranch = card.indexOf("} else if (promotable) {");
    expect(repairBranch).toBeGreaterThan(0);
    expect(promoteBranch).toBeGreaterThan(repairBranch);
    expect(promoteTemplate).toBeGreaterThan(repairBranch);
    // The repair decision reuses the existing repair action controls/dataset.
    expect(card).toContain("button.dataset.action = repair.action");
    expect(card).toContain('button.dataset.repairAction = ""');
  });

  test("WP-B: a drifted environment renders a loud decision state, never the calm resting card", () => {
    const js = source("app.js");
    const card = js.slice(js.indexOf("function renderDecisionCard()"), js.indexOf("function renderLifecycle()"));
    // Gate drift is part of the degraded predicate, so mismatched gates never fall
    // through to the calm resting card (loud-degraded-state invariant).
    expect(card).toContain('environment.gateAlignment.installation === "aligned"');
    expect(card).toContain('environment.gateAlignment.availability === "aligned"');
    expect(card).toContain("const degraded = repair !== null || !gatesAligned");
    expect(card).toContain('host.classList.toggle("needs-decision", promotable || degraded)');
    expect(card).toContain('host.classList.toggle("resting", !promotable && !degraded)');
    // Drift is surfaced with the loud "gates need repair" copy shared with Allowed
    // Tools, and it is handled BEFORE the promote branch (drift blocks promotion).
    expect(card).toContain('`${capitalize(activeEnvironment)} gates need repair`');
    const driftBranch = card.indexOf("} else if (!gatesAligned) {");
    const promoteBranch = card.indexOf("} else if (promotable) {");
    expect(driftBranch).toBeGreaterThan(0);
    expect(promoteBranch).toBeGreaterThan(driftBranch);
  });

  test("Home markup carries the health summary line and the density switch", () => {
    const html = source("index.html");
    const homeScreen = screenBlock(html, "home");
    expect(homeScreen).toContain('id="home-health"');
    for (const density of ["quiet", "list", "dashboard"]) {
      expect(homeScreen).toContain(`data-density="${density}"`);
    }
  });

  // PR C — Sam's Home recomposition: a SINGLE header (the duplicate Fleet Health
  // panel is deleted), health moved LEFT as the prototype's .reassure line under
  // the h1, and the density switch is icon-only buttons in a .seg.icons control.
  test("PR C: Home has one header with a left reassure line and an icon density toggle", () => {
    const html = source("index.html");
    const homeScreen = screenBlock(html, "home");

    // The duplicate Fleet Health panel and its old text-button density switch are gone.
    expect(homeScreen).not.toContain("home-health-panel");
    expect(homeScreen).not.toContain("Fleet health");
    expect(homeScreen).not.toContain("density-option");
    // The old top-right fleet status pill is gone (health now reads on the left).
    expect(homeScreen).not.toContain('id="home-status"');

    // Health is the prototype .reassure line under the h1, carrying #home-health.
    const reassureAt = homeScreen.indexOf('class="reassure"');
    expect(reassureAt).toBeGreaterThan(homeScreen.indexOf("<h1>"));
    expect(homeScreen.slice(reassureAt)).toContain('id="home-health"');

    // Density toggle is a .seg.icons control of icon-only buttons — each keeps an
    // accessible label AND title, and references its Lucide sprite symbol.
    const seg = homeScreen.slice(homeScreen.indexOf('class="seg icons"'));
    const densityButtons = parseButtons(seg.slice(0, seg.indexOf("</div>")));
    expect(densityButtons.map((b) => /data-density="([^"]*)"/.exec(b.raw)?.[1])).toEqual(["quiet", "list", "dashboard"]);
    const ICONS: Record<string, string> = { quiet: "icon-circle", list: "icon-list", dashboard: "icon-layout-grid" };
    for (const button of densityButtons) {
      expect(button.label).toBe(""); // icon-only, no visible text
      expect(button.raw).toMatch(/aria-label="[^"]+"/);
      expect(button.raw).toMatch(/title="[^"]+"/);
      const density = /data-density="([^"]*)"/.exec(button.raw)![1]!;
      expect(button.raw).toContain(`#${ICONS[density]}`);
    }

    // The wedge utility marks the real per-Angel info the prototype card omits.
    const js = source("app.js");
    const dashboard = extractFunction(js, "renderHomeAngel");
    expect(dashboard).toContain('"wedge home-wedge"');
    expect(dashboard).toContain("homeVersionWedgeText");
    // The tag is plain language, not internal jargon, and the tooltip carries
    // the full story plus a pointer for whoever inspects the live UI next.
    expect(dashboard).toContain('"not in the design yet"');
    expect(dashboard).not.toContain('"wedged"');
    expect(dashboard).toMatch(/wedge\.title = ".*docs\/design\/prototype-parity-handoff\.md.*"/);
  });

  // EXECUTE the wedge copy: environment-labelled versions must ALWAYS render,
  // with promotion readiness appended — never substituted. Substitution would
  // blur which environment owns which Version exactly when preview is ahead.
  test("EXECUTES homeVersionWedgeText() so readiness never hides per-environment versions", () => {
    const { homeVersionWedgeText } = loadPure(source("app.js"), ["versionLabel", "homeVersionWedgeText"]) as {
      homeVersionWedgeText: (angel: unknown) => string;
    };
    const angelAt = (production: number | null, preview: number | null, ready: { toVersion: number } | null) =>
      ({ environments: { production: { version: production }, preview: { version: preview } }, readyForProduction: ready });
    expect(homeVersionWedgeText(angelAt(1, 1, null))).toBe("prod version 1 · preview version 1");
    expect(homeVersionWedgeText(angelAt(1, 2, { toVersion: 2 })))
      .toBe("prod version 1 · preview version 2 · Version 2 ready for exact promotion");
    expect(homeVersionWedgeText(angelAt(null, 1, null))).toBe("prod no active version · preview version 1");
  });

  // EXECUTE the ambient-hero copy so a degraded fleet cannot silently render the
  // calm "all healthy" headline — the loud honest variant must swap in.
  test("EXECUTES quietHeadline() so degraded fleets get the loud honest copy", () => {
    const preamble =
      'const document = { createTextNode: (t) => ({ rendered: String(t) }) };\n'
      + 'function element(tag, className, content){ const self = { tag, className: className || "", text: content === undefined ? "" : String(content), kids: [], append(...n){ self.kids.push(...n); }, get rendered(){ return self.text + self.kids.map((k) => (k && k.rendered !== undefined ? k.rendered : "")).join(""); } }; return self; }';
    const { quietHeadline } = loadPure(source("app.js"), ["quietHeadline"], preamble) as {
      quietHeadline: (summary: { total: number; attention: number }) => { className: string; kids: Array<{ className: string; rendered: string }>; rendered: string };
    };
    const healthy = quietHeadline({ total: 3, attention: 0 });
    expect(healthy.rendered).toBe("3 Angels. All healthy.");
    expect(healthy.kids.some((k) => k.className === "ok" && k.rendered === "All healthy.")).toBe(true);
    // Singular noun + calm.
    expect(quietHeadline({ total: 1, attention: 0 }).rendered).toBe("1 Angel. All healthy.");
    // Any attention flips to the loud warn span with pluralized, honest copy.
    const one = quietHeadline({ total: 3, attention: 1 });
    expect(one.rendered).toBe("3 Angels. 1 needs attention.");
    expect(one.kids.some((k) => k.className === "warn")).toBe(true);
    expect(one.kids.some((k) => k.className === "ok")).toBe(false);
    expect(quietHeadline({ total: 4, attention: 2 }).rendered).toBe("4 Angels. 2 need attention.");
  });

  // EXECUTE the shared Home projections so they stay derived from real state.
  test("EXECUTES the Home per-Angel projections (apps / tool count / accent)", () => {
    const { homeApps, homeToolCount, angelAccent, shortToolName } = loadPure(
      source("app.js"),
      ["homeApps", "homeToolCount", "angelAccent", "shortToolName"],
    ) as {
      homeApps: (angel: unknown) => string[];
      homeToolCount: (angel: unknown) => number;
      angelAccent: (id: string) => string;
      shortToolName: (name: string) => string;
    };
    const angel = {
      connections: [{ apps: ["Slack"] }],
      environments: {
        production: { tools: [{ app: "Gmail" }, { app: "Google Docs" }, { app: "Gmail" }] },
        preview: { tools: [] },
      },
    };
    // Distinct, sorted apps from the REAL production tools.
    expect(homeApps(angel)).toEqual(["Gmail", "Google Docs"]);
    expect(homeToolCount(angel)).toBe(3);
    // With nothing deployed, apps fall back to the Angel's Connections.
    expect(homeApps({ connections: [{ apps: ["Slack"] }], environments: { production: { tools: [] }, preview: { tools: [] } } })).toEqual(["Slack"]);
    // Accent is a stable hex chosen deterministically from the id.
    expect(angelAccent("gmail-inbox-zero")).toBe(angelAccent("gmail-inbox-zero"));
    expect(angelAccent("gmail-inbox-zero")).toMatch(/^#[0-9a-f]{6}$/);
    // Tool names shorten to their trailing verb path (real names, never invented).
    expect(shortToolName("gmail.users.messages.list")).toBe("messages.list");
    expect(shortToolName("docs.documents.get")).toBe("documents.get");
  });

  test("EXECUTES angelHealthy() so it cannot be short-circuited to always-healthy", () => {
    const { angelHealthy } = loadPure(source("app.js"), ["angelHealthy"]) as {
      angelHealthy: (angel: unknown) => boolean;
    };
    // Healthy only when enabled AND both gate dimensions aligned AND no pending repair.
    expect(angelHealthy(healthyAngel())).toBe(true);
    // Each failure mode independently flips it to false — a `return true` stub fails here.
    expect(angelHealthy(driftedAngel())).toBe(false);
    expect(angelHealthy(pendingRepairAngel())).toBe(false);
    expect(angelHealthy(disabledAngel())).toBe(false);
  });

  test("EXECUTES fleetHealthSummary() to prove the Home count/label are correct", () => {
    const { fleetHealthSummary } = loadPure(source("app.js"), ["angelHealthy", "fleetHealthSummary"]) as {
      fleetHealthSummary: (angels: unknown[]) => { total: number; attention: number; label: string };
    };
    expect(fleetHealthSummary([])).toEqual({ total: 0, attention: 0, label: "No Angels deployed yet" });
    expect(fleetHealthSummary([healthyAngel()])).toEqual({ total: 1, attention: 0, label: "1 Angel · all healthy" });
    expect(fleetHealthSummary([healthyAngel(), healthyAngel()])).toEqual({ total: 2, attention: 0, label: "2 Angels · all healthy" });
    // Gate-drifted and pending-repair Angels must be counted as needing attention.
    expect(fleetHealthSummary([healthyAngel(), driftedAngel()])).toEqual({ total: 2, attention: 1, label: "2 Angels · 1 needs attention" });
    expect(fleetHealthSummary([driftedAngel(), pendingRepairAngel(), disabledAngel()])).toEqual({ total: 3, attention: 3, label: "3 Angels · 3 need attention" });
  });

  test("EXECUTES the density → renderer mapping and pins the default and click wiring", () => {
    const js = source("app.js");
    // Execute the real mapping with stand-in renderer identities.
    const { homeAngelRenderer } = loadPure(js, ["homeAngelRenderer"],
      'const renderHomeAngel = "dashboard", renderHomeAngelList = "list", renderHomeAngelQuiet = "quiet";') as {
      homeAngelRenderer: (density: string) => unknown;
    };
    expect(homeAngelRenderer("dashboard")).toBe("dashboard");
    expect(homeAngelRenderer("list")).toBe("list");
    expect(homeAngelRenderer("quiet")).toBe("quiet");
    expect(homeAngelRenderer("anything-else")).toBe("quiet"); // default is quiet
    // The default mode is quiet, and renderHome dispatches through the mapping.
    expect(js).toContain('let homeDensity = "quiet"');
    expect(js).toContain("homeAngelRenderer(homeDensity)");
    // The density click handler is wired (removing it would fail this): the branch
    // reads the clicked mode and re-renders Home.
    const clickBranch = js.slice(js.indexOf('const density = event.target.closest("[data-density]")'), js.indexOf("const angelTarget = event.target.closest"));
    expect(clickBranch).toContain("homeDensity = density.dataset.density");
    expect(clickBranch).toContain("renderHome()");
    // The full-card render is preserved as one of the modes.
    expect(js).toContain("function renderHomeAngel(angel)");
  });

  test("EXECUTES the custody honesty guards so reversing them fails", () => {
    const { custodyEmptyNotice, custodyStatusPatch } = loadPure(source("app.js"), ["custodyEmptyNotice", "custodyStatusPatch"]) as {
      custodyEmptyNotice: (count: number, message: string) => string | null;
      custodyStatusPatch: (ok: boolean, message: string) => { status: string; listReplacement: string | null };
    };
    // Empty-state notice ONLY at a genuine zero count; populated lists get null.
    expect(custodyEmptyNotice(0, "No Google Connections are stored.")).toBe("No Google Connections are stored.");
    expect(custodyEmptyNotice(1, "No Google Connections are stored.")).toBe(null);
    expect(custodyEmptyNotice(3, "No Provider Apps are stored.")).toBe(null);
    // Error replaces the live list ONLY on failure; a healthy load never blanks it.
    expect(custodyStatusPatch(false, "Broker down")).toEqual({ status: "Broker down", listReplacement: "Broker down" });
    expect(custodyStatusPatch(true, "Provider custody is healthy.")).toEqual({ status: "Provider custody is healthy.", listReplacement: null });
    // And the load path routes success/failure into ok=true/false respectively.
    const js = source("app.js");
    const custody = js.slice(js.indexOf("async function loadProviderCustody"), js.indexOf("function renderProviderCustody"));
    expect(custody).toContain('reportCustodyStatus("Provider custody is healthy.", true)');
    expect(custody).toContain("reportCustodyStatus(errorMessage(error), false)");
  });

  test("builds Settings from only backed pause/resume and immutable Version history", () => {
    const html = source("index.html");
    const js = source("app.js");
    // Slice the Settings pane (last per-angel pane) up to the Connections screen.
    const from = html.indexOf('data-pane-section="settings"');
    expect(from).toBeGreaterThanOrEqual(0);
    const settings = html.slice(from, html.indexOf('data-screen="connections"'));
    const AUTHORIZED = ["promote", "pause_all", "resume_all", "pause_tool", "resume_tool"];
    // COMPLETE Settings control set: parse EVERY interactive control in the pane
    // and require each to carry a valid backed data-action. An unbacked
    // Rename/Delete/Export button (no data-action, or an invalid one) fails here.
    const controls = [...settings.matchAll(/<(button|a|input)\b([^>]*)>/g)].map((m) => ({
      tag: m[1]!,
      action: /\bdata-action="([^"]*)"/.exec(m[2]!)?.[1] ?? null,
      label: m[2]!,
    }));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.action, `Settings control <${control.tag} ${control.label}> must have a data-action`).not.toBe(null);
      expect(AUTHORIZED, `Settings data-action must be authorized`).toContain(control.action!);
    }
    // The exact backed control set is pause_all + resume_all (nothing else).
    expect([...controls.map((c) => c.action)].sort()).toEqual(["pause_all", "resume_all"]);
    expect(settings).toContain("data-availability-action");
    // Immutable Version history container + heading.
    expect(settings).toContain('id="settings-versions-list"');
    expect(settings).toContain("Version history");
    // NO fake/unbacked controls the backend does not support.
    for (const fake of ["Rename", "Delete", "Export"]) {
      expect(settings).not.toContain(fake);
    }
    // Every data-action across the whole UI is one of the five authorized actions.
    const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]!);
    for (const action of actions) {
      expect(AUTHORIZED).toContain(action);
    }
    // renderSettings fills the pane from real angel state (versions + availability),
    // and emits no mutation controls over immutable history.
    expect(js).toContain("function renderSettings()");
    const renderer = js.slice(js.indexOf("function renderSettings()"), js.indexOf("function renderKeys()"));
    expect(renderer).toContain('document.querySelector("#settings-versions-list")');
    expect(renderer).toContain("angel.versions");
    expect(renderer).toContain("availableCount");
    expect(renderer).toContain("tupleCount");
    expect(renderer).not.toMatch(/Rename|Delete|Export/);
    // Settings stays in sync with the active environment (re-rendered on switch).
    const envSwitch = js.slice(js.indexOf('const environment = event.target.closest("[data-environment]")'), js.indexOf('const activity = event.target.closest'));
    expect(envSwitch).toContain("renderSettings();");
  });

  // --------------------------------------------------------------------------
  // WP4: zero-Angel getting-started guide + ANGEL.yaml groups explainer
  // --------------------------------------------------------------------------

  test("WP4: the zero-Angel Home teaches the REAL google-read-proof CLI journey", () => {
    const js = source("app.js");
    // The step list is pure data — execute the SHIPPED function so the commands
    // are the real strings, not a source substring that could drift from render.
    const { newAngelGuideSteps } = loadPure(js, ["newAngelGuideSteps"]) as {
      newAngelGuideSteps: () => Array<{ where: string; title: string; detail: string; commands: string[] }>;
    };
    const steps = newAngelGuideSteps();
    expect(steps.length).toBeGreaterThanOrEqual(6);
    // Every step is a browser or operator-shell step (mirrors the doc's split).
    for (const step of steps) {
      expect(["browser", "shell"]).toContain(step.where);
      expect(typeof step.title).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);
      expect(Array.isArray(step.commands)).toBe(true);
    }
    const commands = steps.flatMap((step) => step.commands);
    // The COMPLETE command strings, EXACTLY as the served docs-site/public/SKILL.md
    // teaches them — the published @angelmcp/cli in the user's own directory, never
    // `bun run angel` or an examples/ path from a clone of this repo, which SKILL.md
    // names as the wrong path. Asserted whole (not by substring) so an extra/altered
    // flag, a stray argument, or a fabricated literal secret value fails here. The
    // credential value stays as SKILL.md's `...` placeholder; the guide must
    // never invent a real session-token literal.
    const DOC_COMMANDS = [
      // SKILL.md step 1 — install the CLI, no repo clone.
      "pnpm add @angelmcp/cli",
      // SKILL.md step 6 — publish to preview with a control-plane session token.
      "ANGEL_MANAGEMENT_TOKEN=... pnpm exec angel publish google-read-proof --preview",
      // SKILL.md step 7 — promote the exact previewed deployment to production.
      "ANGEL_MANAGEMENT_TOKEN=... pnpm exec angel deploy google-read-proof --prod",
    ];
    // The guide renders EXACTLY these commands, in this order — nothing more.
    expect(commands).toEqual(DOC_COMMANDS);
    // And each rendered command equals the doc string character-for-character.
    for (const command of commands) {
      expect(DOC_COMMANDS).toContain(command);
      // No invented literal secret leaked in place of the placeholders.
      expect(command).not.toMatch(/cf-access-client-id":"(?!\.\.\.)/);
      expect(command).not.toMatch(/cf-access-client-secret":"(?!\.\.\.)/);
      expect(command).not.toMatch(/ANGEL_MANAGEMENT_TOKEN=(?!\.\.\.)\S/);
      // Nothing that only works inside a clone of this repo: `bun run angel` is
      // the repo package script, examples/ is a directory only the clone has,
      // and cloning is the headline thing SKILL.md tells readers not to do.
      // `examples` is matched bare, not as `examples/`, because the package
      // script itself is `cd examples && pnpm exec angel` — the likeliest way
      // the clone-only path comes back wearing the right CLI invocation.
      expect(command).not.toMatch(/bun run angel\b/);
      expect(command).not.toMatch(/\bexamples\b/);
      expect(command).not.toMatch(/git clone/);
      // The CLI is a local dependency, so every invocation is `pnpm exec angel`,
      // never a bare `angel build`.
      for (const match of command.matchAll(/angel (?:build|publish|deploy|delete)\b/g)) {
        expect(command.slice(0, match.index)).toMatch(/(?:^|\s)pnpm exec $/);
      }
    }
    // The shown-once production key is described, never fabricated — and it goes
    // to the user's OWN secret store. GOLDEN_ANGEL_KEY is the maintainer's CI
    // secret for the acceptance runner, which SKILL.md puts outside the user path.
    const detail = steps.map((step) => step.detail).join(" ");
    expect(detail).toContain(
      "Save the production Angel key printed by the initial publish/ensure response into your own secret store",
    );
    expect(detail).not.toContain("GOLDEN_ANGEL_KEY");

    // renderHome's zero-Angel branch renders the guide (and preserves the
    // existing empty-state copy the pre-first-Angel test pins).
    const home = js.slice(js.indexOf("function renderHome()"), js.indexOf("function renderAngelHeading"));
    expect(home).toContain("renderZeroAngelGuide()");
    // The honest empty-state copy is preserved (the pre-first-Angel test pins it).
    expect(js).toContain("No Angels are deployed yet");
    expect(js).toContain("function renderNewAngelGuide()");
    expect(js).toContain("function renderZeroAngelGuide()");
    // The head copy around the steps is pinned too. The commands were only ever
    // half the defect: prose that frames this as a run from the operator's own
    // checkout sends the same wrong message to someone who has no checkout.
    const guide = js.slice(
      js.indexOf("function renderNewAngelGuide()"),
      js.indexOf("function renderZeroAngelGuide()"),
    );
    expect(guide).toContain("shell steps run in your own project directory");
    expect(guide).toContain("In your terminal");
    expect(guide).not.toMatch(/operator checkout|Operator shell/);
  });

  test("WP4: the ANGEL.yaml explainer REUSES WP1's group renderer, not a copy", () => {
    const js = source("app.js");
    // The example's rendered side runs through the SHIPPED grouping primitive.
    const { groupToolsByApp, isReadOnlyTool, angelYamlExampleTools } = loadPure(
      js,
      ["groupToolsByApp", "isReadOnlyTool", "angelYamlExampleTools"],
    ) as {
      groupToolsByApp: (tools: Array<{ app: string; group: string }>) => Map<string, Map<string, unknown[]>>;
      isReadOnlyTool: (tool: { group: string }) => boolean;
      angelYamlExampleTools: () => Array<{ name: string; app: string; group: string; guards: string[] }>;
    };
    const tools = angelYamlExampleTools();
    // The example projects into the SAME app → group tree the live pane produces.
    const apps = groupToolsByApp(tools);
    expect([...apps.keys()]).toEqual(["Gmail"]);
    const gmail = apps.get("Gmail")!;
    expect([...gmail.keys()]).toEqual(["Read", "Use"]);
    expect(gmail.get("Read")!.length).toBe(2);
    expect(gmail.get("Use")!.length).toBe(1);
    // Read-only derivation is WP1's, not a reimplementation: list/get are Read,
    // drafts.create is a Use action tool.
    expect(tools.filter(isReadOnlyTool).map((t) => t.name)).toEqual([
      "gmail.users.messages.list",
      "gmail.users.messages.get",
    ]);

    // Neither the explainer NOR the live pane re-derives grouping: the primitive
    // `apps.set(tool.app` exists exactly ONCE in the whole file (groupToolsByApp),
    // and the provider-card DOM shell exists in exactly ONE renderer.
    expect(js.match(/apps\.set\(tool\.app/g)?.length).toBe(1);
    expect(js.match(/function renderProviderCard\(/g)?.length).toBe(1);
    expect(js.match(/function renderToolFolders\(/g)?.length).toBe(1);
    // BOTH panes go through the SINGLE shared renderer, so they cannot diverge:
    //   • the live Allowed Tools pane WITH the connection toggles,
    //   • the static ANGEL.yaml explainer WITHOUT them.
    const permissions = extractFunction(js, "renderPermissions");
    expect(permissions).toContain("renderToolFolders(environment.tools, { withControls: true })");
    const explainer = extractFunction(js, "renderAngelYamlExplainer");
    expect(explainer).toContain("renderToolFolders(angelYamlExampleTools(), { withControls: false })");
    expect(explainer).toContain("angelYamlExampleSource()");
    // The one shared renderer derives everything from the same primitives; only the
    // per-Connection cards+toggles are gated on withControls (grouping/badges shared).
    const folders = extractFunction(js, "renderToolFolders");
    expect(folders).toContain("groupToolsByApp(tools)");
    expect(folders).toContain("providerAccountFolders(tools)");
    expect(folders).toContain("renderProviderCard(app,");
    expect(folders).toContain("if (!withControls)");
    const card = extractFunction(js, "renderProviderCard");
    expect(card).toContain("isReadOnlyTool");
    const toolRow = extractFunction(js, "renderToolRow");
    expect(toolRow).toContain("renderConnectionToggle(tool, binding)");

    // The ANGEL.yaml shown is a REAL shipped policy, not invented: every example
    // tool name appears in examples/angels/gmail-read-and-draft/ANGEL.yaml.
    const realYaml = readFileSync(join(www, "../examples/angels/gmail-read-and-draft/ANGEL.yaml"), "utf8");
    const { angelYamlExampleSource } = loadPure(js, ["angelYamlExampleSource"]) as {
      angelYamlExampleSource: () => string;
    };
    const yamlText = angelYamlExampleSource();
    for (const tool of tools) {
      expect(yamlText, `example yaml lists ${tool.name}`).toContain(tool.name);
      expect(realYaml, `${tool.name} is a real shipped tool`).toContain(tool.name);
    }
  });

  test("WP4: the getting-started CSS is an appended, token-reusing block", () => {
    const css = source("app.css");
    // WP4 appends its own labelled block (no edits to shared rules).
    expect(css).toContain("WP4");
    expect(css).toContain(".wp4-guide");
    expect(css).toContain(".wp4-explainer");
    expect(css).toContain(".wp4-command");
    // Reuses WP0 tokens rather than introducing new colors.
    const wp4 = css.slice(css.indexOf("WP4"));
    expect(wp4).toMatch(/var\(--/);
  });

  // --------------------------------------------------------------------------
  // PR A: prototype component CSS layer + Lucide icon sprite + providerLogo
  // --------------------------------------------------------------------------

  test("PR A: providerLogo maps known apps to sprite symbols and letters unknowns", () => {
    // element() touches the DOM, so stub it; providerLogo closes over the stub
    // and delegates the mapping to the pure providerLogoSymbol we also execute.
    const preamble =
      "function element(tag, className, content){ return { tag, className: className || \"\", innerHTML: \"\", textContent: content === undefined ? \"\" : content }; }";
    const { providerLogo, providerLogoSymbol } = loadPure(
      source("app.js"),
      ["providerLogoSymbol", "providerLogo"],
      preamble,
    ) as {
      providerLogoSymbol: (app: unknown) => string | null;
      providerLogo: (app: unknown, size?: string) => { className: string; innerHTML: string; textContent: string };
    };

    // Every documented app maps to its exact brand-mark symbol id.
    const KNOWN: Array<[string, string]> = [
      ["gmail", "logo-gmail"],
      ["docs", "logo-gdocs"],
      ["gdocs", "logo-gdocs"],
      ["Google Docs", "logo-gdocs"],
      ["calendar", "logo-gcal"],
      ["gcal", "logo-gcal"],
      ["slack", "logo-slack"],
      ["x", "logo-x"],
      ["twitter", "logo-x"],
      ["whatsapp", "logo-whatsapp"],
      ["imessage", "logo-imessage"],
      ["messages", "logo-imessage"],
      ["telegram", "logo-telegram"],
    ];
    for (const [app, symbol] of KNOWN) {
      expect(providerLogoSymbol(app), `${app} → #${symbol}`).toBe(symbol);
      // Case/whitespace-insensitive.
      expect(providerLogoSymbol(`  ${app.toUpperCase()}  `)).toBe(symbol);
      // The rendered element references the mapped symbol and carries the size.
      const el = providerLogo(app, "lg");
      expect(el.className).toBe("plogo lg");
      expect(el.innerHTML).toContain(`#${symbol}`);
      expect(el.textContent).toBe("");
    }

    // Unknown apps get NO symbol and render a neutral lettered plate.
    for (const unknown of ["notion", "figma", "", "   ", null, undefined]) {
      expect(providerLogoSymbol(unknown)).toBe(null);
    }
    const neutral = providerLogo("Notion", "sm");
    expect(neutral.className).toBe("plogo neutral sm");
    expect(neutral.textContent).toBe("N");
    // In a real DOM, setting textContent rewrites innerHTML too — assert only
    // that no sprite reference was rendered, not a stub-specific empty string.
    expect(neutral.innerHTML).not.toContain("#logo-");
    // The symbol referenced by every logo actually exists in the sprite.
    const html = source("index.html");
    for (const [, symbol] of KNOWN) {
      expect(html).toContain(`id="${symbol}"`);
    }
    // Size is optional.
    expect(providerLogo("gmail").className).toBe("plogo");
  });

  test("PR A: the prototype component layer is ported additively, collisions namespaced", () => {
    const css = source("app.css");
    // The layer is a clearly-marked, appended section.
    expect(css).toContain("PROTOTYPE COMPONENT LAYER (PR A)");

    // The four colliding class rules the shipped app already uses are UNCHANGED;
    // the ported prototype variants are namespaced to .pt-* alongside them.
    expect(css).toContain(".page { margin: 0 auto; max-width: 1120px; padding: 40px 32px 72px; }");
    expect(css).toContain(".pane { padding: 22px 34px; }");
    expect(css).toContain("font-size: 26px"); // shipped global h1 scale preserved
    for (const collided of [".pt-topbar", ".pt-brand", ".pt-page", ".pt-pane"]) {
      expect(css, `${collided} namespaced port exists`).toContain(collided);
    }
    // The page-level prototype h1 scale is scoped under .pt-page, never global.
    expect(css).toContain(".pt-page h1 { font-size: 24px;");

    // Key non-colliding prototype classes keep their original names.
    for (const cls of [
      ".pill", ".pill .led", ".pill.live", ".pill.paused",
      ".btn", ".btn.primary", ".btn.stop", ".btn.sm",
      ".seg", ".seg span.on", ".seg.icons", ".seg.sm2",
      ".collist", ".corow", ".corow .cdot", ".corow .cname", ".corow .cmeta",
      "table.wf", "table.wf .nm", "table.wf .mono", ".prov", ".cap",
      ".dash-hero", ".dash-grid", ".dcard", ".dcard .accent", ".dtools", ".dtrow", ".dsub", ".dmore",
      ".plogo", ".plogo.lg", ".plogo.sm", ".plogo.xs",
      ".chart", ".chart-legend", ".s-hit", ".s-rej", ".s-read",
      ".daccts", ".aitem",
      ".shell", ".rail", ".rail-h", ".rail-item", ".rail-item.sel", ".rail-new",
      ".detail-head", ".detail-head .ic", ".detail-head .nm", ".detail-head .sub",
      ".acct-strip", ".acct-chip", ".subtabs", ".subtab", ".subtab.on",
      ".sec-lead", ".code", ".code .k", ".code .c", ".code .p", ".code .o",
      ".tok-card", ".tokrow", ".tog", ".tog.on", ".tog.off", ".tog.sm",
      ".mprov", ".mprov-head", ".mprov-head .pn2", ".mprov-head .ps2", ".mprov-head .ro-badge",
      ".mprov-right", ".mprov-chev", ".mprov-body",
      ".mgrp-head", ".mgrp-mk", ".mgrp-nm", ".mgrp-ct", ".mgrp-chev", ".mgrp-tools", ".mtool", ".mtool .mtn",
      ".t-ns", ".t-leaf", ".tool-g", ".tg-head", ".guard-pill", ".tg-detail",
      ".guard-item", ".gi-kv", ".gi-field", ".gi-op", ".gi-vals", ".gi-nl",
      ".onekey", ".mhead-logos", ".cfg-h", ".acctwrap", ".acct-row", ".acct-more",
      ".set-head", ".set-card", ".set-actions",
      ".steps", ".step", ".guide-foot", ".stub",
      ".icon", ".plogo.neutral",
    ]) {
      expect(css, `ported class ${cls} exists`).toContain(cls);
    }

    // Dark variants preserved in BOTH forms (system preference AND manual toggle).
    expect(css).toContain('@media (prefers-color-scheme: dark){ .btn.primary {');
    expect(css).toContain(':root[data-theme="dark"] .btn.primary {');
    expect(css).toContain(':root[data-theme="light"] .btn.primary {');
    expect(css).toContain('@media (prefers-color-scheme: dark){ .t-leaf {');
    expect(css).toContain(':root[data-theme="dark"] .t-leaf {');
    expect(css).toContain(':root[data-theme="dark"] .rail-item.sel {');
    expect(css).toContain(':root[data-theme="dark"] .subtab.on {');
    // The manual-toggle warn token is untouched by the ported layer.
    expect(css).toContain("--warn: #8a5e17;");
    expect(css).not.toContain("--warn: #a9762a;");
  });

  test("PR G: the wedge utility reads as a QUIET amber 'pending placement', not danger-red", () => {
    const css = source("app.css");
    expect(css).toContain(".wedge {");
    expect(css).toContain(".wedge-tag {");
    // A thin dashed BORDER (not the old outline) + a subtle warn-tone tint.
    expect(css).toMatch(/\.wedge \{[^}]*border:[^}]*dashed[^}]*\}/);
    // The wedge tokens are the amber/tan --warn family in both themes — never the
    // danger-red (#b3452e / #d3745c) they used to be.
    expect(css).toContain("--wedge: #8a5e17;"); // light — matches --warn
    expect(css).toContain("--wedge: #cc9a4e;"); // dark — matches --warn
    expect(css).toContain('@media (prefers-color-scheme: dark){ :root { --wedge: #cc9a4e;');
    expect(css).toContain(':root[data-theme="dark"] { --wedge: #cc9a4e;');
    expect(css).not.toContain("--wedge: #b3452e;");
    expect(css).not.toContain("--wedge: #d3745c;");
    // The small tag is lowercase, not a loud uppercase red chip.
    expect(css).toMatch(/\.wedge-tag \{[^}]*text-transform: lowercase[^}]*\}/);
  });

  test("PR A: needed Lucide icons are inlined as sprite symbols with attribution", () => {
    const html = source("index.html");
    // ISC license attribution for the inlined Lucide paths.
    expect(html).toContain("Lucide");
    expect(html).toContain("ISC License");
    // Each required icon-only-button glyph exists as a 24×24 stroke symbol.
    for (const id of [
      "icon-circle", "icon-list", "icon-layout-grid", "icon-copy", "icon-rotate-cw",
      "icon-ban", "icon-plus", "icon-pause", "icon-play", "icon-download",
    ]) {
      const marker = `<symbol id="${id}" viewBox="0 0 24 24"`;
      expect(html, `${id} symbol exists`).toContain(marker);
      const from = html.indexOf(marker);
      const symbol = html.slice(from, html.indexOf("</symbol>", from));
      expect(symbol).toContain('fill="none"');
      expect(symbol).toContain('stroke="currentColor"');
      expect(symbol).toContain('stroke-width="2"');
      expect(symbol).toContain('stroke-linecap="round"');
      expect(symbol).toContain('stroke-linejoin="round"');
    }
    // The provider brand-mark symbols still ship alongside the new UI icons.
    for (const id of ["logo-gmail", "logo-gcal", "logo-slack", "logo-x"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
