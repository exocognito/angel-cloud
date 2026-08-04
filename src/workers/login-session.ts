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
  async open(record: SessionRecord): Promise<void> {
    await this.ctx.storage.put(SESSION_KEY, record);
    await this.ctx.storage.setAlarm(record.expiresAt + LOGIN_SESSION_SWEEP_MS);
  }

  async resolve(now: number): Promise<SessionRecord | null> {
    return activeSession(await this.ctx.storage.get<SessionRecord>(SESSION_KEY), now);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
