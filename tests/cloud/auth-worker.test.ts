import { describe, expect, mock, test } from "bun:test";
import { MAGIC_LINK_TTL_MS } from "../../src/magic-link";
import { SESSION_TTL_MS } from "../../src/login-account";
import {
  MAX_LINKS_PER_EMAIL,
  MAX_LINKS_PER_SOURCE,
  THROTTLE_WINDOW_MS,
} from "../../src/login-throttle";
import { EmailSendError, type EmailSender, type OutboundEmail } from "../../src/email-sender";

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

const { handleAuthRequest } = await import("../../src/workers/auth");
const { LoginAttempt: RealLoginAttempt } = await import("../../src/workers/login-attempt");
const { LoginIdentity } = await import("../../src/workers/login-identity");
const { LoginSession } = await import("../../src/workers/login-session");
const { LoginThrottle } = await import("../../src/workers/login-throttle");

const START = 1_700_000_000_000;

/** Holds the clock still for a test; the real object reads Date.now(). */
let attemptClock = START;
class LoginAttempt extends RealLoginAttempt {
  protected override now(): number {
    return attemptClock;
  }
}

describe("asking for a sign-in link", () => {
  test("answers the same way for every address, and mails a link", async () => {
    const world = makeWorld();

    const first = await world.requestLink("stranger@example.test");
    const second = await world.requestLink("stranger@example.test");

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual({ status: "accepted" });
    expect(world.sent).toHaveLength(2);
    expect(world.sent[0]!.to).toBe("stranger@example.test");
  });

  test("a returning owner is indistinguishable from a brand-new one", async () => {
    const world = makeWorld();
    await world.signUp("owner@example.test");

    const returning = await world.requestLink("owner@example.test");
    const newcomer = await world.requestLink("nobody@example.test");

    expect(returning.status).toBe(newcomer.status);
    expect(await returning.json()).toEqual(await newcomer.json());
  });

  test("folds case, so one address cannot become two Accounts", async () => {
    const world = makeWorld();

    const first = await world.signUp("Owner@Example.TEST");
    const second = await world.signUp("owner@example.test");

    expect(second.accountId).toBe(first.accountId);
    expect(second.accountCreated).toBe(false);
  });

  test("refuses input that is not one address, without minting anything", async () => {
    const world = makeWorld();

    const response = await world.requestLink("not-an-address");

    expect(response.status).toBe(400);
    expect(world.sent).toHaveLength(0);
    expect(world.attempts.size).toBe(0);
  });

  test("an undeliverable address gets everyone else's answer, not its own", async () => {
    const world = makeWorld();
    world.rejectSendWith = new EmailSendError("address", "the provider will not take it");

    const rejected = await world.requestLink("undeliverable@example.test");
    world.rejectSendWith = null;
    const ordinary = await world.requestLink("fine@example.test");

    expect(rejected.status).toBe(ordinary.status);
    expect(await rejected.json()).toEqual(await ordinary.json());
  });

  test("a sender that is down answers exactly like everything else", async () => {
    // A capped address never reaches the sender, so it cannot see an outage.
    // Any status here other than the ordinary one would therefore say "that
    // address was not capped".
    const world = makeWorld();
    world.rejectSendWith = new EmailSendError("service", "resend is unreachable");

    const down = await world.requestLink("stranger@example.test");
    world.rejectSendWith = null;
    const ordinary = await world.requestLink("fine@example.test");

    expect(down.status).toBe(ordinary.status);
    expect(await down.json()).toEqual(await ordinary.json());
  });

  test("a capped address and an outage are the same answer, in either order", async () => {
    const world = makeWorld();
    for (let attempt = 0; attempt <= MAX_LINKS_PER_EMAIL; attempt += 1) {
      await world.requestLink("keen@example.test");
    }
    const capped = await world.requestLink("keen@example.test");

    world.rejectSendWith = new EmailSendError("service", "resend is unreachable");
    const uncappedButDown = await world.requestLink("other@example.test");

    expect(capped.status).toBe(uncappedButDown.status);
    expect(await capped.json()).toEqual(await uncappedButDown.json());
  });

  test("a request that did not come through the edge is refused", async () => {
    const world = makeWorld();

    const response = await world.requestLink("stranger@example.test", null);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no source address" });
    expect(world.sent).toHaveLength(0);
  });

  test("the answer does not wait on the sender", async () => {
    // The send is handed off, not awaited. If it were awaited, a capped
    // address — which never reaches the sender — would answer faster than an
    // uncapped one, and the matching bodies would not hide that.
    const world = makeWorld();
    let releaseSend = () => {};
    world.holdSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const answered = await world.callWithoutDraining(
      new Request("https://auth.test/v1/auth/request-link", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ email: "stranger@example.test" }),
      }),
    );

    expect(answered.status).toBe(202);
    expect(world.sent).toHaveLength(0);
    releaseSend();
  });

  test("the mail carries a link back to this service and nothing else secret", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");

    const link = new URL(world.linkFrom(world.sent[0]!));

    expect(link.origin).toBe("https://auth.test");
    expect(link.pathname).toBe("/v1/auth/callback");
    expect(link.searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(world.sent[0]!.text).not.toContain("acct_");
  });
});

