import { api } from "@lib/services";
import { copyText } from "@lib/clipboard";
import { t } from "@lib/i18n";
import { setTransientSuccess, showToast } from "@stores/ui.store";

/**
 * Put a voice channel's no-login guest link in the clipboard — from the call itself or from the
 * channel list, without joining. An existing link is reused: the POST is idempotent on the code,
 * but it also re-latches the channel to the guest key and broadcasts a key-regime frame, which
 * makes every member already in the call rotate keys for nothing.
 * Permission (ManageInvites) is enforced server-side — a 403 lands in the toast.
 */
export async function copyGuestLink(channelId: number): Promise<void> {
  try {
    const existing = (await api.getGuestLinks().catch(() => []))
      .find((l) => l.channel_id === channelId)?.url;
    const url = existing ?? (await api.createGuestLink(channelId)).url;
    if (await copyText(url)) setTransientSuccess(t("voice.guestLinkCopied"));
    else showToast(url, "info"); // clipboard blocked — at least show it
  } catch (e) {
    showToast(e instanceof Error ? e.message : t("voice.guestLinkFailed"), "error");
  }
}
