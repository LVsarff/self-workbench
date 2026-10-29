/** 极简迁移执行器：按文件名顺序执行 migrations/*.sql，已应用的记录在 schema_migrations。 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString });
  const applied: string[] = [];
  try {
    await pool.query(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await pool.query(`select version from schema_migrations`);
    const done = new Set(rows.map((r) => String(r.version)));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(`insert into schema_migrations (version) values ($1)`, [file]);
        await client.query('commit');
        applied.push(file);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`迁移 ${file} 失败: ${String(e)}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}
