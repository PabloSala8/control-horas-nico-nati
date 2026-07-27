/**
 * Migración: aplica `schema.sql` (idempotente). Ejecuta con `npm run migrate`.
 * En esta fase no hay historial de migraciones — un único schema inicial que se
 * puede re-aplicar sin destruir datos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, cerrarPool } from './pool.ts';

const aquí = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(aquí, 'schema.sql'), 'utf8');
  console.log('Aplicando schema.sql...');
  await pool.query(sql);
  console.log('✔ Schema aplicado.');
}

main()
  .catch((err) => {
    console.error('✖ Error en la migración:', err);
    process.exitCode = 1;
  })
  .finally(cerrarPool);
