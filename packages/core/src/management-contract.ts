import type {
  CredentialKind,
  DeploymentEnvironment,
  HostedVersionArtifact,
  ProviderBindingRequirement,
} from "./domain";

export type BindingRequirementId = string;
export type ConnectionId = string;
export type ManagementBindingMap = Readonly<Record<BindingRequirementId, readonly ConnectionId[]>>;

export interface ManagementConnection {
  id: ConnectionId;
  accountId: string;
  nickname: string;
  identityLabel: string;
  credential: CredentialKind;
  providers: readonly string[];
  health: "healthy" | "error";
}

export interface ManagementVersionArtifact extends HostedVersionArtifact {
  bindingRequirements: Array<ProviderBindingRequirement & { id: BindingRequirementId }>;
}

export interface ManagementAngelView {
  id: string;
  accountId: string;
  slug: string;
  environments: Record<DeploymentEnvironment, ManagementEnvironmentView>;
}

export interface PublishedAngelVersion {
  id: string;
  angelId: string;
  number: number;
  digest: string;
  artifact: ManagementVersionArtifact;
}

export interface ManagementDeploymentView {
  id: string;
  angelId: string;
  environment: DeploymentEnvironment;
  versionId: string;
  version: number;
  digest: string;
  bindings: Record<BindingRequirementId, ConnectionId[]>;
}

export interface ManagementAvailabilityView {
  defaultEnabled: boolean;
  toolOverrides: Record<string, boolean>;
  connectionOverrides: Record<string, Record<ConnectionId, boolean>>;
  revision: number;
}

export type ManagementAvailabilityChange =
  | { kind: "all"; enabled: boolean }
  | { kind: "tool"; tool: string; enabled: boolean }
  | { kind: "tool_connection"; tool: string; connectionId: ConnectionId; enabled: boolean };

export interface ManagementDeploymentSummary {
  id: string;
  versionId: string;
  digest: string;
  bindings: Record<BindingRequirementId, ConnectionId[]>;
}

export interface ManagementEnvironmentView {
  environment: DeploymentEnvironment;
  keyFingerprint: string;
  activeDeployment: ManagementDeploymentSummary | null;
  pendingDeployment: ManagementDeploymentSummary | null;
  repair: null | "broker" | "gateway";
  availability: ManagementAvailabilityView;
  pendingAvailability: ManagementAvailabilityChange | null;
}

export interface EnsureAngelResponse {
  angel: ManagementAngelView;
  /** Present only when this ensure call created the Angel; the CLI announces creation from its presence. */
  keys?: Record<DeploymentEnvironment, string>;
}

export interface DeleteAngelResponse {
  id: string;
  slug: string;
  deleted: true;
}

export interface PublishVersionRequest {
  artifact: ManagementVersionArtifact;
  expectedDigest: string;
}

export interface DeployRequest {
  versionId: string;
  expectedDigest: string;
  bindings: ManagementBindingMap;
}

export interface PromoteProductionRequest {
  stagedDeploymentId: string;
  expectedDigest: string;
  bindings: ManagementBindingMap;
}
