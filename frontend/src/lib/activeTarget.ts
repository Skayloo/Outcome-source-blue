import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";

export interface ActiveTarget {
  readonly id: number;
  readonly name: string;
  readonly type: string; // text | voice | announcement | dm
  readonly peerId?: number; // for DMs: the recipient's user id (used to place a direct call)
}

/**
 * Resolve a conversation target — a server channel or an open DM channel.
 *
 * @param channelId Resolve this channel instead of the focused one. Split view opens a second
 * conversation beside the first, and everything it renders has to be told which one it is;
 * without the argument the whole right pane would silently mirror the left.
 */
export function getActiveTarget(channelId?: number | null): ActiveTarget | null {
  const chId = channelId ?? channelsStore.getState().activeChannelId;
  if (chId == null) return null;
  const ch = channelsStore.getState().channels.get(chId);
  if (ch) return { id: ch.id, name: ch.name, type: ch.type };
  const dm = dmStore.getState().channels.find((d) => d.channelId === chId);
  if (dm) return { id: dm.channelId, name: dm.recipient.username, type: "dm", peerId: dm.recipient.id };
  return null;
}
