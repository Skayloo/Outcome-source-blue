# Security

## Reporting a vulnerability

Mail **bikachi84@gmail.com**. Please do not open a public issue for a security bug — the
repository that carries the server source is private, but the deployment kit and the blue
source are not, and an issue there is a disclosure.

What helps: what you did, what happened, and which edition and version (`/health` reports
both). A proof of concept is welcome and not required.

Rough commitments: acknowledged within 48 hours, a fix for anything critical inside a week,
everything else in the next release.

## What the product actually protects

This build encrypts nothing end to end and nothing at rest. Messages, calls and uploads are
readable by the server, which is yours — that is the whole trade a self-hosted install makes,
and it is worth being plain about rather than implying otherwise. Everything below is about
the protections that DO apply: transport, authentication, authorisation and rate limiting.

## Authentication

- Passwords are stored as Argon2 hashes. There is no path that recovers one.
- Sessions are JWTs signed with `JwtAuth:JwtKey`. Rotating that key signs everyone out, which
  is the intended way to end a compromise.
- TOTP two-factor is available per account and can be required server-wide. Login answers
  `requires_2fa` with a short-lived partial token rather than a session.
- Sign-in attempts are rate limited per IP and globally.

## The proxy header, and why it is ignored by default

`Server:TrustedProxies` is **empty** out of the box, and while it is empty
`X-Forwarded-For` is not read at all — the peer address is the client address.

That is deliberate. Every rate limit and every ban keys off the client IP; believing a header
that anyone can set hands all of them to the attacker. Behind a reverse proxy, list the
proxy's CIDR explicitly. Listing `0.0.0.0/0` is the same as having no rate limiting.

## Admin surface

The admin console is restricted to `Server:AdminAllowedCidrs`, which defaults to loopback and
the RFC1918 ranges. Reaching it from the internet requires deliberately widening that.

## Uploads

Size is capped server-side (`Upload:MaxSizeMb`, default 100 MB) and again at the edge, so an
oversized body is rejected before it reaches the API. Files are served only to people with
access to the conversation they were posted in.

## Known limitations

- Binaries and images are not signed. Verify Docker image digests if that matters to you.
- The blue edition stores message text and uploads in readable form. That is not a bug; it is
  what that edition is, and it is stated wherever it could be misread.
