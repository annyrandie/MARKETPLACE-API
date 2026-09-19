// npm run check:env — syncs .env.example against the zod schema. Source of
// truth is the schema's keys: add a variable to the schema → add it to
// .env.example in the SAME commit, or this script (and CI) goes red.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

// env.schema.js is CommonJS; importing it from this ESM script goes through
// Node's default-export interop, so destructure off the whole module object
// rather than relying on named-export detection.
import envSchemaModule from '../src/config/env.schema.js';

const { envSchema } = envSchemaModule;

const schemaKeys = Object.keys(envSchema.shape).sort();
const fileKeys = Object.keys(parse(readFileSync(new URL('../.env.example', import.meta.url)))).sort();

const missing = schemaKeys.filter((k) => !fileKeys.includes(k)); // in the schema, not in the file
const extra = fileKeys.filter((k) => !schemaKeys.includes(k)); // in the file, not in the schema

if (missing.length || extra.length) {
  if (missing.length) console.error(`✗ Missing from .env.example: ${missing.join(', ')}`);
  if (extra.length) console.error(`✗ Extra in .env.example (not in the schema): ${extra.join(', ')}`);
  process.exit(1);
}

console.log(`✓ .env.example is in sync with the schema (${schemaKeys.length} variables)`);
