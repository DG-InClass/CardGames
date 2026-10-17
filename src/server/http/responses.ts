import { RoomError } from '../room-types';
import { StorageError, type StorageErrorCode } from '../storage/room-repository';

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Authorization' },
});

// Stable public errors regardless of which storage adapter is selected.
const storageFailures: Record<StorageErrorCode, { status: number; message: string }> = {
  configuration: { status: 503, message: 'Multiplayer storage is not configured. Solitaire is still available.' },
  unavailable: { status: 503, message: 'The lobby storage is unavailable. Please try again shortly.' },
  capacity: { status: 503, message: 'All tables are busy. Try again later.' },
  conflict: { status: 409, message: 'The table changed. Refresh and try again.' },
};

export function failure(error: unknown) {
  if (error instanceof StorageError) {
    const { message, status } = storageFailures[error.code];
    return json({ error: message }, status);
  }
  if (error instanceof RoomError) return json({ error: error.message }, error.status);
  console.error('Go Fish request failed:', error);
  return json({ error: 'The game service is unavailable. Please try again shortly.' }, 503);
}
