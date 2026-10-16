# Card Table

An Astro + React app for short-lived Solitaire and multiplayer Go Fish games, using [Deck of Cards API](https://www.deckofcardsapi.com/).

## Run locally

Requires Node.js 22.22+ and pnpm.

```sh
pnpm install
pnpm dev
```

The dev script uses `astro dev --background`. Open http://localhost:4321.

```sh
pnpm dev:status
pnpm dev:logs
pnpm dev:stop
pnpm check
pnpm test
pnpm build
pnpm start
```

For players on the same network, run `pnpm dev --host 0.0.0.0` and share the **Network** URL Astro prints. Everyone must connect to the same server. A `localhost` invite only works on the host computer. Allow the chosen port through the host firewall if required.

## Games

- **Solitaire:** draw-one Klondike, unlimited stock recycling, legal stack/foundation moves, automatic reveals, undo (last 100 moves), hints, move count, and a timer. Click a face-up card, then its destination. A new deal or page reload ends that local game.
- **Go Fish:** public waiting lobby, room codes and invite links, two to four human players, host-controlled start, private hands, enforced turns, automatic fishing/books/refills, scorecard, game log, and tied winners. Two players receive seven cards each; three or four receive five. A matching fish earns another turn. Empty hands immediately refill with up to five cards while stock remains.

Each Go Fish tab stores its private seat token in `sessionStorage`. Reloading within 45 seconds restores that seat. For local multiplayer testing, open independent tabs from the address bar; duplicating a tab can copy its session and resume the same seat. Keep the tab open while playing. Browsers that suspend a background tab may stop its heartbeat.

## Multiplayer lifecycle

The React client polls `/api/gofish` every two seconds. The server owns the deck, hands, books, turn order, and scores; clients receive only their own hand and opponents' card counts/book ranks. Random bearer tokens authorize each seat. Version checks reject stale or replayed moves, and mutations are serialized while an external operation is running.

A player can leave explicitly. Otherwise, after **45 seconds without a heartbeat**, the five-second cleanup loop removes their seat. Both their hand and completed books return to the shared stock, which is shuffled. The host and turn pass to remaining players; an active game with fewer than two players ends. Waiting tables can accept replacements; games already in progress cannot. Empty rooms are removed after pending card returns finish. All rooms expire after two hours; at most 100 rooms can exist at once.

## Deck API integration

The service supplies a shuffled 52-card deck for each game. Solitaire manages that deal locally. Go Fish draws the full shuffled deck into server memory so moves never depend on a browser-supplied deck ID or a non-repeatable remote draw. It mirrors player hands and books in named API piles.

On departure, the exact hand/book card codes are returned through each API pile's `return` endpoint, then drawn back into the server-held shared stock. The general deck return endpoint also recovers cards that were already drawn by an interrupted attempt. Return-then-draw can be safely repeated after an interrupted response. Pile transfers are queued in order; failures pause new moves and retry automatically every five seconds. No cards are silently discarded when the upstream API is unavailable. No API key is required.

Card faces are rendered as accessible HTML/CSS from API rank/suit data, so gameplay does not depend on remote card-image loading. The external service and optional Google Fonts still require an internet connection; system fonts are the fallback.

## Hosting

This app uses [Astro's Node adapter](https://docs.astro.build/en/guides/integrations-guide/node/) in standalone server mode. `pnpm build` produces `dist/server/entry.mjs`; `pnpm start` runs it. Set `HOST=0.0.0.0` and `PORT` in the production environment, and serve behind HTTPS when reachable over the internet.

**Use a single long-lived Node process.** Rooms are deliberately ephemeral and live in memory. Restarting the process ends all Go Fish sessions. Static hosting, independently scaled workers, multiple Node processes, and serverless cold starts are not supported by this room store. For multiple instances, move room state, locking, and cleanup to a shared service first. The lobby is public to anyone who can reach this app; room codes are invitations, not private-room passwords. This is a casual game app without accounts or durable scores.

## Source map

- `src/components/` — React game screens and shared cards.
- `src/lib/solitaire.ts` and `src/lib/go-fish.ts` — game rules.
- `src/lib/deck-api.ts` — external deck/pile operations.
- `src/server/rooms.ts` — membership, privacy, presence, expiry, and retry queue.
- `src/pages/api/gofish.ts` — same-origin JSON API.
- `tests/games.test.ts` — rules, card conservation, complete simulated games, authorization, stale moves, capacity, disconnects, and API-failure recovery.
