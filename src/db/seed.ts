/**
 * Seed de datos de prueba. Idempotente (se puede correr varias veces).
 * Ejecuta con `npm run seed`.
 *
 * Valores confirmados por Pablo (sesión 3):
 *  - SMMLV 2026 = $1.750.905.
 *  - rec_extra_diurna = 0.25 (documento técnico).
 *  - rec_extra_nocturna = 0.75.
 *  - rec_dominical = 1.00 (+100%), vigente desde el 1-jul-2026 (reforma laboral).
 *  - Salario base por quincena = mensual / 2 (ver src/core/quincena.ts).
 * Todo sigue siendo editable vía config_rates (versionada por fecha).
 */
import { pool, cerrarPool } from './pool.ts';
import { config } from '../config.ts';

const SMMLV_2026 = 1_750_905; // valor confirmado 2026

// Calendario oficial de festivos colombianos 2026 (Ley Emiliani aplicada).
const FESTIVOS_2026: Array<[string, string]> = [
  ['2026-01-01', 'Año Nuevo'],
  ['2026-01-12', 'Día de los Reyes Magos'],
  ['2026-03-23', 'Día de San José'],
  ['2026-04-02', 'Jueves Santo'],
  ['2026-04-03', 'Viernes Santo'],
  ['2026-05-01', 'Día del Trabajo'],
  ['2026-05-18', 'Ascensión del Señor'],
  ['2026-06-08', 'Corpus Christi'],
  ['2026-06-15', 'Sagrado Corazón'],
  ['2026-06-29', 'San Pedro y San Pablo'],
  ['2026-07-20', 'Día de la Independencia'],
  ['2026-08-07', 'Batalla de Boyacá'],
  ['2026-08-17', 'Asunción de la Virgen'],
  ['2026-10-12', 'Día de la Raza'],
  ['2026-11-02', 'Todos los Santos'],
  ['2026-11-16', 'Independencia de Cartagena'],
  ['2026-12-08', 'Inmaculada Concepción'],
  ['2026-12-25', 'Navidad'],
];

async function seedAdmins(): Promise<string> {
  // Nico y Nati comparten el mismo grupo de admins (chat_id_admin).
  await pool.query(
    `INSERT INTO admins (nombre, telegram_user_id, chat_id_admin)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM admins WHERE nombre = $1)`,
    ['Nico', null, config.adminChatId],
  );
  const nati = await pool.query<{ id: string }>(
    `INSERT INTO admins (nombre, telegram_user_id, chat_id_admin)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (SELECT 1 FROM admins WHERE nombre = $1)
     RETURNING id`,
    ['Nati', null, config.adminChatId],
  );
  // id de Nati (para creado_por en config_rates); si ya existía, lo buscamos.
  const natiId =
    nati.rows[0]?.id ??
    (await pool.query<{ id: string }>(`SELECT id FROM admins WHERE nombre = 'Nati'`)).rows[0].id;
  console.log('✔ admins: Nico y Nati');
  return natiId;
}

async function seedEmpleadas(): Promise<void> {
  const empleadas: Array<[string, string, number]> = [
    ['Yariné (Nena)', 'Nena', config.nenaChatId],
    ['Mayerlis (Maye)', 'Maye', config.mayeChatId],
  ];
  for (const [nombre, alias, chatId] of empleadas) {
    await pool.query(
      `INSERT INTO empleadas (nombre, alias, telegram_user_id, chat_id_grupo, salario_base_mensual, activa)
       VALUES ($1, $2, NULL, $3, $4, true)
       ON CONFLICT (chat_id_grupo) DO UPDATE
         SET nombre = EXCLUDED.nombre, alias = EXCLUDED.alias,
             salario_base_mensual = EXCLUDED.salario_base_mensual`,
      [nombre, alias, chatId, SMMLV_2026],
    );
  }
  console.log('✔ empleadas: Nena y Maye');
}

async function seedConfigRates(natiId: string): Promise<void> {
  // Vigente desde el 1-jul-2026: cubre el arranque real (1-ago) y cualquier demo
  // de hoy. rec_dominical = 1.00 desde esa fecha por la reforma laboral. El motor
  // usa la fila más reciente con vigente_desde <= fecha del turno.
  const vigenteDesde = '2026-07-01';
  await pool.query(
    `INSERT INTO config_rates
       (vigente_desde, salario_base, divisor_horas, rec_extra_diurna, rec_extra_nocturna, rec_dominical, inicio_nocturno, creado_por)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     WHERE NOT EXISTS (SELECT 1 FROM config_rates WHERE vigente_desde = $1)`,
    [vigenteDesde, SMMLV_2026, 210, 0.25, 0.75, 1.0, '19:00', natiId],
  );
  console.log(`✔ config_rates: fila vigente desde ${vigenteDesde} (SMMLV ${SMMLV_2026}, dominical +100%)`);
}

async function seedCatalogoActividades(): Promise<void> {
  // Compat: si el catálogo venía con "Rococó", renómbralo a "Rocco" (mismo id,
  // así las actividades ya registradas siguen apuntando bien). Idempotente.
  await pool.query(`UPDATE catalogo_actividades SET nombre = 'Rocco' WHERE nombre = 'Rococó'`);
  // Rocco y Gatas: hoy $10.000 c/u (secciones 8 y 14), editables por separado.
  const actividades: Array<[string, number]> = [
    ['Rocco', 10_000],
    ['Gatas', 10_000],
  ];
  for (const [nombre, valor] of actividades) {
    await pool.query(
      `INSERT INTO catalogo_actividades (nombre, valor, activa) VALUES ($1, $2, true)
       ON CONFLICT (nombre) DO NOTHING`,
      [nombre, valor],
    );
  }
  console.log(`✔ catalogo_actividades: ${actividades.length} actividades (Rocco, Gatas)`);
}

async function seedFestivos(): Promise<void> {
  for (const [fecha, nombre] of FESTIVOS_2026) {
    await pool.query(
      `INSERT INTO festivos (fecha, nombre) VALUES ($1, $2)
       ON CONFLICT (fecha) DO NOTHING`,
      [fecha, nombre],
    );
  }
  console.log(`✔ festivos: ${FESTIVOS_2026.length} festivos colombianos 2026`);
}

async function main() {
  console.log('Sembrando datos de prueba...');
  const natiId = await seedAdmins();
  await seedEmpleadas();
  await seedConfigRates(natiId);
  await seedCatalogoActividades();
  await seedFestivos();
  console.log('✔ Seed completo.');
}

main()
  .catch((err) => {
    console.error('✖ Error en el seed:', err);
    process.exitCode = 1;
  })
  .finally(cerrarPool);
