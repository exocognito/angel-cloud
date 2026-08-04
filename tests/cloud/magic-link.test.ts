import { describe, expect, mock, test } from "bun:test";
import {
  MAGIC_LINK_TTL_MS,
  MagicLinkError,
  consumeMagicLink,
  hashMagicLinkVerifier,
  mintMagicLink,
  normalizeLoginEmail,
  parseMagicLinkToken,
  type MagicLinkRecord,
} from "../../src/magic-link";

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

const { LoginAttempt, LOGIN_ATTEMPT_SWEEP_MS } = await import("../../src/workers/login-attempt");

describe("login email normalization", () => {
  test("folds case but keeps everything that identifies a mailbox", () => {
    expect(normalizeLoginEmail("  Sam@Example.TEST ")).toBe("sam@example.test");
    expect(normalizeLoginEmail("sam+angel@example.test")).toBe("sam+angel@example.test");
  });

  test("plus-addressing stays distinct, so one mailbox cannot claim another's links", () => {
    expect(normalizeLoginEmail("sam+angel@example.test"))
      .not.toBe(normalizeLoginEmail("sam@example.test"));
  });

  test("refuses anything that is not one plain address", () => {
    for (const bad of [
      "", "   ", "sam", "@example.test", "sam@", "sam@example",
      "sam@.test", "sam@example.", "Sam <sam@example.test>",
      "sam@example.test, other@example.test", "sam@exa mple.test",
      `${"a".repeat(250)}@example.test`, 42, null, undefined,
    ]) {
      expect(normalizeLoginEmail(bad)).toBeNull();
    }
  });
});

describe("magic link minting", () => {
  test("expires exactly ten minutes after issue, on the clock it was given", async () => {
    const minted = await mintMagicLink("sam@example.test", 1_000);

    expect(minted.record.issuedAt).toBe(1_000);
    expect(minted.record.expiresAt).toBe(1_000 + MAGIC_LINK_TTL_MS);
    expect(MAGIC_LINK_TTL_MS).toBe(600_000);
    expect(minted.record.consumedAt).toBeNull();
  });

  test("stores no part of the token, so reading storage cannot log you in", async () => {
    const minted = await mintMagicLink("sam@example.test", 1_000);
    const [, verifier] = minted.token.split(".") as [string, string];
    const stored = JSON.stringify(minted.record);

    expect(stored).not.toContain(verifier);
    expect(stored).not.toContain("sam@example.test");
    expect(minted.record.verifierHash).toBe(await hashMagicLinkVerifier(verifier));
  });

  test("the token is the selector that names storage plus a verifier", async () => {
    const minted = await mintMagicLink("sam@example.test", 1_000);

    expect(minted.token).toBe(`${minted.selector}.${minted.token.split(".")[1]}`);
    expect(parseMagicLinkToken(minted.token)?.selector).toBe(minted.selector);
  });

  test("two links for one address share nothing", async () => {
    const first = await mintMagicLink("sam@example.test", 1_000);
    const second = await mintMagicLink("sam@example.test", 1_000);

    expect(first.selector).not.toBe(second.selector);
    expect(first.token).not.toBe(second.token);
    expect(first.record.emailHash).toBe(second.record.emailHash);
  });
});

describe("magic link token parsing", () => {
  test("refuses anything that is not selector.verifier in base64url", () => {
    for (const bad of ["", "abc", "a.b.c", "a.", ".b", "a b.cd", "a+b.cd", "a/b.cd", 7, null]) {
      expect(parseMagicLinkToken(bad)).toBeNull();
    }
    expect(parseMagicLinkToken("sel-ector.veri_fier")).toEqual({
      selector: "sel-ector",
      verifier: "veri_fier",
    });
  });
});

