# Multiplayer API and storage boundary

The browser uses the existing Go Fish HTTP API. Storage is an internal, server-only API; it is not a publicly accessible CRUD endpoint.

```text
React GoFish component
  -> /api/gofish                         HTTP requests and private views
  -> GoFishService / RoomStore           authorization and game orchestration
     -> RoomRepository                  metadata, presence, leases, recovery journal
        -> RedisRoomRepository          currently selected storage adapter
     -> DeckGateway                     Deck of Cards API decks and piles
```

`src/server/application.ts` connects the concrete implementations. It is the only production module that selects Redis. `RoomStore` requires a `RoomRepository` in its constructor and never imports Redis or reads storage credentials. A repository does not know about Astro, HTTP responses, React, or Deck of Cards API.

## Public HTTP API

The browser contract remains the same when storage changes:

| Request | Input | Success response |
| --- | --- | --- |
| `GET /api/gofish` | None | `RoomSummary[]` |
| `GET /api/gofish?room=ABCDEF` | Seat bearer token | `RoomView` for that player |
| `POST /api/gofish` | `{ "type": "create", "name": "Host" }` | `{ token, room }`, HTTP 201 |
| `POST /api/gofish` | `{ "type": "join", "code": "ABCDEF", "name": "Guest" }` | `{ token, room }` |
| `POST /api/gofish` | `{ "type": "start", "code": "ABCDEF", "version": 1 }` + seat token | Updated `RoomView` |
| `POST /api/gofish` | `{ "type": "ask", "code": "ABCDEF", "version": 2, "opponent": "player-id", "rank": "ACE" }` + seat token | Updated `RoomView` |
| `POST /api/gofish` | `{ "type": "leave", "code": "ABCDEF" }` + seat token | `{ "left": true }` |
| `GET /api/gofish-cleanup` | Cron bearer secret | `{ processed, failed? }` |

POST requests use `Content-Type: application/json`; tokens use `Authorization: Bearer <token>`. Responses have `Cache-Control: no-store`. Errors use `{ "error": "message" }`. Clients receive their own hand and public opponent information, never stored `RoomRecord` objects, deck IDs, or token hashes.

`src/server/http/` owns JSON validation, request limits, origin checks, bearer-token extraction, cron-secret checks, and HTTP error mapping. The route files in `src/pages/api/` connect these handlers to the configured service. `GoFishService` describes the operations the handlers may call; tests can supply a separate service without changing global application objects.

## Internal storage API

The complete contract is documented on each method in [`RoomRepository`](../src/server/storage/room-repository.ts). Records and policy constants live in [`room-types.ts`](../src/server/room-types.ts).

| Concern | Methods | Requirement |
| --- | --- | --- |
| Room discovery | `create`, `read`, `list`, `due` | Atomic creation/capacity checks; detached records; cleanup scheduling |
| Presence | `presence`, `heartbeat` | Refresh existing seats without reviving expired or removed seats |
| Coordination | `acquire`, `owns`, `release` | Exclusive, expiring ownership shared across server instances |
| Persistence | `save`, `remove` | Verify ownership and update metadata/presence/index atomically |

`StorageError` carries a provider-independent code: `configuration`, `unavailable`, `capacity`, or `conflict`. The HTTP layer maps these to stable public messages and statuses (503 or 409). Provider diagnostics and credentials are never included in those responses. Redis HTTP/network/JSON failures are normalized inside its adapter.

The adapter must retain pending operation records as part of room metadata. These temporarily contain card codes, but persistent hands, books, and stock remain in Deck of Cards API piles. The service persists each intended operation before calling the external API, then checkpoints completion. Replacing storage must preserve that ordering.

## Adding another provider

1. Add a server-side implementation of `RoomRepository`, for example a PostgreSQL adapter in `src/server/storage/`. Translate provider errors into `StorageError`.
2. Implement the contract's atomic operations using the provider's transactions or conditional writes. A plain read followed by an unconditional write is insufficient for seat claims, capacity limits, and lock ownership.
3. Use expiring owner-token leases for room coordination. Keep database transactions short; do not hold one open while calling Deck of Cards API. External card mutations must also stay outside any transaction callback that the database may automatically retry.
4. Select the new adapter in `src/server/application.ts` by passing it to `new RoomStore(repository)`. Keep configuration lazy so missing multiplayer credentials do not prevent Solitaire from loading.
5. Exercise the existing service and HTTP tests against the adapter, with particular attention to simultaneous joins, lost ownership, heartbeats racing with saves, expired seats, and recovery after an interrupted write. Verify the real provider's atomic behavior separately; the in-memory test double is not a database integration test.

The React components, game rules, `GoFishService`, HTTP payloads, and Deck API integration should not need changes. Switching providers does not migrate active games; either migrate their metadata deliberately or let those short-lived games finish first.

Redis remains the only production adapter included. The in-memory repository in `tests/helpers.ts` is a test double, not a Vercel storage option.

## Adding controlled multiplayer access later

A class-code or account check can be added at the HTTP boundary before invoking the game service. Apply it to lobby reads, room reads, and every multiplayer mutation; retain the per-seat checks in `RoomStore`. The cleanup endpoint continues to use its separate cron secret. Solitaire remains public and independent of multiplayer storage. This refactor adds no class-code or account login yet.

## Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`. The HTTP tests construct handlers with injected services, verify that instances share only their supplied storage, and check stable errors without leaking provider details. Existing game tests cover private hands, concurrent joins, stale actions, disconnect returns, and recovery across fresh service instances. Redis tests verify REST encoding and failure translation without needing credentials.
