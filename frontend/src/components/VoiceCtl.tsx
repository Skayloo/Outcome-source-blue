/**
 * One round control in a voice bar: the button plus the label under it.
 *
 * Shared by the in-app voice stage and the guest page so a guest sees the same controls as
 * everyone else. The guest page used to style these with `.ac-btn` — the ADMIN toolbar
 * button, whose base and `.on` state are both `var(--accent)`. Pressing mute changed the
 * icon and nothing else, so the button never looked pressed.
 */
import { Icon, type IconName } from "@lib/icons";

export function VoiceCtl(
  { name, label, on, red, onClick }:
  { name: IconName; label: string; on?: boolean; red?: boolean; onClick: () => void },
) {
  const cls = "vsc-btn" + (red ? " on-red" : on ? " on" : "");
  return (
    <div className="vsc-ctl">
      <button className={cls} title={label} onClick={onClick}><Icon name={name} size={22} /></button>
      <span className="vsc-ctl-label">{label}</span>
    </div>
  );
}
