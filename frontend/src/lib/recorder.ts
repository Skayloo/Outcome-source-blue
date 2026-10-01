/**
 * Recording a call on THIS computer (W3GWG-25 stage 4).
 *
 * Red is end-to-end encrypted, so the server never holds the media and cannot record anything;
 * the recording is made here, from what this client already decrypts and plays. What the server
 * does govern is the announcement: a recording starts only after it has checked RecordCalls and
 * put "rec" on our LiveKit sessions (voice_record → voice_record_ok), which every participant —
 * guests included — sees as "● recording — <name>" until we stop or leave.
 *
 * Modes, as the owner agreed them:
 *   audio    — every voice in the room, mixed: one audio file;
 *   video    — the stage as the recorder sees it (screen share large, people as tiles): one video;
 *   both     — the two in one file;
 *   separate — the two as two files.
 *
 * Where the browser lets a page write to a file it was handed (File System Access: Chromium and
 * the desktop shell), chunks go to disk as they are made, so an hour-long call does not sit in
 * memory and a full disk is a reported error, not a crash. Elsewhere the recording is kept in
 * memory and downloaded at the end.
 *
 * And then it goes to the room's chat (the owner's rule): uploaded in parts and posted in the
 * voice room's attached text channel, where everyone can watch or download it. MP4 is preferred
 * where the browser can write it — an iPhone plays MP4 and not WebM.
 */
import { RoomEvent, Track, type Room, type Participant, type RemoteTrack } from "livekit-client";
import { createStore } from "@lib/store";
import { wsSend } from "@lib/services";
import { getVoiceRoom } from "@lib/livekitSession";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { api } from "@lib/services";
import { setTransientError, setTransientSuccess } from "@stores/ui.store";
import { t } from "@lib/i18n";
import { createLogger } from "@lib/logger";
import type { VoiceRecordOkPayload } from "@lib/types";

const log = createLogger("recorder");

export type RecordMode = "audio" | "video" | "both" | "separate";

interface RecorderState {
  readonly active: { readonly mode: RecordMode; readonly startedAt: number; readonly channelId: number } | null;
  readonly busy: boolean;
  /** Posting the finished recording to the room's chat: 0..1, or null. */
  readonly uploading: number | null;
}
export const recorderStore = createStore<RecorderState>({ active: null, busy: false, uploading: null }, true);

// ── where the bytes go ───────────────────────────────────────────────────────────────────

interface Sink {
  readonly name: string;
  readonly mime: string;
  write(chunk: Blob): Promise<void>;
  /** Finish the file; returns it (disk-backed where it was written to disk) for the chat. */
  close(): Promise<Blob | null>;
}

