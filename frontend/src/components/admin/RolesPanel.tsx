/**
 * RolesPanel — /admin → Roles: what each role can do. Read-only on purpose.
 *
 * Roles are fixed since 2026-10-12 (the owner's decision): the SPACE has Owner / Admin / Member
 * (users.role_id), a SERVER has its owner, Admin, Moderator and Member (ServerRoles on the
 * server). The editor that lived here wrote role_claims from the drifted roles.permissions
 * column — saving "Admin" quietly took Administrator from every space admin — and one list of
 * names served both levels, which is how a server's creator came to read "Member". The server
 * now refuses role edits; this page explains the two levels instead.
 */
import { t } from "@lib/i18n";
import { Card } from "@components/admin/kit";

interface RoleRow { readonly name: string; readonly what: string }

export function RolesPanel() {
  const space: RoleRow[] = [
    { name: t("admin.spaceRole_1"), what: t("admin.rolesSpaceOwner") },
    { name: t("admin.spaceRole_2"), what: t("admin.rolesSpaceAdmin") },
    { name: t("admin.spaceRole_4"), what: t("admin.rolesSpaceMember") },
  ];
  const server: RoleRow[] = [
    { name: t("srvset.serverOwner"), what: t("admin.rolesServerOwner") },
    { name: t("sidebar.role_admin"), what: t("admin.rolesServerAdmin") },
    { name: t("sidebar.role_moderator"), what: t("admin.rolesServerModerator") },
    { name: t("sidebar.role_member"), what: t("admin.rolesServerMember") },
  ];
  const table = (rows: RoleRow[]) => (
    <table className="admin-table adm-roles-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td className="adm-cell-main">{r.name}</td>
            <td>{r.what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="settings-pane active">
      <Card title={t("admin.rolesSpaceTitle")} desc={t("admin.rolesSpaceDesc")}>{table(space)}</Card>
      <Card title={t("admin.rolesServerTitle")} desc={t("admin.rolesServerDesc")}>{table(server)}</Card>
    </div>
  );
}
