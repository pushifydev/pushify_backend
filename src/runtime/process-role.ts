import { env } from '../config/env';

export function runsApiServer(): boolean {
  return env.PROCESS_ROLE === 'api' || env.PROCESS_ROLE === 'all';
}

export function runsBackgroundWorkers(): boolean {
  return env.PROCESS_ROLE === 'worker' || env.PROCESS_ROLE === 'all';
}
