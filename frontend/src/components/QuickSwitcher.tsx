import { useEffect, useMemo, useRef, useState } from "react";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { closeDrawer } from "@stores/mobile.store";
import { Icon, type IconName } from "@lib/icons";
import { t } from "@lib/i18n";

interface SwitchItem { id: number; name: string; kind: "text" | "voice" | "announcement" | "dm" }

const KIND_ICON: Record<SwitchItem["kind"], IconName> = {
  text: "hash", voice: "volume-2", announcement: "bell", dm: "user",
};

const KIND_LABEL: Record<SwitchItem["kind"], () => string> = {
  text: () => t("admin.kindText"),
  voice: () => t("admin.kindVoice"),
  announcement: () => t("admin.kindAnnouncement"),
  dm: () => t("admin.kindDm"),
};

/** Subsequence fuzzy match (chars of q appear in order in s). */
function fuzzy(s: string, q: string): boolean {
  if (!q) return true;
  s = s.toLowerCase(); q = q.toLowerCase();
  let i = 0;
  for (const c of s) { if (c === q[i]) i++; if (i === q.length) return true; }
  return i === q.length;
}

/** Ctrl+K command palette: jump to any channel or DM by fuzzy name search. */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<SwitchItem[]>(() => {
    const chans = [...channelsStore.getState().channels.values()]
      .filter((c) => c.type !== "dm")
      .map((c) => ({ id: c.id, name: c.name, kind: (c.type as SwitchItem["kind"]) }));
    const dms = dmStore.getState().channels.map((d) => ({
      id: d.channelId, name: d.recipient.username, kind: "dm" as const,
    }));
    return [...chans, ...dms];
  }, []);

  const filtered = useMemo(
    () => items.filter((it) => fuzzy(it.name, query)).slice(0, 50),
    [items, query],
  );

  useEffect(() => { setSel(0); }, [query]);

  function open(item: SwitchItem | undefined) {
    if (!item) return;
    setActiveChannel(item.id);
    closeDrawer();
    onClose();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); open(filtered[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  return (
    <div className="qs-overlay" onClick={onClose}>
      <div className="qs-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qs-input"
          placeholder={t("admin.quickSwitcherPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="qs-list">
          {filtered.length === 0 && <div className="qs-empty">{t("admin.noMatches")}</div>}
          {filtered.map((it, i) => (
            <div
              key={`${it.kind}-${it.id}`}
              className={"qs-item" + (i === sel ? " active" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => open(it)}
            >
              <Icon name={KIND_ICON[it.kind]} size={16} />
              <span className="qs-item-name">{it.name}</span>
              <span className="qs-item-kind">{KIND_LABEL[it.kind]()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
