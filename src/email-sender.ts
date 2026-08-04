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
      const response = await fetcher("https://api.resend.com/emails", {
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
      if (!response.ok) {
        // Fail loudly either way. A swallowed send looks identical to a link
        // the owner never clicked, and we would debug the wrong end of it.
        const failure = response.status === 400 || response.status === 422 ? "address" : "service";
        throw new EmailSendError(failure, `sending failed with ${response.status}: ${await response.text()}`);
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
      "If you did not ask to sign in, ignore this — nothing has been created.",
      "",
    ].join("\n"),
  };
}
