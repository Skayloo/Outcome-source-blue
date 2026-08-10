/**
 * Friends store — accepted friends + pending incoming/outgoing requests.
 * Hydrated from GET /api/v1/friends; kept live by WS friend_* frames.
 */
import { createStore } from "@lib/store";
import type { PublicUser, FriendsListResponse } from "@lib/types";

export interface FriendsState {
  readonly friends: readonly PublicUser[];
  readonly incoming: readonly PublicUser[];
  readonly outgoing: readonly PublicUser[];
  readonly loaded: boolean;
}

const INITIAL: FriendsState = { friends: [], incoming: [], outgoing: [], loaded: false };

export const friendsStore = createStore<FriendsState>(INITIAL);

export function setFriendsList(r: FriendsListResponse): void {
  friendsStore.setState(() => ({
    friends: r.friends,
    incoming: r.incoming,
    outgoing: r.outgoing,
    loaded: true,
  }));
}

/** An incoming request arrived (WS friend_request). */
export function addIncomingRequest(user: PublicUser): void {
  friendsStore.setState((p) =>
    p.incoming.some((u) => u.id === user.id)
      ? p
      : { ...p, incoming: [user, ...p.incoming] },
  );
}

/** A request I sent was accepted, or I accepted one (WS friend_accepted). */
export function promoteToFriend(user: PublicUser): void {
  friendsStore.setState((p) => ({
    ...p,
    friends: p.friends.some((u) => u.id === user.id) ? p.friends : [user, ...p.friends],
    incoming: p.incoming.filter((u) => u.id !== user.id),
    outgoing: p.outgoing.filter((u) => u.id !== user.id),
  }));
}

/** A friend/request was removed on either side (WS friend_removed) or locally. */
export function dropFriend(userId: number): void {
  friendsStore.setState((p) => ({
    ...p,
    friends: p.friends.filter((u) => u.id !== userId),
    incoming: p.incoming.filter((u) => u.id !== userId),
    outgoing: p.outgoing.filter((u) => u.id !== userId),
  }));
}

/** Optimistically record an outgoing request I just sent. */
export function addOutgoingRequest(user: PublicUser): void {
  friendsStore.setState((p) =>
    p.outgoing.some((u) => u.id === user.id) || p.friends.some((u) => u.id === user.id)
      ? p
      : { ...p, outgoing: [user, ...p.outgoing] },
  );
}
