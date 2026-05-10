/**
 * Never expose stored webhook HMAC secret on routine reads — only on create/regenerate flows.
 */
export function omitWebhookSecret<T extends object>(row: T): Omit<T, 'webhookSecret'> {
  const { webhookSecret: _omit, ...rest } = row as T & { webhookSecret?: unknown };
  return rest as Omit<T, 'webhookSecret'>;
}
