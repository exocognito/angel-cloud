import { createAuth } from "../src/auth-config";

/**
 * What `@better-auth/cli generate` loads to emit the D1 schema. Better Auth
 * calls a binding D1 when it has `batch`, `exec` and `prepare`, and then asks
 * it which tables already exist so it can emit only the difference. This
 * answers "none", which is the truthful answer for a database whose schema is
 * being written for the first time and the only one that yields the whole
 * schema rather than a patch against whatever happens to be deployed.
 *
 * Importing `createAuth` rather than restating the options is the point: the
 * generated schema cannot drift from the running configuration.
 */
const emptyDatabase = {
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
  prepare: (_sql: string) => ({
    bind: (..._parameters: unknown[]) => ({
      all: async () => ({ results: [], meta: {} }),
    }),
  }),
};

export const auth = createAuth(
  {
    AUTH_DB: undefined as never,
    RESEND_API_KEY: "generate-only",
    BETTER_AUTH_SECRET: "generate-only",
    LOGIN_FROM_ADDRESS: "generate-only",
    AUTH_BASE_URL: "https://generate-only.invalid",
    DASHBOARD_BASE_URL: "https://generate-only.invalid",
    SESSION_COOKIE_DOMAIN: ".generate-only.invalid",
  },
  { waitUntil: () => {}, database: emptyDatabase },
);
