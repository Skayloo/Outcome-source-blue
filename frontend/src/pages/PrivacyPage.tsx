/**
 * Privacy policy, served publicly at /privacy — no session, no app shell. The App Store
 * requires a reachable policy URL, and so does anyone deciding whether to sign up.
 *
 * In English because that is the language App Review reads, and the language a policy has to
 * survive being quoted in.
 *
 * Written against what the code actually does, table by table. If the data flows change, this
 * changes with them: a policy describing an older version of the product is worse than none,
 * because it is a promise the software is not keeping. Writing this pass turned up exactly
 * that — it claimed push tokens were deleted with an account, and they were not, so the
 * deletion path was fixed rather than the sentence softened.
 */
import { Logo } from "@components/Logo";

const UPDATED = "5 August 2026";
const CONTACT = "bikachi84@gmail.com";

/**
 * End-to-end encryption is a RED-edition feature. In blue — the public Docker images anyone
 * can self-host — Vite aliases @lib/e2eeSession to the stub and the crypto never ships: DMs
 * are stored exactly as typed. This same page is served by both builds, so a flat "your DMs
 * are end-to-end encrypted" is a promise the blue software does not keep. A policy that
 * describes an older or richer version of the product is worse than none.
 */
const E2EE = __OUTCOME_EDITION__ === "red";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 34 }}>
      <h2 style={{ fontSize: 19, fontWeight: 650, margin: "0 0 10px" }}>{title}</h2>
      {children}
    </section>
  );
}

/** One "what — why" line. Every item we hold has to justify itself in the second half. */
function Item({ what, why }: { what: string; why: string }) {
  return (
    <li style={{ marginBottom: 8 }}>
      <b>{what}</b> — {why}
    </li>
  );
}

const listStyle: React.CSSProperties = { paddingLeft: 20, margin: "10px 0 0" };

