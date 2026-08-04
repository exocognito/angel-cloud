import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_LINKS_PER_EMAIL,
  MAX_LINKS_PER_SOURCE,
  THROTTLE_WINDOW_MS,
} from "../../src/login-throttle";
import { MAGIC_LINK_TTL_SECONDS } from "../../src/auth-config";
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
const { LoginThrottle } = await import("../../src/workers/login-throttle");

const BASE_URL = "https://auth.test";

// Better Auth reads `Date.now()` itself and offers nowhere to inject a clock,
// so moving time means moving the process's. That is the honest way to test
// the expiry anyway: it exercises the framework's own comparison.
afterEach(() => setSystemTime());

describe("asking for a sign-in link", () => {
  test("answers the same way for every address, and mails a link", async () => {
    const world = makeWorld();

    const first = await world.requestLink("stranger@example.test");
    const second = await world.requestLink("stranger@example.test");

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: true });
    expect(second.status).toBe(first.status);
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

    expect(second.angelAccountId).toBe(first.angelAccountId);
    expect(world.users()).toHaveLength(1);
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

  test("a request with no source address is refused before anything is minted", async () => {
    const world = makeWorld();

    const response = await world.requestLink("stranger@example.test", null);

    expect(response.status).toBe(400);
    expect(world.sent).toHaveLength(0);
    expect(world.verifications()).toHaveLength(0);
  });
});

describe("spending a sign-in link", () => {
  test("a first login lands in an Account that did not exist before", async () => {
    const world = makeWorld();

    const signUp = await world.signUp("stranger@example.test");

    expect(signUp.angelAccountId).toMatch(/^acct_[0-9a-f]{32}$/);
    expect(world.users()).toHaveLength(1);
  });

  test("the same link cannot be spent twice", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    const first = await world.click(token);
    const second = await world.click(token);

    expect(first.status).toBe(200);
    expect(second.status).not.toBe(200);
    expect(world.users()).toHaveLength(1);
  });

  test("two simultaneous clicks mint one session, not two", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    const [left, right] = await Promise.all([world.click(token), world.click(token)]);

    expect([left, right].filter((response) => response.status === 200)).toHaveLength(1);
    expect(world.users()).toHaveLength(1);
  });

  test("a link past its ten minutes is refused, and creates nothing", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    world.advance((MAGIC_LINK_TTL_SECONDS + 1) * 1_000);
    const response = await world.click(token);

    expect(response.status).not.toBe(200);
    expect(world.users()).toHaveLength(0);
  });

  test("at the exact instant of expiry the link still works", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    // O4 clause 2 says equality is expired and allows no grace. Better Auth
    // refuses on `expiresAt < now`, so the deadline itself is still valid —
    // one millisecond of grace, accepted knowingly rather than wrapped in
    // code we would then own. This pins it, so an upgrade that changes the
    // comparison is a failing test rather than a silent shift.
    world.freezeAt(Date.parse(world.verifications()[0]!.expiresAt));

    expect((await world.click(token)).status).toBe(200);
  });

  test("a token nobody issued is refused the same way a spent one is", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");
    await world.click(token);

    const spent = await world.click(token);
    const invented = await world.click("nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    expect(invented.status).toBe(spent.status);
    expect(await invented.text()).toBe(await spent.text());
  });

  test("the reply keeps the token out of the next page's Referer", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    const response = await world.click(token);

    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("asking for a new link kills the one before it", async () => {
    const world = makeWorld();
    const stale = await world.requestToken("stranger@example.test");
    const fresh = await world.requestToken("stranger@example.test");

    expect((await world.click(stale)).status).not.toBe(200);
    expect((await world.click(fresh)).status).toBe(200);
  });

  test("one address's new link leaves another address's link alone", async () => {
    const world = makeWorld();
    const other = await world.requestToken("other@example.test");
    await world.requestToken("stranger@example.test");

    expect((await world.click(other)).status).toBe(200);
  });
});

