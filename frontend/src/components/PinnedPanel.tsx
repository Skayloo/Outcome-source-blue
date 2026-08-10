/**
 * PinnedPanel — a right-aligned dropdown listing the pinned messages of a
 * channel. Backed by the REST api (GET /channels/{id}/pins, DELETE …/pins/{id}),
 * which already exists server-side but had no UI. Fetches on mount (aborted on
 * unmount), closes on outside click / Escape, and lets the caller jump to a
 * pinned message via onJump.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "@lib/services";
import { initials, formatTime } from "@lib/format";
import { Icon } from "@lib/icons";
import type { MessageResponse } from "@lib/types";

interface PinnedPanelProps {
  readonly channelId: number;
  readonly onClose: () => void;
  readonly onJump?: (messageId: number) => void;
}

const panelStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 8,
  width: 360,
  maxHeight: 420,
  overflowY: "auto",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,.5)",
  zIndex: 2000,
  padding: 8,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 8px 10px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: ".02em",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  padding: 10,
  borderRadius: 6,
  cursor: "pointer",
};

const avatarStyle: CSSProperties = {
  flex: "0 0 auto",
  width: 32,
  height: 32,
  borderRadius: "50%",
  background: "var(--bg-active)",
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
};

const contentStyle: CSSProperties = {
  fontSize: 14,
  color: "var(--text-normal, var(--text-primary))",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const iconBtnStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
};

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function PinnedPanel({ channelId, onClose, onJump }: PinnedPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pins, setPins] = useState<readonly MessageResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unpinning, setUnpinning] = useState<number | null>(null);

  // Fetch pinned messages on mount; abort the request if we unmount first.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .getPins(channelId, controller.signal)
      .then((res) => {
        setPins(res.messages);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(errMsg(e, "Failed to load pinned messages."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [channelId]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onPointerDown = (e: globalThis.MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const unpin = (messageId: number) => {
    setUnpinning(messageId);
    setError(null);
    void api
      .unpinMessage(channelId, messageId)
      .then(() => {
        setPins((prev) => prev.filter((m) => m.id !== messageId));
        setUnpinning(null);
      })
      .catch((e: unknown) => {
        setError(errMsg(e, "Failed to unpin message."));
        setUnpinning(null);
      });
  };

  const jump = (messageId: number) => {
    onJump?.(messageId);
    onClose();
  };

  return (
    <div ref={panelRef} style={panelStyle} role="dialog" aria-label="Pinned messages">
      <div style={headerStyle}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="pin" size={14} />
          Pinned Messages
        </span>
        <button
          type="button"
          aria-label="Close pinned messages"
          style={iconBtnStyle}
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      {loading && (
        <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>
          Loading…
        </div>
      )}

      {!loading && error && (
        <div style={{ padding: 16, fontSize: 13, color: "var(--red)" }}>{error}</div>
      )}

      {!loading && !error && pins.length === 0 && (
        <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
          No pinned messages
        </div>
      )}

      {!loading && !error &&
        pins.map((msg) => (
          <div
            key={msg.id}
            style={rowStyle}
            role="button"
            tabIndex={0}
            onClick={() => jump(msg.id)}
            onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                jump(msg.id);
              }
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "var(--bg-active)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
            }}
          >
            <div style={avatarStyle}>{initials(msg.user.username)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                  {msg.user.username}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {formatTime(msg.timestamp)}
                </span>
              </div>
              <div style={contentStyle}>
                {msg.content.length > 0 ? msg.content : <em>(no text)</em>}
              </div>
            </div>
            <button
              type="button"
              aria-label="Unpin message"
              title="Unpin"
              disabled={unpinning === msg.id}
              style={{ ...iconBtnStyle, opacity: unpinning === msg.id ? 0.5 : 1 }}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                unpin(msg.id);
              }}
            >
              <Icon name="pin-off" size={16} />
            </button>
          </div>
        ))}
    </div>
  );
}
