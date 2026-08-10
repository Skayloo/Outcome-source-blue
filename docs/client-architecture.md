# Web client architecture

React + TypeScript, built by Vite, served by nginx. There is no desktop shell any more — the
Tauri client this document used to describe is gone, and the web app is what runs everywhere a
browser does. The iOS app is a separate Flutter codebase in `mobile/`.

## Layout

```text
frontend/
├── index.html                 the app shell — an empty #root and nothing else
├── vite.config.ts             path aliases, the __OUTCOME_EDITION__ define
├── nginx.conf                 routing, CSP, the landing/app split on $host
├── public/                    served verbatim: landing.html, fonts, the DFN model, robots
└── src/
    ├── main.tsx               mounts <App/>
    ├── App.tsx                the only routing there is — see below
    ├── pages/                 one per top-level screen
    ├── components/            everything else, by feature
    ├── stores/                state, one store per domain
    ├── lib/                   services: the socket, the REST client, voice, audio
    └── styles/                CSS, including the glass layer
```

Imports use aliases rather than relative chains: `@lib/…`, `@stores/…`, `@components/…`,
`@pages/…`, `@styles/…` (declared in `tsconfig.json` and mirrored in `vite.config.ts`).

## Routing

There is no router. `App.tsx` reads `window.location.pathname` and picks a page:

| Path | |
| --- | --- |
| `/guest/<code>` | `GuestVoicePage` — rendered before any auth gate, because guests have no account |
| `/privacy` | `PrivacyPage` — public, above the gate, for people deciding whether to sign up |
| `/admin…` | `AdminPage`, owner only |
| anything else | `ConnectPage` when signed out, `MainPage` when signed in |

On the public site nginx serves a static landing at `/` and the app moves to `/app`; the app
itself does not care which path it was loaded from.

## State

One store per domain in `stores/`, ~18 of them: `auth`, `channels`, `messages`, `dm`,
`members`, `servers`, `roles`, `friends`, `voice`, `call`, `composer`, `ui`, `mobile`,
`panes`, `mutes`, `listened`, `lightbox`, `voicePlayer`.

Each holds immutable state and notifies subscribers in a batch on the microtask queue, so a
burst of updates from one socket frame repaints once. Components read them with `useStoreState`
and never write directly — they call the store's own actions.

**Data flows down, events flow up.** A component that wants to send something calls a store
action or a service; it does not touch the socket or `fetch`.

## Services

`lib/` holds everything with no DOM in it:

| | |
| --- | --- |
| `ws.ts` | The socket. Authenticates **in-band** — the first frame is `auth`, so there is no HTTP middleware on that route |
| `dispatcher.ts` | The one place a server frame turns into store writes. Every `ws.on(...)` lives here |
| `api.ts` | REST, with the server host resolved per call so the client can sign into a foreign instance |
| `livekitSession.ts` | The call: joining, publishing, reconnecting, screen share |
| `audioPipeline.ts` | Microphone processing — one noise-suppression processor per call, chosen before the graph is built |
| `noise-suppression-dfn.ts` | DeepFilterNet: fetch, warm, and the depth setting |
| `protocolTypes.ts` | The wire types, kept in step with the server's `WsFrames` |

## Editions

`vite.config.ts` defines `__OUTCOME_EDITION__`. In the RED build it is `"red"` and the
encryption modules are compiled in; the public BLUE source contains no encryption at all —
not aliased out, removed. See [encryption.md](encryption.md).

The privacy policy reads that constant to decide which promises it is allowed to make, which
is the whole reason it survived the split.

## Things that will bite

**`backdrop-filter` creates a containing block.** Any `position: fixed` descendant of a
blurred element is positioned against *that element*, not the viewport — which turns a modal
into a box trapped inside a sidebar. Modals therefore render through `ModalPortal`, into
`document.body`.

**Hooks after an early return.** A `useState` below an `if (…) return …` changes the hook count
between renders and React tears the tree down. It blanks the whole app, and it looks like a
deploy problem rather than a code one.

**The bundle is invisible to crawlers.** Everything on screen is written by JavaScript, so a
search engine fetching `/` gets an empty `#root`. That is why the public landing is static HTML
in `public/` and does not depend on the bundle at all.