type SaveHandle = {
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
  getFile?(): Promise<File>;
};
type FsWindow = {
  showSaveFilePicker?: (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;
  showDirectoryPicker?: (o?: { mode?: "readwrite" }) => Promise<{ getFileHandle(n: string, o: { create: boolean }): Promise<SaveHandle> }>;
};

async function fileSink(handle: SaveHandle, name: string, mime: string): Promise<Sink> {
  const w = await handle.createWritable();
  return {
    name, mime,
    write: (b) => w.write(b),
    close: async () => {
      await w.close();
      // Read back from disk for the upload: a File here is a handle on the file, not a copy.
      return handle.getFile ? await handle.getFile() : null;
    },
  };
}

function memorySink(name: string, type: string): Sink {
  const chunks: Blob[] = [];
  return {
    name, mime: type,
    write: async (b) => { chunks.push(b); },
    close: async () => {
      const blob = new Blob(chunks, { type });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return blob;
    },
  };
}

function pickMime(kind: "audio" | "video"): { mime: string; ext: string } {
  // MP4 first: it is what an iPhone can play from the chat. Chromium writes it from 126 on;
  // where it cannot, WebM.
  const candidates: [string, string][] = kind === "audio"
    ? [["audio/mp4;codecs=mp4a.40.2", "m4a"], ["audio/mp4", "m4a"], ["audio/webm;codecs=opus", "webm"], ["audio/webm", "webm"]]
    : [["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "mp4"], ["video/mp4;codecs=avc1,mp4a", "mp4"], ["video/mp4", "mp4"],
       ["video/webm;codecs=vp9,opus", "webm"], ["video/webm;codecs=vp8,opus", "webm"], ["video/webm", "webm"]];
  for (const [mime, ext] of candidates) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  return { mime: "", ext: kind === "audio" ? "webm" : "webm" };
}

function baseName(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `outcome-call-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** Where to write, asked BEFORE anything else: the pickers only open from inside the click. Null
 *  when the person closed the picker. */
async function openSinks(mode: RecordMode, audio: { mime: string; ext: string }, video: { mime: string; ext: string }): Promise<{ a?: Sink; v?: Sink } | null> {
  const fs = window as unknown as FsWindow;
  const base = baseName();
  const names = {
    a: `${base}${mode === "separate" ? "-audio" : ""}.${audio.ext}`,
    v: `${base}${mode === "separate" ? "-video" : ""}.${video.ext}`,
  };
  try {
    if (mode === "separate" && fs.showDirectoryPicker) {
      const dir = await fs.showDirectoryPicker({ mode: "readwrite" });
      return {
        a: await fileSink(await dir.getFileHandle(names.a, { create: true }), names.a, audio.mime || "audio/webm"),
        v: await fileSink(await dir.getFileHandle(names.v, { create: true }), names.v, video.mime || "video/webm"),
      };
    }
    if (mode !== "separate" && fs.showSaveFilePicker) {
      const kind = mode === "audio" ? "a" : "v";
      const handle = await fs.showSaveFilePicker({ suggestedName: names[kind] });
      return kind === "a"
        ? { a: await fileSink(handle, names.a, audio.mime || "audio/webm") }
        : { v: await fileSink(handle, names.v, video.mime || "video/webm") };
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null; // closed the picker
    log.warn("file picker unavailable, keeping the recording in memory", e);
  }
  return {
    ...(mode !== "video" && mode !== "both" ? { a: memorySink(names.a, audio.mime || "audio/webm") } : {}),
    ...(mode !== "audio" ? { v: memorySink(names.v, video.mime || "video/webm") } : {}),
  };
}

// ── what is recorded ─────────────────────────────────────────────────────────────────────

/** Every voice in the room into one stream: our microphone plus each remote audio track, joined
 *  as people arrive. Decrypted already — this is what the speakers play. */
function mixAudio(room: Room): { stream: MediaStream; stop: () => void } {
  const ctx = new AudioContext();
  void ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const sources = new Map<string, MediaStreamAudioSourceNode>();
  const add = (track: MediaStreamTrack | undefined): void => {
    if (track === undefined || track.kind !== "audio" || sources.has(track.id)) return;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(dest);
    sources.set(track.id, src);
  };
  const drop = (track: MediaStreamTrack | undefined): void => {
    if (track === undefined) return;
    sources.get(track.id)?.disconnect();
    sources.delete(track.id);
  };
  add(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack);
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) add(pub.track?.mediaStreamTrack);
  }
  const onSub = (track: RemoteTrack): void => add(track.mediaStreamTrack);
  const onUnsub = (track: RemoteTrack): void => drop(track.mediaStreamTrack);
  const onLocal = (): void => add(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack);
  room.on(RoomEvent.TrackSubscribed, onSub);
  room.on(RoomEvent.TrackUnsubscribed, onUnsub);
  room.on(RoomEvent.LocalTrackPublished, onLocal);
  return {
    stream: dest.stream,
    stop: () => {
      room.off(RoomEvent.TrackSubscribed, onSub);
      room.off(RoomEvent.TrackUnsubscribed, onUnsub);
      room.off(RoomEvent.LocalTrackPublished, onLocal);
      for (const s of sources.values()) s.disconnect();
      void ctx.close();
    },
  };
}

const W = 1280;
const H = 720;
const FPS = 24;

function tint(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

/** The stage, drawn: a screen share large with everyone in a strip under it, or everyone in a
 *  grid — camera where there is one, initials where there is not, a green ring on whoever talks. */
function drawStage(room: Room): { stream: MediaStream; stop: () => void } {
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d")!;
  const videos = new Map<string, HTMLVideoElement>();
  const videoFor = (track: MediaStreamTrack): HTMLVideoElement => {
    let v = videos.get(track.id);
    if (v === undefined) {
      v = Object.assign(document.createElement("video"), { muted: true, playsInline: true, autoplay: true });
      v.srcObject = new MediaStream([track]);
      void v.play().catch(() => {});
      videos.set(track.id, v);
    }
    return v;
  };
  const trackOf = (p: Participant, source: Track.Source): MediaStreamTrack | undefined => {
    const pub = p.getTrackPublication(source);
    return pub && !pub.isMuted ? pub.track?.mediaStreamTrack : undefined;
  };
  const fit = (v: HTMLVideoElement, x: number, y: number, w: number, h: number, cover: boolean): void => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const s = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    g.restore();
  };
  const tile = (p: Participant, x: number, y: number, w: number, h: number): void => {
    const name = (p.name || p.identity).replace(/\s*\(guest\)$/, "");
    g.fillStyle = "#1e1f22";
    g.fillRect(x, y, w, h);
    const cam = trackOf(p, Track.Source.Camera);
    if (cam) fit(videoFor(cam), x, y, w, h, true);
    else {
      const r = Math.min(w, h) * 0.22;
      g.fillStyle = tint(name);
      g.beginPath(); g.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#fff";
      g.font = `600 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(name.slice(0, 2).toUpperCase(), x + w / 2, y + h / 2);
    }
    if (p.isSpeaking) { g.strokeStyle = "#3ba55d"; g.lineWidth = 4; g.strokeRect(x + 2, y + 2, w - 4, h - 4); }
    g.font = "500 16px system-ui, sans-serif";
    g.textAlign = "left"; g.textBaseline = "bottom";
    const label = name.length > 24 ? `${name.slice(0, 23)}…` : name;
    g.fillStyle = "rgba(0,0,0,.55)";
    g.fillRect(x + 8, y + h - 30, g.measureText(label).width + 14, 22);
    g.fillStyle = "#fff";
    g.fillText(label, x + 15, y + h - 12);
  };

  const frame = (): void => {
    const people: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const shares = people.map((p) => trackOf(p, Track.Source.ScreenShare)).filter((x): x is MediaStreamTrack => x !== undefined);
    g.fillStyle = "#111214";
    g.fillRect(0, 0, W, H);
    if (shares.length > 0) {
      const strip = people.length > 0 ? 150 : 0;
      fit(videoFor(shares[0]!), 0, 0, W, H - strip, false);
      const tw = Math.min(220, (W - 8) / Math.max(people.length, 1) - 8);
      people.forEach((p, i) => tile(p, 8 + i * (tw + 8), H - strip + 10, tw, strip - 20));
    } else {
      const n = Math.max(people.length, 1);
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const pad = 8;
      const tw = (W - pad * (cols + 1)) / cols;
      const th = (H - pad * (rows + 1)) / rows;
      people.forEach((p, i) => tile(p, pad + (i % cols) * (tw + pad), pad + Math.floor(i / cols) * (th + pad), tw, th));
    }
  };
  frame();
  // A timer, not requestAnimationFrame: rAF stops altogether in a hidden tab, and a recording
  // that freezes whenever its window is covered is not a recording. Timers are throttled there
  // too, so a covered tab records at a lower frame rate — but it keeps recording.
  const timer = window.setInterval(frame, 1000 / FPS);
  return {
    stream: canvas.captureStream(FPS),
    stop: () => {
      window.clearInterval(timer);
      for (const v of videos.values()) { v.pause(); v.srcObject = null; }
    },
  };
}

