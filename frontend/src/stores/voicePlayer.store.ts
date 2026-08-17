/**
 * Global voice-message playback state — ONE clip plays at a time, app-wide.
 * The audio element lives in lib/voicePlayer.ts and survives channel switches;
 * bubbles and the top playback bar are just views over this store.
 */

import { createStore } from "@lib/store";

export interface VoicePlayerState {
  readonly attId: string | null;
  readonly channelId: number | null;
  readonly messageId: number | null;
  readonly sender: string | null;
  readonly durationMs: number;
  readonly playing: boolean;
  /** Current position, seconds. */
  readonly pos: number;
}

const INITIAL: VoicePlayerState = {
  attId: null, channelId: null, messageId: null, sender: null,
  durationMs: 0, playing: false, pos: 0,
};

export const voicePlayerStore = createStore<VoicePlayerState>(INITIAL, true);

export function patchVoicePlayer(patch: Partial<VoicePlayerState>): void {
  voicePlayerStore.setState((s) => ({ ...s, ...patch }));
}

export function resetVoicePlayer(): void {
  voicePlayerStore.setState(() => INITIAL);
}
