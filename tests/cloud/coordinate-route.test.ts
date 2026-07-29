import { describe, expect, mock, test } from "bun:test";
import { sha256Hex } from "@smcllns/angel-core";

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

const accept = "application/json, text/event-stream";
const KEY = "ak_production_coordinate";

function initializeMessage() {
  return {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contract-client", version: "1.0.0" },
    },
  };
}

async function coordinateEnv(options: { resolutions?: Record<string, string> } = {}) {
  const gatewayKeyHash = await sha256Hex(KEY);
  const runtimeIds: string[] = [];
  const env = {
    CONTROL_GATEWAY_TOKEN: "control-gateway",
    GATEWAY_BROKER_INVOKE_TOKEN: "gateway-broker-invoke",
    GATES: {
      getByName(name: string) {
        runtimeIds.push(name);
        return {
          async snapshot() {
            return {
              gatewayKeyHash,
              installation: {
                artifact: {
                  tools: [{
                    name: "gmail.users.messages.list",
                    provider: "gmail",
                    operation: "gmail.users.messages.list",
                    argGuards: [],
                  }],
                },
                bindings: [{
                  tool: "gmail.users.messages.list",
                  connectionRef: "arc_google",
                  connectionId: "con_google",
                  provider: "gmail",
                  identityLabel: "sam@example.com",
                }],
              },
              availability: {
                defaultEnabled: true,
                overrides: {},
                connectionOverrides: {},
                revision: 0,
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
  return { env: env as never, runtimeIds };
}

function post(path: string, key: string | undefined = KEY) {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(initializeMessage()),
  });
}

describe("the PD 0001 coordinate answers MCP", () => {
  test("bare @handle/angel is production", async () => {
    const { env, runtimeIds } = await coordinateEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(post("/@smcllns/golden-assistant"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { serverInfo: { name: "AngelMCP" } },
    });
    expect(runtimeIds).toEqual(["acct_m1:golden-assistant:production"]);
  });

  test("@handle/angel@preview is the preview environment", async () => {
    const { env, runtimeIds } = await coordinateEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(post("/@smcllns/golden-assistant@preview"), env);
    expect(response.status).toBe(200);
    expect(runtimeIds).toEqual(["acct_m1:golden-assistant:preview"]);
  });

  test("a retired handle answers directly, never a redirect", async () => {
    const { env, runtimeIds } = await coordinateEnv({
      resolutions: { "old-name": "acct_m1", "new-name": "acct_m1" },
    });
    const response = await handleGatewayRequest(post("/@old-name/golden-assistant"), env);
    expect(response.status).toBe(200);
    expect(runtimeIds).toEqual(["acct_m1:golden-assistant:production"]);
  });

  test("an unknown handle answers exactly like a wrong key", async () => {
    const { env, runtimeIds } = await coordinateEnv();
    const response = await handleGatewayRequest(post("/@nobody-here/golden-assistant"), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: -32001, message: "invalid Angel key" },
    });
    expect(runtimeIds).toEqual([]);
  });

  test("latest, production, staging, and pinned @N suffixes are 404, never environments", async () => {
    const { env } = await coordinateEnv({ resolutions: { smcllns: "acct_m1" } });
    for (const suffix of ["@latest", "@production", "@staging", "@3"]) {
      const response = await handleGatewayRequest(post(`/@smcllns/golden-assistant${suffix}`), env);
      expect(response.status).toBe(404);
    }
  });

  test("an internal acct_* id is not a coordinate account segment", async () => {
    const { env } = await coordinateEnv();
    const response = await handleGatewayRequest(post("/@acct_demo/golden-assistant"), env);
    expect(response.status).toBe(404);
  });

  // GET and HEAD on the coordinate now serve the public Angel page (PD 0002),
  // covered in public-angel-page.test.ts. Every other non-POST method stays 405.
  test("non-POST, non-page methods on the coordinate get 405", async () => {
    const { env } = await coordinateEnv({ resolutions: { smcllns: "acct_m1" } });
    const response = await handleGatewayRequest(new Request(
      "https://gateway.example/@smcllns/golden-assistant",
      { method: "DELETE", headers: { accept } },
    ), env);
    expect(response.status).toBe(405);
  });
});

describe("the legacy route still answers through the cutover", () => {
  test("the staging spelling reaches the preview runtime", async () => {
    const { env, runtimeIds } = await coordinateEnv();
    const response = await handleGatewayRequest(post("/v1/a/acct_demo/golden-assistant/staging/mcp"), env);
    expect(response.status).toBe(200);
    expect(runtimeIds).toEqual(["acct_demo:golden-assistant:preview"]);
  });

  test("the preview spelling works on the legacy route too", async () => {
    const { env, runtimeIds } = await coordinateEnv();
    const response = await handleGatewayRequest(post("/v1/a/acct_demo/golden-assistant/preview/mcp"), env);
    expect(response.status).toBe(200);
    expect(runtimeIds).toEqual(["acct_demo:golden-assistant:preview"]);
  });

  test("the production spelling still answers unchanged", async () => {
    const { env, runtimeIds } = await coordinateEnv();
    const response = await handleGatewayRequest(post("/v1/a/acct_demo/golden-assistant/production/mcp"), env);
    expect(response.status).toBe(200);
    expect(runtimeIds).toEqual(["acct_demo:golden-assistant:production"]);
  });
});
