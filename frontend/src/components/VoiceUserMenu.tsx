import { useState } from "react";
import { setUserVolume, getUserVolume, setAudioSmoothing } from "@lib/livekitSession";
import { toggleMute, toggleDeafen } from "@lib/voice";
import { voiceStore } from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { ContextMenu, type MenuEntry } from "@components/ContextMenu";
import { t } from "@lib/i18n";

/** Right-click menu for a voice participant: per-user volume + mute (others), or mute/deafen (self). */
export function VoiceUserMenu({ userId, x, y, onClose }: { userId: number; x: number; y: number; onClose: () => void }) {
  const me = authStore.getState().user?.id ?? 0;
  const isSelf = userId === me;
  const [vol, setVol] = useState<number>(() => {
    const v = getUserVolume(userId);
    // Older builds allowed up to 400%; fold any stored overshoot back under the cap.
    return Number.isFinite(v) ? Math.min(v, 200) : 100;
  });

  const v = voiceStore.getState();
  const items: MenuEntry[] = isSelf
    ? [
        { label: v.localMuted ? t("ctx.unmuteMic") : t("ctx.muteMic"), onClick: toggleMute },
        { label: v.localDeafened ? t("ctx.undeafen") : t("ctx.deafen"), onClick: toggleDeafen },
      ]
    : [
        {
          render: () => (
            <div>
              <div className="setting-label">{t("ctx.userVolume")} — {vol}%</div>
              <input
                type="range" className="settings-slider" min={0} max={200} value={vol}
                style={{ width: 180 }}
                onChange={(e) => { const nv = Number(e.target.value); setVol(nv); setUserVolume(userId, nv); }}
              />
            </div>
          ),
        },
        { separator: true },
        {
          label: vol === 0 ? t("ctx.unmuteUser") : t("ctx.muteUser"),
          onClick: () => { const nv = vol === 0 ? 100 : 0; setVol(nv); setUserVolume(userId, nv); },
        },
        // Listener-side remedy for a participant whose audio arrives choppy (their bursty
        // uplink): a stretched jitter buffer smooths playback at the cost of ~¼s latency.
        {
          label: (v.smoothedAudio.has(userId) ? "✓ " : "") + t("ctx.smoothAudio"),
          onClick: () => setAudioSmoothing(userId, !v.smoothedAudio.has(userId)),
        },
      ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
