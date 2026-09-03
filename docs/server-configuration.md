# Server configuration

Every setting below is read by `ServerDotnet/Outcome.Api` at startup and bound to a class in
`Shared/Outcome.Core/Configuration/`. If this page and those classes ever disagree, the classes
are right — they are what the server actually reads.

## How settings get in

Three layers, later winning over earlier:

1. **`appsettings.json`** next to the binary — the defaults that ship.
2. **`appsettings.Development.json`** when `ASPNETCORE_ENVIRONMENT=Development`.
3. **Environment variables**, which is how every deployment actually configures it.

An environment variable names its section and key with a **double underscore**, prefixed
`OUTCOME_`:

```
Section:Key   in JSON   →   OUTCOME_Section__Key   in the environment
Minio:Bucket             →   OUTCOME_Minio__Bucket
OAuth:Google:ClientId    →   OUTCOME_OAuth__Google__ClientId
```

The prefix is stripped, so `OUTCOME_Minio__Bucket` fills `Minio:Bucket`. Case matches the JSON.
Connection strings are the one exception — they use the ASP.NET convention without the prefix:
`ConnectionStrings__Postgres`.

## Database

| Key | Default | |
| --- | --- | --- |
| `ConnectionStrings__Postgres` | `Host=localhost;…` | Runtime queries. Behind PgBouncer add `No Reset On Close=true` — transaction pooling does its own reset, and Npgsql's `DISCARD ALL` breaks it |
| `ConnectionStrings__PostgresDirect` | falls back to the above | Migrations only. They take a session advisory lock, which a transaction pooler silently breaks, so this must reach Postgres itself |

## Server

Bound from `Server` (`ServerOptions`).

| Key | Default | |
| --- | --- | --- |
| `Port` | `8443` | Ignored when `ASPNETCORE_URLS` is set, which is how the container runs it |
| `Name` | `Outcome Server` | Shown to clients on connect |
| `DataDir` | `data` | |
| `AllowedOrigins` | `*` | CORS |
| `TrustedProxies` | *(empty)* | CIDRs whose `X-Forwarded-For` is believed. **Empty means the header is ignored entirely** — that is deliberate. Trusting it from anyone hands every rate limit to whoever sets a header |
| `AdminAllowedCidrs` | loopback + RFC1918 | Who may reach the admin surface |

## Authentication

Bound from `JwtAuth`.

| Key | Default | |
| --- | --- | --- |
| `JwtKey` | dev placeholder | **Change it.** At least 32 bytes; sessions are signed with it, so rotating it signs everyone out |
| `JwtIssuer` | `outcome` | |
| `JwtExpirationMinutes` | `43200` (30 days) | |

## Storage (MinIO)

Bound from `Minio`.

| Key | Default | |
| --- | --- | --- |
| `Endpoint` | `minio:9000` | host:port, no scheme |
| `AccessKey` / `SecretKey` | `minioadmin` | **Change both** |
| `Bucket` | `outcome-uploads` | Created on first use |
| `UseSsl` | `false` | |
| `EncryptionKey` | *(empty)* | RED only — base64 of exactly 32 bytes, AES-256-GCM at rest. The BLUE edition has no cipher at all and ignores it; see [encryption.md](encryption.md) |

Upload size is `Upload:MaxSizeMb` (default 100). The edge has to allow at least as much or the
request never arrives.

## Voice (LiveKit)

Bound from `Voice`.

| Key | Default | |
| --- | --- | --- |
| `LiveKitApiKey` / `LiveKitApiSecret` | *(empty)* | Voice is disabled without both. The secret must be **at least 32 characters** — the SDK refuses shorter ones with "apiSecret must be at least 256 bits long" |
| `LiveKitUrl` | `ws://localhost:7880` | What the **browser** is told to connect to. Behind TLS this is the same-origin proxy, `wss://<domain>/livekit` |
| `LiveKitInternalUrl` | falls back to `LiveKitUrl` | What the **server** uses to reach LiveKit — `ws://livekit:7880` inside compose |
| `NodeIp` | *(empty)* | The SFU's public IP, advertised to browsers for media. Media bypasses the HTTP proxy, so this must be reachable |
| `Quality` | `medium` | `low` \| `medium` \| `high` |
| `LiveKitBinary` | *(empty)* | Path to a `livekit-server` the API should spawn itself instead of running one alongside |

