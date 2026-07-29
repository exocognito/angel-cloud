import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ConnectionNicknameBinding = string | readonly string[];
export type DeploymentBindingMap = Readonly<Record<string, ConnectionNicknameBinding>>;

export interface AngelDeploymentConfig {
  target: string;
  account: string;
  angel: string;
  bindings: {
    preview: DeploymentBindingMap;
    production: DeploymentBindingMap;
  };
}

export function loadAngelDeploymentConfig(input: {
  repoRoot: string;
  angelId: string;
}): AngelDeploymentConfig {
  return parseAngelDeploymentConfig(
    readFileSync(join(input.repoRoot, "angels", input.angelId, "angel.json"), "utf8"),
  );
}

export function parseAngelDeploymentConfig(raw: string): AngelDeploymentConfig {
  const root = record(JSON.parse(raw), "angel.json");
  exactKeys(root, ["target", "account", "angel", "bindings"], "angel.json");
  const target = parseTarget(root.target);
  const account = nonEmptyString(root.account, "account");
  const angel = nonEmptyString(root.angel, "angel");
  const bindings = record(root.bindings, "bindings");
  // The second environment was renamed staging → preview; a legacy file gets
  // the rename instruction instead of the generic exact-keys error.
  if ("staging" in bindings) {
    throw new Error("angel.json bindings.staging is now bindings.preview: rename the key");
  }
  exactKeys(bindings, ["preview", "production"], "bindings");
  return {
    target,
    account,
    angel,
    bindings: {
      preview: parseBindingMap(bindings.preview, "bindings.preview"),
      production: parseBindingMap(bindings.production, "bindings.production"),
    },
  };
}

function parseTarget(value: unknown): string {
  const raw = nonEmptyString(value, "target");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("target must be an absolute HTTPS base URL");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname !== "/"
  ) {
    throw new Error("target must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function parseBindingMap(value: unknown, label: string): DeploymentBindingMap {
  const input = record(value, label);
  const output: Record<string, ConnectionNicknameBinding> = {};
  for (const [requirementId, binding] of Object.entries(input)) {
    if (requirementId.trim() === "") throw new Error(`${label} requirement IDs must be non-empty`);
    if (typeof binding === "string") {
      output[requirementId] = nonEmptyString(binding, `${label}.${requirementId}`);
      continue;
    }
    if (!Array.isArray(binding) || binding.length === 0) {
      throw new Error(`${label}.${requirementId} must be a Connection nickname or non-empty list`);
    }
    const nicknames = binding.map((nickname) =>
      nonEmptyString(nickname, `${label}.${requirementId}`)
    );
    if (new Set(nicknames).size !== nicknames.length) {
      throw new Error(`${label}.${requirementId} must not repeat a Connection nickname`);
    }
    output[requirementId] = nicknames;
  }
  return output;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} must contain exactly ${sortedExpected.join(", ")}`);
  }
}
