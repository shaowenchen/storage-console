import { getAdapter as initAdapter } from './adapter.js';
import { migrateSchema } from './migrate.js';

export async function getDb() {
  return initAdapter(migrateSchema);
}
