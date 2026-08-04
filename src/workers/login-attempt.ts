import { DurableObject } from "cloudflare:workers";
import {
  MagicLinkError,
  consumeMagicLink,
  type MagicLinkFailure,
  type MagicLinkRecord,
} from "../magic-link";

export type ConsumeOutcome =
  | { ok: true; emailHash: string }
  | { ok: false; failure: MagicLinkFailure };

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
   * Reports refusal as a value rather than an exception, because a thrown
   * error crossing the Durable Object boundary arrives as a plain Error and
   * the caller can no longer tell a refused link from a broken service.
   *
   * Deliberately not wrapped in `blockConcurrencyWhile`, which resets the
   * object when its callback throws — a stranger typing a wrong token must
   * not be able to do that.
   */
  async consume(presentedVerifierHash: string, now: number): Promise<ConsumeOutcome> {
    const stored = await this.ctx.storage.get<MagicLinkRecord>(RECORD_KEY);
    let consumed: MagicLinkRecord;
    try {
      consumed = consumeMagicLink(stored, presentedVerifierHash, now);
    } catch (error) {
      if (error instanceof MagicLinkError) return { ok: false, failure: error.failure };
      throw error;
    }
    await this.ctx.storage.put(RECORD_KEY, consumed);
    return { ok: true, emailHash: consumed.emailHash };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export { MagicLinkError };