## Mail

Bound from `Email`. With `Host` empty the server prints confirmation codes to its log instead
of sending them — fine for a first run, not for real users.

| Key | Default |
| --- | --- |
| `Host` / `Port` | *(empty)* / `587` |
| `Username` / `Password` | *(empty)* |
| `From` / `FromName` | `no-reply@outcome.local` / `Outcome` |
| `UseSsl` | `true` |

A mail outage answers **503**, not 500: the account exists and the send failed, and the two
mean different things to whoever is looking at the response.

## Single sign-on

Bound from `OAuth`. A provider turns on simply by having both halves of its credential —
clients ask `/api/v1/auth/oauth/providers` and render only what the server holds keys for.

| Key | |
| --- | --- |
| `PublicOrigin` | The public `https://` origin. The `redirect_uri` is built from it, so behind a reverse proxy it cannot be inferred from the request |
| `Google__ClientId` / `Google__ClientSecret` | |
| `Yandex__ClientId` / `Yandex__ClientSecret` | |

The callback lands at `{PublicOrigin}/api/v1/auth/oauth/{provider}/callback` — register exactly
that with the provider.

## Push notifications

A device registers the token of whichever **transport** answered on it, and the server sends
through that one. The transport is the routing key rather than the operating system, because
Android has two gateways and a token minted by one is meaningless to the other. Stored in
`device_tokens.platform`: `ios`, `rustore`, `fcm`.

Configuring none of them is a supported state — messages simply arrive over the live socket
only, as they did before push existed. An unconfigured transport logs one line and its devices
go unreachable while the app is closed; it does not delete their registrations.

### APNs (iOS)

Bound from `Apns`. Leave `Key` empty to turn it off.

| Key | |
| --- | --- |
| `Key` | The `.p8` contents as a **single line** (newlines as `\n`), which is what survives a `.env` |
| `KeyPath` | Or a path to the file, if you would rather mount it |
| `KeyId` / `TeamId` | From the Apple developer portal |
| `BundleId` | `com.outcome.outcome` |

### RuStore (Android)

Bound from `RuStorePush`. Leave `ServiceToken` empty to turn it off. Both values come from
RuStore Console → the app → Push notifications → Projects.

| Key | |
| --- | --- |
| `ProjectId` | Also compiled into the Android app — the client SDK reads it from the manifest and has no other way to be told, so it is **not** a secret |
| `ServiceToken` | Authorises sending. This one **is** the secret and must never reach a client |
| `BaseUrl` | Defaults to `https://vkpns.rustore.ru`; override only to point a test elsewhere |

Requires the RuStore app installed on the device and the user signed into it. For an audience
that installed Outcome *from* RuStore this holds by construction, which is why this transport
is the one to configure first.

### FCM (Android)

Bound from `Fcm`. Leave both keys empty to turn it off.

| Key | |
| --- | --- |
| `Credentials` | The service-account JSON itself, for deployments that inject secrets as env vars |
| `CredentialsPath` | Or a path to the file. Ignored when `Credentials` is set |

Firebase Console → Project settings → Service accounts → Generate new private key. This is
**not** the `google-services.json` that ships inside the Android app: that one identifies the
app to Google, this one authorises sending to it. Putting the second where the first goes hands
anyone who unzips the APK the ability to push to every install.

RuStore does not cover this. Its console configures its own transport only — there is no field
there for a Firebase key — so a phone that has Google services but no RuStore is reachable only
by talking to FCM directly, which is what this sender does.

## TLS

Bound from `Tls`. `Mode` is `off` \| `self_signed` \| `acme` \| `manual`. Behind Caddy or an
ingress leave it `off` — the edge terminates TLS and the server speaks plain HTTP to it.

## Edition

`OUTCOME_EDITION` is **baked into the image**, not configured: an image *is* its edition. It is
reported by `/health` and decides whether the storage cipher exists at all.
