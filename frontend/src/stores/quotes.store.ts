/**
 * Parents of replies that are NOT in the loaded history of their channel, fetched one at a time.
 *
 * A reply quotes its parent by id, and the quote used to be drawn only from what the channel
 * held in memory: reply to something older than the loaded page and every reader saw "Deleted
 * message" until they scrolled far enough back for the original to load — at which point the
 * very same quote filled in. The iOS app has fetched missing parents like this all along
 * (AppState.ensureQuoted); MessageList does the fetching, this holds the results.
 */

import { createStore } from "@lib/store";
import type { MessageResponse } from "@lib/types";
import { messageResponseToMessage, type Message } from "@stores/messages.store";

export interface QuotesState {
  /** Fetched parents, by message id. */
  readonly found: ReadonlyMap<number, Message>;
  /** Looked up and not there — deleted, or from someone blocked. Only these read "deleted". */
  readonly missing: ReadonlySet<number>;
  /** Asked for already: a quote scrolling past twenty times asks once. */
  readonly requested: ReadonlySet<number>;
}

const INITIAL: QuotesState = { found: new Map(), missing: new Set(), requested: new Set() };

// Per account: message ids are only unique inside one space, so another sign-in must not see
// the previous one's quotes.
export const quotesStore = createStore<QuotesState>(INITIAL, true);

/** True if the caller should fetch this parent now — false if it already has been asked for. */
export function claimQuoteLookup(messageId: number): boolean {
  if (quotesStore.getState().requested.has(messageId)) return false;
  quotesStore.setState((s) => ({ ...s, requested: new Set(s.requested).add(messageId) }));
  return true;
}

/** The fetch failed outright (network, not "no such message"): let the next render ask again. */
export function releaseQuoteLookup(messageId: number): void {
  quotesStore.setState((s) => {
    const requested = new Set(s.requested);
    requested.delete(messageId);
    return { ...s, requested };
  });
}

/** Takes the REST shape, already decrypted by the caller if it is a DM. */
export function setQuoteFound(r: MessageResponse): void {
  const m = messageResponseToMessage(r);
  quotesStore.setState((s) => ({ ...s, found: new Map(s.found).set(m.id, m) }));
}

export function setQuoteMissing(messageId: number): void {
  quotesStore.setState((s) => ({ ...s, missing: new Set(s.missing).add(messageId) }));
}
