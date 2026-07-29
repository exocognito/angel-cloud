import type { HostedTool } from "./domain";

/** Human-readable labels for a tool's argument guards, one per guard. */
export function guardLabels(tool: HostedTool): string[] {
  return tool.argGuards.map((guard) => {
    if ("pin" in guard) return `${guard.field} pinned to ${guard.pin}`;
    if ("forbid" in guard) return `${guard.field} forbidden`;
    return `${guard.field} forbids ${guard.forbiddenValues.join(", ")}`;
  });
}

/** Display name for a provider id. */
export function appName(provider: string): string {
  if (provider === "gmail") return "Gmail";
  if (provider === "docs") return "Google Docs";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