describe("caps on asking", () => {
  test("a fourth link for one address is refused in silence, with no mail", async () => {
    const world = makeWorld();

    for (let attempt = 0; attempt < MAX_LINKS_PER_EMAIL; attempt += 1) {
      expect((await world.requestLink("keen@example.test")).status).toBe(202);
    }
    const capped = await world.requestLink("keen@example.test");

    expect(capped.status).toBe(202);
    expect(await capped.json()).toEqual({ status: "accepted" });
    expect(world.sent).toHaveLength(MAX_LINKS_PER_EMAIL);
  });

  test("the cap is per address, so one greedy address cannot lock out another", async () => {
    const world = makeWorld();
    for (let attempt = 0; attempt <= MAX_LINKS_PER_EMAIL; attempt += 1) {
      await world.requestLink("keen@example.test");
    }

    await world.requestLink("someone-else@example.test");

    expect(world.sent.at(-1)!.to).toBe("someone-else@example.test");
  });

  test("the allowance comes back once the window passes", async () => {
    const world = makeWorld();
    for (let attempt = 0; attempt <= MAX_LINKS_PER_EMAIL; attempt += 1) {
      await world.requestLink("keen@example.test");
    }
    expect(world.sent).toHaveLength(MAX_LINKS_PER_EMAIL);

    world.clock = START + THROTTLE_WINDOW_MS;
    await world.requestLink("keen@example.test");

    expect(world.sent).toHaveLength(MAX_LINKS_PER_EMAIL + 1);
  });

  test("one source flooding many addresses is cut off, and told so", async () => {
    const world = makeWorld();

    for (let attempt = 0; attempt < MAX_LINKS_PER_SOURCE; attempt += 1) {
      expect((await world.requestLink(`victim${attempt}@example.test`)).status).toBe(202);
    }
    const flood = await world.requestLink("victim-last@example.test");

    // Refusing by source names no address, so it is allowed to say what it is.
    expect(flood.status).toBe(429);
    expect(await flood.json()).toEqual({ error: "too many sign-in requests" });
    expect(world.sent).toHaveLength(MAX_LINKS_PER_SOURCE);
  });

  test("malformed requests spend the source allowance too", async () => {
    const world = makeWorld();

    for (let attempt = 0; attempt < MAX_LINKS_PER_SOURCE; attempt += 1) {
      expect((await world.requestLink("junk")).status).toBe(400);
    }

    expect((await world.requestLink("real@example.test")).status).toBe(429);
  });

  test("a different source has its own allowance", async () => {
    const world = makeWorld();
    for (let attempt = 0; attempt <= MAX_LINKS_PER_SOURCE; attempt += 1) {
      await world.requestLink(`victim${attempt}@example.test`);
    }

    expect((await world.requestLink("elsewhere@example.test", "203.0.113.9")).status).toBe(202);
  });
});

