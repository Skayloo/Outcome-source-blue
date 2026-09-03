# PRODUCT.md

Strategic context for design work. `CLAUDE.md` covers how the code is built; this covers who
it is for and what it should feel like.

## Register

**Both, split by surface.**

- **Brand** — `frontend/public/landing.html` and `/privacy`. Static hand-written HTML at the
  apex domain. Design IS the product here: it is the only thing a stranger sees before deciding.
- **Product** — everything under `/app` (the React SPA) and `mobile/`. Design SERVES the work:
  people live in it for hours, and the interface should get out of the way.

Do not let the landing's voice leak into the app, or the app's restraint into the landing.

## What it is

Outcome is a self-hosted, Discord-shaped team messenger: text channels, DMs, voice and video,
roles, an admin console. It runs on hardware the customer owns. No cloud dependency, no
telemetry, no paid tiers.

## Who it is for

- **Teams that cannot use a cloud messenger.** Not "privacy enthusiasts" — organisations with a
  policy, a regulator, or a client contract that forbids it. They are not shopping for features;
  they are shopping for a place to put their conversations that is legally theirs.
- **One technical person inside that team** who will actually run `docker compose up`, and who
  has to convince everyone else that it will not be worse than what they use now.

The second reader is the harder one. The landing has to survive being forwarded to a manager.

## The two editions — the one thing never to blur

`docs/encryption.md` is the source of truth and says it outright:

> Red's guarantee is *the server cannot read this*. Blue's guarantee is *the server is yours*.
> Both are real; they are just not the same promise, and claiming red's on blue's behalf is the
> mistake this page exists to prevent.

**RED** (`outcome.ru`, commercial): end-to-end encrypted DMs and calls, encrypted uploads.
**BLUE** (the public images anyone self-hosts): no end-to-end encryption at all.

Every user-facing claim must name the edition it belongs to. A page that says "run it yourself"
and "your messages are encrypted" in the same breath is lying to whoever follows the advice.
This has already gone wrong once, in the RuStore listing.

## Brand personality

Three words: **plain, self-possessed, unhurried.**

- **Plain** — say the mechanism, not the adjective. "Runs on your hardware" beats "enterprise-grade
  sovereignty". The audience can tell the difference and is tired of the second kind.
- **Self-possessed** — no apologising for being small, no comparing itself to Slack in every line.
  Blue is not a crippled Red; it is a different promise.
- **Unhurried** — no urgency theatre, no countdowns, no "join 10,000 teams". The decision this
  page supports takes weeks and involves other people.

## Anti-references

- **Urgency-driven SaaS.** Gradient hero, floating testimonial cards, "trusted by" logo wall of
  companies nobody recognises, a pricing table with a highlighted middle column.
- **Privacy-doom marketing.** Padlocks, shields, hooded figures, dark-web green-on-black. The
  product is a workplace tool, not a threat model.
- **Editorial-magazine cosplay.** Display serif italic, ruled columns, tracked lowercase labels.
  Fashionable and wrong for a thing you install with a shell command.

## Design principles

1. **Show the product.** Fifty real screenshots exist in `docs/images/`. A screenshot of the
   actual app beats any illustration of an abstract concept.
2. **The page must work dead.** No bundle, no API, JavaScript off. The landing is hand-written in
   `public/` for exactly this reason — it has to render when the app build is broken.
3. **Russian first.** The audience reads Russian; the interface ships RU and EN. Copy is written
   in Russian and not translated from English phrasing.
4. **Every claim carries its edition.** See above.

## Brand assets

Font **Onest** (variable, Cyrillic-native), self-hosted in `frontend/public/fonts/`. Committed
identity — not up for reflex-rejection.

Palette from the app's Graphite theme (`mobile/lib/theme.dart`, `frontend/src/styles/`):
`#141118` ground · `#221D2B` surface · `#8B5CF6` iris · `#E8E4F0` ink · `#A49DB4` muted ·
`#34D399` positive.
