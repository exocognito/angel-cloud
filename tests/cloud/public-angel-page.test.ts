import { describe, expect, mock, test } from "bun:test";
import type { HostedVersionArtifact } from "../../src/domain";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { handleGatewayRequest } = await import("../../src/workers/gateway");
const { publicAngelView, renderPublicAngelHtml } = await import("../../src/public-angel-page");

// Distinctive strings that must NEVER appear in any public page output.
const SECRET_IDENTITY = "leaky-identity@example.com";
const SECRET_CONNECTION_ID = "con_leaky_distinctive";
const SECRET_CONNECTION_REF = "arc_leaky_distinctive";
const SECRET_ORIGIN = "https://gmail.googleapis.com/leaky-origin";
const SECRET_SOURCE = "canonical-source-leaky-marker";
const SECRET_CHILD = "leaky-child-angel";
const SECRET_SCOPE = "https://www.googleapis.com/auth/leaky.scope";

const ARTIFACT: HostedVersionArtifact = {
  format: "angel.version.v2",
  name: "golden-assistant",
  charter: "Reads the inbox. Never sends, never deletes.",
  children: [{ name: SECRET_CHILD, digest: "sha256:child" }],
  providers: {
    gmail: { adapter: "google-gmail", origin: SECRET_ORIGIN, sourceDigest: "sha256:adapter" },
  },
  bindingRequirements: [{
    id: "google",
    source: "gmail",
    provider: "gmail",
    credential: "google_oauth",
    requiredScopes: [SECRET_SCOPE],
    tools: ["gmail.users.messages.list"],
  }],
  tools: [{
    name: "gmail.users.messages.list",
    provider: "gmail",
    operation: "gmail.users.messages.list",
    argGuards: [
      { field: "maxResults", pin: "5" },
      { field: "q", forbid: true },
    ],
    request: {
      kind: "http",
      method: "GET",
      pathTemplate: "/gmail/v1/users/{userId}/messages",
      pathParams: ["userId"],
      pathDefaults: { userId: "me" },
      queryParams: ["maxResults", "q"],
      hasBody: false,
    },
  }],
  canonicalSource: SECRET_SOURCE,
  digest: "sha256:policy-digest-abc123",
};

function pageEnv(options: {
  resolutions?: Record<string, string>;
  installed?: boolean;
} = {}) {
  const runtimeIds: string[] = [];
  let brokerTouched = false;
  const env = {
    CONTROL_GATEWAY_TOKEN: "control-gateway",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
    BROKER: {
      fetch() {
        brokerTouched = true;
        throw new Error("the public page must never reach the Broker");
      },
    },
    GATES: {
      getByName(name: string) {
        runtimeIds.push(name);
        return {
          async snapshot() {
            return {
              installation: options.installed === false ? null : {
                accountId: "acct_m1",
                angelId: "golden-assistant",
                environment: "production",
                gate: "gateway",
                deploymentId: "dep_1",
                version: 3,
                policyDigest: ARTIFACT.digest,
                bindingsDigest: "sha256:bindings",
                artifact: ARTIFACT,
                bindings: [{
                  tool: "gmail.users.messages.list",
                  connectionRef: SECRET_CONNECTION_REF,
                  connectionId: SECRET_CONNECTION_ID,
                  provider: "gmail",
                  identityLabel: SECRET_IDENTITY,
                }],
              },
            };
          },
        };
      },
    },
    HANDLES: {
      getByName: () => ({
        resolve: async (handle: string) => options.resolutions?.[handle] ?? null,
      }),
    },
  };
  return { env: env as never, runtimeIds, brokerTouched: () => brokerTouched };
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://gateway.example${path}`, { method: "GET", headers });
}

