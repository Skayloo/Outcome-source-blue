import { useStoreState } from "@lib/useStore";
import { voicePlayerStore } from "@stores/voicePlayer.store";
import { toggleVoice, stopVoice, seekVoiceFrac } from "@lib/voicePlayer";
import { Icon } from "@lib/icons";

/** Telegram-style strip above the chat while a voice message plays: sender, a seekable
 *  progress track, pause and close. Lives OUTSIDE the message list, so it stays put
 *  (and keeps playing) when the user wanders between chats. */
export function PlaybackBar() {
  const s = useStoreState(voicePlayerStore);
  if (s.attId === null) return null;

  const total = s.durationMs / 1000;
  const frac = total > 0 ? Math.min(1, s.pos / total) : 0;
  const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  return (
    <div className="playbar">
      <button className="playbar-btn" onClick={toggleVoice} aria-label={s.playing ? "Pause" : "Play"}>
        <Icon name={s.playing ? "pause" : "play"} size={14} />
      </button>
      <span className="playbar-name">{s.sender}</span>
      <div
        className="playbar-track"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seekVoiceFrac((e.clientX - r.left) / r.width);
        }}
      >
        <div className="playbar-fill" style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="playbar-time">{fmt(s.pos)} / {fmt(total)}</span>
      <button className="playbar-btn" onClick={stopVoice} aria-label="Close"><Icon name="x" size={14} /></button>
    </div>
  );
}
