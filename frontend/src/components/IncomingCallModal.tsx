/**
 * IncomingCallModal — phone-style overlay shown to the callee while a 1-on-1 call
 * is ringing in. Driven purely by the call store's `incoming` entry; renders the
 * caller's avatar with a pulsing ring plus accept / decline actions. The actual
 * signaling and media join happen inside acceptCall / declineCall.
 */
import { Avatar } from "@components/Avatar";
import { useStoreState } from "@lib/useStore";
import { callStore } from "@stores/call.store";
import { t } from "@lib/i18n";
import { Icon } from "@lib/icons";
import { acceptCall, declineCall } from "@lib/call";

export function IncomingCallModal() {
  const c = useStoreState(callStore);
  if (!c.incoming) return null;

  return (
    <div className="call-overlay">
      <div className="call-card">
        <Avatar
          username={c.incoming.callerName}
          avatar={c.incoming.callerAvatar}
          size={88}
          color="#5865f2"
          className="cc-avatar call-ring-pulse"
        />
        <div className="cc-name">{c.incoming.callerName}</div>
        <div className="cc-sub">{t("call.incomingTitle")}</div>
        <div className="cc-actions">
          <button className="cc-btn accept" title={t("call.accept")} onClick={acceptCall}>
            <Icon name="phone" />
          </button>
          <button className="cc-btn decline" title={t("call.decline")} onClick={declineCall}>
            <Icon name="phone-down" />
          </button>
        </div>
      </div>
    </div>
  );
}
