import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@lib/icons";
import { assetUrl } from "@lib/serverHost";
import { Avatar } from "@components/Avatar";
import { VoiceMessage } from "@components/VoiceMessage";
import { EmojiPicker } from "@components/EmojiPicker";
import { useStoreState } from "@lib/useStore";
import { channelsStore } from "@stores/channels.store";
import { messagesStore, getChannelMessages, isChannelLoaded, setMessages, setMessagePinned, type Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { dmStore } from "@stores/dm.store";
import { setReply, setEditing } from "@stores/composer.store";
import { prompt } from "@components/ConfirmDialog";
import { setTransientSuccess, setTransientError } from "@stores/ui.store";
import { api, wsSend } from "@lib/services";
import { ForwardModal } from "@components/ForwardModal";
import { UserProfileModal } from "@components/UserProfileModal";
import { messagePreview } from "@lib/messagePreview";
import { markListenedBulk, markListenedByOthersBulk } from "@stores/listened.store";
import { roleColor, formatTime, formatDayDivider, sameDay, formatFileSize } from "@lib/format";
import { linkify, imageUrlsIn } from "@lib/linkify";
import { openLightbox } from "@stores/lightbox.store";
import { loadPref } from "@components/settings/helpers";
import { t } from "@lib/i18n";

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const isImage = (mime: string) => mime.startsWith("image/");
/** A voice message: audio attachment carrying the transcoder's duration/waveform. */
const isVoice = (att: { mime: string; duration_ms?: number }) => att.mime.startsWith("audio/") && att.duration_ms != null;

export function MessageList({ channelId: forced }: { channelId?: number } = {}) {
  useStoreState(messagesStore);
  useStoreState(membersStore);
  const ch = useStoreState(channelsStore);
  const channelId = forced ?? ch.activeChannelId;
  const containerRef = useRef<HTMLDivElement>(null);

  // Viewing a channel reads it: advance the server-side marker on open and again when
  // the window regains focus, so badges clear on every device (Telegram behaviour).
  useEffect(() => {
    if (channelId == null) return;
    wsSend("read", { channel_id: channelId });
    const onFocus = (): void => { wsSend("read", { channel_id: channelId }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [channelId]);

  useEffect(() => {
    if (channelId == null || isChannelLoaded(channelId)) return;
    let cancelled = false;
    api.getMessages(channelId, { limit: 50 })
      .then((resp) => {
        if (cancelled) return;
        const msgs = resp.messages;
        setMessages(channelId, msgs, resp.has_more);
        // Seed the listened-sets from history (per-user flags the REST layer computes).
        markListenedBulk(msgs.flatMap((m) => m.attachments.filter((a) => a.listened).map((a) => a.id)));
        markListenedByOthersBulk(msgs.flatMap((m) => m.attachments.filter((a) => a.listened_by_others).map((a) => a.id)));
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [channelId]);

  const messages = channelId != null ? getChannelMessages(channelId) : [];
  // A DM is a conversation between two people; either of them may delete anything in it.
  const isDm = channelId != null
    && dmStore.getState().channels.some((d) => d.channelId === channelId);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // Telegram behaviour: clicking a quoted reply scrolls to its source and flashes it.
  const [flashId, setFlashId] = useState<number | null>(null);
  // Forward: Telegram-style centered dialog with search over every chat.
  const [fwdFor, setFwdFor] = useState<Message | null>(null);
  // Clicking whoever wrote a line opens them — the same door the mobile app has.
  const [profile, setProfile] = useState<{ id: number; username: string; avatar: string | null } | null>(null);
  function jumpToMessage(id: number): void {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return; // source not loaded (deep history)
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1700);
  }
  // "Text & Images" settings: inline previews for image URLs in message text.
  const showInlineMedia = loadPref("inlineMedia", true) && loadPref("showLinkPreviews", true);

  // Track whether the user is reading near the bottom — new messages must not yank the
  // view down while they're scrolled up reading history. Channel switches always snap.
  const nearBottomRef = useRef(true);
  const lastChannelRef = useRef<number | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const channelSwitched = lastChannelRef.current !== channelId;
    lastChannelRef.current = channelId;
    if (channelSwitched || nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, channelId]);

  if (channelId == null) return <div className="messages-container" ref={containerRef} />;

  const me = authStore.getState().user;
  const members = membersStore.getState().members;
  const colorFor = (userId: number) => roleColor(members.get(userId)?.role);
  // Mentions: only names that resolve to a real member get the highlight.
  const mentionNames = new Set([...members.values()].map((u) => u.username.toLowerCase()));
  const selfName = me?.username?.toLowerCase() ?? null;
  const linkOpts = { isMention: (n: string) => mentionNames.has(n.toLowerCase()), selfName };
  // Own-message ticks (Telegram model): one check = sent, two = read by someone else.
  const dmPeerRead = isDm
    ? (dmStore.getState().channels.find((d) => d.channelId === channelId)?.peerReadUpTo ?? 0)
    : 0;
  const chOthersRead = !isDm ? (ch.channels.get(channelId ?? -1)?.othersReadUpTo ?? 0) : 0;
  const readUpTo = isDm ? dmPeerRead : chOthersRead;
  const ticks = (m: Message): React.ReactNode => (
    <span className={"msg-ticks" + (m.id <= readUpTo ? " read" : "")}>{m.id <= readUpTo ? "✓✓" : "✓"}</span>
  );
  const mentionsMe = (content: string): boolean =>
    selfName != null && new RegExp(`@${selfName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w.\\-])`, "i").test(content);
  const react = (m: Message, emoji: string, mine: boolean) =>
    wsSend(mine ? "reaction_remove" : "reaction_add", { message_id: m.id, emoji });
  const byId = (id: number) => messages.find((x) => x.id === id);
  /** File a report: the reason is optional context for the moderator; the server snapshots
   *  the message content itself, so an edit or delete afterwards can't scrub the evidence. */
  async function reportMessage(m: Message) {
    const reason = await prompt({
      title: t("chat.reportTitle"),
      message: t("chat.reportBody", { name: m.user.username }),
      highlight: m.user.username,
      confirmLabel: t("chat.reportSubmit"),
      danger: true,
      input: { placeholder: t("chat.reportPlaceholder"), maxLength: 1000 },
    });
    if (reason === null) return;
    try {
      await api.reportMessage(m.id, reason);
      setTransientSuccess(t("chat.reportSent"));
    } catch (e) {
      setTransientError(e instanceof Error ? e.message : t("chat.reportFailed"));
    }
  }

  async function togglePin(m: Message) {
    if (channelId == null) return;
    try {
      if (m.pinned) await api.unpinMessage(channelId, m.id);
      else await api.pinMessage(channelId, m.id);
      setMessagePinned(channelId, m.id, !m.pinned);
    } catch { /* ignore */ }
  }

  const rows: ReactNode[] = [];
  let prev: Message | null = null;
  for (const m of messages) {
    if (m.deleted) { prev = null; continue; }

    if (!prev || !sameDay(prev.timestamp, m.timestamp)) {
      rows.push(
        <div className="msg-day-divider" key={`day-${m.id}`}>
          <span className="line" /><span className="date">{formatDayDivider(m.timestamp)}</span><span className="line" />
        </div>,
      );
      prev = null;
    }
    const grouped = !!prev && prev.user.id === m.user.id &&
      new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() < GROUP_WINDOW_MS;

    const own = me?.id === m.user.id;
    const replyRef = m.replyTo != null && (() => {
      const parent = byId(m.replyTo);
      // Parent missing (not loaded / purged) or soft-deleted → show the deleted placeholder.
      if (!parent || parent.deleted) {
        return (
          <div className="msg-reply-ref">
            <span className="rr-text rr-deleted">{t("chat.deletedMessage")}</span>
          </div>
        );
      }
      return (
        <div className="msg-reply-ref" onClick={() => jumpToMessage(parent.id)}>
          <span className="rr-author" style={{ color: colorFor(parent.user.id) }}>{parent.user.username}</span>
          <span className="rr-text">{messagePreview(parent)}</span>
        </div>
      );
    })();

    const body = (
      <>
        {m.forwardedFrom && (
          <div className="msg-fwd"><Icon name="arrow-right" size={12} /> {t("chat.forwardedFrom", { name: m.forwardedFrom })}</div>
        )}
        {m.content && (
          <div className="msg-text">{linkify(m.content, linkOpts)}{m.editedAt && <span className="msg-edited"> {t("chat.edited")}</span>}</div>
        )}

        {showInlineMedia && m.content && imageUrlsIn(m.content).map((u) => (
          <div className="msg-image" key={u}>
            <img src={u} alt="" loading="lazy" onClick={() => openLightbox(u)} style={{ maxWidth: 400, maxHeight: 320, borderRadius: 8, display: "block", cursor: "zoom-in" }} />
          </div>
        ))}

        {m.attachments.map((att) => isVoice(att) ? (
          <VoiceMessage key={att.id} att={att} channelId={m.channelId} messageId={m.id} sender={m.user.username} own={own} />
        ) : isImage(att.mime) ? (
          <div className="msg-image" key={att.id}>
            <img src={assetUrl(att.url)} alt={att.filename} onClick={() => openLightbox(assetUrl(att.url), att.filename)} style={{ maxWidth: 400, maxHeight: 320, borderRadius: 8, display: "block", cursor: "zoom-in" }} />
          </div>
        ) : (
          <div className="msg-file" key={att.id}>
            <div className="msg-file-inner">
              <div className="msg-file-icon">📄</div>
              <div>
                <div className="msg-file-name">{att.filename}</div>
                <div className="msg-file-size">{formatFileSize(att.size)}</div>
              </div>
              <a className="msg-file-download" href={assetUrl(att.url)} download={att.filename} title={t("chat.download")}>⤓</a>
            </div>
          </div>
        ))}

        {m.reactions.length > 0 && (
          <div className="msg-reactions">
            {m.reactions.map((r) => (
              <div className={"reaction-chip" + (r.me ? " me" : "")} key={r.emoji} onClick={() => react(m, r.emoji, r.me)}>
                <span>{r.emoji}</span><span className="rc-count">{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );

    const actions = (
      <div className="msg-actions-bar">
          <div style={{ position: "relative", display: "inline-flex" }}>
            <button title={t("chat.react")} onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}><Icon name="smile" size={16} /></button>
            {pickerFor === m.id && (
              <EmojiPicker
                onPick={(emoji) => { react(m, emoji, false); setPickerFor(null); }}
                onClose={() => setPickerFor(null)}
              />
            )}
          </div>
          <button title={t("chat.reply")} onClick={() => setReply(m)}><Icon name="reply" size={16} /></button>
          <button title={t("chat.forward")} onClick={() => setFwdFor(m)}><Icon name="arrow-right" size={16} /></button>
          {me?.id !== m.user.id && (
            <button title={t("chat.report")} onClick={() => reportMessage(m)}><Icon name="flag" size={16} /></button>
          )}
          <button title={m.pinned ? t("chat.unpin") : t("chat.pin")} onClick={() => togglePin(m)}><Icon name={m.pinned ? "pin-off" : "pin"} size={16} /></button>
          {me?.id === m.user.id && (
            <button title={t("chat.edit")} onClick={() => setEditing(m)}><Icon name="pencil" size={16} /></button>
          )}
          {/* In a DM either party may delete anything — it is their conversation, and the
              server erases the row for both. Elsewhere: own messages only (moderators are
              gated by the server's ManageMessages check, not by this button). */}
          {(me?.id === m.user.id || isDm) && (
            <button title={t("chat.delete")} onClick={() => wsSend("chat_delete", { message_id: m.id })}><Icon name="trash-2" size={16} /></button>
          )}
      </div>
    );

    rows.push(
      isDm ? (
        // Telegram-style DM: mine right (accent bubble), theirs left (surface bubble +
        // avatar), a small translucent time hugging the bubble's inner side.
        <div id={`msg-${m.id}`} className={"message dm-row" + (own ? " own" : " theirs") + (grouped ? " grouped" : "") + (pickerFor === m.id ? " picker-open" : "") + (flashId === m.id ? " flash" : "") + (!own && mentionsMe(m.content) ? " mention-me" : "")} key={m.id}>
          {!own && (grouped
            ? <span className="dm-ava-spacer" />
            : <Avatar username={m.user.username} avatar={m.user.avatar} size={30} color={colorFor(m.user.id)} className="dm-ava" />)}
          {own && <span className="dm-time" title={new Date(m.timestamp).toLocaleString()}>{ticks(m)}{formatTime(m.timestamp)}</span>}
          <div className="dm-bubble">
            {replyRef}
            {body}
          </div>
          {!own && <span className="dm-time" title={new Date(m.timestamp).toLocaleString()}>{formatTime(m.timestamp)}</span>}
          {actions}
        </div>
      ) : (
        <div id={`msg-${m.id}`} className={"message" + (grouped ? " grouped" : "") + (pickerFor === m.id ? " picker-open" : "") + (flashId === m.id ? " flash" : "") + (!own && mentionsMe(m.content) ? " mention-me" : "")} key={m.id}>
          {replyRef}
          {!grouped
            ? <Avatar username={m.user.username} avatar={m.user.avatar} size={40} color={colorFor(m.user.id)} className="msg-avatar" />
            : <span className="msg-hover-time">{formatTime(m.timestamp)}</span>}
          {!grouped && (
            <div className="msg-header">
              <span className="msg-author clickable" style={{ color: colorFor(m.user.id) }}
                onClick={() => setProfile({ id: m.user.id, username: m.user.username, avatar: m.user.avatar })}
              >{m.user.username}</span>
              <span className="msg-time" title={new Date(m.timestamp).toLocaleString()}>{formatTime(m.timestamp)}{own && ticks(m)}</span>
            </div>
          )}
          {body}
          {actions}
        </div>
      ),
    );
    prev = m;
  }

  return (
    <div
      className="messages-container"
      ref={containerRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {rows.length === 0 ? (
        <div className="channel-welcome">
          <div className="channel-welcome-icon">#</div>
          <div className="channel-welcome-title">{t("chat.welcomeTitle")}</div>
          <div className="channel-welcome-text">{t("chat.welcomeText")}</div>
        </div>
      ) : rows}
      {fwdFor && <ForwardModal message={fwdFor} onClose={() => setFwdFor(null)} />}
      {profile && (
        <UserProfileModal
          userId={profile.id}
          username={profile.username}
          avatar={profile.avatar}
          onClose={() => setProfile(null)}
        />
      )}
    </div>
  );
}
