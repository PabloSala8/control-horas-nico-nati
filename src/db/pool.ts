import pg from 'pg';
import { config } from '../config.ts';

/**
 * Pool de conexiones a PostgreSQL (Railway en prod, Postgres local en dev).
 * `timestamp` sin tz se maneja como texto en convención Bogotá — ver
 * `src/core/tiempo.ts`. Desactivamos el parseo automático de `date`/`timestamp`
 * a Date de JS para no reintroducir la zona horaria del proceso.
 */

// 1082 = DATE, 1114 = TIMESTAMP (sin tz): devolverlos como string tal cual.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v);

const usaSSL = /railway|render|amazonaws|supabase/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: usaSSL ? { rejectUnauthorized: false } : undefined,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function cerrarPool(): Promise<void> {
  await pool.end();
}
