import { useStoreState } from "@lib/useStore";
import { uiStore } from "@stores/ui.store";

export function Toast() {
  const ui = useStoreState(uiStore);
  // A persistent error (ban / server error) is always a failure; a transient toast is
  // whatever its kind says. Only "error" is red — success/info wear the brand accent, so a
  // positive outcome ("friend request sent") never reads as something going wrong.
  const msg = ui.transientError ?? ui.persistentError;
  if (!msg) return null;
  const isError = ui.transientError === null || ui.transientKind === "error";
  return (
    <div className={`app-toast ${isError ? "toast-error" : "toast-accent"}`} role="status">
      {msg}
    </div>
  );
}