describe("the link in storage", () => {
  test("is a hash, so reading the database cannot sign anyone in", async () => {
    const world = makeWorld();
    const token = await world.requestToken("stranger@example.test");

    const stored = world.verifications();

    expect(stored).toHaveLength(1);
    expect(stored[0]!.identifier).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe("throttling", () => {
  test("an address past its cap gets the ordinary answer and no mail", async () => {
    const world = makeWorld();
    for (let index = 0; index < MAX_LINKS_PER_EMAIL; index += 1) {
      await world.requestLink("popular@example.test");
    }
    const before = world.sent.length;

    const capped = await world.requestLink("popular@example.test");
    const ordinary = await world.requestLink("quiet@example.test");

    expect(capped.status).toBe(ordinary.status);
    expect(await capped.json()).toEqual(await ordinary.json());
    expect(world.sent).toHaveLength(before + 1);
  });

  test("a source past its cap is told so, because that names no address", async () => {
    const world = makeWorld();
    for (let index = 0; index < MAX_LINKS_PER_SOURCE; index += 1) {
      await world.requestLink(`person-${index}@example.test`);
    }

    const response = await world.requestLink("one-too-many@example.test");

    expect(response.status).toBe(429);
    // Whose 429 matters. Better Auth ships its own per-IP limit on these
    // paths, and it used to fire first — five requests in sixty seconds, well
    // inside our window, with its own wording. Asserting only the status let
    // that through, and the live run found it on the third request.
    expect(await response.json()).toEqual({ error: "too many sign-in requests" });
  });

  test("the framework's own limit never fires before ours does", async () => {
    const world = makeWorld();

    const answers = [];
    for (let index = 0; index < MAX_LINKS_PER_SOURCE; index += 1) {
      answers.push(await world.requestLink(`person-${index}@example.test`));
    }

    expect(answers.map((response) => response.status)).toEqual(
      Array.from({ length: MAX_LINKS_PER_SOURCE }, () => 200),
    );
    expect(world.sent).toHaveLength(MAX_LINKS_PER_SOURCE);
  });

  test("the window reopens once it has passed", async () => {
    const world = makeWorld();
    for (let index = 0; index < MAX_LINKS_PER_EMAIL; index += 1) {
      await world.requestLink("popular@example.test");
    }

    world.advance(THROTTLE_WINDOW_MS + 1);
    const before = world.sent.length;
    await world.requestLink("popular@example.test");

    expect(world.sent).toHaveLength(before + 1);
  });

  test("a refusal writes too, so a capped address does not answer faster", async () => {
    const world = makeWorld();
    for (let index = 0; index < MAX_LINKS_PER_EMAIL; index += 1) {
      await world.requestLink("popular@example.test");
    }
    const before = world.throttleWrites;

    await world.requestLink("popular@example.test");

    expect(world.throttleWrites).toBe(before + 2);
  });
});

interface SignUp {
  angelAccountId: string;
  sessionToken: string;
}

interface StoredVerification {
  identifier: string;
  value: string;
  expiresAt: string;
}

function makeWorld() {
  const database = new Database(":memory:");
  const migrations = join(import.meta.dir, "../../migrations");
  for (const file of readdirSync(migrations).sort()) {
    if (file.endsWith(".sql")) database.exec(readFileSync(join(migrations, file), "utf8"));
  }

  const sent: OutboundEmail[] = [];
  const sender: EmailSender = {
    async send(message) {
      if (world.rejectSendWith !== null) throw world.rejectSendWith;
      sent.push(message);
    },
  };
  const throttles = objectNamespace(LoginThrottle, () => {
    world.throttleWrites += 1;
  });
  const env = {
    AUTH_DB: d1OverSqlite(database),
    THROTTLE: throttles.namespace,
    RESEND_API_KEY: "unused-in-tests",
    BETTER_AUTH_SECRET: "a-test-secret-long-enough-to-keep-it-quiet",
    LOGIN_NAME_KEY: "test-name-key",
    LOGIN_FROM_ADDRESS: "Angel <noreply@angel.test>",
    AUTH_BASE_URL: BASE_URL,
  } as never;

  const world = {
    get clock() {
      return Date.now();
    },
    /** Moves the process clock, which is the only one Better Auth reads. */
    advance(milliseconds: number) {
      setSystemTime(new Date(Date.now() + milliseconds));
    },
    /** Stops the clock on an exact instant, for the expiry boundary. */
    freezeAt(instant: number) {
      setSystemTime(new Date(instant));
    },
    rejectSendWith: null as EmailSendError | null,
    throttleWrites: 0,
    sent,

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
      const headers: Record<string, string> = {
        "content-type": "application/json",
        origin: BASE_URL,
      };
      if (source !== null) headers["cf-connecting-ip"] = source;
      return world.call(new Request(`${BASE_URL}/v1/auth/sign-in/magic-link`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email }),
      }));
    },
    /** Asks for a link and reads the token back out of the mail. */
    async requestToken(email: string): Promise<string> {
      const before = sent.length;
      await world.requestLink(email);
      const link = sent[before]!.text.split(/\s+/).find((word) => word.startsWith("https://"))!;
      return new URL(link).searchParams.get("token")!;
    },
    /**
     * Spends a link without the `callbackURL` the mail carries, so the reply
     * is the session as JSON rather than a redirect to it.
     */
    click(token: string) {
      const url = new URL(`${BASE_URL}/v1/auth/magic-link/verify`);
      url.searchParams.set("token", token);
      return world.call(new Request(url.toString(), { headers: { origin: BASE_URL } }));
    },
    async signUp(email: string): Promise<SignUp> {
      const token = await world.requestToken(email);
      const body = await (await world.click(token)).json() as {
        token: string;
        user: { angelAccountId: string };
      };
      return { angelAccountId: body.user.angelAccountId, sessionToken: body.token };
    },
    users(): Array<{ email: string; angelAccountId: string }> {
      return database.query("select email, angelAccountId from user").all() as never;
    },
    verifications(): StoredVerification[] {
      return database.query("select identifier, value, expiresAt from verification").all() as never;
    },
  };
  return world;
}

