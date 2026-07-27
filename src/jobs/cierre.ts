/**
 * Cierre de quincena (sección 12). Sin Telegram: valida, calcula y congela.
 * El envío de reportes y la conversación viven en el bot; el scheduler dispara
 * el cierre automático en las fechas de corte.
 *
 * Invariante clave (CLAUDE.md): `quincenas.snapshot` se escribe UNA vez, al
 * cerrar, y nunca se recalcula. `marcarQuincenaCerrada` solo procede si la
 * quincena estaba `abierta`.
 */
import { construirResumen, type Resumen } from '../bot/servicio.ts';
import {
  getQuincenaById,
  pendientesEnRango,
  marcarQuincenaCerrada,
  type PendienteResumen,
} from '../db/queries.ts';

export type PrepararCierre =
  | { estado: 'ya_cerrada'; resumen: Resumen }
  | { estado: 'bloqueado'; pendientes: PendienteResumen[] }
  | { estado: 'listo'; resumen: Resumen };

/** Revisa el estado del cierre SIN escribir nada (para previsualizar/confirmar). */
export async function prepararCierre(quincenaId: string): Promise<PrepararCierre> {
  const q = await getQuincenaById(quincenaId);
  if (!q) throw new Error('Quincena no encontrada.');
  if (q.estado === 'cerrada') return { estado: 'ya_cerrada', resumen: q.snapshot as Resumen };

  const pendientes = await pendientesEnRango(q.fecha_inicio, q.fecha_fin);
  if (pendientes.length > 0) return { estado: 'bloqueado', pendientes };

  const resumen = await construirResumen(quincenaId);
  return { estado: 'listo', resumen };
}

export type ResultadoCierre =
  | { ok: true; resumen: Resumen }
  | { ok: false; motivo: 'bloqueado'; pendientes: PendienteResumen[] }
  | { ok: false; motivo: 'ya_cerrada'; resumen: Resumen };

/** Ejecuta el cierre: congela el snapshot y marca la quincena `cerrada`. */
export async function confirmarCierre(quincenaId: string): Promise<ResultadoCierre> {
  const prep = await prepararCierre(quincenaId);
  if (prep.estado === 'bloqueado') return { ok: false, motivo: 'bloqueado', pendientes: prep.pendientes };
  if (prep.estado === 'ya_cerrada') return { ok: false, motivo: 'ya_cerrada', resumen: prep.resumen };

  const cerrada = await marcarQuincenaCerrada(quincenaId, JSON.stringify(prep.resumen));
  if (!cerrada) {
    // Carrera: se cerró entre la preparación y ahora. Devolvemos el snapshot real.
    const q = await getQuincenaById(quincenaId);
    return { ok: false, motivo: 'ya_cerrada', resumen: q!.snapshot as Resumen };
  }
  return { ok: true, resumen: prep.resumen };
}
