# Contributing

## What you need

| | |
| --- | --- |
| .NET SDK 10 | the server |
| Node 20 | the web client |
| Flutter 3.44+ and Xcode | the iOS app, macOS only |
| Docker | Postgres, Redis, Garage and LiveKit while you work |

macOS, Linux and Windows all work — nothing in the toolchain is platform-specific any more.

## Commands

Backend from `ServerDotnet/`, frontend from `frontend/`, mobile from `mobile/`.

```bash
# Server
dotnet build
dotnet run --project Outcome.Api          # :5000

# Web client
npm install
npm run dev                               # Vite, proxies /api to :5000
npm run typecheck                         # tsc --noEmit — run this before pushing
npm run build

# iOS
flutter run -d <simulator udid> --dart-define=OUTCOME_HOST=127.0.0.1:8099
```

The backing services are easiest to borrow from the deployment kit's compose file. See
[quick-start.md](quick-start.md).

## Checks that exist

There is no unit-test project on the server: `dotnet build` is the gate there. On the client, `npm run typecheck` is the gate that matters — it is what catches a dangling
reference after something is removed.

## Conventions

- Branch off **`dev`**; `main` is stable releases. PRs target `dev`.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.
- C#: standard `dotnet format` layout. TypeScript: the repo's tsconfig is strict — keep it that
  way rather than widening it for one call site.
- Comments explain **why**, not what. A comment restating the line above it is noise; a comment
  saying which bug the line prevents is why the line survives the next refactor.

## Two things that are defined once

**Protocol message types.** The server's `Outcome.Api/Realtime/WsFrames.cs` and the client's
`lib/protocolTypes.ts` describe the same wire. Change one and the other has to move with it —
nothing checks this for you.

**Permissions.** Role ids and permission bits live in one place on the server. Never redefine
them client-side; read them from what the server sends.

