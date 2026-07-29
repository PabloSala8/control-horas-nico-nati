import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentosDeTurno, type RatesConfig } from './clasificador.ts';
import type { VentanaOrdinaria } from './horarios.ts';
import { formatoHora12 } from './tiempo.ts';

const RATES: RatesConfig = {
  salarioBase: 1_750_905,
  divisorHoras: 210,
  recExtraDiurna: 0.25,
  recExtraNocturna: 0.75,
  recDominical: 1.0,
  inicioNocturno: '19:00',
};

// Ventana tipo Nena lun–vie: 7:00–15:00 (8h ordinarias).
const V_7_15: VentanaOrdinaria = { desde: '07:00', hasta: '15:00' };

/** Hora de pared de Bogotá: campos UTC == hora local. */
const bog = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 22, h, m));

const comoRangos = (segs: ReturnType<typeof segmentosDeTurno>) =>
  segs.map((s) => `${s.tramo} ${formatoHora12(s.desde)}–${formatoHora12(s.hasta)}`);

test('entra antes y sale después de la ventana (7–15): extra, ordinaria, extra', () => {
  const segs = segmentosDeTurno({ entrada: bog(6), salida: bog(17), rates: RATES, esDominicalOFestivo: false, ventanaOrdinaria: V_7_15 });
  assert.deepEqual(comoRangos(segs), [
    'extra_diurna 6:00 AM–7:00 AM',
    'ordinaria 7:00 AM–3:00 PM',
    'extra_diurna 3:00 PM–5:00 PM',
  ]);
});

test('extra fuera de ventana que cruza el corte nocturno', () => {
  // Ventana 7–15; turno 15–21 todo fuera: diurna 15–19, nocturna 19–21.
  const segs = segmentosDeTurno({ entrada: bog(15), salida: bog(21), rates: RATES, esDominicalOFestivo: false, ventanaOrdinaria: V_7_15 });
  assert.deepEqual(comoRangos(segs), [
    'extra_diurna 3:00 PM–7:00 PM',
    'extra_nocturna 7:00 PM–9:00 PM',
  ]);
});

test('todo dentro de la ventana: un solo segmento ordinaria', () => {
  const segs = segmentosDeTurno({ entrada: bog(8), salida: bog(14), rates: RATES, esDominicalOFestivo: false, ventanaOrdinaria: V_7_15 });
  assert.deepEqual(comoRangos(segs), ['ordinaria 8:00 AM–2:00 PM']);
});

test('día sin ventana (null): todo extra', () => {
  const segs = segmentosDeTurno({ entrada: bog(8), salida: bog(12), rates: RATES, esDominicalOFestivo: false, ventanaOrdinaria: null });
  assert.deepEqual(comoRangos(segs), ['extra_diurna 8:00 AM–12:00 PM']);
});

test('dominical/festivo: un único tramo dominical (ventana no aplica)', () => {
  const segs = segmentosDeTurno({ entrada: bog(6), salida: bog(10), rates: RATES, esDominicalOFestivo: true, ventanaOrdinaria: V_7_15 });
  assert.deepEqual(comoRangos(segs), ['dominical 6:00 AM–10:00 AM']);
});

test('turno inválido devuelve vacío', () => {
  assert.deepEqual(segmentosDeTurno({ entrada: bog(10), salida: bog(10), rates: RATES, esDominicalOFestivo: false, ventanaOrdinaria: V_7_15 }), []);
});
