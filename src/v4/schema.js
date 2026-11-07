/**
 * MAJIN V4 — zod input schema -> the JSON Schema an OpenAI-compatible model
 * expects.
 *
 * Extracted from tools.js so the exposure layer (which builds the model-facing
 * tool list) can use it without importing the whole tool surface, and so there
 * is exactly one conversion in the codebase.
 */
import { z } from 'zod';

export function jsonSchemaFor(schema) {
  if (!schema) return { type: 'object', properties: {} };
  try {
    const converted = z.toJSONSchema(schema, { io: 'input' });
    // The model adapters do not want a $schema key pointing at a spec version.
    const { $schema, ...rest } = converted || {};
    void $schema;
    return rest;
  } catch {
    return null;
  }
}
