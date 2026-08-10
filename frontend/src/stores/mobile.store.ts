import { createStore } from "@lib/store";

export type Drawer = "none" | "sidebar" | "members";

/** Which off-canvas drawer is open on small screens. */
export const mobileStore = createStore<{ drawer: Drawer }>({ drawer: "none" });

export function openDrawer(d: Drawer): void {
  mobileStore.setState(() => ({ drawer: d }));
}

export function closeDrawer(): void {
  mobileStore.setState(() => ({ drawer: "none" }));
}
