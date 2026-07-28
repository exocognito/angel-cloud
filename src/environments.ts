/**
 * The hosted environment vocabulary (PD 0003, amended by PD 0005): every
 * Angel has `production` plus an opt-in second environment named `preview`.
 *
 * `preview` replaced the old name `staging` on 2026-07-28. The pinned
 * `@smcllns/angel-core` CLI still speaks the old spelling on the `/v1`
 * management surface, and old MCP URLs still carry it, so the legacy
 * spelling stays accepted at the HTTP boundaries and is translated to the
 * canonical name there. Internal state, gate runtime ids, and every new
 * surface use `preview` only.
 */
export type HostedEnvironment = "preview" | "production";

export const HOSTED_ENVIRONMENTS: readonly HostedEnvironment[] = ["preview", "production"];

/** The retired spelling of `preview`, served through the cutover. */
export const LEGACY_PREVIEW_SPELLING = "staging";

/**
 * Any environment name a persisted record may still carry: gate installations
 * written before the rename say `staging` until their Angel is redeployed.
 */
export type RecordedEnvironment = HostedEnvironment | typeof LEGACY_PREVIEW_SPELLING;

/**
 * Map a wire-format environment segment to its canonical name, or null when
 * it names no environment. The legacy `staging` spelling canonicalizes to
 * `preview`; everything else must already be canonical.
 */
export function canonicalEnvironment(value: string): HostedEnvironment | null {
  if (value === LEGACY_PREVIEW_SPELLING) return "preview";
  if (value === "preview" || value === "production") return value;
  return null;
}
