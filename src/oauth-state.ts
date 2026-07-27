export interface OAuthStateRecord {
  state: string;
  accountId: string;
  accessSubject: string;
  providerAppId: string;
  connectionId: string;
  nickname: string;
  redirectUri: string;
  flow: "create" | "reauth";
  codeVerifier: string;
  codeChallenge: string;
  expiresAt: number;
  used: boolean;
}

export async function issueOAuthState(input: {
  accountId: string;
  accessSubject: string;
  providerAppId: string;
  connectionId: string;
  nickname: string;
  redirectUri: string;
  flow?: "create" | "reauth";
  now?: number;
}): Promise<{ state: string; record: OAuthStateRecord }> {
  const state = randomToken(32);
  const codeVerifier = randomToken(32);
  const record: OAuthStateRecord = {
    state,
    accountId: input.accountId,
    accessSubject: input.accessSubject,
    providerAppId: input.providerAppId,
    connectionId: input.connectionId,
    nickname: input.nickname,
    redirectUri: input.redirectUri,
    flow: input.flow ?? "create",
    codeVerifier,
    codeChallenge: await sha256Base64Url(codeVerifier),
    expiresAt: (input.now ?? Date.now()) + 10 * 60 * 1000,
    used: false,
  };
  return { state, record };
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