/**
 * D1 is SQLite behind a `prepare`/`bind`/`all` shape, and Better Auth picks
 * its dialect off exactly those three methods. Putting that shape over an
 * in-memory SQLite runs these tests through the same dialect and the same SQL
 * the deployed Worker uses — including the single `DELETE ... RETURNING` that
 * single-use rests on. What it cannot show is D1's own behaviour over the
 * network, and that is what the live run is for.
 */
function d1OverSqlite(database: Database) {
  const statement = (sql: string, parameters: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async all() {
      const results = database.query(sql).all(...(parameters as never[])) as unknown[];
      return { results, success: true, meta: lastMeta() };
    },
    async run() {
      database.query(sql).run(...(parameters as never[]));
      return { results: [], success: true, meta: lastMeta() };
    },
  });
  const lastMeta = () =>
    database
      .query("select changes() as changes, last_insert_rowid() as last_row_id")
      .get() as { changes: number; last_row_id: number };
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ all(): Promise<unknown> }>) =>
      Promise.all(statements.map((one) => one.all())),
    exec: async (sql: string) => {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

/** A Durable Object namespace over in-memory instances, one per name. */
function objectNamespace<T>(
  Class: new (ctx: never, env: never) => T,
  onWrite?: () => void,
) {
  const instances = new Map<string, T>();
  return {
    instances,
    namespace: {
      getByName(name: string) {
        const existing = instances.get(name);
        if (existing !== undefined) return existing;
        const map = new Map<string, unknown>();
        const storage = {
          async get(key: string) {
            return map.get(key);
          },
          async put(key: string, value: unknown) {
            if (onWrite !== undefined) onWrite();
            map.set(key, value);
          },
          async setAlarm() {},
          async deleteAll() {
            map.clear();
          },
        };
        const created = new Class({ storage } as never, {} as never);
        instances.set(name, created);
        return created;
      },
    },
  };
}
