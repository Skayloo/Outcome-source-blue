/**
 * The support mailbox section of the admin console — now a mail client of its own
 * (components/admin/mail/MailClient.tsx). This name stays because both consoles (/admin and the
 * in-app one) mount it.
 */
import { MailClient } from "@components/admin/mail/MailClient";

export function AdminMailPanel() {
  return <MailClient />;
}
