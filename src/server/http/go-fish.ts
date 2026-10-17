import type { APIRoute } from 'astro';
import type { GoFishService } from '../go-fish-service';
import { RoomError } from '../room-types';
import { RANKS, type Rank } from '../../lib/cards';
import { failure, json } from './responses';

const token = (request: Request) => request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';

export function createGoFishHandlers(rooms: GoFishService): { GET: APIRoute; POST: APIRoute } {
  const GET: APIRoute = async ({ request, url }) => {
    try {
      const code = url.searchParams.get('room');
      if (code && !/^[A-Fa-f0-9]{6}$/.test(code)) throw new RoomError('Enter the six-character table code.');
      return json(code ? await rooms.get(code, token(request)) : await rooms.list());
    } catch (error) { return failure(error); }
  };

  const POST: APIRoute = async ({ request, url }) => {
    try {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new RoomError('Use this app to make game requests.', 403);
      if (!request.headers.get('Content-Type')?.includes('application/json')) throw new RoomError('Expected JSON.', 415);
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 4096) { await reader.cancel(); throw new RoomError('Request is too large.', 413); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let input: Record<string, unknown>;
      try { input = JSON.parse(body); } catch { throw new RoomError('Invalid JSON.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoomError('Invalid request.');
      if (input.type === 'create') return json(await rooms.create(input.name), 201);
      if (typeof input.code !== 'string' || !/^[A-Fa-f0-9]{6}$/.test(input.code)) throw new RoomError('Enter the six-character table code.');
      if (input.type === 'join') return json(await rooms.join(input.code, input.name));
      if (input.type === 'leave') { await rooms.leave(input.code, token(request)); return json({ left: true }); }
      if (!Number.isInteger(input.version)) throw new RoomError('A table version is required.');
      if (input.type === 'start') return json(await rooms.action(input.code, token(request), input.version as number, { type: 'start' }));
      if (input.type === 'ask' && typeof input.opponent === 'string' && RANKS.includes(input.rank as Rank)) {
        return json(await rooms.action(input.code, token(request), input.version as number, { type: 'ask', opponent: input.opponent, rank: input.rank as Rank }));
      }
      throw new RoomError('Unknown game action.');
    } catch (error) { return failure(error); }
  };
  return { GET, POST };
}
