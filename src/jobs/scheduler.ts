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
import { esFechaDeCorte, esVisperaDeCorte } from '../core/quincena.ts';
import { ensureQuincenaVigente } from '../db/queries.ts';

/**
 * @param onCorte   se llama a las 23:00 de un día de corte (día 15 o último del mes).
 * @param onVispera se llama a las 23:30 de la VÍSPERA de un corte (respaldo del
 *   Excel/PDF antes de que cierre la quincena, sección 12.1).
 */
export function iniciarScheduler(
  onCorte: (quincenaId: string) => Promise<void>,
  onVispera: (quincenaId: string) => Promise<void>,
): void {
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

  cron.schedule(
    '30 23 * * *',
    async () => {
      try {
        const hoy = ahoraBogota();
        if (!esVisperaDeCorte(hoy)) return;
        const quincenaId = await ensureQuincenaVigente(fechaISO(hoy));
        await onVispera(quincenaId);
      } catch (err) {
        console.error('Error en el job de respaldo de víspera:', err);
      }
    },
    { timezone: 'America/Bogota' },
  );

  console.log('⏰ Scheduler activo (cierre 23:00 en corte; respaldo 23:30 en la víspera, hora Bogotá).');
}
