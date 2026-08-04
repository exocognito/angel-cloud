import { describe, expect, test } from "bun:test";
import {
  EmailSendError,
  loginLinkEmail,
  resendSender,
} from "../../src/email-sender";

/**
 * The classification below is the line whose absence produced a live
 * enumeration oracle: an address Resend refused answered differently from
 * every other address. It is worth its own tests.
 */

describe("the Resend sender", () => {
  test("sends the message Resend expects, with the key as a bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = resendSender({
      apiKey: "re_test",
      from: "Angel <noreply@angel.test>",
      fetcher: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await sender.send({ to: "sam@example.test", subject: "hello", text: "body" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: "Angel <noreply@angel.test>",
      to: ["sam@example.test"],
      subject: "hello",
      text: "body",
    });
  });

  test("a refusal about the address is told apart from a sender that is down", async () => {
    for (const [status, failure] of [
      [400, "address"],
      [422, "address"],
      [401, "service"],
      [403, "service"],
      [429, "service"],
      [500, "service"],
      [503, "service"],
    ] as const) {
      const sender = stubbed(async () => new Response("nope", { status }));

      const thrown = await sender.send(message()).then(() => null, (error: unknown) => error);

      expect(thrown).toBeInstanceOf(EmailSendError);
      expect((thrown as EmailSendError).failure).toBe(failure);
    }
  });

  test("a reply whose body will not read is still a classified failure", async () => {
    const sender = stubbed(async () => ({
      ok: false,
      status: 422,
      async text() {
        throw new TypeError("body already consumed");
      },
    }) as unknown as Response);

    const thrown = await sender.send(message()).then(() => null, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(EmailSendError);
    expect((thrown as EmailSendError).failure).toBe("address");
    expect((thrown as EmailSendError).message).toContain("422");
  });

  test("a connection that never replies is a sender that is down, not an escaping error", async () => {
    const sender = stubbed(async () => {
      throw new TypeError("network error");
    });

    const thrown = await sender.send(message()).then(() => null, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(EmailSendError);
    expect((thrown as EmailSendError).failure).toBe("service");
    expect((thrown as EmailSendError).message).toContain("network error");
  });
});

describe("the sign-in mail", () => {
  test("carries the link and says what it does, and nothing else", () => {
    const mail = loginLinkEmail({ to: "sam@example.test", url: "https://auth.test/x?token=a.b" });

    expect(mail.to).toBe("sam@example.test");
    expect(mail.text).toContain("https://auth.test/x?token=a.b");
    expect(mail.text).toContain("works once and lasts ten minutes");
    expect(mail.text).toContain("no Account has been created");
    // A LoginAttempt record does exist until it expires, so the mail must not
    // claim nothing at all was written.
    expect(mail.text).not.toContain("nothing has been created");
  });
});

function stubbed(fetcher: () => Promise<Response>) {
  return resendSender({
    apiKey: "re_test",
    from: "Angel <noreply@angel.test>",
    fetcher: fetcher as unknown as typeof fetch,
  });
}

function message() {
  return { to: "sam@example.test", subject: "s", text: "t" };
}
