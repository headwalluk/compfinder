/** Every output field, in output order. A lookup result always carries all of them. */
export const FIELD_NAMES = ['name', 'website', 'address', 'phone', 'email', 'logo', 'place_id', 'socials'] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

/** Narrows a string to a FieldName. */
export function isFieldName(value: string): value is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(value);
}
