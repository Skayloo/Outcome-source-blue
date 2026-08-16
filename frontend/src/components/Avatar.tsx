import { initials } from "@lib/format";
import { assetUrlSmall } from "@lib/serverHost";

interface AvatarProps {
  username: string;
  avatar?: string | null;
  /** Diameter in px. */
  size?: number;
  /** Background color for the initials fallback. */
  color?: string;
  className?: string;
}

/** Renders a user's uploaded avatar image, or their initials on a colored disc as a fallback. */
export function Avatar({ username, avatar, size = 40, color = "#5865f2", className }: AvatarProps) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    fontSize: Math.max(10, Math.round(size * 0.4)),
    fontWeight: 700,
    color: "white",
    background: avatar ? "transparent" : color,
  };
  return (
    <div className={"oc-avatar" + (className ? " " + className : "")} style={style}>
      {avatar ? (
        <img
          src={assetUrlSmall(avatar)}
          alt={username}
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: "cover", display: "block" }}
          draggable={false}
        />
      ) : (
        initials(username)
      )}
    </div>
  );
}
