/**
 * The ONE app-wide voice-message player. The <audio> element lives here (module scope),
 * so playback survives channel switches; bubbles and the top bar render from
 * voicePlayerStore. When a clip ends, the NEXT voice message in the same channel plays
 * automatically (Telegram behaviour). Starting a clip marks it listened (synced).
 */

import { voicePlayerStore, patchVoicePlayer, resetVoicePlayer } from "@stores/voicePlayer.store";
import { markListened } from "@stores/listened.store";
import { getChannelMessages } from "@stores/messages.store";
import { wsSend } from "@lib/services";
import { assetUrl } from "@lib/serverHost";
import type { Attachment } from "@lib/types";

export function isVoiceAttachment(att: Attachment): boolean {
  return att.mime.startsWith("audio/") && att.duration_ms != null;
}

const audio = new Audio();
audio.preload = "auto";
let pendingSeekFrac: number | null = null;

audio.addEventListener("timeupdate", () => patchVoicePlayer({ pos: audio.currentTime }));
audio.addEventListener("play", () => patchVoicePlayer({ playing: true }));
audio.addEventListener("pause", () => patchVoicePlayer({ playing: false }));
audio.addEventListener("loadedmetadata", () => {
  if (pendingSeekFrac !== null) {
    audio.currentTime = pendingSeekFrac * (audio.duration || 0);
    pendingSeekFrac = null;
  }
});
audio.addEventListener("ended", () => { playNextInChannel(); });

export interface PlayVoiceArgs {
  readonly att: Attachment;
  readonly channelId: number;
  readonly messageId: number;
  readonly sender: string;
  readonly seekFrac?: number;
}

export function playVoice({ att, channelId, messageId, sender, seekFrac }: PlayVoiceArgs): void {
  patchVoicePlayer({
    attId: att.id, channelId, messageId, sender,
    durationMs: att.duration_ms ?? 0, pos: 0,
  });
  pendingSeekFrac = seekFrac ?? null;
  audio.src = assetUrl(att.url);
  void audio.play().catch(() => resetVoicePlayer());
  // Listened, Telegram-style: marked the moment playback starts, synced to other devices.
  markListened(att.id);
  wsSend("listen", { attachment_id: att.id });
}

/** Pause/resume the CURRENT clip. */
export function toggleVoice(): void {
  if (voicePlayerStore.getState().attId === null) return;
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
}

export function seekVoiceFrac(frac: number): void {
  const f = Math.max(0, Math.min(1, frac));
  if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = f * audio.duration;
  else pendingSeekFrac = f;
}

export function stopVoice(): void {
  audio.pause();
  audio.removeAttribute("src");
  resetVoicePlayer();
}

/** Auto-advance: the next (newer) voice message in the same channel, if it's loaded. */
function playNextInChannel(): void {
  const s = voicePlayerStore.getState();
  if (s.channelId === null || s.messageId === null) { resetVoicePlayer(); return; }
  const msgs = getChannelMessages(s.channelId);
  for (const m of msgs) {
    if (m.id <= s.messageId || m.deleted) continue;
    const att = m.attachments.find(isVoiceAttachment);
    if (att) {
      playVoice({ att, channelId: s.channelId, messageId: m.id, sender: m.user.username });
      return;
    }
  }
  resetVoicePlayer();
}
