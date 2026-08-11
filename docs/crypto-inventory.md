# Cryptographic inventory

Prepared for an export-control classification of Outcome under the EAR. It states what the
product does cryptographically and where; it draws no legal conclusion, assigns no ECCN, and
takes no position on which regime or licence exception applies.

Every entry below was read out of the source, not recalled. Line references are to the RED
tree at the time of writing.

## Two editions, and the difference matters here

Outcome ships as two distinct products built from one tree.

**RED** is the commercial edition — the hosted service at `outcome.ru` and partner
deployments. It is the edition described in every section below.

**BLUE** is the self-hosted edition, published both as prebuilt images and as source
(github.com/Skayloo/Outcome-source-blue — readable, and licensed for nothing else).
Encryption is not disabled in it, it is **removed**: `deploy/export-blue.sh` deletes the
modules, the key exchange, the storage cipher and every call site, then refuses to finish if
any of it survives (12 leak checks). Blue therefore contains no end-to-end encryption, no frame
encryption and no storage
cipher. Only TLS at the edge remains.

The iOS and web clients are one binary each, shared by both editions. The client-side
cryptography listed below is present in the binary regardless of which server it connects to;
whether it is exercised depends on the server.

## 1. End-to-end encryption of direct messages

Client-side only. The server relays ciphertext and holds no key material.

| | |
| --- | --- |
| Key agreement | X25519 (Curve25519) |
| Message encryption | NaCl `box` — Curve25519-XSalsa20-Poly1305 |
| Symmetric strength | XSalsa20, 256-bit key; Poly1305 authentication |
| Nonce | 24 bytes, from the library CSPRNG |
| Web implementation | `tweetnacl` 1.0.3 (`frontend/src/lib/e2ee.ts`) |
| iOS implementation | `pinenacl` 0.6.0 (`mobile/lib/services/e2ee.dart`) |
| Private key storage | iOS Keychain via `flutter_secure_storage`; browser IndexedDB |

Each device holds a long-term X25519 identity keypair. Only the public half reaches the
server. Nothing in this path uses the operating system's cryptography — both libraries are
bundled into the application.

## 2. Password-wrapped backup of the identity key

So a user can restore their messages on a new device.

| | |
| --- | --- |
| Key derivation | PBKDF2-HMAC-SHA256, **210 000 iterations**, 32-byte output |
| Wrapping | NaCl `secretbox` — XSalsa20-Poly1305 |
| Web implementation | WebCrypto `crypto.subtle.deriveBits` (`frontend/src/lib/e2ee.ts:95`) |
| iOS implementation | `pointycastle` 4.0.0 (`PBKDF2KeyDerivator`, `HMac`, `SHA256Digest`) |

The web client derives through the browser's own WebCrypto; the iOS client derives in a
bundled library, because the two must produce identical output. The passphrase never leaves
the device.

## 3. End-to-end encryption of voice and video

Frame-level encryption between participants. The SFU (LiveKit) forwards ciphertext and is not
given the room key.

| | |
| --- | --- |
| Frame cipher | AES-GCM, 12-byte IV (`livekit-client`, insertable streams) |
| Room key distribution | wrapped per recipient with NaCl `box` (X25519 + XSalsa20-Poly1305) |
| Relay | the server forwards the wrapped key opaquely — `WebSocketHandler.cs:565`, "blind relay" |
| Guests | a guest joining by link receives the same room key, so guest audio is encrypted too |

The frame cipher is the browser's own AES-GCM, reached through the WebRTC encoded-transform
API. The key exchange that feeds it is the bundled NaCl implementation.

## 4. Encryption of uploaded files at rest

Server-side, RED only. `Shared/Outcome.Core/Storage/MinioFileStorage.cs`.

| | |
| --- | --- |
| Cipher | AES-256-GCM (.NET `System.Security.Cryptography.AesGcm`) |
| Structure | chunked, 64 KiB per chunk |
| Authentication | the object id and chunk index are bound in as AAD |
| Key | operator-supplied, from the `MINIO_ENC_KEY` environment variable |

This is the operating system's / runtime's own cryptography — .NET's `AesGcm`, no third-party
library. Blue has a cipher-free replacement (`MinioFileStorage.blue.cs`) and cannot read what
red wrote; a separate migration tool exists for that reason.

## 5. Authentication and transport

Neither is about confidentiality of user content.

| Use | Primitive | Where |
| --- | --- | --- |
| Password storage | **Argon2id** | server, `Argon2PasswordHasher` |
| Session tokens | JWT, **HMAC-SHA256** (HS256) | server |
| Media-server tokens | JWT, HMAC-SHA256 | server → LiveKit |
| Transport | TLS 1.2/1.3, certificates from Let's Encrypt via Caddy | edge |
| TURN relay | TLS, same certificate | LiveKit (currently disabled) |

Argon2id and the JWT signing are the .NET runtime and a standard library; TLS is the
platform's.

## 6. Summary — bundled versus platform cryptography

The distinction an export classification usually turns on:

**Bundled into the application** (not the operating system's):

- `tweetnacl` (web) — X25519, XSalsa20-Poly1305
- `pinenacl` (iOS) — X25519, XSalsa20-Poly1305
- `pointycastle` (iOS) — PBKDF2-HMAC-SHA256

**Used from the platform:**

- WebCrypto — PBKDF2, AES-GCM (web)
- .NET `AesGcm`, Argon2id, HMAC-SHA256 (server)
- TLS (Caddy / OpenSSL, and the OS on each client)

**Nothing proprietary.** Every algorithm above is published and standardised: X25519
(RFC 7748), XSalsa20-Poly1305 (NaCl / RFC 8439 family), AES-GCM (NIST SP 800-38D), PBKDF2
(RFC 8018), Argon2id (RFC 9106), SHA-256 (FIPS 180-4), HMAC (RFC 2104), TLS (RFC 8446).

No algorithm is modified, and none is used outside its published parameters.

## 7. Distribution

| | |
| --- | --- |
| iOS | Apple App Store, worldwide availability, free |
| Web | served from the operator's own deployment |
| Self-hosted images | Docker Hub, public, **contain no encryption** |
| Self-hosted source | github.com/Skayloo/Outcome-source-blue, public, readable but not open source |
| Developer / operator | Russia |
| Primary market | Russia |

## What this document does not say

It does not classify the product, name an ECCN, claim any exemption, or assert which
authorisation applies. Those are questions for someone qualified in US export control,
which the author of this file is not. The purpose here is only to remove guesswork about
what the software actually contains.
