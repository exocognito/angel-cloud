import { compileHostedAngel, type HostedVersionArtifact } from "./domain";

const CHARTER = `Research my mail and documents. Read a bounded set of Gmail messages and
one pinned Google Doc. Never send mail, delete content, alter labels, or
modify documents. An out-of-bounds read exists only to prove the compiled
argument guards fail closed before a provider call.`;

const HEADER = `name: golden-research-assistant

charter: |
  ${CHARTER.replaceAll("\n", "\n  ")}

tools:
  - tool: gmail.users.messages.list
    argGuards:
      - field: maxResults
        pin: "5"
`;

const DOCS_TOOL = `  - tool: docs.documents.get
    argGuards:
      - field: documentId
        pin: "doc_golden_1"
`;

const LABELS_TOOL = `  - gmail.users.labels.list
`;

export const DEMO_ACCOUNT = { id: "acct_demo", name: "Personal" } as const;
export const DEMO_ANGEL = {
  id: "golden-research-assistant",
  name: "Golden Research Assistant",
} as const;
export const DEMO_CONNECTIONS = [{
  id: "con_google",
  accountId: DEMO_ACCOUNT.id,
  credential: "google_oauth" as const,
  label: "Golden Google",
  apps: ["Gmail", "Google Docs"],
  health: "healthy" as const,
}];
export const DEMO_BINDINGS = {
  gmail: {
    connectionId: "con_google",
    identityLabel: "Golden Google",
  },
  docs: {
    connectionId: "con_google",
    identityLabel: "Golden Google",
  },
};

export async function demoArtifact(version: 1 | 2): Promise<HostedVersionArtifact> {
  return compileHostedAngel(version === 1
    ? `${HEADER}${DOCS_TOOL}`
    : `${HEADER}${LABELS_TOOL}${DOCS_TOOL}`);
}
