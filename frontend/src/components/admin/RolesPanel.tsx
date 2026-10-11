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
import { Banner } from "@components/settings/controls";
import { Badge, Btn, Card, Empty, Spinner } from "@components/admin/kit";
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

  const pickable = /^#[0-9a-fA-F]{6}$/.test(draftColor) ? draftColor : DEFAULT_ROLE_COLOR;

  return (
    <div className="settings-pane active">
      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="adm-loading"><Spinner size={20} /></div>
      ) : roles.length === 0 ? (
        <Empty icon="shield" title={t("admin.noRolesYet")}>
          <Btn kind="primary" icon="plus" disabled={busy} onClick={createRole}>{t("admin.newRole")}</Btn>
        </Empty>
      ) : (
        <div className="adm-split">
          <aside className="adm-split-list">
            {roles.map((role) => (
              <button
                key={role.id}
                type="button"
                className={"adm-list-item" + (role.id === selectedId ? " is-active" : "")}
                onClick={() => setSelectedId(role.id)}
              >
                <span className="adm-role-dot" style={{ background: colorOf(role.color) }} aria-hidden="true" />
                <span className="adm-list-item-name">{role.name}</span>
                {role.is_default && <Badge>{t("admin.defaultBadge")}</Badge>}
              </button>
            ))}
            <Btn kind="ghost" size="sm" icon="plus" disabled={busy} onClick={createRole}>{t("admin.newRole")}</Btn>
          </aside>

          <div className="adm-split-main">
            {!selected ? (
              <Empty icon="shield" title={t("admin.selectRoleToEdit")} />
            ) : (
              <Card>
                <div className="adm-form-grid adm-form-grid--2">
                  <label className="adm-field">
                    <span>{t("admin.name")}</span>
                    <input className="form-input" type="text" placeholder={t("admin.roleNamePlaceholder")} value={draftName} onChange={onNameChange} />
                  </label>
                  <div className="adm-field">
                    <span>{t("admin.color")}</span>
                    <div className="adm-color">
                      <input type="color" aria-label={t("admin.pickRoleColor")} value={pickable} onChange={onColorPickChange} />
                      <input className="form-input mono" type="text" placeholder="#99aab5" value={draftColor} onChange={onColorTextChange} />
                      <span className="adm-role-preview" style={{ color: pickable }}>{draftName || "…"}</span>
                    </div>
                  </div>
                </div>

                <div className="adm-section-label">{t("admin.permissions")}</div>
                <div className="adm-perms">
                  {PERMISSION_ENTRIES.map((perm) => {
                    const checked = (draftPerms & perm.bit) !== 0;
                    return (
                      <label key={perm.bit} className={"adm-perm" + (checked ? " is-on" : "")}>
                        <input type="checkbox" checked={checked} onChange={onPermChange(perm.bit)} />
                        <span>{perm.label}</span>
                      </label>
                    );
                  })}
                </div>

                <div className="adm-form-actions">
                  <Btn kind="danger" icon="trash-2" disabled={busy || selected.is_default}
                    title={selected.is_default ? t("admin.defaultRolesCannotDelete") : undefined} onClick={deleteRole}>
                    {t("admin.delete")}
                  </Btn>
                  <span className="adm-spacer" />
                  <Btn kind="primary" icon="check" disabled={busy} onClick={saveRole}>
                    {busy ? t("admin.saving") : t("admin.save")}
                  </Btn>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
