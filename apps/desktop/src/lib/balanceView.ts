import type { Account } from "@vault/shared";
import { useEffect, useState } from "react";

/**
 * Available vs actual balances.
 *
 * Money set aside for a bill, a gift fund or a savings bucket is still in the
 * bank, but it isn't free to spend — so accounts show what's left after those
 * set-asides, and one button flips every balance in the app back to the bank's
 * number. The choice is per device, like the dashboard's other view toggles.
 */
const KEY = "vault.balances.show-actual";
const EVENT = "vault:balances-view";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function useShowActualBalances(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(load);
  useEffect(() => {
    // Keep the Accounts page and the dashboard widget in step.
    const sync = () => setOn(load());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const set = (next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      /* per-device convenience only */
    }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

/** What's free to use: the balance minus money set aside in it. */
export function availableCents(account: Pick<Account, "balanceCents" | "setAsideCents">): number {
  return account.balanceCents - (account.setAsideCents ?? 0);
}

/** The balance to show, given the current view. */
export function shownBalance(
  account: Pick<Account, "balanceCents" | "setAsideCents">,
  showActual: boolean,
): number {
  return showActual ? account.balanceCents : availableCents(account);
}
