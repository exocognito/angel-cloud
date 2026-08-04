// Secrets are set with `wrangler secret put`, so they are absent from
// `wrangler.control.jsonc` and `wrangler types` cannot see them. Regenerating
// types therefore deletes them from the env every time; declaring them here,
// in a file the generator never writes, is what stops that being a silent
// break. Keep in step with the secret list in `wrangler.control.jsonc`.
declare namespace Cloudflare {
  interface Env {
    CONTROL_RESPONSE_KEK: string;
    CONTROL_GATEWAY_TOKEN: string;
    CONTROL_BROKER_TOKEN: string;
    DEMO_ADMIN_TOKEN: string;
  }
}

interface ControlEnv extends Cloudflare.Env {}
