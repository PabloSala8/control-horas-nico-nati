/**
 * Horarios ordinarios por empleada (sección 5 — regla real de negocio, corregida
 * tras el primer día de prueba). Las horas trabajadas DENTRO de la ventana de reloj
 * de ese día son ordinarias; todo lo de afuera (o un día sin ventana) es extra.
 * Domingo/festivo lo maneja aparte el clasificador (recargo dominical, manda sobre
 * todo, incluso dentro de la ventana).
 *
 * Dato PURO y hardcodeado a propósito (decisión de sesión): cambiar un horario
 * requiere redeploy, pero cambian rara vez y así NO hay migración ni riesgo en la
 * base de datos. Si a futuro se quieren editables sin desplegar, se mueven a una
 * tabla versionada como `config_rates`.
 *
 * Día de la semana: 0=domingo … 6=sábado (getUTCDay, convención de tiempo.ts).
 */
import { diaSemana } from './tiempo.ts';

export interface VentanaOrdinaria {
  desde: string; // "HH:MM" inclusive
  hasta: string; // "HH:MM" exclusive
}

type HorarioSemanal = Partial<Record<number, VentanaOrdinaria>>;

/**
 * Clave = alias de la empleada (estable entre reseeds, a diferencia del id UUID).
 * Maye: lun–jue 7:00–16:00 (9h) + vie 7:00–13:00 (6h) = 42h. Sáb/dom: todo extra.
 * Nena: lun–vie 7:00–15:00 (8h) + sáb 7:00–09:00 (2h) = 42h. Dom: todo extra.
 */
const HORARIOS: Record<string, HorarioSemanal> = {
  Maye: {
    1: { desde: '07:00', hasta: '16:00' }, // lunes
    2: { desde: '07:00', hasta: '16:00' }, // martes
    3: { desde: '07:00', hasta: '16:00' }, // miércoles
    4: { desde: '07:00', hasta: '16:00' }, // jueves
    5: { desde: '07:00', hasta: '13:00' }, // viernes
  },
  Nena: {
    1: { desde: '07:00', hasta: '15:00' }, // lunes
    2: { desde: '07:00', hasta: '15:00' }, // martes
    3: { desde: '07:00', hasta: '15:00' }, // miércoles
    4: { desde: '07:00', hasta: '15:00' }, // jueves
    5: { desde: '07:00', hasta: '15:00' }, // viernes
    6: { desde: '07:00', hasta: '09:00' }, // sábado
  },
};

/**
 * Ventana ordinaria de una empleada (por alias) para la fecha dada, o `null` si ese
 * día no tiene jornada ordinaria (→ todo lo trabajado ese día es extra). Un alias
 * desconocido también devuelve `null`.
 */
export function ventanaParaFecha(alias: string, fecha: Date): VentanaOrdinaria | null {
  return HORARIOS[alias]?.[diaSemana(fecha)] ?? null;
}
