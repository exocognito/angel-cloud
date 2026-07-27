import { describe, expect, test } from "bun:test";
import { parseMcpRequest, mcpError, mcpResult } from "../../src/mcp";

describe("minimal Angel MCP transport", () => {
  test("parses the 2025-06-18 initialize shape, initialized notification, and tool messages", () => {
    const initialize = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize" as const,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contract-client", version: "1.0.0" },
      },
    };
    expect(parseMcpRequest(initialize)).toEqual(initialize);
    expect(parseMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }))
      .toEqual({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(parseMcpRequest({ jsonrpc: "2.0", id: "list", method: "tools/list" }))
      .toEqual({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    expect(parseMcpRequest({ jsonrpc: "2.0", id: "page", method: "tools/list", params: { cursor: "later" } }))
      .toEqual({ jsonrpc: "2.0", id: "page", method: "tools/list", params: { cursor: "later" } });
    expect(parseMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gmail.users.messages.list", arguments: { maxResults: 5 } },
    })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "gmail.users.messages.list", arguments: { maxResults: 5 } },
    });
  });

  test("rejects incomplete initialization, unknown methods, unknown params, and malformed arguments", () => {
    for (const value of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "future-client", version: "1", websiteUrl: "https://example.com" },
        },
      },
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: [] } },
    ]) {
      expect(() => parseMcpRequest(value)).toThrow();
    }
  });

  test("builds exact JSON-RPC result and error envelopes", () => {
    expect(mcpResult("ok", { tools: [] })).toEqual({
      jsonrpc: "2.0",
      id: "ok",
      result: { tools: [] },
    });
    expect(mcpError(3, -32003, "tool paused", { requestId: "req_1" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32003, message: "tool paused", data: { requestId: "req_1" } },
    });
  });
});
