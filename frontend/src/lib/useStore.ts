import { useSyncExternalStore } from "react";
import type { Store } from "./store";

/**
 * Bind a React component to one of the app's reactive stores. `getState()` returns
 * a stable immutable reference (only changes on setState), so this is loop-safe.
 * Re-renders on any change to the store; select the fields you need in render.
 */
export function useStoreState<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
