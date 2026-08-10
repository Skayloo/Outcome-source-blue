/**
 * Call store — transient 1-on-1 call signaling state (incoming ring, outgoing ring,
 * and the currently active call channel). Media itself runs through the voice store /
 * LiveKit session on the DM channel; this store only drives the phone-style UI.
 */
import { createStore } from "@lib/store";

export interface IncomingCall {
  readonly callerId: number;
  readonly callerName: string;
  readonly callerAvatar: string | null;
  readonly channelId: number;
}

export interface OutgoingCall {
  readonly calleeId: number;
  readonly calleeName: string;
  readonly channelId: number;
}

export interface CallState {
  readonly incoming: IncomingCall | null;
  readonly outgoing: OutgoingCall | null;
  /** DM channel id of the connected call, or null when not in a call. */
  readonly activeChannelId: number | null;
}

const INITIAL: CallState = { incoming: null, outgoing: null, activeChannelId: null };

export const callStore = createStore<CallState>(INITIAL);

export function setIncomingCall(c: IncomingCall): void {
  callStore.setState((p) => ({ ...p, incoming: c }));
}
export function clearIncomingCall(): void {
  callStore.setState((p) => ({ ...p, incoming: null }));
}
export function setOutgoingCall(c: OutgoingCall): void {
  callStore.setState((p) => ({ ...p, outgoing: c }));
}
export function clearOutgoingCall(): void {
  callStore.setState((p) => ({ ...p, outgoing: null }));
}
export function setActiveCall(channelId: number | null): void {
  callStore.setState((p) => ({ ...p, activeChannelId: channelId }));
}
