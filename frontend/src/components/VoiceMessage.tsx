import { useStoreState } from "@lib/useStore";
import { voicePlayerStore } from "@stores/voicePlayer.store";
import { listenedStore } from "@stores/listened.store";
import { playVoice, toggleVoice, seekVoiceFrac } from "@lib/voicePlayer";
import { Icon } from "@lib/icons";
import type { Attachment } from "@lib/types";

/** Voice-message bubble — a VIEW over the global player (lib/voicePlayer.ts): play/pause,
 *  clickable waveform, time, and the unlistened dot. Playback itself survives unmounts
 *  (channel switches), so this renders progress only while ITS clip is the active one. */
export function VoiceMessage({ att, channelId, messageId, sender, own }: {
  att: Attachment; channelId: number; messageId: number; sender: string; own: boolean;
}) {
  const player = useStoreState(voicePlayerStore);
  const listened = useStoreState(listenedStore);

  const active = player.attId === att.id;
  const playing = active && player.playing;
  const totalMs = att.duration_ms ?? 0;
  const total = totalMs / 1000;
  const cur = active ? player.pos : 0;
  const progress = active && total > 0 ? cur / total : 0;
  // Telegram semantics, both directions: receiver's dot until THEY play it;
  // sender's dot until the OTHER side has played it.
  const unlistened = own
    ? !listened.listenedByOthers.has(att.id)
    : !listened.listened.has(att.id);

  const peaks: number[] = (() => {
    try { const p = JSON.parse(att.waveform ?? "[]"); return Array.isArray(p) && p.length ? p : Array(48).fill(35); }
    catch { return Array(48).fill(35); }
  })();

  function start(seekFrac?: number): void {
    playVoice({ att, channelId, messageId, sender, seekFrac });
  }

  function seekTo(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (active) seekVoiceFrac(frac);
    else start(frac);
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="voice-msg">
      <button className="voice-msg-play" onClick={() => (active ? toggleVoice() : start())} aria-label={playing ? "Pause" : "Play"}>
        <Icon name={playing ? "pause" : "play"} size={16} />
      </button>
      <div className="voice-msg-wave" onClick={seekTo}>
        {peaks.map((p, i) => {
          const played = i / peaks.length < progress;
          return <span key={i} className={"vm-bar" + (played ? " played" : "")} style={{ height: `${Math.max(8, p)}%` }} />;
        })}
      </div>
      <span className="voice-msg-time">{fmt(active && cur > 0 ? cur : total)}</span>
      {unlistened && <span className="vm-dot" title="Не прослушано" />}
    </div>
  );
}
