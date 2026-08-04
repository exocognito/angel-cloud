import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { mintAccountId } from "./angel-account";
import { EmailSendError, loginLinkEmail, resendSender, type EmailSender } from "./email-sender";

/**
 * The O4 contract, expressed as Better Auth configuration. Everything here is
 * a deliberate departure from a default; the defaults it does not name are
 * left alone on purpose.
 */

/** O4: ten minutes, not the framework's five. */
export const MAGIC_LINK_TTL_SECONDS = 600;

/** Unchanged from the implementation this replaces. */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface AuthConfigEnv {
  AUTH_DB: D1Database;
  RESEND_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  LOGIN_FROM_ADDRESS: string;
  AUTH_BASE_URL: string;
}

export interface AuthConfigDependencies {
  sender?: EmailSender;
  /** Where the send is handed to, so it never sits on the response path. */
  waitUntil: (work: Promise<unknown>) => void;
  /**
   * Stands in for the D1 binding. A test passes SQLite it can inspect, and
   * the schema generator passes something that only has to be recognised as
   * SQLite, never queried. Production passes nothing and gets the binding.
   */
  database?: unknown;
}

export function createAuth(env: AuthConfigEnv, dependencies: AuthConfigDependencies) {
  const sender = dependencies.sender
    ?? resendSender({ apiKey: env.RESEND_API_KEY, from: env.LOGIN_FROM_ADDRESS });

  return betterAuth({
    // The binding itself. Better Auth detects D1 and switches transactions
    // off, because D1 has none — so single-use rests on `consumeOne`, which
    // for SQLite is one `DELETE ... RETURNING`. That is the whole guarantee,
    // and it is enough: of two racing clicks exactly one gets a row back.
    database: (dependencies.database ?? env.AUTH_DB) as D1Database,
    baseURL: env.AUTH_BASE_URL,
    basePath: "/v1/auth",
    secret: env.BETTER_AUTH_SECRET,
    // O4 clause 8. Nothing may redirect a spent link off this origin.
    trustedOrigins: [env.AUTH_BASE_URL],
    session: { expiresIn: SESSION_TTL_SECONDS },
    // In-memory limits are decorative on Workers: an isolate is per-request
    // and per-colo, so nothing accumulates. This is the framework's own
    // per-IP limit and it is not the per-address cap O4 asks for — that one
    // is ours, in the Worker.
    rateLimit: { enabled: true, storage: "database" },
    user: {
      additionalFields: {
        // Named `angel` to keep it clear of Better Auth's own `account`
        // table, which is for linked OAuth identities and is a different
        // thing entirely.
        angelAccountId: { type: "string", required: true, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Minted in the same insert that creates the person. The ordering
          // problem this replaces — a session pointing at an Account whose
          // write had failed — cannot arise when there is only one write.
          before: async (user) => ({ data: { ...user, angelAccountId: mintAccountId() } }),
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // O4 clause 3. The default stores the token in the clear.
        storeToken: "hashed",
        sendMagicLink: ({ email, url }) => {
          // Returns without awaiting, and that is the point. The plugin
          // awaits this before answering, so a slow or failing send would
          // time the reply differently for a deliverable address than an
          // undeliverable one — the enumeration oracle O4 clause 6 forbids,
          // and the one this codebase already found the hard way once.
          dependencies.waitUntil((async () => {
            try {
              await sender.send(loginLinkEmail({ to: email, url }));
            } catch (error) {
              const failure = error instanceof EmailSendError ? error.failure : "unknown";
              const detail = error instanceof Error ? error.message : String(error);
              console.error(`sign-in mail failed (${failure}): ${detail}`);
            }
          })());
        },
      }),
    ],
  });
}