// ── the session ──────────────────────────────────────────────────────────────────────────

interface Running {
  recorders: MediaRecorder[];
  sinks: Sink[];
  stops: (() => void)[];
  failed: boolean;
  unwatch: () => void;
}
let running: Running | null = null;

let ackWaiter: { channelId: number; resolve: (ok: boolean) => void } | null = null;

/** voice_record_ok, from the dispatcher: the room has been told. */
export function onRecordAck(p: VoiceRecordOkPayload): void {
  if (p.on && ackWaiter !== null && ackWaiter.channelId === p.channel_id) {
    ackWaiter.resolve(true);
    ackWaiter = null;
  }
}

function announce(channelId: number): Promise<boolean> {
  return new Promise((resolve) => {
    ackWaiter = { channelId, resolve };
    wsSend("voice_record", { channel_id: channelId, on: true });
    // A refusal arrives as an ordinary error frame (shown by the dispatcher), so silence past
    // this point means no.
    window.setTimeout(() => {
      if (ackWaiter?.resolve === resolve) { ackWaiter = null; resolve(false); }
    }, 6000);
  });
}

export async function startRecording(mode: RecordMode): Promise<void> {
  const channelId = voiceStore.getState().currentChannelId;
  const room = getVoiceRoom();
  if (channelId === null || room === null || running !== null || recorderStore.getState().busy) return;
  if (typeof MediaRecorder === "undefined") { setTransientError(t("rec.unsupported")); return; }
  recorderStore.setState((s) => ({ ...s, busy: true }));
  try {
    const audioType = pickMime("audio");
    const videoType = pickMime("video");
    const sinks = await openSinks(mode, audioType, videoType);
    if (sinks === null) return;
    if (!(await announce(channelId))) {
      for (const s of [sinks.a, sinks.v]) await s?.close().catch(() => {});
      return;
    }

    const stops: (() => void)[] = [];
    const recorders: MediaRecorder[] = [];
    const audio = mode !== "video" ? mixAudio(room) : null;
    const video = mode !== "audio" ? drawStage(room) : null;
    if (audio) stops.push(audio.stop);
    if (video) stops.push(video.stop);

    const state: Running = { recorders, sinks: [sinks.a, sinks.v].filter((s): s is Sink => s !== undefined), stops, failed: false, unwatch: () => {} };
    const record = (stream: MediaStream, mime: string, sink: Sink): void => {
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        sink.write(e.data).catch((err: unknown) => {
          log.error("writing the recording failed", err);
          if (!state.failed) {
            state.failed = true;
            setTransientError(t("rec.writeFailed"));
            void stopRecording();
          }
        });
      };
      rec.onerror = () => { setTransientError(t("rec.failed")); void stopRecording(); };
      rec.start(1000);
      recorders.push(rec);
    };
    if (mode === "both" && audio && video) {
      record(new MediaStream([...video.stream.getVideoTracks(), ...audio.stream.getAudioTracks()]), videoType.mime, sinks.v!);
    } else {
      if (audio && sinks.a) record(audio.stream, audioType.mime, sinks.a);
      if (video && sinks.v) record(video.stream, videoType.mime, sinks.v);
    }

    // Leaving the call ends the recording and keeps what was made.
    state.unwatch = voiceStore.subscribe((v) => { if (v.currentChannelId !== channelId) void stopRecording(); });
    running = state;
    recorderStore.setState((s) => ({ ...s, active: { mode, startedAt: Date.now(), channelId }, busy: false }));
  } catch (e) {
    log.error("could not start recording", e);
    setTransientError(t("rec.failed"));
  } finally {
    recorderStore.setState((s) => ({ ...s, busy: false }));
  }
}

