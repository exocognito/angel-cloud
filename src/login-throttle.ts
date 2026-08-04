/**
 * Caps on how often a link can be asked for. Without these the sign-in
 * endpoint is a way to mail anyone, repeatedly, from our sending domain.
 */

export const THROTTLE_WINDOW_MS = 15 * 60 * 1_000;

/** One person losing a mail asks two or three times; nobody asks four. */
export const MAX_LINKS_PER_EMAIL = 3;

/** A shared office egress is one source, so this is looser than the address cap. */
export const MAX_LINKS_PER_SOURCE = 10;

export interface ThrottleWindow {
  windowStart: number;
  count: number;
}

/**
 * A fixed window rather than a sliding one: it lets a burst through at a
 * boundary, and in exchange it holds two numbers instead of a list, so an
 * attacker cannot grow our storage by asking.
 */
export function spendAllowance(
  window: ThrottleWindow | undefined,
  limit: number,
  now: number,
): { window: ThrottleWindow; allowed: boolean } {
  if (window === undefined || now - window.windowStart >= THROTTLE_WINDOW_MS) {
    return { window: { windowStart: now, count: 1 }, allowed: true };
  }
  if (window.count >= limit) return { window, allowed: false };
  return { window: { ...window, count: window.count + 1 }, allowed: true };
}
