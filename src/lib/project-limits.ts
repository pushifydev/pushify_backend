/**
 * Per-project resource limits — the single source for the dashboard/API services,
 * the pushify.yaml schema and the pushify.yaml sync on deploy. The docs quote
 * these numbers; change them here and update /pushify-yaml and docs/projects.md.
 */
export const PROJECT_LIMITS = {
  scheduledTasks: {
    maxPerProject: 10,
    minTimeoutSeconds: 10,
    maxTimeoutSeconds: 600,
    defaultTimeoutSeconds: 120,
    maxNameLength: 255,
    maxCommandLength: 2000,
  },
  volumes: {
    maxPerProject: 5,
  },
  workers: {
    maxPerProject: 5,
    maxCommandLength: 1000,
  },
} as const;
