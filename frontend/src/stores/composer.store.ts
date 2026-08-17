import { createStore } from "@lib/store";
import type { Message } from "./messages.store";

/** React-side UI state for the composer: which message is being replied to / edited. */
interface ComposerState {
  readonly replyTo: Message | null;
  readonly editing: Message | null;
}

const INITIAL: ComposerState = { replyTo: null, editing: null };

export const composerStore = createStore<ComposerState>(INITIAL, true);

export function setReply(m: Message | null): void {
  composerStore.setState((p) => ({ ...p, replyTo: m, editing: null }));
}

export function setEditing(m: Message | null): void {
  composerStore.setState((p) => ({ ...p, editing: m, replyTo: null }));
}

export function clearComposer(): void {
  composerStore.setState(() => ({ replyTo: null, editing: null }));
}
