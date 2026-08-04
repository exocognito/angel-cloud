import { DurableObject } from "cloudflare:workers";
import {
  THROTTLE_WINDOW_MS,
  spendAllowance,
  type ThrottleWindow,
} from "../login-throttle";

/**
 * One Durable Object per thing being counted — an email identity, or a source
 * address. Named by a hash either way, so the object holds a count and never
 * the address itself.
 */

const WINDOW_KEY = "window";

export interface LoginThrottleEnv {
  THROTTLE: DurableObjectNamespace<LoginThrottle>;
}

export class LoginThrottle extends DurableObject<LoginThrottleEnv> {
  /**
   * Take one from the allowance, or report there is none. Only storage awaits
   * sit between the read and the write, so the input gate holds across them
   * and a burst of simultaneous requests cannot each read the same count.
   */
  async spend(limit: number, now: number): Promise<boolean> {
    const stored = await this.ctx.storage.get<ThrottleWindow>(WINDOW_KEY);
    const outcome = spendAllowance(stored, limit, now);
    if (!outcome.allowed) return false;
    await this.ctx.storage.put(WINDOW_KEY, outcome.window);
    await this.ctx.storage.setAlarm(outcome.window.windowStart + THROTTLE_WINDOW_MS);
    return true;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
