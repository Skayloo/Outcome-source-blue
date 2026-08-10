# Database schema

Postgres, through EF Core. There are no hand-written migration files to read — the model in
`ServerDotnet/**/*DbContext.cs` and its entity configurations are the source of truth, and the
tables below are generated from it.

Runtime queries go through PgBouncer with `No Reset On Close=true`. **Migrations must not**:
they take a session advisory lock, and transaction pooling breaks that silently, which is why
the server keeps a second connection string (`ConnectionStrings__PostgresDirect`) pointed
straight at Postgres.

## Tables (26)

| DbSet | Entity |
| --- | --- |
| `Attachments` | `Attachment` |
| `AuditLog` | `AuditLogEntry` |
| `BugReports` | `BugReport` |
| `Channels` | `Channel` |
| `ChannelMutes` | `ChannelMute` |
| `ChannelOverrideClaims` | `ChannelOverrideClaim` |
| `DeviceTokens` | `DeviceToken` |
| `DmOpenStates` | `DmOpenState` |
| `DmParticipants` | `DmParticipant` |
| `Emojis` | `Emoji` |
| `Friendships` | `Friendship` |
| `GuestLinks` | `GuestLink` |
| `Invites` | `Invite` |
| `LoginAttempts` | `LoginAttempt` |
| `Messages` | `Message` |
| `MessageReports` | `MessageReport` |
| `Reactions` | `Reaction` |
| `ReadStates` | `ReadState` |
| `Servers` | `Server` |
| `ServerMembers` | `ServerMember` |
| `Sessions` | `Session` |
| `Settings` | `Setting` |
| `Sounds` | `Sound` |
| `UserBlocks` | `UserBlock` |
| `VoiceListens` | `VoiceListen` |
| `VoiceStates` | `VoiceState` |

## Permissions

Permissions are an `int64` bitfield, defined once in
`Shared/Outcome.Abstractions/Authorization/Permissions.cs`. Every package imports from there;
nothing redefines them, least of all the client.

| | Bit | Mask |
| --- | --- | --- |
| `SendMessages` | `1L << 0` | `0x00000001` |
| `ReadMessages` | `1L << 1` | `0x00000002` |
| `AttachFiles` | `1L << 5` | `0x00000020` |
| `AddReactions` | `1L << 6` | `0x00000040` |
| `UseSoundboard` | `1L << 8` | `0x00000100` |
| `ConnectVoice` | `1L << 9` | `0x00000200` |
| `SpeakVoice` | `1L << 10` | `0x00000400` |
| `UseVideo` | `1L << 11` | `0x00000800` |
| `ShareScreen` | `1L << 12` | `0x00001000` |
| `ManageMessages` | `1L << 16` | `0x00010000` |
| `ManageChannels` | `1L << 17` | `0x00020000` |
| `KickMembers` | `1L << 18` | `0x00040000` |
| `BanMembers` | `1L << 19` | `0x00080000` |
| `MuteMembers` | `1L << 20` | `0x00100000` |
| `ManageRoles` | `1L << 24` | `0x01000000` |
| `ManageServer` | `1L << 25` | `0x02000000` |
| `ManageInvites` | `1L << 26` | `0x04000000` |
| `ViewAuditLog` | `1L << 27` | `0x08000000` |
| `Administrator` | `1L << 30` | `0x40000000` |

`Administrator` bypasses every check — do not test for it alongside another bit, test for the
bit and let the helper handle the bypass.

### Channel overrides

A channel can grant or deny per role, Discord-style:

```
effective = (rolePermissions & ~deny) | allow
```

Deny is applied before allow, so an explicit grant on the channel wins over a deny on the same
channel. The order matters and is the usual source of "why can this role still post".

## Multi-tenancy

Rows are scoped to a space. `CurrentServerMiddleware` resolves which one from the request, and
a singleton that needs a scoped repository creates a scope **for that space** rather than
capturing one — a cached scope is how one tenant ends up reading another's rows.

## Soft deletion

Users and messages are marked deleted rather than removed: `deleted`, `deleted_at`. A deleted
account keeps its row so the address cannot be quietly re-registered while reports referring to
it are open. Queries filter on it; a query that forgets to is how deleted content reappears.

---

Generated from the EF model. If you add a `DbSet`, this list is stale until it is regenerated.
