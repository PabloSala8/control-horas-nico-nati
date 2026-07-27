import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentosDeTurno, type RatesConfig } from './clasificador.ts';
import { formatoHora12 } from './tiempo.ts';

const RATES: RatesConfig = {
  salarioBase: 1_750_905,
  divisorHoras: 210, // jornada diaria 7h
  recExtraDiurna: 0.25,
  recExtraNocturna: 0.75,
  recDominical: 1.0,
  inicioNocturno: '19:00',
};

/** Hora de pared de Bogotá: campos UTC == hora local. */
const bog = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 22, h, m));

const comoRangos = (segs: ReturnType<typeof segmentosDeTurno>) =>
  segs.map((s) => `${s.tramo} ${formatoHora12(s.desde)}–${formatoHora12(s.hasta)}`);

test('turno con extra diurna: ordinaria 6–13, extra diurna 13–17', () => {
  const segs = segmentosDeTurno({ entrada: bog(6), salida: bog(17), rates: RATES, esDominicalOFestivo: false });
  assert.deepEqual(comoRangos(segs), [
    'ordinaria 6:00 AM–1:00 PM',
    'extra_diurna 1:00 PM–5:00 PM',
  ]);
});

test('extra que cruza el corte nocturno: diurna hasta 19:00, nocturna después', () => {
  const segs = segmentosDeTurno({ entrada: bog(10), salida: bog(21), rates: RATES, esDominicalOFestivo: false });
  assert.deepEqual(comoRangos(segs), [
    'ordinaria 10:00 AM–5:00 PM',
    'extra_diurna 5:00 PM–7:00 PM',
    'extra_nocturna 7:00 PM–9:00 PM',
  ]);
});

test('turno corto: todo ordinaria en un solo segmento', () => {
  const segs = segmentosDeTurno({ entrada: bog(14), salida: bog(21), rates: RATES, esDominicalOFestivo: false });
  assert.deepEqual(comoRangos(segs), ['ordinaria 2:00 PM–9:00 PM']);
});

test('dominical/festivo: un único tramo dominical', () => {
  const segs = segmentosDeTurno({ entrada: bog(6), salida: bog(10), rates: RATES, esDominicalOFestivo: true });
  assert.deepEqual(comoRangos(segs), ['dominical 6:00 AM–10:00 AM']);
});

test('turno inválido devuelve vacío', () => {
  assert.deepEqual(segmentosDeTurno({ entrada: bog(10), salida: bog(10), rates: RATES, esDominicalOFestivo: false }), []);
});
