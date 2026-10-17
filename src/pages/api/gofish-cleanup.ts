import { rooms } from '../../server/application';
import { createCleanupHandler } from '../../server/http/cleanup';

export const GET = createCleanupHandler(rooms, () => process.env.CRON_SECRET || import.meta.env?.CRON_SECRET);
