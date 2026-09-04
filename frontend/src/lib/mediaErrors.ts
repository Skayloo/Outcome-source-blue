// Why the camera or the microphone did not turn on, in words the person can act on.
//
// Written after two rounds of the same bug: the code caught the error, showed "could not turn
// the camera on", and dropped the one piece of information that mattered. A refused permission,
// a camera another app is holding and a camera that is not there need three different actions,
// and the browser tells us which it is — we were throwing that away.
import { t } from "@lib/i18n";

/** A message for a getUserMedia / setCameraEnabled failure. `kind` picks the wording. */
export function describeMediaError(err: unknown, kind: "camera" | "microphone"): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return kind === "camera" ? t("media.cameraBlocked") : t("media.micBlocked");
    case "NotFoundError":
    case "OverconstrainedError":
      return kind === "camera" ? t("media.cameraMissing") : t("media.micMissing");
    case "NotReadableError":
    case "AbortError":
      // Firefox and Windows are strict about exclusive access: another tab or app holding the
      // device is the single most common cause of this one.
      return kind === "camera" ? t("media.cameraBusy") : t("media.micBusy");
    default:
      return kind === "camera" ? t("media.cameraFailed") : t("media.micFailed");
  }
}
