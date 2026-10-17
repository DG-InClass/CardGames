import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import type { GoFishService } from '../go-fish-service';
import { failure, json } from './responses';

export function createCleanupHandler(rooms: Pick<GoFishService, 'sweep'>, readSecret: () => string | undefined): APIRoute {
  return async ({ request }) => {
    const secret = readSecret();
    const supplied = Buffer.from(request.headers.get('Authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret ?? ''}`);
    if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json({ error: 'Unauthorized.' }, 401);
    }
    try {
      const result = await rooms.sweep();
      return json(result, result.failed ? 503 : 200);
    } catch (error) {
      return failure(error);
    }
  };
}
