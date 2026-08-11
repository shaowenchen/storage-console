import type { DatabaseAdapter } from './adapter.js';

export function sqlPlaceholders(count: number): string {
  return Array(count).fill('?').join(', ');
}

export async function insertRows(
  db: DatabaseAdapter,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const columnsSql = columns.join(', ');
  const rowSql = `(${sqlPlaceholders(columns.length)})`;
  const chunkSize = Math.max(1, Math.floor(900 / columns.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.run(
      `INSERT INTO ${table} (${columnsSql}) VALUES ${chunk.map(() => rowSql).join(', ')}`,
      chunk.flat(),
    );
  }
}
