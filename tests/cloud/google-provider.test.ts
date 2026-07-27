import { describe, expect, test } from "bun:test";
import { GENERATED_ADAPTERS } from "@smcllns/angel-core";
import {
  createGoogleProvider,
  GoogleProviderError,
  GoogleRefreshAuthorizationError,
} from "../../src/google-provider";

const gmail = GENERATED_ADAPTERS.gmail!;
const docs = GENERATED_ADAPTERS.docs!;

function sealed(operation: string, args: Record<string, unknown>) {
  const adapter = operation.split(".", 1)[0] === "docs" ? docs : gmail;
  return {
    operation,
    origin: adapter.origin,
    request: adapter.operations[operation]!.request,
    args,
  };
}

async function run(
  provider: ReturnType<typeof createGoogleProvider>,
  invocation: ReturnType<typeof sealed>,
  credential: ReturnType<typeof lease>,
) {
  return provider.invoke(provider.prepare(invocation), credential);
}

function tokenResponse() {
  return Response.json({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" });
}

describe("Google provider sealed-request execution", () => {
  test("refreshes once and executes the sealed Gmail list template exactly", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const provider = createGoogleProvider(async (input, init) => {
      calls.push({ input, init });
      if (String(input) === "https://oauth2.googleapis.com/token") return tokenResponse();
      return Response.json({ messages: [{ id: "msg_1", threadId: "thread_1" }], resultSizeEstimate: 1 });
    });

    const result = await run(provider, sealed("gmail.users.messages.list", {
      q: "from:alerts@example.com",
      maxResults: "5",
      pageToken: "next-page",
    }), lease());

    expect(result).toEqual({ messages: [{ id: "msg_1", threadId: "thread_1" }], resultSizeEstimate: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      input: "https://oauth2.googleapis.com/token",
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "client_id=client-id&client_secret=client-secret&refresh_token=refresh-token&grant_type=refresh_token",
      },
    });
    // Query params follow sealed template order; the userId path default is
    // materialized without the caller naming it.
    expect(calls[1]).toEqual({
      input: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&pageToken=next-page&q=from%3Aalerts%40example.com",
      init: {
        method: "GET",
        headers: { authorization: "Bearer access-token" },
      },
    });
  });

  test("repeats array-valued query params instead of joining them", async () => {
    const urls: string[] = [];
    const provider = createGoogleProvider(async (input) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      urls.push(String(input));
      return Response.json({});
    });
    await run(provider, sealed("gmail.users.messages.list", { labelIds: ["INBOX", "UNREAD"] }), lease());
    expect(urls[0]).toContain("labelIds=INBOX&labelIds=UNREAD");
  });

  test("executes a sealed write template with the leftover args as JSON body", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const provider = createGoogleProvider(async (input, init) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      calls.push({ input, init });
      return Response.json({ id: "draft_1" });
    });

    const result = await run(provider, sealed("gmail.users.drafts.create", {
      message: { raw: "encoded-mime" },
    }), lease());

    expect(result).toEqual({ id: "draft_1" });
    expect(calls[0]!.input).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(calls[0]!.init).toEqual({
      method: "POST",
      headers: {
        authorization: "Bearer access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: { raw: "encoded-mime" } }),
    });
  });

  test("sends an empty JSON body for a body-capable operation with no body args", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const provider = createGoogleProvider(async (input, init) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      calls.push({ init });
      return Response.json({});
    });
    // messages.modify seals a required request body — omitting it entirely
    // would 400 at Google even though the call is well-formed.
    await run(provider, sealed("gmail.users.messages.modify", { id: "msg_1" }), lease());
    expect(calls[0]!.init?.body).toBe("{}");
    expect((calls[0]!.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("keeps a __proto__ argument in the forwarded body instead of losing it", async () => {
    const bodies: string[] = [];
    const provider = createGoogleProvider(async (input, init) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      bodies.push(String(init?.body));
      return Response.json({});
    });
    await run(provider, sealed("gmail.users.drafts.create", JSON.parse('{"__proto__": {"x": 1}}')), lease());
    expect(bodies[0]).toContain("__proto__");
  });

  test("rejects leftover args on a body-less operation instead of dropping them", async () => {
    let upstreamCalls = 0;
    const provider = createGoogleProvider(async (input) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      upstreamCalls += 1;
      return Response.json({});
    });
    await expect(run(provider, sealed("gmail.users.messages.list", { extraneous: "x" }), lease()))
      .rejects.toThrow(/argument extraneous is not expressible/);
    expect(upstreamCalls).toBe(0);
  });

  test("encodes path params and rejects dot segments that would rewrite the path", async () => {
    const urls: string[] = [];
    const provider = createGoogleProvider(async (input) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      urls.push(String(input));
      return Response.json({});
    });
    await run(provider, sealed("docs.documents.get", { documentId: "doc id/slash" }), lease());
    expect(urls[0]).toBe("https://docs.googleapis.com/v1/documents/doc%20id%2Fslash");

    // "", ".", ".." all rewrite the path to a different resource than the
    // allowlisted operation — an empty id collapses the whole segment.
    for (const documentId of ["", ".", ".."]) {
      await expect(run(provider, sealed("docs.documents.get", { documentId }), lease()))
        .rejects.toThrow(/may not be|must not be empty/);
    }

    // Non-scalars would stringify to "[object Object]" — reject, don't coerce.
    await expect(run(provider, sealed("docs.documents.get", { documentId: {} }), lease()))
      .rejects.toThrow(/string, number, or boolean/);
    await expect(run(provider, sealed("gmail.users.messages.list", { labelIds: [{}] }), lease()))
      .rejects.toThrow(/strings, numbers, or booleans/);
    await expect(run(provider, sealed("gmail.users.messages.list", { q: {} }), lease()))
      .rejects.toThrow(/string, number, or boolean/);
    expect(urls).toHaveLength(1);
  });

  test("fails on a missing required path param with no default", async () => {
    const provider = createGoogleProvider(async (input) => {
      if (String(input).includes("oauth2")) return tokenResponse();
      return Response.json({});
    });
    await expect(run(provider, sealed("docs.documents.get", {}), lease()))
      .rejects.toThrow(/documentId/);
  });

  test("resolves a 204 No Content mutation to an empty result instead of failing after success", async () => {
    const provider = createGoogleProvider(async (input) => String(input).includes("oauth2")
      ? tokenResponse()
      : new Response(null, { status: 204 }));
    // labels.delete really answers 204 — reporting failure after the label
    // was deleted invites a harmful retry.
    await expect(run(provider, sealed("gmail.users.labels.delete", { id: "Label_1" }), lease()))
      .resolves.toEqual({});
  });

  test("reports provider HTTP and malformed JSON failures without returning the body", async () => {
    const forbidden = createGoogleProvider(async (input) => String(input).includes("oauth2")
      ? tokenResponse()
      : Response.json({ secret: "must-not-escape" }, { status: 403 }));
    await expect(run(forbidden, sealed("gmail.users.messages.list", {}), lease()))
      .rejects.toThrow("Google gmail.users.messages.list request failed with status 403");

    const malformed = createGoogleProvider(async (input) => String(input).includes("oauth2")
      ? tokenResponse()
      : new Response("not json", { status: 200 }));
    await expect(run(malformed, sealed("gmail.users.messages.list", {}), lease()))
      .rejects.toThrow("Google gmail.users.messages.list response is invalid");
  });

  test("refreshes independently for successive invocations and retains no access token", async () => {
    let refreshes = 0;
    const authorizationHeaders: string[] = [];
    const provider = createGoogleProvider(async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        refreshes += 1;
        return Response.json({ access_token: `access-${refreshes}`, expires_in: 3600, token_type: "Bearer" });
      }
      authorizationHeaders.push((init?.headers as Record<string, string> | undefined)?.authorization!);
      return Response.json({ invocation: authorizationHeaders.length });
    });

    await run(provider, sealed("gmail.users.messages.list", {}), lease());
    await run(provider, sealed("gmail.users.messages.list", {}), lease());

    expect(refreshes).toBe(2);
    expect(authorizationHeaders).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  test("preserves network cause without exposing credentials in serialization", async () => {
    const networkError = new Error("socket closed while contacting oauth2.googleapis.com using client-secret and refresh-token");
    const provider = createGoogleProvider(async () => {
      throw networkError;
    });

    const thrown = await run(provider, sealed("gmail.users.messages.list", {}), lease())
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GoogleProviderError);
    const cause = (thrown as GoogleProviderError & { cause?: Error }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.message).toContain("socket closed");
    expect(cause?.message).not.toContain("client-secret");
    expect(cause?.message).not.toContain("refresh-token");
    expect((thrown as Error).message).not.toContain("client-secret");
    expect((thrown as Error).message).not.toContain("refresh-token");
    expect(JSON.stringify(thrown)).not.toContain("client-secret");
    expect(JSON.stringify(thrown)).not.toContain("refresh-token");
  });

  test("sanitizes an access-token network cause without attaching the original error", async () => {
    const originalError = new Error("socket closed while using access-token");
    const provider = createGoogleProvider(async (input) => {
      if (String(input) === "https://oauth2.googleapis.com/token") return tokenResponse();
      throw originalError;
    });
    const thrown = await run(provider, sealed("gmail.users.messages.list", {}), lease())
      .catch((error: unknown) => error);
    const cause = (thrown as GoogleProviderError & { cause?: Error }).cause;
    expect(cause?.message).toContain("socket closed");
    expect(cause?.message).not.toContain("access-token");
    expect(cause).not.toBe(originalError);
  });

  test("classifies 401 and invalid_grant refresh responses as authorization failures", async () => {
    for (const response of [
      new Response("not json", { status: 401 }),
      Response.json({ error: "invalid_grant", error_description: "secret details" }, { status: 400 }),
    ]) {
      const provider = createGoogleProvider(async () => response);
      const thrown = await run(provider, sealed("gmail.users.messages.list", {}), lease())
        .catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(GoogleRefreshAuthorizationError);
    }
  });

  test("rejects malformed successful refresh responses", async () => {
    for (const payload of [
      { access_token: "access-token", token_type: "Basic", expires_in: 3600 },
      { access_token: "", token_type: "Bearer", expires_in: 3600 },
      { access_token: "access-token", token_type: "Bearer", expires_in: 0 },
      { access_token: "access-token", token_type: "Bearer", expires_in: Number.POSITIVE_INFINITY },
    ]) {
      const provider = createGoogleProvider(async () => Response.json(payload));
      await expect(run(provider, sealed("gmail.users.messages.list", {}), lease()))
        .rejects.toThrow("Google token refresh response is invalid");
    }
  });
});

function lease() {
  return {
    accountId: "acct_google",
    connectionId: "con_google",
    providerAppId: "app_google",
    provider: "google" as const,
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    subject: "google-sub",
    grantedScopes: [],
  };
}
