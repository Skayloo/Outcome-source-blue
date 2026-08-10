import { useStoreState } from "@lib/useStore";
import { membersStore, getTypingUsers } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { t } from "@lib/i18n";

export function TypingIndicator({ channelId }: { channelId?: number } = {}) {
  useStoreState(membersStore);
  const ch = useStoreState(channelsStore);
  const id = channelId ?? ch.activeChannelId;
  if (id == null) return <div className="typing-slot" style={{ height: 18 }} />;

  const typing = getTypingUsers(id);
  let text = "";
  if (typing.length === 1) text = t("chat.typingOne", { name: typing[0]!.username });
  else if (typing.length > 1 && typing.length <= 3) text = t("chat.typingSome", { names: typing.map((u) => u.username).join(", ") });
  else if (typing.length > 3) text = t("chat.typingMany");

  return (
    <div className="typing-slot" style={{ height: 18, padding: "0 16px", fontSize: 12, color: "var(--text-muted)", lineHeight: "18px" }}>
      {text}
    </div>
  );
}
