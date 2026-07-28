import type { ProviderBindingRequirement } from "../domain";
import type {
  ManagementBindingMap,
  ManagementConnection,
} from "../management-contract";
import {
  buildPortableAngel,
  type PortableBuildResult,
} from "../build";
import { ManagementClient, ManagementRequestError } from "./client";
import type { FetchLike } from "./client";
import {
  loadAngelDeploymentConfig,
  type AngelDeploymentConfig,
  type DeploymentBindingMap,
} from "./config";

export interface AngelCommandDependencies {
  repoRoot: string;
  fetch?: FetchLike;
  build?: (input: { repoRoot: string; angelId: string }) => Promise<PortableBuildResult>;
  loadDeploymentConfig?: (input: { repoRoot: string; angelId: string }) => AngelDeploymentConfig;
  output?: (line: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
}

export async function runAngelCommand(
  args: readonly string[],
  dependencies: AngelCommandDependencies,
): Promise<void> {
  const [command, angelId, ...flags] = args;
  if (command === "build" && angelId !== undefined && flags.length === 0) {
    const result = await build(dependencies)({ repoRoot: dependencies.repoRoot, angelId });
    output(dependencies)(`built ${result.artifact.name} ${result.artifact.digest} in ${result.outDir}`);
    return;
  }
  if (command === "publish" && angelId !== undefined && flags.length === 0) {
    await publish(angelId, dependencies);
    return;
  }
  if (command === "deploy" && angelId !== undefined && flags.length === 1 && flags[0] === "--prod") {
    await deployProduction(angelId, dependencies);
    return;
  }
  if (command === "delete" && angelId !== undefined && flags.length === 0) {
    await deleteAngel(angelId, undefined, dependencies);
    return;
  }
  if (
    command === "delete" && angelId !== undefined
    && flags.length === 2 && flags[0] === "--confirm" && flags[1] !== undefined
  ) {
    await deleteAngel(angelId, flags[1], dependencies);
    return;
  }
  throw new Error(
    "usage: angel build <angel> | angel publish <angel> | angel deploy <angel> --prod"
    + " | angel delete <angel> [--confirm <slug>]",
  );
}

async function publish(angelId: string, dependencies: AngelCommandDependencies): Promise<void> {
  const config = deploymentConfig(dependencies, angelId);
  const built = await build(dependencies)({ repoRoot: dependencies.repoRoot, angelId });
  if (built.artifact.name !== config.angel) {
    throw new Error(`angel.json angel ${config.angel} does not match artifact ${built.artifact.name}`);
  }
  const client = managementClient(config.target, dependencies);
  const connections = await client.listConnections(config.account);
  const bindings = resolveBindings(
    config.bindings.staging,
    connections,
    built.artifact.bindingRequirements,
    config.account,
  );
  const ensured = await client.ensureAngel(config.account, config.angel);
  if (ensured.angel.accountId !== config.account || ensured.angel.slug !== config.angel) {
    throw new Error("ensure Angel response does not match angel.json");
  }
  if (ensured.keys !== undefined) {
    output(dependencies)(`staging key: ${ensured.keys.staging}`);
    output(dependencies)(`production key: ${ensured.keys.production}`);
  }
  const version = await client.publishVersion(ensured.angel.id, {
    artifact: built.artifact,
    expectedDigest: built.artifact.digest,
  });
  if (version.angelId !== ensured.angel.id || version.digest !== built.artifact.digest) {
    throw new Error("published Version response does not match the built artifact");
  }
  const deployment = await client.deployStaging(ensured.angel.id, {
    versionId: version.id,
    expectedDigest: built.artifact.digest,
    bindings,
  });
  if (deployment.versionId !== version.id || deployment.digest !== built.artifact.digest) {
    throw new Error("staging deployment response does not match the published Version");
  }
  output(dependencies)(`published ${config.angel} Version ${version.number} to staging`);
}

async function deployProduction(
  angelId: string,
  dependencies: AngelCommandDependencies,
): Promise<void> {
  const config = deploymentConfig(dependencies, angelId);
  const client = managementClient(config.target, dependencies);
  const angel = await client.getAngel(config.account, config.angel);
  if (angel.accountId !== config.account || angel.slug !== config.angel) {
    throw new Error("Angel response does not match angel.json");
  }
  const staging = await client.getEnvironment(angel.id, "staging");
  if (staging.environment !== "staging" || staging.activeDeployment === null) {
    throw new Error("no active staged deployment to promote");
  }
  const connections = await client.listConnections(config.account);
  const bindings = resolveBindings(config.bindings.production, connections, undefined, config.account);
  const promoted = await client.promoteProduction(angel.id, {
    stagedDeploymentId: staging.activeDeployment.id,
    expectedDigest: staging.activeDeployment.digest,
    bindings,
  });
  if (
    promoted.environment !== "production"
    || promoted.versionId !== staging.activeDeployment.versionId
    || promoted.digest !== staging.activeDeployment.digest
  ) {
    throw new Error("production deployment response does not match the active staged deployment");
  }
  output(dependencies)(`deployed ${config.angel} Version ${promoted.version} to production`);
}

async function deleteAngel(
  angelId: string,
  confirm: string | undefined,
  dependencies: AngelCommandDependencies,
): Promise<void> {
  const config = deploymentConfig(dependencies, angelId);
  const client = managementClient(config.target, dependencies);
  let deleted;
  try {
    deleted = await client.deleteAngel(
      config.account,
      config.angel,
      confirm === undefined ? {} : { confirm },
    );
  } catch (error) {
    // The API refuses to delete a live production Angel without the slug typed
    // back. Surface the refusal and say how to confirm; never bypass it.
    if (error instanceof ManagementRequestError && error.status === 409 && confirm === undefined) {
      throw new Error(
        `${error.message}\nre-run with: angel delete ${angelId} --confirm ${config.angel}`,
      );
    }
    throw error;
  }
  if (deleted.slug !== config.angel) {
    throw new Error("delete response does not match angel.json");
  }
  output(dependencies)(`deleted ${config.angel} (${deleted.id})`);
}

function resolveBindings(
  configured: DeploymentBindingMap,
  connections: readonly ManagementConnection[],
  requirements: readonly ProviderBindingRequirement[] | undefined,
  accountId: string,
): ManagementBindingMap {
  const byNickname = new Map<string, ManagementConnection[]>();
  for (const connection of connections) {
    if (connection.accountId !== accountId) {
      throw new Error(`Connection ${connection.id} does not belong to Account ${accountId}`);
    }
    const matches = byNickname.get(connection.nickname) ?? [];
    matches.push(connection);
    byNickname.set(connection.nickname, matches);
  }
  if (requirements !== undefined) {
    const expected = requirements.map((requirement) => requirement.id).sort();
    const actual = Object.keys(configured).sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new Error(`bindings must exactly cover artifact requirements: ${expected.join(", ")}`);
    }
  }
  const resolved: Record<string, string[]> = {};
  for (const [requirementId, value] of Object.entries(configured)) {
    const nicknames = typeof value === "string" ? [value] : value;
    resolved[requirementId] = nicknames.map((nickname) => {
      const matches = byNickname.get(nickname) ?? [];
      const healthy = matches.filter((connection) => connection.health === "healthy");
      if (healthy.length > 1) {
        throw new Error(`Connection nickname ${nickname} is duplicated`);
      }
      const connection = healthy[0];
      if (connection === undefined && matches.length > 0) {
        throw new Error(`Connection nickname ${nickname} exists but is not healthy`);
      }
      if (connection === undefined) {
        throw new Error(`Connection nickname ${nickname} was not found`);
      }
      const requirement = requirements?.find((candidate) => candidate.id === requirementId);
      if (
        requirement !== undefined
        && (connection.credential !== requirement.credential
          || !connection.providers.includes(requirement.provider))
      ) {
        throw new Error(`Connection nickname ${nickname} cannot satisfy ${requirementId}`);
      }
      return connection.id;
    });
  }
  return resolved;
}

function managementClient(target: string, dependencies: AngelCommandDependencies): ManagementClient {
  const token = dependencies.env?.ANGEL_MANAGEMENT_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("ANGEL_MANAGEMENT_TOKEN must be set");
  }
  return new ManagementClient({
    target,
    token,
    accessToken: dependencies.env?.ANGEL_ACCESS_TOKEN,
    fetch: dependencies.fetch ?? globalThis.fetch,
  });
}

function build(dependencies: AngelCommandDependencies) {
  return dependencies.build ?? buildPortableAngel;
}

function deploymentConfig(
  dependencies: AngelCommandDependencies,
  angelId: string,
): AngelDeploymentConfig {
  return dependencies.loadDeploymentConfig?.({ repoRoot: dependencies.repoRoot, angelId })
    ?? loadAngelDeploymentConfig({ repoRoot: dependencies.repoRoot, angelId });
}

function output(dependencies: AngelCommandDependencies): (line: string) => void {
  return dependencies.output ?? console.log;
}
