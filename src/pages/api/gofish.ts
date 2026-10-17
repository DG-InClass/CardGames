import { rooms } from '../../server/application';
import { createGoFishHandlers } from '../../server/http/go-fish';

export const { GET, POST } = createGoFishHandlers(rooms);
