import { DurableObject } from "cloudflare:workers";
import { activeSession, type SessionRecord } from "../login-account";

/**
 * One Durable Object per session, named by the hash of the session token. The
 * token itself is never stored, so reading storage cannot impersonate anyone,
 * and the object is reachable only by whoever holds the token.
 */

const SESSION_KEY = "session";

/** How long a dead session lingers before the alarm sweeps it. */
export const LOGIN_SESSION_SWEEP_MS = 60_000;

export interface LoginSessionEnv {
  SESSION: DurableObjectNamespace<LoginSession>;
}

export class LoginSession extends DurableObject<LoginSessionEnv> {
  /**
   * Arms the sweep before it writes. The other order can leave a record with
   * no alarm if `setAlarm` fails — a durable session a failed login left
   * behind, which is exactly what the callback's ordering exists to prevent.
   * This way a failed `put` leaves an alarm over empty storage, which is
   * harmless.
   */
  async open(record: SessionRecord): Promise<void> {
    await this.ctx.storage.setAlarm(record.expiresAt + LOGIN_SESSION_SWEEP_MS);
    await this.ctx.storage.put(SESSION_KEY, record);
  }

  async resolve(now: number): Promise<SessionRecord | null> {
    return activeSession(await this.ctx.storage.get<SessionRecord>(SESSION_KEY), now);
  }

  /** Drop a session written by a login that then failed. */
  async close(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
