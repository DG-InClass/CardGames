# Card Table

An Astro + React app for short-lived Solitaire and multiplayer Go Fish, using [Deck of Cards API](https://www.deckofcardsapi.com/). The app uses [Astro's Vercel adapter](https://docs.astro.build/en/guides/integrations-guide/vercel/) and supports independent serverless function instances.

## Run locally

Requires Node.js 22.22+ and pnpm.

```sh
pnpm install
```

Copy `.env.example` to `.env` and supply an Upstash Redis REST URL and **read/write** token. These are server-only values; never prefix them with `PUBLIC_`. Go Fish requires Redis in development too. Without it, the lobby explains the missing configuration and Solitaire remains available.

```sh
pnpm dev
pnpm dev:status
pnpm dev:logs
pnpm dev:stop
pnpm check
pnpm test
pnpm build
```

The dev script uses `astro dev --background`. Open http://localhost:4321. For players on the same network, use `pnpm dev --host 0.0.0.0` and share Astro's Network URL. A localhost invite only works on the host computer.

## Deploy on Vercel

1. Import the repository into Vercel. If this app is within a larger repository, set the project Root Directory to `RnD/CardGames`. Use the Astro framework preset and `pnpm build`.
2. Connect an Upstash Redis database through the Vercel Marketplace, or use an existing database's REST credentials.
3. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel. The `KV_REST_API_URL` / `KV_REST_API_TOKEN` aliases are also accepted. Use a database near the Vercel function region.
4. Set `CRON_SECRET` to a long random value. Vercel supplies it as a bearer token when invoking `/api/gofish-cleanup`.
5. Deploy. `vercel.json` registers a daily cleanup job; the adapter sets the function maximum duration to 60 seconds. No continuously running Node server or WebSocket server is required.

`CARD_TABLE_NAMESPACE` optionally selects a Redis key namespace. Leave it unset on Vercel to use `production` or a namespace unique to each preview deployment. Locally it defaults to `local`. If you override it, use different values for local, preview, and production. Do not copy the example's `local` namespace into production. Credentials and namespaces are described in `.env.example`.

The daily cron schedule works with Vercel Hobby. Active clients remove disconnected seats during polling, after the 45-second grace period. If **everyone** closes the app, card returns wait for a cleanup invocation or a subsequent create/join request that processes that room. Cleanup processes a bounded batch; unfinished rooms remain queued. For faster cleanup of fully abandoned games on a plan that supports it, change the cron schedule to `* * * * *`. [Vercel's cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) permit daily jobs on Hobby and minute-level jobs on Pro/Enterprise. Cron jobs run on production deployments; preview/local cleanup is driven by requests or a manual authenticated cleanup call.

Redis command usage and Deck API calls grow with the number of polling players. Keep an eye on the limits of the database and Vercel plan you choose. This is a casual public lobby, without accounts, private-room passwords, or durable scores.

## Games

- **Solitaire:** draw-one Klondike, unlimited stock recycling, legal stack/foundation moves, automatic reveals, undo (last 100 moves), hints, move count, and a timer. Click a face-up card, then its destination. A new deal or page reload ends that local game.
- **Go Fish:** public waiting lobby, room codes and invite links, two to four human players, host-controlled start, private hands, enforced turns, automatic fishing/books/refills, scorecard, game log, and tied winners. Two players receive seven cards each; three or four receive five. A matching fish earns another turn. Empty hands refill with up to five cards while stock remains.

Each Go Fish tab stores its private seat token in `sessionStorage`. Reloading within 45 seconds restores that seat. For local multiplayer testing, open independent tabs from the address bar; duplicating a tab can copy its session and resume the same seat. Keep the tab open while playing. Browsers that suspend a background tab may stop its heartbeat.

## State and recovery

The game uses a provider-independent server API. HTTP handlers depend on `GoFishService`; the game service depends on `RoomRepository`. Redis is selected in `src/server/application.ts`. See [the storage boundary guide](docs/storage-boundary.md) for the HTTP contract, adapter guarantees, and how to add another storage provider.

Deck of Cards API is the source of truth for the cards:

- `stock` holds the pond in a named API pile.
- `hand_<player-id>` holds each player's hand.
- `books_<player-id>` holds their completed books.

The server lists these piles to reconstruct the game for each action. A shuffled deck is drawn once at the start and distributed into piles. Subsequent moves transfer specific card codes between piles; there is no authoritative in-memory hand or stock. Solitaire continues to manage its initial API deal in the browser.

Redis stores the room code, external deck ID, player names and hashed seat tokens, turn, public book ranks, log, version, expiry, heartbeats, and a per-room lock. A temporary operation journal contains card codes only while an API operation is unfinished. Completed moves leave no hands or stock in Redis. Browsers receive only their own hand plus opponents' counts and book ranks, never the deck ID or another player's token.

Moves are serialized by Redis locks and checked against the client's room version. Before updating a pile, the server saves the intended operations. It checkpoints each completed operation. A new function instance can resume the journal after a timeout or lost response. Pending moves pause play and recover on the next poll, request, or cleanup invocation. There is no background interval or process-local room map. The lock outlives the configured function duration, and ownership is checked before each external mutation and Redis write.

Leaving explicitly, losing a heartbeat for **45 seconds**, or reaching the room's **two-hour** lifetime returns both hand and books through the API's pile-return endpoints. Those cards are then drawn into the shared remote `stock` pile and that pile is shuffled. Recovery normalizes cards left in the main deck, unpiled, or already in stock, so an interrupted draw/add can be retried. Departing players are removed together before remaining hands refill. Host and turn pass to survivors; an active game with fewer than two players ends. Empty rooms are deleted after pending returns finish. Waiting tables accept replacements; games in progress do not. Capacity is capped at 100 rooms per namespace.

Deck of Cards API retains decks for **two weeks after their last use**; this is separate from the app's two-hour room lifetime. Redis metadata has a 14-day recovery TTL, refreshed by room writes. The external API's retention keeps cards available between function invocations, while Redis supplies the lobby, identity, turn, presence, and locking features that the card API does not provide. No Deck API key is required. See the [deck/pile API documentation](https://www.deckofcardsapi.com/).

Card faces are accessible HTML/CSS rendered from API rank/suit data. Gameplay does not depend on remote card-image loading. The card service and optional Google Fonts require an internet connection; system fonts are the fallback.

## Source and verification

- `src/components/` — React game screens and shared cards.
- `src/lib/solitaire.ts` and `src/lib/go-fish.ts` — game rules.
- `src/lib/deck-api.ts` — external deck/pile operations and return recovery.
- `src/server/application.ts` — production wiring and storage-provider selection.
- `src/server/go-fish-service.ts` — application API consumed by HTTP handlers.
- `src/server/rooms.ts` — storage-independent orchestration, privacy, disconnect cleanup, and retry journal.
- `src/server/storage/room-repository.ts` — storage API, atomicity requirements, and portable errors.
- `src/server/storage/redis.ts` — Redis REST adapter and atomic Lua operations.
- `src/server/http/` — request validation, injected handlers, and public error responses.
- `src/pages/api/gofish.ts` — same-origin JSON API.
- `src/pages/api/gofish-cleanup.ts` — secret-protected cleanup endpoint.
- `tests/` — rules, complete simulated games, shared-storage instances, concurrency, private hands, disconnects, API recovery, Redis request encoding, and HTTP routes. Test doubles run without credentials; they do not provision or verify a live Redis database.

For an optional smoke check against the real card service, run `pnpm exec tsx tests/live-deck-smoke.ts`. This creates a temporary deck, plays a move, removes all three seats, and verifies that all 52 unique cards return to the remote stock pile. It uses a test repository for metadata and does not require Redis credentials.
