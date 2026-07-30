/* eslint-disable */
// Authored, NOT generated. `wrangler types` only emits a secret's declaration
// when that secret is present locally (a .dev.vars file), so a regeneration on
// any other machine silently deletes them. Declaring them here by interface
// merging keeps types/control.d.ts pure generated output, so regenerating it
// during the domain cutover cannot quietly drop the secrets.
//
// `bun run types:check` guards the generated file, but only against drift from
// wrangler.control.jsonc: `wrangler types --check` compares a hash of the config,
// never the file body, so a hand-edit inside types/control.d.ts still passes. It
// runs with --env-file=types/types-check.vars (deliberately empty) because a local
// .dev.vars would otherwise change the expected output and fail the gate. The gate
// covers this Worker only: types/gateway.d.ts was generated with a real secrets
// env file and types/broker.d.ts is hand-authored with no generation hash, so
// checking either one means giving it this same treatment first.
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