export function PrivacyPage() {
  const mail = (
    <a href={`mailto:${CONTACT}`} style={{ color: "var(--accent, #8b5cf6)" }}>{CONTACT}</a>
  );

  return (
    // Scrolls itself. The app locks the document (html, body { overflow: hidden }) so the chat
    // layout can own the viewport, which leaves a long page like this one with nowhere to go.
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        background: "var(--bg, #101014)",
        color: "var(--text, #e7e5ee)",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "56px 24px 96px", lineHeight: 1.65 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <Logo width={36} />
          <span style={{ fontSize: 20, fontWeight: 650 }}>Outcome</span>
        </div>

        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 6px" }}>Privacy Policy</h1>
        <p style={{ opacity: 0.6, margin: 0 }}>Last updated {UPDATED}</p>

        <Section title="At a glance">
          <p>
            Outcome is a messenger you can run on your own server. We collect what the service
            needs in order to work, and nothing beyond it. There is no advertising, no analytics
            SDK, no third-party tracker and no profiling anywhere in the product.
          </p>
          {E2EE ? (
            <p>
              Direct messages and one-to-one calls are end-to-end encrypted on your devices. The
              keys never leave them, so no server — ours included — can read that content.
            </p>
          ) : (
            <p>
              This installation does not use end-to-end encryption, and does not encrypt
              anything at rest. Traffic is encrypted in transit, but messages and files are
              stored in readable form and are available to whoever operates this server. What
              that protects you from, and what it does not, is set out below.
            </p>
          )}
          <p>We do not sell personal data, and we never have.</p>
        </Section>

        <Section title="Who this policy covers">
          <p>
            If you use the public server at <b>outcome.ru</b>, we are the data controller and
            this policy applies to you.
          </p>
          <p>
            If you point the app at a different Outcome server — a company's, a community's, or
            one you host yourself — the operator of that server is the controller and their
            terms apply instead. The server you are connected to is always visible on the
            sign-in screen and in settings. We receive nothing from those installations.
          </p>
        </Section>

        <Section title="What we collect">
          <p>Only the following, each for the reason given:</p>
          <ul style={listStyle}>
            <Item what="E-mail address" why="signing in, confirming the address, resetting a password and security notices. Never used for marketing." />
            <Item what="Username and profile picture" why="so people can tell who they are talking to. Both are chosen by you and visible to others." />
            <Item what="Password" why="kept only as a salted hash. We cannot read it or recover it. Accounts created through Google or Yandex have no password at all." />
            <Item what="Messages, attachments and reactions" why="the content of the service itself. What we can and cannot read is set out below." />
            <Item what="Memberships, roles and read state" why="which servers and channels you belong to, and where you stopped reading." />
            <Item what="Presence" why="whether you are online, so others know whether it is worth calling." />
            <Item what="Push token" why="an identifier issued by Apple so a notification can reach your phone. Stored only if you allow notifications." />
            <Item what="Sessions" why="so you stay signed in, and so you can sign other devices out." />
            <Item what="IP address and time of sign-in attempts" why="rate limiting and abuse defence. This is the only place an IP address of yours is recorded." />
            <Item what="Reports you send" why="bug reports and reports about messages or people, so that they can be acted on." />
          </ul>
          <p style={{ marginTop: 14 }}>
            We do not collect contacts, location, advertising identifiers, or anything from other
            apps on your device. The app asks for the microphone and camera only for calls, and
            for photos only at the moment you attach one.
          </p>
        </Section>

        <Section title={E2EE ? "End-to-end encryption, and its limits" : "Encryption, and its limits"}>
          {E2EE ? (
            <p>
              <b>Direct messages and one-to-one calls are end-to-end encrypted.</b> Keys are
              generated on your device and never sent to us. What reaches the server is
              ciphertext, and we have no way to turn it back into text or audio.
            </p>
          ) : (
            <p>
              <b>Nothing here is end-to-end encrypted.</b> This build of Outcome does not
              contain the end-to-end encryption code at all — not for direct messages, not for
              calls. Your messages are stored on this server in readable form and are available
              to whoever operates it. If you need content the operator cannot read, this is not
              the software to rely on for it.
            </p>
          )}
          <p>
            <b>Messages in server channels are not end-to-end encrypted.</b> A channel is a
            shared room whose history newcomers are meant to be able to read, and per-device keys
            cannot provide that. Channel messages are stored on the server and are readable by
            whoever operates it. Treat a channel the way you would any group chat on a hosted
            service.
          </p>
          {E2EE ? (
            <p>
              Everything is encrypted in transit with TLS either way. The algorithms are standard
              and public — X25519 key agreement with XSalsa20-Poly1305, via libsodium — with
              nothing proprietary and no key escrow.
            </p>
          ) : (
            <p>
              Everything is encrypted in transit with TLS. That protects your data from
              someone intercepting the network — not from anyone who reaches the server's
              disks, and not from the operator of the server itself.
            </p>
          )}
        </Section>

        <Section title="Files you send">
          <p>
            Attachments are held in object storage and served only to people with access to
            the conversation they were sent in.
            {E2EE
              ? " They are encrypted at rest with AES-256-GCM, and a file sent in a direct message is additionally encrypted end to end before it leaves your device."
              : " They are stored as uploaded — this build does not encrypt them at rest — so whoever operates the server can open them."}
          </p>
        </Section>

        <Section title="Calls">
          <p>
            Voice and video are relayed through our own media server. They are not recorded and
            nothing is written to disk. We keep only who is currently in which room, so the app
            can show it, and that is removed when the call ends.
          </p>
          <p>
            Noise suppression runs entirely on your own device: the audio is filtered before it
            is encrypted and sent, and the filter never touches the network.
          </p>
        </Section>

        <Section title="Push notifications">
          <p>
            To deliver a notification we hand Apple a device token and the notification payload.
            {E2EE
              ? " For a direct message that payload is the same ciphertext the server holds — your phone decrypts it locally in a notification extension, which is why you can read the message on the lock screen while neither we nor Apple can."
              : " If the preview is on, that payload contains the message text, so it passes through Apple in readable form."}
          </p>
          <p>
            You can switch the preview off in settings, leaving notifications that say only that
            a message arrived. Turning notifications off in iOS stops them altogether.
          </p>
        </Section>

        <Section title="Signing in with Google or Yandex">
          <p>
            Optional. If you use it, the provider gives us your e-mail address and name so an
            account can be created or matched — nothing else, and your password with them is
            never shared with us. Their own privacy policy governs their side of it. You can sign
            up with an e-mail address instead and never involve them at all.
          </p>
        </Section>

        <Section title="Who else sees your data">
          <p>Three parties, each for one narrow job:</p>
          <ul style={listStyle}>
            <Item what="Apple" why="delivers push notifications to iOS devices, receiving the device token and the payload described above." />
            <Item what="Google or Yandex" why="only if you choose to sign in with them, and only at the moment you do." />
            <Item what="Our mail server" why="sends confirmation and password-reset messages. It is a machine we run, not a third-party service." />
          </ul>
          <p style={{ marginTop: 14 }}>
            Nobody else. We do not share, rent or sell data, and there is no analytics or
            advertising provider in the product to share it with.
          </p>
          <p>
            We disclose data to authorities only where a valid legal demand compels us, and then
            only what we actually hold
            {E2EE ? " — which, for direct messages and calls, is ciphertext we cannot decrypt." : "."}
          </p>
        </Section>

        <Section title="Cookies and tracking">
          <p>
            The web app keeps your sign-in token and your own settings in the browser, so that
            you stay signed in and your preferences survive a reload. There are no advertising
            cookies, no tracking pixels and no cross-site identifiers.
          </p>
        </Section>

        <Section title="How long we keep things">
          <ul style={listStyle}>
            <Item what="Messages and attachments" why="until you or a moderator delete them, or the server is shut down." />
            <Item what="Sign-in attempt records" why="kept only as long as rate limiting needs them." />
            <Item what="Sessions" why="until they expire or you sign that device out." />
            <Item what="Server logs" why="rotated continuously and kept for days, not months." />
          </ul>
        </Section>

        <Section title="Deleting your account">
          <p>
            Settings → Delete account, confirmed with your password. No e-mail to us, no waiting
            on support. It takes effect immediately:
          </p>
          <ul style={listStyle}>
            <Item what="Your messages" why="marked deleted and no longer shown to anyone." />
            <Item what="Memberships" why="removed; any server you own is closed and its members released." />
            <Item what="Sessions and call state" why="destroyed, so the account cannot keep acting anywhere." />
            <Item what="Push tokens" why="deleted, so no notification can reach your devices afterwards." />
            <Item what="Invites you issued" why="revoked." />
          </ul>
          <p style={{ marginTop: 14 }}>
            The account record itself is retained in a deleted state, so that the address cannot
            quietly be re-registered by someone else while reports referring to it are still
            open. Ask at {mail} and we will erase that too.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You may ask for a copy of the data we hold about you, ask for it to be corrected, or
            ask for it to be erased. Write to {mail} from the address on the account and we will
            answer within 30 days. Most of it you can do without us: your profile is editable in
            settings, your messages are deletable, and your account is deletable without asking
            anyone's permission.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Passwords are stored hashed. Transport is TLS throughout.
            {E2EE ? " Files are encrypted at rest, and direct messages and calls are encrypted end to end." : " Nothing is encrypted at rest."} The
            administrative interface is reachable only from the operator's own network.
          </p>
          <p>
            No system is perfect. If you find a vulnerability, write to {mail} — we would much
            rather hear it from you than from an incident.
          </p>
        </Section>

        <Section title="Children">
          <p>
            Outcome is not intended for children under 13, and we do not knowingly collect data
            from them. If you believe a child has created an account, write to {mail} and we will
            remove it.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If this policy changes in a way that affects what we collect or who sees it, we will
            say so in the app rather than quietly editing this page. The date at the top always
            reflects the version you are reading.
          </p>
        </Section>

        <Section title="Contact">
          <p>Questions about this policy, or about the data we hold on you: {mail}</p>
        </Section>
      </div>
    </div>
  );
}
