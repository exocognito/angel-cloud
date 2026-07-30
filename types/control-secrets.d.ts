/* eslint-disable */
// Authored, NOT generated. `wrangler types` only emits a secret's declaration
// when that secret is present locally (a .dev.vars file), so a regeneration on
// any other machine silently deletes them. Declaring them here by interface
// merging keeps types/control.d.ts pure generated output — which `bun run
// types:check` can then hold to `wrangler types --check`. That gate covers the
// Control and Gateway files; types/broker.d.ts is hand-authored and carries no
// generation hash, so `--check` cannot read it.
//
// Control refuses to serve unless every one of these is non-empty and pairwise
// distinct (src/workers/control.ts).
interface ControlEnv {
	MANAGEMENT_API_TOKEN: string;
	CONTROL_RESPONSE_KEK: string;
	CONTROL_GATEWAY_TOKEN: string;
	CONTROL_BROKER_TOKEN: string;
	DEMO_ADMIN_TOKEN: string;
}
