import { z } from "zod";

/** Peels `.default()` / `.prefault()` (and the `.optional()` around them) off a field schema. */
function withoutDefault(schema: z.ZodType): z.ZodType {
  let s: z.ZodType = schema;
  for (;;) {
    if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) s = s.unwrap() as z.ZodType;
    else if (s instanceof z.ZodOptional) s = s.unwrap() as z.ZodType;
    else return s;
  }
}

/**
 * A PATCH body for an object schema: every field optional and *no defaults*.
 *
 * Zod 4's `.partial()` keeps each field's `.default()`, so a PATCH that only
 * sends `{ enabled: true }` would come back with every defaulted field filled
 * in (`conditions: []`, `type: "custom"` …) and the update would silently
 * reset them. With `patchOf`, a key the client did not send stays absent.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }> {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, withoutDefault(field as z.ZodType).optional()]));
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }>;
}