export async function stopRecording(): Promise<void> {
  const r = running;
  const active = recorderStore.getState().active;
  if (r === null) return;
  running = null;
  r.unwatch();
  // Each recorder hands over its last chunk on stop; wait for that before closing the files.
  await Promise.all(r.recorders.map((rec) => new Promise<void>((resolve) => {
    if (rec.state === "inactive") { resolve(); return; }
    rec.addEventListener("stop", () => resolve(), { once: true });
    rec.stop();
  })));
  // ondataavailable writes are async; give the last one a moment to land in the file.
  await new Promise((res) => window.setTimeout(res, 300));
  for (const stop of r.stops) stop();
  let saved = !r.failed;
  const files: { blob: Blob; name: string; mime: string }[] = [];
  for (const sink of r.sinks) {
    try {
      const blob = await sink.close();
      if (blob !== null) files.push({ blob, name: sink.name, mime: sink.mime });
    } catch (e) { saved = false; log.error("closing the recording failed", e); }
  }
  if (active !== null) wsSend("voice_record", { channel_id: active.channelId, on: false });
  recorderStore.setState((s) => ({ ...s, active: null, busy: false }));
  if (saved) setTransientSuccess(t("rec.saved", { name: r.sinks.map((s) => s.name).join(", ") }));
  else setTransientError(t("rec.writeFailed"));
  if (saved && active !== null && files.length > 0) await postToChat(active.channelId, files, Date.now() - active.startedAt);
}

/**
 * The recording into the voice room's chat — the owner's rule: after the call it is there for
 * everyone to watch or download. A DM call has no attached chat (and its own is end-to-end
 * encrypted, which a server-readable recording has no place in), so it stays on this computer.
 */
async function postToChat(voiceChannelId: number, files: { blob: Blob; name: string; mime: string }[], ms: number): Promise<void> {
  const room = channelsStore.getState().channels.get(voiceChannelId);
  const chatId = room?.chatChannelId;
  if (chatId == null) return;
  const total = files.reduce((n, f) => n + f.blob.size, 0) || 1;
  let before = 0;
  recorderStore.setState((s) => ({ ...s, uploading: 0 }));
  try {
    const ids: string[] = [];
    for (const f of files) {
      const up = await api.uploadRecording(f.blob, f.name, f.mime.split(";")[0]!, (sent) => {
        recorderStore.setState((s) => ({ ...s, uploading: Math.min(1, (before + sent) / total) }));
      });
      before += f.blob.size;
      ids.push(up.id);
    }
    const secs = Math.round(ms / 1000);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    wsSend("chat_send", { channel_id: chatId, content: t("rec.chatMessage", { time }), attachments: ids });
    setTransientSuccess(t("rec.posted", { channel: room?.name ?? "" }));
  } catch (e) {
    log.error("posting the recording to the chat failed", e);
    setTransientError(t("rec.uploadFailed"));
  } finally {
    recorderStore.setState((s) => ({ ...s, uploading: null }));
  }
}
