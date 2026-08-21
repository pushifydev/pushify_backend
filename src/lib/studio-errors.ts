/**
 * Validation failures raised by the studio's pure SQL layer.
 *
 * The SQL builders know nothing about HTTP or locales, so they throw this instead; the service
 * translates it into a 400 in the caller's language using `key`.
 */
export type StudioErrorKey =
  | 'studioInvalidIdentifier'
  | 'studioInvalidValue'
  | 'studioInvalidFilter'
  | 'studioInvalidColumnType'
  | 'studioAutoIncrementType'
  | 'studioAutoIncrementKey'
  | 'studioNoColumns'
  | 'studioNoValues'
  | 'studioTooManyRows'
  | 'studioTooManyColumns'
  | 'studioDuplicateColumn'
  | 'studioNoPrimaryKey'
  | 'studioPrimaryKeyRequired'
  | 'studioQueryFailed';

export class StudioValidationError extends Error {
  constructor(public readonly key: StudioErrorKey) {
    super(key);
    this.name = 'StudioValidationError';
  }
}
