/**
 * Muted chats — per-user "don't notify me" flags for any channel (DMs included).
 * Seeded from READY's muted_channels, toggled from the chat context menu.
 * The set lives server-side, so mutes follow the account across web and mobile.
 */

import { createStore } from "@lib/store";
import { api } from "@lib/services";

export interface MutesState {
  readonly muted: ReadonlySet<number>;
}

const INITIAL: MutesState = { muted: new Set() };

export const mutesStore = createStore<MutesState>(INITIAL);

/** Bulk-set from the READY payload. */
export function setMutedChannels(channelIds: readonly number[]): void {
  mutesStore.setState(() => ({ muted: new Set(channelIds) }));
}

export function isChannelMuted(channelId: number): boolean {
  return mutesStore.getState().muted.has(channelId);
}

/** Optimistic toggle: flip locally at once, roll back if the server call fails. */
export function toggleChannelMute(channelId: number): void {
  const wasMuted = isChannelMuted(channelId);
  const apply = (muted: boolean): void => {
    mutesStore.setState((s) => {
      const next = new Set(s.muted);
      if (muted) next.add(channelId); else next.delete(channelId);
      return { muted: next };
    });
  };
  apply(!wasMuted);
  void (wasMuted ? api.unmuteChannel(channelId) : api.muteChannel(channelId))
    .catch(() => apply(wasMuted));
}
