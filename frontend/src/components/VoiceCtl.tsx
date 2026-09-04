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
  { name, glyph, label, on, red, onClick }:
  { name?: IconName; glyph?: string; label: string; on?: boolean; red?: boolean; onClick: () => void },
) {
  const cls = "vsc-btn" + (red ? " on-red" : on ? " on" : "");
  return (
    <div className="vsc-ctl">
      {/* A glyph instead of an icon where the meaning IS the character: there is no hand in the
          icon set, and a drawn hand next to a real emoji reaction bar would read as two
          different vocabularies. */}
      <button className={cls} title={label} onClick={onClick}>
        {glyph !== undefined ? <span className="vsc-glyph">{glyph}</span> : name !== undefined ? <Icon name={name} size={22} /> : null}
      </button>
      <span className="vsc-ctl-label">{label}</span>
    </div>
  );
}
