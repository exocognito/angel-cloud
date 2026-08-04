import { DurableObject } from "cloudflare:workers";
import {
  MagicLinkError,
  consumeMagicLink,
  type MagicLinkRecord,
} from "../magic-link";

/**
 * One Durable Object per issued link, named by the token's selector. The
 * selector is 128 random bits, so an instance is reachable only by whoever
 * holds the mail — and every login gets its own object, so no two logins
 * queue behind each other.
 */

const RECORD_KEY = "record";

/** How long a spent or dead record lingers before the alarm sweeps it. */
export const LOGIN_ATTEMPT_SWEEP_MS = 60_000;

export interface LoginAttemptEnv {
  LOGIN: DurableObjectNamespace<LoginAttempt>;
}

export class LoginAttempt extends DurableObject<LoginAttemptEnv> {
  async issue(record: MagicLinkRecord): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.expiresAt + LOGIN_ATTEMPT_SWEEP_MS);
  }

  /**
   * Spend the link, or refuse. Takes the verifier already hashed: hashing is
   * the one variable-time step, and doing it in the caller keeps every await
   * below a storage await. The input gate stays shut across those, so the
   * read, the decision and the write are one indivisible step and two
   * simultaneous clicks cannot both win.
   *
   * Throws MagicLinkError. Deliberately not wrapped in
   * `blockConcurrencyWhile`, which resets the object on a thrown exception —
   * a stranger typing a wrong token must not be able to do that.
   */
  async consume(presentedVerifierHash: string, now: number): Promise<{ emailHash: string }> {
    const stored = await this.ctx.storage.get<MagicLinkRecord>(RECORD_KEY);
    const consumed = consumeMagicLink(stored, presentedVerifierHash, now);
    await this.ctx.storage.put(RECORD_KEY, consumed);
    return { emailHash: consumed.emailHash };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export { MagicLinkError };
