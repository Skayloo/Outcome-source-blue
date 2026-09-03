import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@lib/icons";
import { assetUrl, assetUrlSmall, assetUrlMedium } from "@lib/serverHost";
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

  // Read the flag during render, not inside the effect, and depend on it: unlocking E2EE
  // clears the loaded set to force a refetch, and with [channelId] alone the OPEN channel
  // never noticed — the history you were looking at stayed as lock placeholders until a
  // reload. The component already re-renders on this store, so the flag flipping is enough.
  const channelLoaded = channelId != null && isChannelLoaded(channelId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setLoadError(null); }, [channelId]);
  useEffect(() => {
    if (channelId == null || channelLoaded) return;
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
      // A swallowed failure leaves an EMPTY channel with no way to tell it apart from one
      // that has nothing in it — which is exactly what "I joined and there is no history"
      // looks like from the inside. Say so, and let it be tried again.
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [channelId, channelLoaded, retry]);

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
  // Whether the view should be glued to the end. Set when a chat opens and held until the
  // reader scrolls away themselves — WITHOUT it, opening a busy chat drops you into the
  // middle: the scroll is set while the pictures and avatars are still zero-height, every one
  // that loads pushes the end further down, and the position that was the bottom a moment ago
  // is now nowhere near it.
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const toBottom = (smooth = false) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const channelSwitched = lastChannelRef.current !== channelId;
    lastChannelRef.current = channelId;
    if (channelSwitched) { stickRef.current = true; setShowJump(false); }
    if (channelSwitched || nearBottomRef.current) toBottom();
  }, [messages.length, channelId]);

  // Re-pin on every size change while glued. A picture finishing its download is a size
  // change, and it is the one that used to leave the reader halfway up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (stickRef.current) toBottom(); });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [channelId, messages.length]);

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

        {/* Pictures are laid out together, as one album — the phone does it and a column of
            separate framed thumbnails is not what "sent five photos" looks like anywhere.
            One picture keeps its own proportions and fills the bubble. */}
        {(() => {
          const imgs = m.attachments.filter((a) => isImage(a.mime));
          if (imgs.length === 0) return null;
          // The viewer gets the WHOLE album and opens on the one that was clicked, so several
          // pictures are browsed in place instead of opened and closed one at a time.
          const album = imgs.map((a) => ({
            url: assetUrlMedium(a.url)!, alt: a.filename,
            thumb: assetUrlSmall(a.url), full: assetUrl(a.url),
          }));
          if (imgs.length === 1) {
            const a = imgs[0]!;
            return (
              <div className="msg-photo" key={a.id}>
                {/* Preview in the list, full size only when it is opened. */}
                <img src={assetUrlSmall(a.url)} alt={a.filename} loading="lazy"
                  onClick={() => openLightbox(album, 0)} />
              </div>
            );
          }
          // The grid is derived from the count, not chosen from a list of cases: a square-ish
          // arrangement, never wider than three, which holds for two pictures and for ten
          // without a rule per number. A single leftover on the last row spans it rather than
          // sitting in one column with a hole beside it.
          // Three columns only when they divide evenly or leave exactly one over — otherwise
          // two, which always does. That is what keeps the last row from ending in a hole at
          // any count, and why there is no case list here. Up to four, two columns keep the
          // pictures big enough to make out.
          const cols = imgs.length <= 4 ? 2 : imgs.length % 3 <= 1 ? 3 : 2;
          const orphan = imgs.length % cols === 1 ? imgs.length - 1 : -1;
          return (
            <div className="msg-album" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
              {imgs.map((a, i) => (
                <img key={a.id} src={assetUrlSmall(a.url)} alt={a.filename} loading="lazy"
                  style={i === orphan ? { gridColumn: `span ${cols}`, aspectRatio: `${cols * 1.15} / 1` } : undefined}
                  onClick={() => openLightbox(album, i)} />
              ))}
            </div>
          );
        })()}

        {m.attachments.filter((a) => !isImage(a.mime)).map((att) => isVoice(att) ? (
          <VoiceMessage key={att.id} att={att} channelId={m.channelId} messageId={m.id} sender={m.user.username} own={own} />
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
      // One layout everywhere. Channels used to be a flat Discord-style list while DMs were
      // bubbles; the phone has always been bubbles for both, and two different chats in one
      // product is just two things to keep in sync. A channel adds the author's name inside
      // the bubble, which a DM does not need — there are only two people in it.
      <div id={`msg-${m.id}`} className={"message dm-row" + (own ? " own" : " theirs") + (grouped ? " grouped" : "") + (pickerFor === m.id ? " picker-open" : "") + (flashId === m.id ? " flash" : "") + (!own && mentionsMe(m.content) ? " mention-me" : "")} key={m.id}>
        {!own && (grouped
          ? <span className="dm-ava-spacer" />
          : <Avatar username={m.user.username} avatar={m.user.avatar} size={30} color={colorFor(m.user.id)} className="dm-ava" />)}
        {own && <span className="dm-time" title={new Date(m.timestamp).toLocaleString()}>{ticks(m)}{formatTime(m.timestamp)}</span>}
        <div className={"dm-bubble" + (
          !m.content.trim() && m.attachments.length > 0 && m.attachments.every((a) => isImage(a.mime))
            ? " photo-only" : "")}>
          {!isDm && !own && !grouped && (
            <div className="dm-author clickable" style={{ color: colorFor(m.user.id) }}
              onClick={() => setProfile({ id: m.user.id, username: m.user.username, avatar: m.user.avatar })}
            >{m.user.username}</div>
          )}
          {replyRef}
          {body}
        </div>
        {!own && <span className="dm-time" title={new Date(m.timestamp).toLocaleString()}>{formatTime(m.timestamp)}</span>}
        {actions}
      </div>,
    );
    prev = m;
  }

  return (
    <div
      className="messages-container"
      ref={containerRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        nearBottomRef.current = fromBottom < 80;
        // Scrolling away is the reader taking over; nothing re-pins until they come back.
        stickRef.current = fromBottom < 80;
        setShowJump(fromBottom > 400);
      }}
    >
      {loadError !== null ? (
        <div className="channel-welcome">
          <div className="channel-welcome-icon"><Icon name="triangle-alert" size={28} /></div>
          <div className="channel-welcome-title">{t("chat.historyFailed")}</div>
          <div className="channel-welcome-text">{loadError}</div>
          <button className="btn-primary" style={{ marginTop: 12 }}
            onClick={() => { setLoadError(null); setRetry((n) => n + 1); }}>
            {t("chat.retry")}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="channel-welcome">
          <div className="channel-welcome-icon">#</div>
          <div className="channel-welcome-title">{t("chat.welcomeTitle")}</div>
          <div className="channel-welcome-text">{t("chat.welcomeText")}</div>
        </div>
      ) : rows}
      {showJump && (
        <button className="jump-to-end" title={t("chat.jumpToEnd")}
          onClick={() => { stickRef.current = true; setShowJump(false); toBottom(true); }}>
          <Icon name="chevron-down" size={20} />
        </button>
      )}
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
