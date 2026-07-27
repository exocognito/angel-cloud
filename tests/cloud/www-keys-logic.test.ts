import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MemoryGateFleet } from "../../src/control";
import {
  AesGcmResponseReplayVault,
  ManagementControl,
  createManagementState,
} from "../../src/management";
import type {
  ManagementBindingMap,
  ManagementVersionArtifact,
  MutationIdentity,
} from "../../src/management-contract";
import { buildDemoView, type DemoView } from "../../src/demo-view";

// EXECUTE (not grep) the Agent Keys pane logic shipped in www/app.js. app.js is a
// browser classic script, so we evaluate it in a sandboxed VM with stubbed
// DOM/network globals (the same technique the Allowed Tools pane logic and the
// demo-view validator tests use) and reach in for the real render helpers +
// mutation flow. This proves REAL behavior: the masked fingerprint is honest, the
// action dataset carries the key id + action, a revoked key never renders as an
// active row, the one-time plaintext reveal renders once and is dropped on
// re-render, row actions disable in flight and restore, and a backend guard (the
// last-active-key 409) surfaces honestly instead of being pre-hidden.

const GATEWAY_BASE_URL = "https://gw.test";
const DEMO_NOW = "2026-07-22T09:30:00.000Z";

interface StubNode {
  tag: string;
  className: string;
  children: unknown[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  type: string;
  title: string;
  disabled: boolean;
  name: string;
  placeholder: string;
  value: string;
  innerHTML: string;
  textContent: string;
  append: (...kids: unknown[]) => StubNode;
  setAttribute: (name: string, value: unknown) => void;
  addEventListener: (event: string, handler: unknown) => void;
  replaceChildren: (...kids: unknown[]) => void;
}

function stubNode(tag: string): StubNode {
  const node: StubNode = {
    tag,
    className: "",
    children: [],
    attrs: {},
    dataset: {},
    type: "",
    title: "",
    disabled: false,
    name: "",
    placeholder: "",
    value: "",
    innerHTML: "",
    textContent: "",
    append(...kids: unknown[]) {
      node.children.push(...kids);
      return node;
    },
    setAttribute(name: string, value: unknown) {
      node.attrs[name] = String(value);
    },
    addEventListener() {},
    replaceChildren(...kids: unknown[]) {
      node.children = [...kids];
    },
  };
  return node;
}

interface KeyView {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string | null;
  revokedAt: string | null;
}

interface KeysHarness {
  maskFingerprint: (fingerprint: unknown) => string;
  renderAgentKeysCard: (keys: KeyView[]) => StubNode;
  renderKeys: () => void;
  resetKeysPaneTransient: () => void;
  performKeyMutation: (action: string, payload: Record<string, unknown>) => Promise<void>;
  setDemoState: (state: unknown) => void;
  setActiveAngel: (id: string) => void;
  setActiveEnvironment: (environment: string) => void;
  setKeyReveal: (reveal: unknown) => void;
  setKeysBusy: (busy: boolean) => void;
  getKeyReveal: () => { plaintext: string; name: string; environment: string } | null;
  getKeysBusy: () => boolean;
  getKeyError: () => string | null;
  keysHost: StubNode;
}

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type FetchImpl = (url: string, options?: unknown) => Promise<StubResponse>;

function loadKeysHarness(): { h: KeysHarness; setFetch: (impl: FetchImpl) => void } {
  const source = readFileSync(new URL("../../www/app.js", import.meta.url), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anything: any = new Proxy(function () {}, { get: () => anything, apply: () => anything, construct: () => anything });
  // A single inspectable #keys-host so renderKeys()'s replaceChildren output can be
  // walked (proving the reveal is painted exactly once by the REAL render path).
  const keysHost = stubNode("div");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const documentStub: any = new Proxy(
    {
      createElement: (tag: string) => stubNode(tag),
      createTextNode: (text: unknown) => ({ tag: "#text", text: String(text), children: [] as unknown[] }),
      querySelector: (selector: string) => (selector === "#keys-host" ? keysHost : anything),
    },
    { get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop] : anything) },
  );
  // A mutable fetch the tests swap per case; defaults to rejecting so the app.js
  // bootstrap IIFE stays inert until a test opts into a network shape.
  const fetchHolder: { impl: FetchImpl } = { impl: () => Promise.reject(new Error("no network in unit test")) };
  let token = 0;
  const context: Record<string, unknown> = {
    document: documentStub,
    window: anything,
    navigator: anything,
    localStorage: anything,
    crypto: { randomUUID: () => `tok-${++token}` },
    addEventListener: () => {},
    fetch: (url: string, options?: unknown) => fetchHolder.impl(url, options),
    console,
    URL,
    Promise,
    JSON,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}
;globalThis.__keys = {
  maskFingerprint,
  renderAgentKeysCard,
  renderKeys,
  resetKeysPaneTransient,
  performKeyMutation,
  setDemoState: (state) => { demoState = state; },
  setActiveAngel: (id) => { activeAngelId = id; },
  setActiveEnvironment: (environment) => { activeEnvironment = environment; },
  setKeyReveal: (reveal) => { keyReveal = reveal; },
  setKeysBusy: (busy) => { keysBusy = busy; },
  getKeyReveal: () => keyReveal,
  getKeysBusy: () => keysBusy,
  getKeyError: () => keyError,
};`,
    context,
    { filename: "app.js" },
  );
  const h = context.__keys as KeysHarness | undefined;
  if (!h || typeof h.maskFingerprint !== "function" || typeof h.renderAgentKeysCard !== "function") {
    throw new Error("app.js did not expose the Agent Keys helpers");
  }
  h.keysHost = keysHost;
  return { h, setFetch: (impl: FetchImpl) => { fetchHolder.impl = impl; } };
}

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

// The concatenated text of a node's direct text-content and any #text descendants,
// so an assertion can read what a row/label actually shows.
function textOf(node: StubNode): string {
  let text = node.textContent ?? "";
  for (const child of node.children) {
    if (child && typeof child === "object") {
      if ((child as { tag?: string }).tag === "#text") text += (child as { text: string }).text;
      else if ("className" in (child as Record<string, unknown>)) text += textOf(child as StubNode);
    }
  }
  return text;
}

function okJson(value: unknown): StubResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(value) };
}

function errorJson(status: number, error: string): StubResponse {
  return { ok: false, status, json: () => Promise.resolve({ error }) };
}

// ---- one genuine DemoView fixture (active Default key + a revoked key) ----
let view: DemoView;
let productionKeys: KeyView[];

beforeAll(async () => {
  const harness = demoHarness();
  const golden = await deployAngel(harness, "golden-assistant", {
    "gdocs-read": ["con_personal_google"],
    "gmail-read-and-draft": ["con_personal_google", "con_work_google"],
  });
  const created = await harness.control.createKey(
    golden.angelId,
    "production",
    { name: "CI deploy" },
    mutation("create-ci", { name: "CI deploy" }),
  );
  await harness.control.revokeKey(
    golden.angelId,
    "production",
    { keyId: created.key.id },
    mutation("revoke-ci", { keyId: created.key.id }),
  );
  view = await buildDemoView(
    harness.control.exportState(),
    (_angelId, slug) => harness.fleets.get(slug)!,
    { gatewayBaseUrl: GATEWAY_BASE_URL },
  );
  productionKeys = view.angels[0]!.environments.production.keys as KeyView[];
});

describe("maskFingerprint — honest short suffix, never a fabricated secret prefix", () => {
  const { h } = loadKeysHarness();

  test("a 12-hex fingerprint masks to dots + its real last three chars", () => {
    expect(h.maskFingerprint("a1b2c3d4e5f6")).toBe("••••5f6");
  });

  test("never invents a key_live_ style prefix; the suffix is always REAL trailing chars", () => {
    const masked = h.maskFingerprint("deadbeef0011");
    expect(masked).toBe("••••011");
    expect(masked).not.toContain("key_live_");
    expect("deadbeef0011".endsWith(masked.replace(/•/g, ""))).toBe(true);
  });

  test("a too-short value is shown verbatim (nothing to mask, nothing fabricated)", () => {
    expect(h.maskFingerprint("ab")).toBe("ab");
    expect(h.maskFingerprint("")).toBe("");
  });
});

describe("Agent keys card — structure, dataset wiring, revoked isolation", () => {
  const { h } = loadKeysHarness();

  test("active keys render as tokrows with masked fingerprint + full-fingerprint title", () => {
    const active: KeyView = { id: "key_1", name: "Default key", fingerprint: "0123456789ab", status: "active", createdAt: DEMO_NOW, revokedAt: null };
    const card = h.renderAgentKeysCard([active]);
    const nodes = collectNodes(card);
    const fingerprint = nodes.find((node) => hasClass(node, "tk"))!;
    // Masked display echoes the prototype; the full public fingerprint is on title.
    expect(fingerprint.textContent).toBe("••••9ab");
    expect(fingerprint.title).toBe("0123456789ab");
    // The row shows the real key name, never the secret hash.
    const name = nodes.find((node) => hasClass(node, "tn"))!;
    expect(name.textContent).toBe("Default key");
  });

  test("each active row wires Rotate/Revoke to the key id + action; existing keys get NO Copy", () => {
    const active: KeyView = { id: "key_abc", name: "CI", fingerprint: "aaaabbbbcccc", status: "active", createdAt: DEMO_NOW, revokedAt: null };
    const card = h.renderAgentKeysCard([active]);
    const actions = collectNodes(card).filter((node) => node.dataset.keyAction !== undefined && node.dataset.keyId !== undefined);
    expect(actions.map((node) => [node.dataset.keyAction, node.dataset.keyId])).toEqual([
      ["rotate_key", "key_abc"],
      ["revoke_key", "key_abc"],
    ]);
    // Copy is NEVER offered on an existing key (a fingerprint copy is useless for
    // auth and plaintext is unavailable post-mint).
    const copy = collectNodes(card).filter((node) => node.dataset.keyAction === "copy_plaintext");
    expect(copy).toHaveLength(0);
  });

  test("a revoked key is isolated in the Revoked group with no actions — never a usable row", () => {
    const active: KeyView = { id: "key_a", name: "Active one", fingerprint: "111122223333", status: "active", createdAt: DEMO_NOW, revokedAt: null };
    const revoked: KeyView = { id: "key_r", name: "Old key", fingerprint: "444455556666", status: "revoked", createdAt: DEMO_NOW, revokedAt: DEMO_NOW };
    const card = h.renderAgentKeysCard([active, revoked]);
    const nodes = collectNodes(card);

    // Exactly one ACTIVE tokrow (the active key); the revoked key never appears as one.
    const activeRows = nodes.filter((node) => hasClass(node, "tokrow") && !hasClass(node, "key-revoked-row"));
    expect(activeRows).toHaveLength(1);
    expect(textOf(activeRows[0]!)).toContain("Active one");
    expect(textOf(activeRows[0]!)).not.toContain("Old key");

    // The revoked key lives only in the dimmed Revoked group, tagged, actionless.
    const group = nodes.find((node) => hasClass(node, "key-revoked-group"))!;
    expect(group).toBeDefined();
    const revokedRow = collectNodes(group).find((node) => hasClass(node, "key-revoked-row"))!;
    expect(textOf(revokedRow)).toContain("Old key");
    expect(collectNodes(group).some((node) => hasClass(node, "key-revoked-tag"))).toBe(true);
    expect(collectNodes(group).some((node) => node.dataset.keyAction !== undefined)).toBe(false);
  });

  test("an empty active set renders an honest empty state, still offering + New key", () => {
    const card = h.renderAgentKeysCard([]);
    const nodes = collectNodes(card);
    expect(nodes.some((node) => hasClass(node, "key-empty"))).toBe(true);
    expect(nodes.some((node) => node.dataset.keyAction === "open_new")).toBe(true);
  });

  test("real projected keys: the migrated Default stays active, the created key is isolated as revoked", () => {
    // productionKeys comes from a genuine buildDemoView projection, not a fabrication.
    expect(productionKeys.map((key) => key.status).sort()).toEqual(["active", "revoked"]);
    const card = h.renderAgentKeysCard(productionKeys);
    const nodes = collectNodes(card);
    const activeRows = nodes.filter((node) => hasClass(node, "tokrow") && !hasClass(node, "key-revoked-row"));
    expect(activeRows).toHaveLength(1);
    // No secret hash is ever rendered.
    expect(JSON.stringify(card).includes("hash")).toBe(false);
  });
});

describe("row actions disable in flight and restore", () => {
  const { h } = loadKeysHarness();

  test("keysBusy disables every active-row action button; clearing it re-enables them", () => {
    const active: KeyView = { id: "key_1", name: "Default key", fingerprint: "0123456789ab", status: "active", createdAt: DEMO_NOW, revokedAt: null };

    h.setKeysBusy(true);
    const busyActions = collectNodes(h.renderAgentKeysCard([active])).filter((node) => node.dataset.keyAction === "rotate_key" || node.dataset.keyAction === "revoke_key");
    expect(busyActions).toHaveLength(2);
    expect(busyActions.every((node) => node.disabled === true)).toBe(true);

    h.setKeysBusy(false);
    const idleActions = collectNodes(h.renderAgentKeysCard([active])).filter((node) => node.dataset.keyAction === "rotate_key" || node.dataset.keyAction === "revoke_key");
    expect(idleActions.every((node) => node.disabled === false)).toBe(true);
  });
});

function keysHostPlaintext(h: KeysHarness): StubNode | undefined {
  return collectNodes(h.keysHost).find((node) => node.dataset.keyPlaintext !== undefined);
}

describe("one-time plaintext reveal path (create success → rendered once → gone on re-render)", () => {
  test("a successful create paints the plaintext ONCE via renderKeys, then a re-render shows nothing — no manual reset (finding #4)", async () => {
    const { h, setFetch } = loadKeysHarness();
    h.setDemoState(structuredClone(view));
    h.setActiveAngel(view.angels[0]!.id);
    h.setActiveEnvironment("production");

    const seenBusy: boolean[] = [];
    setFetch((url) => {
      if (url === "/api/demo/action") {
        seenBusy.push(h.getKeysBusy()); // actions disabled WHILE in flight
        return Promise.resolve(okJson({
          key: { id: "key_new", name: "CI deploy", fingerprint: "abcabcabcabc", status: "active", createdAt: DEMO_NOW, revokedAt: null },
          plaintext: "ak_production_reveal_once_7f3",
        }));
      }
      if (url === "/api/demo/state") return Promise.resolve(okJson(structuredClone(view)));
      throw new Error(`unexpected fetch ${url}`);
    });

    await h.performKeyMutation("create_key", { name: "CI deploy" });

    // In flight the actions were disabled; afterwards the busy flag is restored.
    expect(seenBusy).toEqual([true]);
    expect(h.getKeysBusy()).toBe(false);
    expect(h.getKeyError()).toBe(null);

    // performKeyMutation's own render (the finally) is the SINGLE paint: the #keys-host
    // shows the plaintext in a copyable .code block with the "shown once" warning.
    const painted = keysHostPlaintext(h);
    expect(painted).toBeDefined();
    expect(painted!.textContent).toBe("ak_production_reveal_once_7f3");
    const hostNodes = collectNodes(h.keysHost);
    expect(hostNodes.some((node) => hasClass(node, "key-reveal-warn"))).toBe(true);
    expect(hostNodes.some((node) => node.dataset.keyAction === "copy_plaintext")).toBe(true);
    // Consumed on paint: the module state no longer holds the secret.
    expect(h.getKeyReveal()).toBe(null);

    // A second ordinary render — WITHOUT any manual reset — shows nothing.
    h.renderKeys();
    expect(keysHostPlaintext(h)).toBeUndefined();
  });

  test("a failed list refresh AFTER a committed create still paints the plaintext and surfaces the refresh error (round-2 finding #1)", async () => {
    const { h, setFetch } = loadKeysHarness();
    h.setDemoState(structuredClone(view));
    h.setActiveAngel(view.angels[0]!.id);
    h.setActiveEnvironment("production");

    setFetch((url) => {
      if (url === "/api/demo/action") {
        return Promise.resolve(okJson({
          key: { id: "key_new", name: "CI", fingerprint: "abcabcabcabc", status: "active", createdAt: DEMO_NOW, revokedAt: null },
          plaintext: "ak_production_committed_but_refresh_failed",
        }));
      }
      if (url === "/api/demo/state") return Promise.reject(new Error("state refresh timed out"));
      throw new Error(`unexpected fetch ${url}`);
    });

    await h.performKeyMutation("create_key", { name: "CI" });

    // The key is committed server-side; the one-time plaintext is NOT discarded by
    // the failed refresh — it is still painted, alongside a loud refresh error.
    expect(keysHostPlaintext(h)?.textContent).toBe("ak_production_committed_but_refresh_failed");
    expect(h.getKeyError()).toContain("refreshing the list failed");
    expect(h.getKeysBusy()).toBe(false);
  });

  test("a reveal minted for production never paints as a staging key after a mid-flight switch; it routes back to production (finding #3)", async () => {
    const { h, setFetch } = loadKeysHarness();
    h.setDemoState(structuredClone(view));
    h.setActiveAngel(view.angels[0]!.id);
    h.setActiveEnvironment("production");

    setFetch((url) => {
      if (url === "/api/demo/action") {
        // The operator switches to staging WHILE the request is in flight.
        h.setActiveEnvironment("staging");
        return Promise.resolve(okJson({
          key: { id: "key_prod", name: "Prod key", fingerprint: "abcabcabcabc", status: "active", createdAt: DEMO_NOW, revokedAt: null },
          plaintext: "ak_production_secret_do_not_leak",
        }));
      }
      if (url === "/api/demo/state") return Promise.resolve(okJson(structuredClone(view)));
      throw new Error(`unexpected fetch ${url}`);
    });

    await h.performKeyMutation("create_key", { name: "Prod key" });

    // Completion happens while live env is staging: the secret is NOT painted here.
    expect(h.keysHost.children.length).toBeGreaterThan(0);
    expect(keysHostPlaintext(h)).toBeUndefined();
    // It is held, tagged to the production context it was minted for.
    const held = h.getKeyReveal();
    expect(held).not.toBe(null);
    expect(held!.environment).toBe("production");
    expect(held!.plaintext).toBe("ak_production_secret_do_not_leak");

    // Returning to production routes the reveal to its correct context — painted once.
    h.setActiveEnvironment("production");
    h.renderKeys();
    expect(keysHostPlaintext(h)?.textContent).toBe("ak_production_secret_do_not_leak");
    // ...and then it is gone.
    h.renderKeys();
    expect(keysHostPlaintext(h)).toBeUndefined();
    expect(h.getKeyReveal()).toBe(null);
  });

  test("a lost network response replays with the SAME idempotency token instead of minting a duplicate (finding #2)", async () => {
    const { h, setFetch } = loadKeysHarness();
    h.setDemoState(structuredClone(view));
    h.setActiveAngel(view.angels[0]!.id);
    h.setActiveEnvironment("production");

    const tokens: unknown[] = [];
    let attempt = 0;
    setFetch((url, options) => {
      if (url === "/api/demo/action") {
        tokens.push(JSON.parse(String((options as { body: string }).body)).idempotencyToken);
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("connection reset")); // committed-but-lost
        return Promise.resolve(okJson({
          key: { id: "key_new", name: "CI", fingerprint: "abcabcabcabc", status: "active", createdAt: DEMO_NOW, revokedAt: null },
          plaintext: "ak_production_recovered_once",
        }));
      }
      if (url === "/api/demo/state") return Promise.resolve(okJson(structuredClone(view)));
      throw new Error(`unexpected fetch ${url}`);
    });

    await h.performKeyMutation("create_key", { name: "CI" });

    // Two POST attempts, but the SAME token both times → the server can replay the
    // committed mutation rather than mint a duplicate.
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(h.getKeyError()).toBe(null);
    expect(keysHostPlaintext(h)?.textContent).toBe("ak_production_recovered_once");
  });

  test("revoke never reveals plaintext and surfaces the last-active-key 409 honestly (no retry on a definitive error)", async () => {
    const { h, setFetch } = loadKeysHarness();
    h.setDemoState(structuredClone(view));
    h.setActiveAngel(view.angels[0]!.id);
    h.setActiveEnvironment("production");

    let calls = 0;
    setFetch((url) => {
      if (url === "/api/demo/action") { calls += 1; return Promise.resolve(errorJson(409, "the last active key cannot be revoked")); }
      throw new Error(`unexpected fetch ${url}`);
    });

    await h.performKeyMutation("revoke_key", { keyId: "key_only" });

    expect(calls).toBe(1); // a definitive HTTP error is never retried
    expect(h.getKeyReveal()).toBe(null);
    expect(h.getKeysBusy()).toBe(false);
    expect(h.getKeyError()).toContain("the last active key cannot be revoked");
  });
});

// ---- management harness (mirrors demo-view.test.ts) to produce a REAL view ----
function demoHarness() {
  const fleets = new Map<string, MemoryGateFleet>();
  let id = 0;
  const control = ManagementControl.restore(createManagementState({
    account: { id: "acct_demo", name: "Personal" },
    connections: [
      {
        id: "con_personal_google",
        accountId: "acct_demo",
        nickname: "personal-google",
        identityLabel: "Personal Google",
        credential: "google_oauth",
        providers: ["gmail", "docs"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/documents.readonly",
        ],
        health: "healthy",
      },
      {
        id: "con_work_google",
        accountId: "acct_demo",
        nickname: "work-google",
        identityLabel: "Work Google",
        credential: "google_oauth",
        providers: ["gmail"],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
        health: "healthy",
      },
    ],
  }), {
    replayVault: new AesGcmResponseReplayVault("www-keys-test-kek"),
    fleetFor: (_angelId, slug) => {
      const fleet = fleets.get(slug) ?? new MemoryGateFleet();
      fleets.set(slug, fleet);
      return fleet;
    },
    randomId: (prefix) => `${prefix}_${++id}`,
    checkpoint: { async persist() {} },
    now: () => DEMO_NOW,
  });
  return { control, fleets };
}

async function deployAngel(
  harness: ReturnType<typeof demoHarness>,
  slug: string,
  bindings: ManagementBindingMap,
) {
  const ensured = await harness.control.ensureAngel("acct_demo", slug, mutation(`ensure-${slug}`, {}));
  const artifact = checkedArtifact(slug);
  const publishBody = { artifact, expectedDigest: artifact.digest };
  const version = await harness.control.publishVersion(ensured.angel.id, publishBody, mutation(`publish-${slug}`, publishBody));
  const stagingBody = { versionId: version.id, expectedDigest: version.digest, bindings };
  const staging = await harness.control.deployStaging(ensured.angel.id, stagingBody, mutation(`stage-${slug}`, stagingBody));
  const productionBody = { stagedDeploymentId: staging.id, expectedDigest: staging.digest, bindings };
  await harness.control.promoteProduction(ensured.angel.id, productionBody, mutation(`promote-${slug}`, productionBody));
  return { angelId: ensured.angel.id, version, staging };
}

function checkedArtifact(slug: string): ManagementVersionArtifact {
  const canonicalSource = readFileSync(new URL(`../../angels/${slug}/build/angel.version.json`, import.meta.url), "utf8").trim();
  const digest = readFileSync(new URL(`../../angels/${slug}/build/angel.version.sha256`, import.meta.url), "utf8").trim();
  return { ...JSON.parse(canonicalSource), canonicalSource, digest };
}

function mutation(idempotencyKey: string, body: unknown): MutationIdentity {
  return { method: "POST", path: `/demo/${idempotencyKey}`, idempotencyKey, body };
}
