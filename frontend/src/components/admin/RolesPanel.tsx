/**
 * RolesPanel — admin pane to manage server roles (restores UI for the existing
 * /api/v1/roles backend endpoints). Left column lists roles colored by their
 * `color`; the right column edits the selected role's name, color, and the full
 * permission bitfield as a checkbox grid. Create / Save / Delete go through the
 * REST api and the list is refreshed after every mutation.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { api } from "@lib/services";
import { t } from "@lib/i18n";
import { Section, Banner } from "@components/settings/controls";
import { Permission, type RoleResponse } from "@lib/types";

// ---------------------------------------------------------------------------
// Permission metadata derived from the Permission enum (single source of truth).
// ---------------------------------------------------------------------------

interface PermissionEntry {
  readonly label: string;
  readonly bit: number;
}

/** Human-readable label for an enum key like "SEND_MESSAGES" -> "Send Messages". */
function humanizePermission(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** All permission bits, in declaration order, with friendly labels. */
const PERMISSION_ENTRIES: readonly PermissionEntry[] = Object.entries(Permission)
  .filter((entry): entry is [string, number] => typeof entry[1] === "number")
  .map(([key, bit]) => ({ label: humanizePermission(key), bit }));

const DEFAULT_ROLE_COLOR = "#99aab5";

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Normalize a possibly-null role color to a usable hex string for swatches. */
function colorOf(color: string | null): string {
  return color && color.trim().length > 0 ? color : DEFAULT_ROLE_COLOR;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RolesPanel() {
  const [roles, setRoles] = useState<readonly RoleResponse[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editor draft state for the selected role.
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_ROLE_COLOR);
  const [draftPerms, setDraftPerms] = useState(0);

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  // Load roles (used on mount and after every mutation). Returns the list so
  // callers can re-select a freshly created role.
  const loadRoles = useCallback(
    async (signal?: AbortSignal): Promise<readonly RoleResponse[]> => {
      const next = await api.getRoles(signal);
      if (signal?.aborted) return next;
      setRoles(next);
      return next;
    },
    [],
  );

  // Initial fetch on mount.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .getRoles(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setRoles(next);
        const first = next[0];
        if (first) setSelectedId(first.id);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(errMsg(e, t("admin.failedLoadRoles")));
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

  // Sync the editor draft whenever the selected role changes (by id/identity).
  useEffect(() => {
    if (!selected) {
      setDraftName("");
      setDraftColor(DEFAULT_ROLE_COLOR);
      setDraftPerms(0);
      return;
    }
    setDraftName(selected.name);
    setDraftColor(colorOf(selected.color));
    setDraftPerms(selected.permissions);
  }, [selected]);

  const togglePerm = (bit: number, checked: boolean): void => {
    setDraftPerms((prev) => (checked ? prev | bit : prev & ~bit));
  };

  const onNameChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setDraftName(e.target.value);
  };

  const onColorTextChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setDraftColor(e.target.value);
  };

  const onColorPickChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setDraftColor(e.target.value);
  };

  const onPermChange = (bit: number) => (e: ChangeEvent<HTMLInputElement>): void => {
    togglePerm(bit, e.target.checked);
  };

  const createRole = (): void => {
    setBusy(true);
    setError(null);
    const maxPosition = roles.reduce((max, r) => (r.position > max ? r.position : max), 0);
    void api
      .createRole({ name: "new role", permissions: 0, position: maxPosition + 1 })
      .then((created) =>
        loadRoles().then(() => {
          setSelectedId(created.id);
        }),
      )
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedCreateRole"))))
      .finally(() => setBusy(false));
  };

  const saveRole = (): void => {
    if (!selected) return;
    const name = draftName.trim();
    if (name.length === 0) {
      setError(t("admin.roleNameEmpty"));
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .updateRole(selected.id, {
        name,
        color: draftColor,
        permissions: draftPerms,
        position: selected.position,
      })
      .then(() => loadRoles())
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedSaveRole"))))
      .finally(() => setBusy(false));
  };

  const deleteRole = (): void => {
    if (!selected || selected.is_default) return;
    const removedId = selected.id;
    setBusy(true);
    setError(null);
    void api
      .deleteRole(removedId)
      .then(() => loadRoles())
      .then((next) => {
        if (selectedId === removedId) {
          setSelectedId(next[0]?.id ?? null);
        }
      })
      .catch((e: unknown) => setError(errMsg(e, t("admin.failedDeleteRole"))))
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-pane active">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Section title={t("admin.roles")} />
        <button className="ac-btn" disabled={busy} onClick={createRole}>
          {busy ? t("admin.working") : t("admin.newRole")}
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <Banner kind="info">{t("admin.loadingRoles")}</Banner>
      ) : roles.length === 0 ? (
        <Banner kind="info">{t("admin.noRolesYet")}</Banner>
      ) : (
        <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start" }}>
          {/* Role list */}
          <div
            style={{
              flex: "0 0 200px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 420,
              overflowY: "auto",
            }}
          >
            {roles.map((role) => {
              const active = role.id === selectedId;
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => setSelectedId(role.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: active ? "var(--bg-active)" : "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    textAlign: "left",
                    font: "inherit",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "0 0 12px",
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: colorOf(role.color),
                    }}
                  />
                  <span style={{ color: colorOf(role.color), fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {role.name}
                  </span>
                  {role.is_default && (
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>{t("admin.defaultBadge")}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Editor */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!selected ? (
              <Banner kind="info">{t("admin.selectRoleToEdit")}</Banner>
            ) : (
              <>
                <div className="setting-row">
                  <div className="setting-label">{t("admin.name")}</div>
                </div>
                <input
                  className="form-input"
                  type="text"
                  placeholder={t("admin.roleNamePlaceholder")}
                  value={draftName}
                  onChange={onNameChange}
                  style={{ marginBottom: 12 }}
                />

                <div className="setting-row">
                  <div className="setting-label">{t("admin.color")}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "0 0 28px",
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: draftColor,
                    }}
                  />
                  <input
                    type="color"
                    aria-label={t("admin.pickRoleColor")}
                    value={/^#[0-9a-fA-F]{6}$/.test(draftColor) ? draftColor : DEFAULT_ROLE_COLOR}
                    onChange={onColorPickChange}
                    style={{ width: 40, height: 32, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
                  />
                  <input
                    className="form-input"
                    type="text"
                    placeholder="#99aab5"
                    value={draftColor}
                    onChange={onColorTextChange}
                    style={{ maxWidth: 140 }}
                  />
                </div>

                <div className="settings-section-title">{t("admin.permissions")}</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                    gap: "6px 16px",
                    margin: "8px 0 16px",
                  }}
                >
                  {PERMISSION_ENTRIES.map((perm) => {
                    const checked = (draftPerms & perm.bit) !== 0;
                    return (
                      <label
                        key={perm.bit}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text-primary)" }}
                      >
                        <input type="checkbox" checked={checked} onChange={onPermChange(perm.bit)} />
                        <span>{perm.label}</span>
                      </label>
                    );
                  })}
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button className="ac-btn" disabled={busy} onClick={saveRole}>
                    {busy ? t("admin.saving") : t("admin.save")}
                  </button>
                  <button
                    className="ac-btn account-delete-btn"
                    disabled={busy || selected.is_default}
                    title={selected.is_default ? t("admin.defaultRolesCannotDelete") : undefined}
                    onClick={deleteRole}
                  >
                    {t("admin.delete")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
