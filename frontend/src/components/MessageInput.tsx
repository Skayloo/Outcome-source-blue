import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useStoreState } from "@lib/useStore";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { Avatar } from "@components/Avatar";
import { composerStore, clearComposer } from "@stores/composer.store";
import { setTransientError } from "@stores/ui.store";
import { getActiveTarget } from "@lib/activeTarget";
import { api, ws, wsSend } from "@lib/services";
import { stopVoice } from "@lib/voicePlayer";
import { Icon } from "@lib/icons";
import { messagePreview } from "@lib/messagePreview";
import { EmojiPicker } from "@components/EmojiPicker";
import { t } from "@lib/i18n";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // matches the server's cap in UploadEndpoints

interface Pending { key: number; filename: string; progress: number; serverId: string | null }

export function MessageInput({ channelId }: { channelId?: number } = {}) {
  useStoreState(channelsStore);
  useStoreState(dmStore);
  useStoreState(composerStore);
  const ch = getActiveTarget(channelId);
  const composer = composerStore.getState();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Discord-style @mention autocomplete: the token being typed + which candidate is armed.
  const [mentionQ, setMentionQ] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionMembers = useStoreState(membersStore);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const keySeq = useRef(0);
  const dragDepth = useRef(0);
  // Voice recording (hooks must sit BEFORE the early return below).
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recStream = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (composer.editing) {
      setText(composer.editing.content);
      taRef.current?.focus();
    }
  }, [composer.editing?.id]);

  // Above the early return below on purpose: a hook placed after it is skipped on a
  // voice channel, and a render with a different hook count takes the whole tree down.
  // The grown height is inline style, and every path that empties the composer — send,
  // finishing an edit, Escape — has to undo it. One effect instead of a reset line per
  // branch, which is how the edit path came to be missing one.
  useEffect(() => {
    if (text === "" && taRef.current) taRef.current.style.height = "";
  }, [text]);

  if (!ch || ch.type === "voice") return <div className="message-input-wrap" />;

  function uploadFiles(files: FileList | File[]): void {
    for (const f of Array.from(files)) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setTransientError(t("chat.fileTooLarge", { name: f.name }));
        continue;
      }
      const key = keySeq.current++;
      setPending((p) => [...p, { key, filename: f.name, progress: 0, serverId: null }]);
      api.uploadFileWithProgress(f, (pct) => {
        setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: pct } : x)));
      })
        .then((r) => {
          setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: 100, serverId: r.id } : x)));
        })
        .catch(() => {
          setTransientError(t("chat.uploadFailed", { name: f.name }));
          setPending((p) => p.filter((x) => x.key !== key));
        });
    }
  }

  function submit() {
    const content = text.trim();
    if (composer.editing) {
      if (content) {
        wsSend("chat_edit", { message_id: composer.editing.id, content });
      }
      clearComposer();
      setText("");
      return;
    }
    if (pending.some((p) => p.serverId === null)) return; // wait for in-flight uploads
    const ready = pending.filter((p) => p.serverId !== null);
    if (!content && ready.length === 0) return;
    // Never silently destroy a message typed while the socket is down (reconnect backoff):
    // keep the text + attachments in the composer and tell the user.
    if (ws.getState() !== "connected") {
      setTransientError(t("chat.notConnected"));
      return;
    }
    const payload: Record<string, unknown> = {
      channel_id: ch!.id, content, attachments: ready.map((p) => p.serverId),
    };
    if (composer.replyTo) payload.reply_to = composer.replyTo.id;
    wsSend("chat_send", payload);
    setText("");
    setPending([]);
    clearComposer();
  }

  async function startRecording() {
    if (recording) return;
    stopVoice(); // recording a reply must silence the message being played
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStream.current = stream;
      recChunks.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) recChunks.current.push(e.data); };
      mr.start();
      recRef.current = mr;
      setRecElapsed(0);
      setRecording(true);
      const start = Date.now();
      recTimer.current = setInterval(() => setRecElapsed(Math.floor((Date.now() - start) / 1000)), 250);
    } catch {
      setTransientError(t("chat.micDenied"));
    }
  }

  function stopTracks() {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    recStream.current?.getTracks().forEach((tk) => tk.stop());
    recStream.current = null;
    recRef.current = null;
    setRecording(false);
  }

  function cancelRecording() {
    const mr = recRef.current;
    if (mr && mr.state !== "inactive") { mr.onstop = null; mr.stop(); }
    recChunks.current = [];
    stopTracks();
  }

  /** Stop, upload the clip to /uploads/voice, and send it as a (text-less) message. */
  function sendRecording() {
    const mr = recRef.current;
    if (!mr) return;
    if (ws.getState() !== "connected") { setTransientError(t("chat.notConnected")); cancelRecording(); return; }
    const chId = ch!.id;
    mr.onstop = () => {
      const blob = new Blob(recChunks.current, { type: mr.mimeType || "audio/webm" });
      recChunks.current = [];
      stopTracks();
      if (blob.size === 0) return;
      api.uploadVoice(blob)
        .then((r) => wsSend("chat_send", { channel_id: chId, content: "", attachments: [r.id] }))
        .catch(() => setTransientError(t("chat.voiceSendFailed")));
    };
    mr.stop();
  }

  function fmtRec(sec: number): string {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // "@par" before the caret → the candidate list; anything else closes it.
  const MENTION_TOKEN_RE = /(^|\s)@([\w.\-]{0,32})$/;
  function updateMention(ta: HTMLTextAreaElement): void {
    const upto = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const m = MENTION_TOKEN_RE.exec(upto);
    setMentionQ(m ? m[2]! : null);
    setMentionIdx(0);
  }
  const mentionCands = mentionQ === null
    ? []
    : [...mentionMembers.members.values()]
        .filter((u) => u.username.toLowerCase().startsWith(mentionQ.toLowerCase()))
        .slice(0, 8);
  function applyMention(username: string): void {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? text.length;
    const upto = text.slice(0, caret);
    const m = MENTION_TOKEN_RE.exec(upto);
    if (!m) return;
    const start = caret - m[2]!.length;
    const next = text.slice(0, start) + username + " " + text.slice(caret);
    setText(next);
    setMentionQ(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + username.length + 1;
      ta.setSelectionRange(pos, pos);
    });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionCands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionCands.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionCands.length) % mentionCands.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionCands[mentionIdx]!.username); return; }
      if (e.key === "Escape") { setMentionQ(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === "Escape") { clearComposer(); setText(""); return; }
    const now = Date.now();
    if (now - lastTyping.current > 3000) { lastTyping.current = now; wsSend("typing_start", { channel_id: ch!.id }); }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) uploadFiles(e.target.files);
    e.target.value = "";
  }

  function insertEmoji(emoji: string) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const pos = start + emoji.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  /**
   * A screenshot on the clipboard has no filename — the browser hands it over as a nameless
   * blob, so one is invented here. Without this, Ctrl+V in the composer did nothing at all,
   * which is the single most common way people share a screenshot.
   *
   * Only intercepts when the clipboard actually carries a file; pasting text stays the
   * browser's job.
   */
  function onPaste(e: ClipboardEvent<HTMLDivElement>): void {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
      .map((f) => (f.name && f.name !== "image.png"
        ? f
        : new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${f.type.split("/")[1] ?? "png"}`, { type: f.type })));
    if (files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  }
  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  const uploading = pending.some((p) => p.serverId === null);

  return (
    <div
      className={"message-input-wrap" + (dragOver ? " drag-over" : "")}
      onDrop={onDrop}
      onPaste={onPaste}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragOver && <div className="drop-hint">{t("chat.dropToUpload")}</div>}
      {composer.replyTo && (
        <div className="reply-bar visible">
          <Icon name="reply" size={17} />
          {/* The quoted line, not just the name: replying to someone who wrote five
              messages in a row is otherwise a coin flip about which one you hit. */}
          <div className="reply-quote">
            <span className="rq-author">{composer.replyTo.user.username}</span>
            <span className="rq-text">{messagePreview(composer.replyTo)}</span>
          </div>
          <button className="remove-btn" title={t("chat.cancel")} onClick={() => clearComposer()}>×</button>
        </div>
      )}
      {composer.editing && (
        <div className="edit-bar visible">
          <span className="edit-label">{t("chat.editingHint")}</span>
        </div>
      )}
      {pending.length > 0 && (
        <div className="attachment-preview-bar visible">
          {pending.map((p) => (
            <div className="attachment-preview" key={p.key}>
              <span className="att-name">{p.filename}</span>
              {p.serverId === null && (
                <span className="att-progress"><span className="att-progress-bar" style={{ width: `${p.progress}%` }} /></span>
              )}
              <button className="remove-btn" onClick={() => setPending((x) => x.filter((y) => y.key !== p.key))}>×</button>
            </div>
          ))}
        </div>
      )}
      {recording ? (
        <div className="message-input-box voice-recording">
          <span className="voice-rec-dot" />
          <span className="voice-rec-label">{t("chat.recording")} · {fmtRec(recElapsed)}</span>
          <div style={{ flex: 1 }} />
          <button className="input-btn" title={t("chat.cancel")} onClick={cancelRecording}><Icon name="trash-2" size={20} /></button>
          <button className="input-btn input-send" title={t("chat.send")} onClick={sendRecording}><Icon name="send" size={20} /></button>
        </div>
      ) : (
      <div className="message-input-box">
        <button className="input-btn" title={t("chat.attachFile")} onClick={() => fileRef.current?.click()}><Icon name="file-text" size={20} /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={onFile} />
        <textarea
          ref={taRef}
          className="msg-textarea"
          rows={1}
          placeholder={composer.editing ? t("chat.editMessagePlaceholder") : ch.type === "dm" ? t("chat.messageDm", { name: ch.name }) : t("chat.messageChannel", { name: ch.name })}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const ta = e.target;
            updateMention(ta);
            ta.style.height = "auto";
            ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
          }}
          onSelect={(e) => updateMention(e.currentTarget)}
          onKeyDown={onKey}
        />
        {mentionCands.length > 0 && (
          <div className="mention-pop">
            {mentionCands.map((u, i) => (
              <div
                key={u.id}
                className={"mention-item" + (i === mentionIdx ? " active" : "")}
                onMouseDown={(e) => { e.preventDefault(); applyMention(u.username); }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <Avatar username={u.username} avatar={u.avatar} size={20} color="#8b5cf6" />
                <span>{u.username}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ position: "relative", display: "inline-flex" }}>
          <button className="input-btn" title={t("chat.emoji")} onClick={() => setEmojiOpen((o) => !o)}><Icon name="smile" size={20} /></button>
          {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
        </div>
        {/* Mic when there's nothing to send yet; the send arrow once there's text or an upload. */}
        {text.trim().length === 0 && pending.length === 0 && !composer.editing ? (
          <button className="input-btn" title={t("chat.recordVoice")} onClick={startRecording}><Icon name="mic" size={20} /></button>
        ) : (
          <button className="input-btn input-send" title={uploading ? t("chat.waitingForUpload") : t("chat.send")} onClick={submit} disabled={uploading}><Icon name="send" size={20} /></button>
        )}
      </div>
      )}
    </div>
  );
}
