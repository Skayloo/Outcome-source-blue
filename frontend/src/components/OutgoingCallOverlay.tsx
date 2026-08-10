/**
 * OutgoingCallOverlay — phone-style overlay shown to the caller while a 1-on-1
 * call is ringing out. Driven purely by the call store's `outgoing` entry; shows
 * the callee's name with a pulsing avatar and a single cancel action that hangs
 * up before the call is answered (cancelCall).
 */
import { Avatar } from "@components/Avatar";
import { useStoreState } from "@lib/useStore";
import { callStore } from "@stores/call.store";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { cancelCall } from "@lib/call";

export function OutgoingCallOverlay() {
  const c = useStoreState(callStore);
  if (!c.outgoing) return null;

  return (
    <div className="call-overlay">
      <div className="call-card">
        <Avatar
          username={c.outgoing.calleeName}
          avatar={null}
          size={88}
          color="#5865f2"
          className="cc-avatar call-ring-pulse"
        />
        <div className="cc-name">{c.outgoing.calleeName}</div>
        <div className="cc-sub">{t("call.calling", { name: c.outgoing.calleeName })}</div>
        <div className="cc-actions">
          <button className="cc-btn decline" title={t("call.cancel")} onClick={cancelCall}>
            <Icon name="phone-down" />
          </button>
        </div>
      </div>
    </div>
  );
}