describe("the public Angel page on the bare production coordinate", () => {
  test("GET renders the trust page as HTML by default", async () => {
    const { env, runtimeIds } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(get("/@smcllns/golden-assistant"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("vary")).toBe("Accept");
    const html = await response.text();
    expect(html).toContain("golden-assistant");
    expect(html).toContain("Reads the inbox. Never sends, never deletes.");
    expect(html).toContain("Gmail");
    expect(html).toContain("gmail.users.messages.list");
    expect(html).toContain("maxResults pinned to 5");
    expect(html).toContain("q forbidden");
    expect(html).toContain("Version 3");
    expect(html).toContain("sha256:policy-digest-abc123");
    expect(html).toContain("immutable");
    expect(html).toContain("ANGEL.yaml");
    expect(runtimeIds).toEqual(["acct_m1:golden-assistant:production"]);
  });

  test("Accept: application/json gets the same view as JSON", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(
      get("/@smcllns/golden-assistant", { accept: "application/json" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(await response.json()).toEqual(publicAngelView(ARTIFACT, 3) as never);
  });

  test("the JSON body is exactly the public subset", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(
      get("/@smcllns/golden-assistant", { accept: "application/json" }),
      env,
    );
    expect(await response.json()).toEqual({
      name: "golden-assistant",
      charter: "Reads the inbox. Never sends, never deletes.",
      version: 3,
      policyDigest: "sha256:policy-digest-abc123",
      provenance: "This page describes an immutable artifact compiled from ANGEL.yaml.",
      tools: [{
        name: "gmail.users.messages.list",
        provider: "gmail",
        app: "Gmail",
        operation: "gmail.users.messages.list",
        guards: ["maxResults pinned to 5", "q forbidden"],
      }],
    });
  });

  test("HEAD answers with the same headers and no body", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(
      new Request("https://gateway.example/@smcllns/golden-assistant", { method: "HEAD" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(await response.text()).toBe("");
  });

  test("an empty charter renders gracefully", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const emptyCharter = { ...ARTIFACT, charter: "" };
    (env as { GATES: unknown }).GATES = {
      getByName: () => ({
        async snapshot() {
          return {
            installation: {
              version: 1,
              policyDigest: emptyCharter.digest,
              artifact: emptyCharter,
              bindings: [],
            },
          };
        },
      }),
    };
    const response = await handleGatewayRequest(get("/@smcllns/golden-assistant"), env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("golden-assistant");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  test("requires no auth and never touches the Broker", async () => {
    const { env, brokerTouched } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(get("/@smcllns/golden-assistant"), env);
    expect(response.status).toBe(200);
    expect(brokerTouched()).toBe(false);
  });

  test("never sets a cookie", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const variants: Record<string, string>[] = [{}, { accept: "application/json" }];
    for (const headers of variants) {
      const response = await handleGatewayRequest(get("/@smcllns/golden-assistant", headers), env);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("installation data can never leak to the public page", () => {
  test("identity labels, connection ids, origins, scopes, children, and source never appear", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const secrets = [
      SECRET_IDENTITY,
      SECRET_CONNECTION_ID,
      SECRET_CONNECTION_REF,
      SECRET_ORIGIN,
      SECRET_SOURCE,
      SECRET_CHILD,
      SECRET_SCOPE,
    ];
    const html = await (await handleGatewayRequest(get("/@smcllns/golden-assistant"), env)).text();
    const json = await (await handleGatewayRequest(
      get("/@smcllns/golden-assistant", { accept: "application/json" }),
      env,
    )).text();
    for (const secret of secrets) {
      expect(html).not.toContain(secret);
      expect(json).not.toContain(secret);
    }
  });

  test("user-authored content is HTML-escaped", async () => {
    const hostile = {
      ...ARTIFACT,
      charter: `<script>alert("owned")</script>`,
    };
    const html = renderPublicAngelHtml(publicAngelView(hostile, 1));
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("every page-route 404 is byte-identical", () => {
  test("unknown handle, unknown angel, @preview, @N, and no production deployment", async () => {
    const known = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const undeployed = pageEnv({ resolutions: { smcllns: "acct_m1" }, installed: false });
    const unknown = pageEnv();
    const responses = await Promise.all([
      handleGatewayRequest(get("/@nobody-here/golden-assistant"), unknown.env),
      handleGatewayRequest(get("/@smcllns/golden-assistant"), undeployed.env),
      handleGatewayRequest(get("/@smcllns/golden-assistant@preview"), known.env),
      handleGatewayRequest(get("/@smcllns/golden-assistant@3"), known.env),
      handleGatewayRequest(get("/@smcllns/golden-assistant@latest"), known.env),
    ]);
    const bodies: string[] = [];
    for (const response of responses) {
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    const [first] = bodies;
    for (const body of bodies) expect(body).toBe(first!);
    // The suffix 404s answer before handle resolution, so a suffixed GET can
    // never confirm a handle exists.
    const suffixed = await handleGatewayRequest(get("/@nobody-here/golden-assistant@preview"), unknown.env);
    expect(await suffixed.text()).toBe(first!);
  });

  test("@preview 404s without resolving the handle or touching a gate", async () => {
    const { env, runtimeIds } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(get("/@smcllns/golden-assistant@preview"), env);
    expect(response.status).toBe(404);
    expect(runtimeIds).toEqual([]);
  });
});

describe("surrounding routes keep today's behavior", () => {
  test("GET on the legacy /v1/a route stays 405", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(
      get("/v1/a/acct_m1/golden-assistant/production/mcp"),
      env,
    );
    expect(response.status).toBe(405);
  });

  test("non-GET, non-POST methods on the coordinate stay 405", async () => {
    const { env } = pageEnv({ resolutions: { smcllns: "acct_m1" } });
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const response = await handleGatewayRequest(
        new Request("https://gateway.example/@smcllns/golden-assistant", { method }),
        env,
      );
      expect(response.status).toBe(405);
    }
  });
});

describe("the renderer sees only the artifact and version", () => {
  test("the view is built from the artifact alone", () => {
    const view = publicAngelView(ARTIFACT, 7);
    expect(view.version).toBe(7);
    expect(view.policyDigest).toBe(ARTIFACT.digest);
    expect(JSON.stringify(view)).not.toContain(SECRET_ORIGIN);
    expect(JSON.stringify(view)).not.toContain(SECRET_CHILD);
    expect(JSON.stringify(view)).not.toContain(SECRET_SOURCE);
  });
});
