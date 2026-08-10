import { useEffect } from "react";
import { useStoreState } from "@lib/useStore";
import { uiStore, closeModal, openModal, toggleMemberList } from "@stores/ui.store";
import { mobileStore, closeDrawer } from "@stores/mobile.store";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { initVoice } from "@lib/voice";
import { ServerRail } from "@components/ServerRail";
import { Sidebar } from "@components/Sidebar";
import { ChatHeader } from "@components/ChatHeader";
import { VoiceStage } from "@components/VoiceStage";
import { MessageList } from "@components/MessageList";
import { TypingIndicator } from "@components/TypingIndicator";
import { MessageInput } from "@components/MessageInput";
import { MemberList } from "@components/MemberList";
import { SettingsModal } from "@components/SettingsModal";
import { AdminPanel } from "@components/admin/AdminPanel";
import { InviteModal } from "@components/admin/InviteModal";
import { GuestAccessModal } from "@components/GuestAccessModal";
import { FriendsPanel } from "@components/FriendsPanel";
import { IncomingCallModal } from "@components/IncomingCallModal";
import { OutgoingCallOverlay } from "@components/OutgoingCallOverlay";
import { ImageLightbox } from "@components/ImageLightbox";
import { GlobalKeybinds } from "@components/GlobalKeybinds";
import { CommandPalette } from "@components/CommandPalette";
import { VoiceWidget } from "@components/VoiceWidget";
import { BugReportModal } from "@components/BugReportModal";
import { CreateServerModal } from "@components/ServerRail";
import { Toast } from "@components/Toast";
import { PaneDivider } from "@components/PaneDivider";
import { panesStore, closeSplit } from "@stores/panes.store";

export function MainPage() {
  const ui = useStoreState(uiStore);
  const { drawer } = useStoreState(mobileStore);
  const panes = useStoreState(panesStore);
  useStoreState(channelsStore);
  useEffect(() => { initVoice(); }, []);

  // ⌘K / Ctrl-K opens the command palette from anywhere. Capture phase + stopPropagation so
  // it fires before any focused input and beats the browser's own Ctrl+K (omnibox search) on
  // browsers that let pages cancel it. This is the SOLE Ctrl+K handler (see GlobalKeybinds).
  // A few browsers reserve Ctrl+K as a non-cancelable accelerator — the visible "Search ⌘K"
  // pill always opens the palette by click as a fallback there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        if (uiStore.getState().activeModal === "command") closeModal();
        else openModal("command");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const active = getActiveChannel();
  const voice = useStoreState(voiceStore);
  // Voice channels always get the stage; a DM does too while its 1-on-1 call is live,
  // so tapping the call icon / answering drops you into the voice room, not the chat log.
  // NB: DM channels are absent from channelsStore (getActiveChannel() → null for them),
  // so the call-stage rule must use the raw active id, not the resolved channel.
  const activeId = channelsStore.select((s) => s.activeChannelId);
  const isVoiceView = active?.type === "voice"
    || (activeId !== null && voice.currentChannelId === activeId);
  // Home (DM) view has no server member list — the layout collapses like Discord's DM screen.
  const homeView = ui.sidebarMode === "dms";

  // Members are an overlay drawer now, so the chat canvas is always full-width (no-members).
  // Two doors open it and they set different state: the desktop button toggles
  // memberListVisible, the phone one opens the mobile drawer. Gating the render on the first
  // alone meant that on a phone the drawer slid open over nothing at all.
  const membersDrawer = drawer === "members";
  const membersOpen = (ui.memberListVisible || membersDrawer) && !homeView;
  const appClass = "app no-members"
    + (drawer === "sidebar" ? " drawer-sidebar" : "")
    + (drawer === "members" ? " drawer-members" : "");

  return (
    <div className={appClass}>
      <div className="navigator">
        <ServerRail />
        <Sidebar />
      </div>
      <div className="panes" style={panes.secondary != null ? { ["--split" as string]: `${panes.ratio}` } : undefined}>
        <div className="chat-area">
          <ChatHeader />
          {isVoiceView ? (
            <VoiceStage channelId={active?.id ?? activeId!} />
          ) : (
            <>
              <MessageList />
              <TypingIndicator />
              <MessageInput />
            </>
          )}
        </div>
        {panes.secondary != null && (
          <>
            <PaneDivider />
            {/* The right pane is a whole conversation, not a preview: its own header, its own
                composer. A read-only second column would be a worse version of scrolling up. */}
            <div className="chat-area chat-area-secondary">
              <ChatHeader channelId={panes.secondary} onClose={closeSplit} />
              <MessageList channelId={panes.secondary} />
              <TypingIndicator channelId={panes.secondary} />
              <MessageInput channelId={panes.secondary} />
            </div>
          </>
        )}
      </div>
      {membersOpen && (
        <>
          {/* On a phone the shared mobile backdrop below already covers this and closes the
              drawer; a second scrim here would sit on top of it and swallow the tap. */}
          {!membersDrawer && <div className="members-backdrop" onClick={toggleMemberList} />}
          <MemberList />
        </>
      )}
      {drawer !== "none" && <div className="mobile-backdrop" onClick={closeDrawer} />}
      {ui.settingsOpen && <SettingsModal />}
      {ui.activeModal === "admin" && <AdminPanel onClose={closeModal} />}
      {ui.activeModal === "invites" && <InviteModal onClose={closeModal} />}
      {ui.activeModal === "guestAccess" && <GuestAccessModal onClose={closeModal} />}
      {ui.activeModal === "friends" && <FriendsPanel onClose={closeModal} />}
      {ui.activeModal === "command" && <CommandPalette />}
      {ui.activeModal === "bug" && <BugReportModal onClose={closeModal} />}
      {ui.activeModal === "create-space" && <CreateServerModal onClose={closeModal} />}
      {/* Floating voice dock — persists across every view while connected. */}
      <VoiceWidget />
      <IncomingCallModal />
      <OutgoingCallOverlay />
      <ImageLightbox />
      <GlobalKeybinds />
      <Toast />
    </div>
  );
}