describe("spending a magic link", () => {
  test("a good verifier inside the window marks the record spent", () => {
    const record = storedRecord();

    const spent = consumeMagicLink(record, "verifier-hash", 1_500);

    expect(spent.consumedAt).toBe(1_500);
    expect(spent.emailHash).toBe("email-hash");
  });

  test("the second spend is refused", () => {
    const spent = consumeMagicLink(storedRecord(), "verifier-hash", 1_500);

    expect(() => consumeMagicLink(spent, "verifier-hash", 1_600)).toThrow(
      expect.objectContaining({ failure: "consumed" }),
    );
  });

  test("expiry has no grace: the last live instant works, expiry itself does not", () => {
    const record = storedRecord();

    expect(consumeMagicLink(record, "verifier-hash", record.expiresAt - 1).consumedAt)
      .toBe(record.expiresAt - 1);
    expect(() => consumeMagicLink(record, "verifier-hash", record.expiresAt)).toThrow(
      expect.objectContaining({ failure: "expired" }),
    );
    expect(() => consumeMagicLink(record, "verifier-hash", record.expiresAt + 1)).toThrow(
      expect.objectContaining({ failure: "expired" }),
    );
  });

  test("a wrong verifier is refused, and is refused the same way whatever the record's state", () => {
    const live = storedRecord();
    const spent = { ...live, consumedAt: 1_500 };
    const dead = { ...live, expiresAt: 0 };

    for (const record of [live, spent, dead]) {
      expect(() => consumeMagicLink(record, "wrong-hash", 1_600)).toThrow(
        expect.objectContaining({ failure: "mismatched" }),
      );
    }
  });

  test("an unknown selector is refused", () => {
    expect(() => consumeMagicLink(undefined, "verifier-hash", 1_500)).toThrow(
      expect.objectContaining({ failure: "unknown" }),
    );
  });
});

describe("LoginAttempt storage", () => {
  test("issuing keeps the record and arms a sweep past expiry", async () => {
    const { attempt, storage } = makeAttempt();
    const record = storedRecord();

    await attempt.issue(record);

    expect(storage.map.get("record")).toEqual(record);
    expect(storage.alarm).toBe(record.expiresAt + LOGIN_ATTEMPT_SWEEP_MS);
  });

  test("only the first of two queued spends wins", async () => {
    const { attempt } = makeAttempt();
    await attempt.issue(storedRecord());

    const first = await attempt.consume("verifier-hash", 1_500);
    const second = await attempt.consume("verifier-hash", 1_500).then(
      () => null,
      (error: unknown) => error,
    );

    expect(first).toEqual({ emailHash: "email-hash" });
    expect(second).toBeInstanceOf(MagicLinkError);
    expect((second as MagicLinkError).failure).toBe("consumed");
  });

  test("a refused spend leaves the link usable", async () => {
    const { attempt, storage } = makeAttempt();
    await attempt.issue(storedRecord());

    await expect(attempt.consume("wrong-hash", 1_500)).rejects.toThrow(
      expect.objectContaining({ failure: "mismatched" }),
    );

    expect((storage.map.get("record") as MagicLinkRecord).consumedAt).toBeNull();
    expect(await attempt.consume("verifier-hash", 1_600)).toEqual({ emailHash: "email-hash" });
  });

  test("the sweep alarm erases the record", async () => {
    const { attempt, storage } = makeAttempt();
    await attempt.issue(storedRecord());

    await attempt.alarm();

    expect(storage.map.size).toBe(0);
  });
});

function storedRecord(): MagicLinkRecord {
  return {
    emailHash: "email-hash",
    verifierHash: "verifier-hash",
    issuedAt: 1_000,
    expiresAt: 1_000 + MAGIC_LINK_TTL_MS,
    consumedAt: null,
  };
}

/**
 * Stands in for the Durable Object's storage. Calls arrive one at a time, as
 * the runtime's input gate delivers them; that the gate really does hold
 * across `consume` is a runtime guarantee this fake assumes rather than
 * proves, and the live signup run tests it for real.
 */
function makeAttempt() {
  const map = new Map<string, unknown>();
  const storage = {
    map,
    alarm: null as number | null,
    async get(key: string) {
      return map.get(key);
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async setAlarm(time: number) {
      storage.alarm = time;
    },
    async deleteAll() {
      map.clear();
    },
  };
  const attempt = new LoginAttempt({ storage } as never, {} as never);
  return { attempt, storage };
}
