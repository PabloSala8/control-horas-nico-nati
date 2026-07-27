/**
 * Scheduler del cierre de quincena (sección 12). Corre todos los días a las
 * 23:00 hora Bogotá y, si es fecha de corte (día 15 o último del mes), dispara
 * el cierre de la quincena vigente vía el callback `onCorte`.
 *
 * No sabe de Telegram: el bot le pasa `onCorte`, que hace el cierre y envía los
 * reportes al grupo de admins.
 */
import cron from 'node-cron';
import { ahoraBogota, fechaISO } from '../core/tiempo.ts';
import { esFechaDeCorte } from '../core/quincena.ts';
import { ensureQuincenaVigente } from '../db/queries.ts';

export function iniciarScheduler(onCorte: (quincenaId: string) => Promise<void>): void {
  cron.schedule(
    '0 23 * * *',
    async () => {
      try {
        const hoy = ahoraBogota();
        if (!esFechaDeCorte(hoy)) return;
        const quincenaId = await ensureQuincenaVigente(fechaISO(hoy));
        await onCorte(quincenaId);
      } catch (err) {
        console.error('Error en el job de cierre programado:', err);
      }
    },
    { timezone: 'America/Bogota' },
  );
  console.log('⏰ Scheduler de cierre activo (días 15 y último de cada mes, 23:00 Bogotá).');
}
