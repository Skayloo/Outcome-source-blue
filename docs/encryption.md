# What each edition encrypts

Outcome ships as two builds. They are not the same product with a licence check on top —
they differ by what is *compiled in*, so the public image does not contain the private code
at all. That means the honest answer to "is it encrypted?" is different for each, and every
README, policy page and marketing line has to say which one it is talking about.

This page is the source of truth. If it disagrees with something else, this page is right and
the other thing is a bug.

|                                   | RED (`outcome.ru`, commercial) | BLUE (self-hosted; images and source public) |
| --------------------------------- | ------------------------------ | -------------------------------- |
| Transport (HTTPS / WSS)           | TLS                            | TLS                              |
| Direct messages, end-to-end       | **Yes** — X25519 + XSalsa20-Poly1305, keys never leave the device | **No** — stored as typed |
| 1-on-1 calls and voice, end-to-end| **Yes** — AES-GCM per frame, the SFU forwards opaque bytes | **No** — DTLS-SRTP only, which the SFU terminates |
| Channel messages, end-to-end      | No — a shared room whose history newcomers must be able to read | No |
| Uploads at rest (MinIO)           | **Yes** — chunked AES-256-GCM  | **No** — stored as uploaded      |
| Push payload                      | Ciphertext, decrypted on the phone | The message text, if previews are on |
| Passwords                         | Salted hash                    | Salted hash                      |

## How the split is implemented

- **Client.** `frontend/vite.config.ts` aliases `@lib/e2eeSession`, `@lib/e2eeBackup` and
  `@lib/voiceKeys` to `*.blue.ts` stubs when `OUTCOME_EDITION=blue`. The crypto modules and
  tweetnacl are never emitted into the public bundle, and `__OUTCOME_EDITION__` lets pages
  like the privacy policy describe the build they are actually part of.
- **Server.** The image bakes `OUTCOME_EDITION`; `Program.cs` reports it on `/health`.
  `MinioFileStorage` reads the same variable and encrypts on write only in red.

## Storage: what blue does with an existing encrypted bucket

Blue not encrypting is a decision about what it **writes**, never about what it can **read**.

An install that has been running an earlier version has a bucket full of AES-256-GCM objects
and a `MINIO_ENC_KEY` in its `.env`. Blue keeps that key on the read path: old objects still
decrypt, new ones land in plaintext, and nothing has to be migrated. Removing the key from
the environment is what would break those files — so the deploy repo tells operators to leave
it alone.

One consequence worth knowing, because it caused a real bug: once a bucket holds both kinds
of object, a leading `0x03` byte stops being proof that an object is ours. A plain file that
happens to start with one used to reach the decrypter and fail its tag check partway through
a download. `ChunkedGcmReadStream.TryCreate` now asks GCM before committing and falls back to
serving the bytes verbatim. `ServerDotnet/tools/StorageCompatCheck` covers exactly that case,
along with the red→blue upgrade path; run it against a throwaway MinIO before touching this
code.

## Saying it out loud

The blue pitch is not a weaker version of the red one, and it should not be written as if it
were apologising. Red's guarantee is *the server cannot read this*. Blue's guarantee is *the
server is yours*: nothing leaves your infrastructure, there is no analytics, no telemetry and
no third party in the path. Both are real; they are just not the same promise, and claiming
red's on blue's behalf is the mistake this page exists to prevent.
