import { DurableObject } from "cloudflare:workers";
import { mintAccountId, type AccountIdentity } from "../login-account";

/**
 * One Durable Object per email identity, named by the hash of the address.
 * Sharding this way means a signup never queues behind an unrelated one, and
 * the object's own serialization is what stops two links racing to create two
 * Accounts for the same person.
 */

const IDENTITY_KEY = "identity";

export interface LoginIdentityEnv {
  IDENTITY: DurableObjectNamespace<LoginIdentity>;
}

export class LoginIdentity extends DurableObject<LoginIdentityEnv> {
  /**
   * The Account this address owns, created on the first successful login and
   * unchanged by every login after. Only storage awaits sit between the read
   * and the write, so the input gate holds across them.
   */
  async accountFor(now: number): Promise<{ accountId: string; created: boolean }> {
    const stored = await this.ctx.storage.get<AccountIdentity>(IDENTITY_KEY);
    if (stored !== undefined) return { accountId: stored.accountId, created: false };

    const identity: AccountIdentity = { accountId: mintAccountId(), createdAt: now };
    await this.ctx.storage.put(IDENTITY_KEY, identity);
    return { accountId: identity.accountId, created: true };
  }

  /** Read-only: resolving a session must never bring an Account into being. */
  async account(): Promise<string | null> {
    const stored = await this.ctx.storage.get<AccountIdentity>(IDENTITY_KEY);
    return stored?.accountId ?? null;
  }
}
