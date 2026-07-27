export interface EncryptedValue {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export interface StoredProviderApp {
  id: string;
  accountId: string;
  provider: "google";
  displayName: string;
  clientId: string;
  clientSecret: EncryptedValue;
}

export interface StoredConnection {
  id: string;
  accountId: string;
  nickname: string;
  providerAppId: string;
  provider: "google";
  subject: string;
  displayName: string;
  grantedScopes: string[];
  health: "healthy" | "revoked" | "error";
  refreshToken: EncryptedValue;
}

export interface AccountCustodyState {
  wrappedDek: EncryptedValue;
  providerApps: Record<string, StoredProviderApp>;
  connections: Record<string, StoredConnection>;
}

export interface CustodyState {
  schemaVersion: 1;
  accounts: Record<string, AccountCustodyState>;
}

export interface StoreProviderAppInput {
  accountId: string;
  providerAppId: string;
  provider: "google";
  displayName: string;
  clientId: string;
  clientSecret: string;
}

export interface StoreConnectionInput {
  accountId: string;
  connectionId: string;
  nickname: string;
  providerAppId: string;
  provider: "google";
  subject: string;
  displayName?: string;
  grantedScopes: string[];
  refreshToken: string;
}

export interface ProviderAppSummary {
  id: string;
  accountId: string;
  provider: "google";
  displayName: string;
  clientIdSuffix: string;
}

export interface ProviderAppCredentialLease {
  accountId: string;
  providerAppId: string;
  provider: "google";
  clientId: string;
  clientSecret: string;
}

export interface ConnectionSummary {
  id: string;
  accountId: string;
  nickname: string;
  providerAppId: string;
  provider: "google";
  displayName: string;
  grantedScopes: string[];
  health: "healthy" | "revoked" | "error";
}

export interface ConnectionCredentialLease {
  accountId: string;
  connectionId: string;
  providerAppId: string;
  provider: "google";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  subject: string;
  grantedScopes: string[];
}

export class CustodyOwnershipError extends Error {
  constructor(message = "Credential record not found in Account") {
    super(message);
    this.name = "CustodyOwnershipError";
  }
}

export class CustodyIntegrityError extends Error {
  constructor(message = "Credential custody integrity check failed") {
    super(message);
    this.name = "CustodyIntegrityError";
  }
}

export class EnvelopeCustody {
  private constructor(
    private readonly kek: CryptoKey,
    private readonly state: CustodyState,
  ) {}

  static async create(kek: Uint8Array, state?: CustodyState): Promise<EnvelopeCustody> {
    if (kek.byteLength !== 32) throw new Error("KEK must be exactly 32 bytes");
    const importedKek = await importAesKey(kek);
    const persisted = state === undefined
      ? { schemaVersion: 1 as const, accounts: {} }
      : structuredClone(state);
    validateState(persisted);
    return new EnvelopeCustody(importedKek, persisted);
  }

  async storeProviderApp(input: StoreProviderAppInput): Promise<ProviderAppSummary> {
    validateIdentifier(input.accountId, "accountId");
    validateIdentifier(input.providerAppId, "providerAppId");
    validateText(input.displayName, "displayName");
    validateText(input.clientId, "clientId");
    validateText(input.clientSecret, "clientSecret");
    const { account, dek } = await this.accountForWrite(input.accountId);
    if (account.providerApps[input.providerAppId] !== undefined) {
      throw new Error(`Provider App already exists: ${input.providerAppId}`);
    }
    account.providerApps[input.providerAppId] = {
      id: input.providerAppId,
      accountId: input.accountId,
      provider: input.provider,
      displayName: input.displayName,
      clientId: input.clientId,
      clientSecret: await encryptText(
        dek,
        input.clientSecret,
        providerAppAad(input.accountId, input.providerAppId),
      ),
    };
    return this.getProviderApp(input.accountId, input.providerAppId);
  }

  async storeConnection(input: StoreConnectionInput): Promise<ConnectionSummary> {
    validateIdentifier(input.accountId, "accountId");
    validateIdentifier(input.connectionId, "connectionId");
    validateNickname(input.nickname);
    validateIdentifier(input.providerAppId, "providerAppId");
    validateText(input.subject, "subject");
    validateText(input.refreshToken, "refreshToken");
    const grantedScopes = normalizeScopes(input.grantedScopes);
    const { account, dek } = await this.accountForWrite(input.accountId);
    const providerApp = account.providerApps[input.providerAppId];
    if (providerApp === undefined || providerApp.provider !== input.provider) {
      throw new CustodyOwnershipError();
    }
    if (account.connections[input.connectionId] !== undefined) {
      throw new Error(`Connection already exists: ${input.connectionId}`);
    }
    if (Object.values(account.connections).some((connection) => connection.nickname === input.nickname)) {
      throw new Error(`Connection nickname already exists: ${input.nickname}`);
    }
    account.connections[input.connectionId] = {
      id: input.connectionId,
      accountId: input.accountId,
      nickname: input.nickname,
      providerAppId: input.providerAppId,
      provider: input.provider,
      subject: input.subject,
      displayName: input.displayName ?? input.subject,
      grantedScopes,
      health: "healthy",
      refreshToken: await encryptText(
        dek,
        input.refreshToken,
        connectionAad(input.accountId, input.connectionId),
      ),
    };
    return this.getConnection(input.accountId, input.connectionId);
  }

  async replaceConnection(input: StoreConnectionInput): Promise<ConnectionSummary> {
    validateIdentifier(input.accountId, "accountId");
    validateIdentifier(input.connectionId, "connectionId");
    validateNickname(input.nickname);
    validateIdentifier(input.providerAppId, "providerAppId");
    validateText(input.subject, "subject");
    validateText(input.refreshToken, "refreshToken");
    const grantedScopes = normalizeScopes(input.grantedScopes);
    const { account, dek } = await this.accountForWrite(input.accountId);
    const providerApp = account.providerApps[input.providerAppId];
    const existing = account.connections[input.connectionId];
    if (
      providerApp === undefined
      || providerApp.accountId !== input.accountId
      || providerApp.provider !== input.provider
      || existing === undefined
      || existing.accountId !== input.accountId
    ) throw new CustodyOwnershipError();
    if (existing.providerAppId !== input.providerAppId) {
      throw new CustodyOwnershipError("Connection reauth must use the same Provider App");
    }
    if (existing.subject !== input.subject) {
      throw new CustodyOwnershipError("Connection reauth must use the same Google identity");
    }
    if (existing.nickname !== input.nickname) {
      throw new CustodyOwnershipError("Connection reauth must preserve the same nickname");
    }
    account.connections[input.connectionId] = {
      ...existing,
      providerAppId: input.providerAppId,
      provider: input.provider,
      subject: input.subject,
      displayName: input.displayName ?? input.subject,
      grantedScopes,
      health: "healthy",
      refreshToken: await encryptText(
        dek,
        input.refreshToken,
        connectionAad(input.accountId, input.connectionId),
      ),
    };
    return this.getConnection(input.accountId, input.connectionId);
  }

  markConnectionHealth(
    accountId: string,
    connectionId: string,
    health: StoredConnection["health"],
  ): ConnectionSummary {
    const connection = this.state.accounts[accountId]?.connections[connectionId];
    if (connection === undefined || connection.accountId !== accountId) throw new CustodyOwnershipError();
    connection.health = health;
    return this.getConnection(accountId, connectionId);
  }

  removeConnection(accountId: string, connectionId: string): void {
    const account = this.state.accounts[accountId];
    const connection = account?.connections[connectionId];
    if (account === undefined || connection === undefined || connection.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    delete account.connections[connectionId];
  }

  getProviderApp(accountId: string, providerAppId: string): ProviderAppSummary {
    const record = this.state.accounts[accountId]?.providerApps[providerAppId];
    if (record === undefined || record.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    return {
      id: record.id,
      accountId: record.accountId,
      provider: record.provider,
      displayName: record.displayName,
      clientIdSuffix: record.clientId.slice(-15),
    };
  }

  async leaseProviderApp(accountId: string, providerAppId: string): Promise<ProviderAppCredentialLease> {
    const account = this.state.accounts[accountId];
    const providerApp = account?.providerApps[providerAppId];
    if (account === undefined || providerApp === undefined || providerApp.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    const dek = await this.unwrapDek(accountId, account.wrappedDek);
    return {
      accountId,
      providerAppId,
      provider: providerApp.provider,
      clientId: providerApp.clientId,
      clientSecret: await decryptText(dek, providerApp.clientSecret, providerAppAad(accountId, providerAppId)),
    };
  }

  getConnection(accountId: string, connectionId: string): ConnectionSummary {
    const record = this.state.accounts[accountId]?.connections[connectionId];
    if (record === undefined || record.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    return {
      id: record.id,
      accountId: record.accountId,
      nickname: record.nickname,
      providerAppId: record.providerAppId,
      provider: record.provider,
      displayName: record.displayName,
      grantedScopes: [...record.grantedScopes],
      health: record.health,
    };
  }

  async leaseConnection(accountId: string, connectionId: string): Promise<ConnectionCredentialLease> {
    const account = this.state.accounts[accountId];
    const connection = account?.connections[connectionId];
    if (account === undefined || connection === undefined || connection.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    if (connection.health !== "healthy") throw new CustodyOwnershipError(`Connection is ${connection.health}`);
    return this.leaseConnectionRecord(accountId, connectionId, account, connection);
  }

  async leaseConnectionForRevocation(accountId: string, connectionId: string): Promise<ConnectionCredentialLease> {
    const account = this.state.accounts[accountId];
    const connection = account?.connections[connectionId];
    if (account === undefined || connection === undefined || connection.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    return this.leaseConnectionRecord(accountId, connectionId, account, connection);
  }

  private async leaseConnectionRecord(
    accountId: string,
    connectionId: string,
    account: AccountCustodyState,
    connection: StoredConnection,
  ): Promise<ConnectionCredentialLease> {
    const providerApp = account.providerApps[connection.providerAppId];
    if (providerApp === undefined || providerApp.accountId !== accountId) {
      throw new CustodyOwnershipError();
    }
    const dek = await this.unwrapDek(accountId, account.wrappedDek);
    const [clientSecret, refreshToken] = await Promise.all([
      decryptText(dek, providerApp.clientSecret, providerAppAad(accountId, providerApp.id)),
      decryptText(dek, connection.refreshToken, connectionAad(accountId, connection.id)),
    ]);
    return {
      accountId,
      connectionId: connection.id,
      providerAppId: providerApp.id,
      provider: connection.provider,
      clientId: providerApp.clientId,
      clientSecret,
      refreshToken,
      subject: connection.subject,
      grantedScopes: [...connection.grantedScopes],
    };
  }

  exportState(): CustodyState {
    return structuredClone(this.state);
  }

  private async accountForWrite(accountId: string): Promise<{
    account: AccountCustodyState;
    dek: CryptoKey;
  }> {
    const existing = this.state.accounts[accountId];
    if (existing !== undefined) {
      return { account: existing, dek: await this.unwrapDek(accountId, existing.wrappedDek) };
    }
    const rawDek = randomBytes(32);
    try {
      const dek = await importAesKey(rawDek);
      const account: AccountCustodyState = {
        wrappedDek: await encryptBytes(this.kek, rawDek, accountDekAad(accountId)),
        providerApps: {},
        connections: {},
      };
      this.state.accounts[accountId] = account;
      return { account, dek };
    } finally {
      rawDek.fill(0);
    }
  }

  private async unwrapDek(accountId: string, wrappedDek: EncryptedValue): Promise<CryptoKey> {
    const rawDek = await decryptBytes(this.kek, wrappedDek, accountDekAad(accountId));
    try {
      if (rawDek.byteLength !== 32) throw new CustodyIntegrityError();
      return await importAesKey(rawDek);
    } finally {
      rawDek.fill(0);
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptText(key: CryptoKey, plaintext: string, aad: string): Promise<EncryptedValue> {
  return encryptBytes(key, encoder.encode(plaintext), aad);
}

async function encryptBytes(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<EncryptedValue> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(encoder.encode(aad)),
      tagLength: 128,
    },
    key,
    toArrayBuffer(plaintext),
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptText(key: CryptoKey, value: EncryptedValue, aad: string): Promise<string> {
  const plaintext = await decryptBytes(key, value, aad);
  try {
    return decoder.decode(plaintext);
  } catch {
    throw new CustodyIntegrityError();
  } finally {
    plaintext.fill(0);
  }
}

async function decryptBytes(key: CryptoKey, value: EncryptedValue, aad: string): Promise<Uint8Array> {
  try {
    validateEnvelope(value);
    const iv = fromBase64(value.iv);
    const ciphertext = fromBase64(value.ciphertext);
    if (iv.byteLength !== 12 || ciphertext.byteLength === 0) throw new CustodyIntegrityError();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(encoder.encode(aad)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof CustodyIntegrityError) throw error;
    throw new CustodyIntegrityError();
  }
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function accountDekAad(accountId: string): string {
  return `angel-cloud:custody:v1:account:${accountId}:dek`;
}

function providerAppAad(accountId: string, providerAppId: string): string {
  return `angel-cloud:custody:v1:account:${accountId}:provider-app:${providerAppId}:client-secret`;
}

function connectionAad(accountId: string, connectionId: string): string {
  return `angel-cloud:custody:v1:account:${accountId}:connection:${connectionId}:refresh-token`;
}

function normalizeScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error("grantedScopes must not be empty");
  const normalized = scopes.map((scope) => {
    validateText(scope, "grantedScopes entry");
    return scope;
  });
  return [...new Set(normalized)].sort();
}

function validateIdentifier(value: string, field: string): void {
  validateText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${field} contains unsupported characters`);
  }
}

function validateNickname(value: string): void {
  validateText(value, "nickname");
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("nickname must be a safe label of 128 characters or fewer");
  }
}

function validateText(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must not be empty`);
}

function validateState(state: CustodyState): void {
  if (!isRecord(state) || state.schemaVersion !== 1 || !isRecord(state.accounts)) {
    throw new CustodyIntegrityError("Stored custody state is malformed");
  }
  for (const [accountId, account] of Object.entries(state.accounts)) {
    if (!isRecord(account) || !isRecord(account.providerApps) || !isRecord(account.connections)) {
      throw new CustodyIntegrityError("Stored custody state is malformed");
    }
    validateEnvelope(account.wrappedDek);
    for (const [id, providerApp] of Object.entries(account.providerApps)) {
      if (
        !isRecord(providerApp) || providerApp.id !== id || providerApp.accountId !== accountId ||
        providerApp.provider !== "google" || typeof providerApp.displayName !== "string" ||
        typeof providerApp.clientId !== "string"
      ) {
        throw new CustodyIntegrityError("Stored custody state is malformed");
      }
      validateEnvelope(providerApp.clientSecret);
    }
    for (const [id, connection] of Object.entries(account.connections)) {
      if (
        !isRecord(connection) || connection.id !== id || connection.accountId !== accountId ||
        connection.provider !== "google" || typeof connection.nickname !== "string" || connection.nickname === "" ||
        typeof connection.providerAppId !== "string" ||
        typeof connection.subject !== "string" || typeof connection.displayName !== "string" ||
        !Array.isArray(connection.grantedScopes) ||
        !["healthy", "revoked", "error"].includes(connection.health as string)
      ) {
        throw new CustodyIntegrityError("Stored custody state is malformed");
      }
      validateEnvelope(connection.refreshToken);
    }
  }
}

function validateEnvelope(value: unknown): asserts value is EncryptedValue {
  if (
    !isRecord(value) || value.version !== 1 || value.algorithm !== "AES-GCM" ||
    typeof value.iv !== "string" || typeof value.ciphertext !== "string"
  ) {
    throw new CustodyIntegrityError("Stored encrypted value is malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CustodyIntegrityError("Stored encrypted value is malformed");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy.buffer;
}
