/**
 * What the signed-in person may do, from the server's own answer — never from role NAMES, which
 * used to decide it here (and a renamed role broke every gate).
 *
 * Two separate things (2026-10-12):
 *  - `role` (auth_ok, READY, member_update, rosters) is the role INSIDE the active server:
 *    owner (the person who created it) / admin / moderator / member;
 *  - `space_admin` says they administer the whole space — the /admin console. A space admin
 *    manages any server from there, but does not read servers they are not in.
 * The server enforces all of it; these only decide what to offer.
 */
import { t } from "@lib/i18n";
import type { UserWithRole } from "@lib/types";

export type ServerRoleName = "owner" | "admin" | "moderator" | "member";

/** Roster order: owner, admins, moderators, members. */
export const SERVER_ROLE_ORDER: readonly ServerRoleName[] = ["owner", "admin", "moderator", "member"];
/** What a manager can hand out — the owner is whoever created the server and is never assigned. */
export const ASSIGNABLE_SERVER_ROLES: readonly Exclude<ServerRoleName, "owner">[] = ["admin", "moderator", "member"];

export function serverRole(role: string | null | undefined): ServerRoleName {
  const r = (role ?? "").toLowerCase();
  return r === "owner" || r === "admin" || r === "moderator" ? r : "member";
}

export function serverRoleLabel(role: string | null | undefined): string {
  return t(`sidebar.role_${serverRole(role)}`);
}

export function isSpaceAdmin(user: UserWithRole | null | undefined): boolean {
  return user?.space_admin === true;
}

/** Name, picture, visibility, members' roles and removing members of the ACTIVE server. */
export function canManageServer(user: UserWithRole | null | undefined): boolean {
  if (!user) return false;
  const r = serverRole(user.role);
  return isSpaceAdmin(user) || r === "owner" || r === "admin";
}

/** The active server's report queue: whoever holds ManageMessages there — its owner, admins and
 *  moderators (ServerRoles.Grant on the server) — or the space's Administrator. */
export function canModerateServer(user: UserWithRole | null | undefined): boolean {
  return canManageServer(user) || serverRole(user?.role) === "moderator";
}

/** Invites and guest links into the active server. */
export function canInviteToServer(user: UserWithRole | null | undefined): boolean {
  return canManageServer(user) || serverRole(user?.role) === "moderator";
}

/** Whether `user` may remove a member whose role in the server is `target`. */
export function canRemoveMember(user: UserWithRole | null | undefined, target: string): boolean {
  const t2 = serverRole(target);
  if (t2 === "owner" || !user) return false;
  if (canManageServer(user)) return true;
  return serverRole(user.role) === "moderator" && t2 === "member";
}