describe("clicking the link", () => {
  test("creates one empty Account and opens a session", async () => {
    const world = makeWorld();

    const result = await world.signUp("stranger@example.test");

    expect(result.accountId).toMatch(/^acct_[0-9a-f]{32}$/);
    expect(result.accountCreated).toBe(true);
    expect(result.session).toMatch(/^[0-9a-f]{64}$/);
    // One Account, and nothing else: no Angel, no handle, no Connection.
    expect(world.identities.size).toBe(1);
  });

  test("a second click is refused, and the session already issued survives", async () => {
    const world = makeWorld();
    const first = await world.signUp("stranger@example.test");

    const second = await world.click(first.token);

    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "this sign-in link is not valid" });
    expect(await world.whoAmI(first.session)).toMatchObject({ accountId: first.accountId });
  });

  test("logging in again lands in the same Account, and creates no second one", async () => {
    const world = makeWorld();
    const first = await world.signUp("stranger@example.test");

    const again = await world.signUp("stranger@example.test");

    expect(again.accountId).toBe(first.accountId);
    expect(again.accountCreated).toBe(false);
    expect(again.session).not.toBe(first.session);
    expect(world.identities.size).toBe(1);
  });

  test("a link is dead the instant it turns ten minutes old", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;

    world.clock = START + MAGIC_LINK_TTL_MS;
    const late = await world.click(token);

    expect(late.status).toBe(400);
    // Nothing was created on the way to refusing it.
    expect(world.identities.size).toBe(0);
  });

  test("a link that just misses expiry still works", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;

    world.clock = START + MAGIC_LINK_TTL_MS - 1;

    expect((await world.click(token)).status).toBe(200);
  });

  test("a tampered verifier is refused and does not burn the real link", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;
    const [selector] = token.split(".") as [string, string];

    const tampered = await world.click(`${selector}.wrongverifier`);

    expect(tampered.status).toBe(400);
    expect(world.identities.size).toBe(0);
    expect((await world.click(token)).status).toBe(200);
  });

  test("every refusal reads the same, whatever went wrong", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;
    const [selector, verifier] = token.split(".") as [string, string];

    const bodies = [];
    for (const attempt of ["", "junk", "a.b.c", `unknownselector.${verifier}`, `${selector}.wrong`]) {
      const response = await world.click(attempt);
      bodies.push([response.status, await response.json()]);
    }

    expect(new Set(bodies.map((entry) => JSON.stringify(entry))).size).toBe(1);
  });

  test("keeps the token out of the Referer of whatever loads next", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;

    const good = await world.click(token);
    const bad = await world.click("junk.junk");

    expect(good.headers.get("referrer-policy")).toBe("no-referrer");
    expect(bad.headers.get("referrer-policy")).toBe("no-referrer");
    expect(good.headers.get("cache-control")).toBe("no-store");
  });

  test("the session cookie is not readable by script and not sent across sites", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;

    const cookie = (await world.click(token)).headers.get("set-cookie") ?? "";

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1_000}`);
  });
});

describe("a login that half-fails", () => {
  test("leaves no Account when the Account write fails, and the session it opened is refused", async () => {
    const world = makeWorld();
    await world.requestLink("stranger@example.test");
    const token = new URL(world.linkFrom(world.sent[0]!)).searchParams.get("token")!;
    world.breakAccountWrite = true;

    const failed = await world.click(token).then((r) => r, (error: unknown) => error);

    // Nothing was created that nothing can reach.
    expect(world.identities.size).toBe(0);
    expect(failed).toBeInstanceOf(Error);
  });

  test("an older object answering with undefined is refused, not answered 200 with no Account", async () => {
    // What a rolling deploy did once: the identity object on the other side of
    // the call was an earlier version and returned undefined, which a
    // `=== null` check waved through.
    const world = makeWorld();
    const signedUp = await world.signUp("stranger@example.test");
    for (const identity of world.identities.values()) {
      (identity as { account: () => Promise<unknown> }).account = async () => undefined;
    }

    const response = await world.session(signedUp.session);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign in required" });
  });

  test("a session whose Account never landed is refused like an unknown one", async () => {
    const world = makeWorld();
    const signedUp = await world.signUp("stranger@example.test");
    // Wipe the identity the way a failed write would have left it.
    world.identities.clear();

    const response = await world.session(signedUp.session);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "sign in required" });
  });
});

describe("using the session", () => {
  test("names the Account it belongs to", async () => {
    const world = makeWorld();
    const signedUp = await world.signUp("stranger@example.test");

    expect(await world.whoAmI(signedUp.session)).toEqual({
      accountId: signedUp.accountId,
      expiresAt: START + SESSION_TTL_MS,
    });
  });

  test("refuses a missing, unknown or expired session the same way", async () => {
    const world = makeWorld();
    const signedUp = await world.signUp("stranger@example.test");

    const missing = await world.session(null);
    const unknown = await world.session("f".repeat(64));
    world.clock = START + SESSION_TTL_MS;
    const expired = await world.session(signedUp.session);

    for (const response of [missing, unknown, expired]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "sign in required" });
    }
  });

  test("the session token is never stored, so reading storage cannot impersonate", async () => {
    const world = makeWorld();
    const signedUp = await world.signUp("stranger@example.test");

    expect(JSON.stringify([...world.sessions.keys()])).not.toContain(signedUp.session);
    expect(JSON.stringify([...world.sessions.values()].map((it) => it.dump())))
      .not.toContain(signedUp.session);
  });
});

interface SignUp {
  token: string;
  accountId: string;
  session: string;
  accountCreated: boolean;
}

function makeWorld() {
  const sent: OutboundEmail[] = [];
  const sender: EmailSender = {
    async send(message) {
      if (world.holdSend !== null) await world.holdSend;
      if (world.rejectSendWith !== null) throw world.rejectSendWith;
      sent.push(message);
    },
  };
  const attempts = objectNamespace(LoginAttempt);
  const identities = objectNamespace(LoginIdentity, () => {
    if (world.breakAccountWrite) throw new Error("identity storage is unavailable");
  });
  const sessions = objectNamespace(LoginSession);
  const throttles = objectNamespace(LoginThrottle);
  const env = {
    LOGIN: attempts.namespace,
    IDENTITY: identities.namespace,
    SESSION: sessions.namespace,
    THROTTLE: throttles.namespace,
    RESEND_API_KEY: "unused-in-tests",
    LOGIN_NAME_KEY: "test-name-key",
    LOGIN_FROM_ADDRESS: "Angel <noreply@angel.test>",
    AUTH_BASE_URL: "https://auth.test",
  } as never;

  attemptClock = START;
  const world = {
    get clock() {
      return attemptClock;
    },
    set clock(value: number) {
      attemptClock = value;
    },
    rejectSendWith: null as EmailSendError | null,
    holdSend: null as Promise<void> | null,
    breakAccountWrite: false,
    sent,
    attempts: attempts.instances,
    identities: identities.instances,
    sessions: sessions.instances,

    /** Answers without draining the handed-off send, as the runtime does. */
    callWithoutDraining(request: Request) {
      return handleAuthRequest(request, env, {
        now: () => world.clock,
        sender,
        waitUntil: () => {},
      });
    },
    async call(request: Request) {
      const pending: Array<Promise<unknown>> = [];
      const response = await handleAuthRequest(request, env, {
        now: () => world.clock,
        sender,
        waitUntil: (work) => void pending.push(work),
      });
      // The send is handed off rather than awaited, so drain it here — the
      // Worker runtime does the same before the request is finished with.
      await Promise.all(pending);
      return response;
    },
    requestLink(email: unknown, source: string | null = "198.51.100.7") {
      return world.call(new Request("https://auth.test/v1/auth/request-link", {
        method: "POST",
        headers: source === null ? {} : { "cf-connecting-ip": source },
        body: JSON.stringify({ email }),
      }));
    },
    click(token: string) {
      const url = new URL("https://auth.test/v1/auth/callback");
      url.searchParams.set("token", token);
      return world.call(new Request(url.toString()));
    },
    session(token: string | null) {
      return world.call(new Request("https://auth.test/v1/auth/session", {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }));
    },
    async whoAmI(token: string) {
      return (await world.session(token)).json();
    },
    linkFrom(message: OutboundEmail): string {
      return message.text.split(/\s+/).find((word) => word.startsWith("https://"))!;
    },
    async signUp(email: string): Promise<SignUp> {
      const before = sent.length;
      await world.requestLink(email);
      const token = new URL(world.linkFrom(sent[before]!)).searchParams.get("token")!;
      const body = await (await world.click(token)).json() as Omit<SignUp, "token">;
      return { token, ...body };
    },
  };
  return world;
}

/** A Durable Object namespace over in-memory instances, one per name. */
function objectNamespace<T>(Class: new (ctx: never, env: never) => T, onGet?: () => void) {
  const instances = new Map<string, T & { dump(): unknown }>();
  return {
    instances,
    namespace: {
      getByName(name: string) {
        if (onGet !== undefined) onGet();
        const existing = instances.get(name);
        if (existing !== undefined) return existing;
        const map = new Map<string, unknown>();
        const storage = {
          async get(key: string) {
            return map.get(key);
          },
          async put(key: string, value: unknown) {
            map.set(key, value);
          },
          async setAlarm() {},
          async deleteAll() {
            map.clear();
          },
        };
        const created = new Class({ storage } as never, {} as never) as T & { dump(): unknown };
        created.dump = () => [...map.entries()];
        instances.set(name, created);
        return created;
      },
    },
  };
}
