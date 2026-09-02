import { config } from '../config.js';
import { AroFloLiveClient } from './liveClient.js';
import { AroFloMockClient } from './mockClient.js';

export function createAroFloClient() {
  if (config.aroflo.mode === 'live') {
    return new AroFloLiveClient(config.aroflo);
  }
  return new AroFloMockClient();
}

export { JOB_STATUSES } from './mockClient.js';
