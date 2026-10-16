import type { APIRoute } from 'astro';
import { rooms, RoomError } from '../../server/rooms';
import { RANKS, type Rank } from '../../lib/cards';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Authorization' },
});
const token = (request: Request) => request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';

function failure(error: unknown) {
  if (error instanceof RoomError) return json({ error: error.message }, error.status);
  console.error('Go Fish request failed:', error);
  return json({ error: 'The card service is unavailable. Please try again shortly.' }, 503);
}

export const GET: APIRoute = ({ request, url }) => {
  try {
    const code = url.searchParams.get('room');
    return json(code ? rooms.get(code, token(request)) : rooms.list());
  } catch (error) { return failure(error); }
};

export const POST: APIRoute = async ({ request, url }) => {
  try {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new RoomError('Use this app to make game requests.', 403);
    if (!request.headers.get('Content-Type')?.includes('application/json')) throw new RoomError('Expected JSON.', 415);
    const body = await request.text();
    if (body.length > 4096) throw new RoomError('Request is too large.', 413);
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { throw new RoomError('Invalid JSON.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoomError('Invalid request.');
    if (input.type === 'create') return json(rooms.create(input.name), 201);
    if (typeof input.code !== 'string' || !/^[A-Fa-f0-9]{6}$/.test(input.code)) throw new RoomError('Enter the six-character table code.');
    if (input.type === 'join') return json(rooms.join(input.code, input.name));
    if (input.type === 'leave') { await rooms.leave(input.code, token(request)); return json({ left: true }); }
    if (!Number.isInteger(input.version)) throw new RoomError('A table version is required.');
    if (input.type === 'start') return json(await rooms.action(input.code, token(request), input.version as number, { type: 'start' }));
    if (input.type === 'ask' && typeof input.opponent === 'string' && RANKS.includes(input.rank as Rank)) {
      return json(await rooms.action(input.code, token(request), input.version as number, { type: 'ask', opponent: input.opponent, rank: input.rank as Rank }));
    }
    throw new RoomError('Unknown game action.');
  } catch (error) { return failure(error); }
};
