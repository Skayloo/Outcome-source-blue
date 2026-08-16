import { api } from "./services";
import { addDmChannel } from "@stores/dm.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { setSidebarMode, rememberServerChannel } from "@stores/ui.store";

/** Jump to the Discord-style Home (DM) view, remembering the server channel we came from. */
export function enterDmView(): void {
  const st = channelsStore.getState();
  if (st.activeChannelId !== null && st.channels.has(st.activeChannelId)) {
    rememberServerChannel(st.activeChannelId);
  }
  setSidebarMode("dms");
}

/** Create or open a DM with a user and switch to it (jumps to the Home/DM view). */
export async function openDm(userId: number): Promise<void> {
  try {
    const r = await api.createDm(userId);
    addDmChannel({
      channelId: r.channel_id,
      recipient: {
        id: r.recipient.id,
        username: r.recipient.username,
        avatar: r.recipient.avatar,
        status: r.recipient.status,
      },
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      peerReadUpTo: 0,
    });
    enterDmView();
    setActiveChannel(r.channel_id);
  } catch { /* ignore */ }
}
