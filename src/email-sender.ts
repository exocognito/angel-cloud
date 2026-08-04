/**
 * Sending a login link to someone we have never met. Cloudflare Email Routing
 * cannot do this — its `send_email` binding only reaches addresses already
 * verified in the account — so the link goes out through Resend.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: OutboundEmail): Promise<void>;
}

/**
 * Whose fault the send was. `address` means the provider judged the recipient
 * undeliverable — a fact about that one address, which the sign-in endpoint
 * must never reveal. `service` means our sender is broken, which is true of
 * every address at once and so gives nothing away.
 */
export type EmailSendFailure = "address" | "service";

export class EmailSendError extends Error {
  constructor(readonly failure: EmailSendFailure, message: string) {
    super(message);
  }
}

export function resendSender(input: {
  apiKey: string;
  from: string;
  fetcher?: typeof fetch;
}): EmailSender {
  const fetcher = input.fetcher ?? fetch;
  return {
    async send(message) {
      let response: Response;
      try {
        response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
        });
      } catch (cause) {
        // A refused connection or a DNS failure is our sender being down, and
        // must arrive as the same kind of failure as a 500 from Resend — an
        // unwrapped rejection would escape as an unhandled error and answer
        // the caller differently from a capped address.
        throw new EmailSendError(
          "service",
          `sending failed before a reply: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (!response.ok) {
        // Fail loudly either way. A swallowed send looks identical to a link
        // the owner never clicked, and we would debug the wrong end of it.
        const failure = response.status === 400 || response.status === 422 ? "address" : "service";
        // Reading the body can itself fail, and an escaping error here would
        // arrive somewhere that does not know it came from the sender.
        const detail = await response.text().catch(() => "<body unreadable>");
        throw new EmailSendError(failure, `sending failed with ${response.status}: ${detail}`);
      }
    },
  };
}

export function loginLinkEmail(input: { to: string; url: string }): OutboundEmail {
  return {
    to: input.to,
    subject: "Your Angel sign-in link",
    text: [
      "Open this link to sign in to Angel:",
      "",
      input.url,
      "",
      "It works once and lasts ten minutes.",
      "If you did not ask to sign in, ignore this — no Account has been created,",
      "and the link above stops working on its own.",
      "",
    ].join("\n"),
  };
}
