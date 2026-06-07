import { env } from '../config/env';

/** Public API origin (no trailing slash). Used for webhook URLs shown to users and GitHub. */
export function getApiBaseUrl(): string {
  if (env.API_BASE_URL) {
    return env.API_BASE_URL;
  }
  return `http://localhost:${env.PORT}`;
}
