import { betterAuth } from "better-auth";
import { bearer, magicLink } from "better-auth/plugins";
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
  /** Where a spent link lands: the dashboard, on the same zone as this Worker. */
  DASHBOARD_BASE_URL: string;
  /** The zone both hosts sit on, so one cookie reaches both. */
  SESSION_COOKIE_DOMAIN: string;
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
    // O4 clause 8, widened by exactly one host. A spent link has to land on
    // the dashboard, which is a different origin from this Worker, so that
    // origin is named here and nothing else is.
    trustedOrigins: [env.AUTH_BASE_URL, env.DASHBOARD_BASE_URL],
    session: { expiresIn: SESSION_TTL_SECONDS },
    // The dashboard is a different host on the same zone, and it cannot read a
    // cookie pinned to this one. Verified against the framework: this stamps
    // `domain` on the session cookie. It is why both hosts had to leave
    // workers.dev — that suffix is on the Public Suffix List, so no cookie can
    // ever span two Workers there.
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: env.SESSION_COOKIE_DOMAIN },
      // Without this the framework reads `x-forwarded-for` only, finds nothing
      // behind Cloudflare, and — by its own warning — falls back to "a single
      // shared per-path bucket". Every caller would then share one allowance.
      // `x-forwarded-for` is unreachable in production and kept only for local
      // runs off Cloudflare: the edge always sets `cf-connecting-ip`, and on
      // the two service-binding paths Control builds fresh headers that carry
      // the credential and the address and nothing else.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    // In-memory limits are decorative on Workers: an isolate is per-request
    // and per-colo, so nothing accumulates. This is the framework's own
    // per-IP limit, kept for the endpoints the Worker does not guard itself.
    rateLimit: {
      enabled: true,
      storage: "database",
      // Control asks this once for every authenticated request it serves, so
      // the default 100-per-10s would cap the product rather than an attacker.
      // It stays capped, just generously: now that `cf-connecting-ip` is named
      // above, the bucket is per-IP, so a limit no real user can reach still
      // bounds a stranger looping invalid bearers — one D1 read each — against
      // a publicly routed Worker.
      customRules: { "/get-session": { window: 10, max: 1000 } },
    },
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
      // Lets a session token arrive as `Authorization: Bearer`, not only as a
      // cookie. The CLI has no cookie jar, and the implementation this
      // replaces answered on a bearer header.
      bearer(),
      magicLink({
        // The plugin's own limit is 5 per 60 seconds per IP across both
        // magic-link paths, and it fires ahead of the Worker's caps — which
        // are stricter, per address as well as per source, and are the ones
        // O4 specifies. Widened past the source cap so ours always binds
        // first; this stays as a backstop rather than a competitor.
        rateLimit: { window: 900, max: 1_000 },
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
