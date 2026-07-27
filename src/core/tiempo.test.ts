import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intervalosSeCruzan } from './tiempo.ts';

/** Hora de pared de Bogotá (campos UTC == hora local). */
const h = (hora: number, min = 0) => new Date(Date.UTC(2026, 6, 22, hora, min));

test('intervalosSeCruzan: se cruzan cuando comparten tiempo', () => {
  // 8:00–15:00 vs 10:00–16:00 -> sí
  assert.equal(intervalosSeCruzan(h(8), h(15), h(10), h(16)), true);
  // uno contiene al otro
  assert.equal(intervalosSeCruzan(h(7), h(18), h(9), h(12)), true);
});

test('intervalosSeCruzan: extremos que se tocan NO cuentan (mañana + tarde)', () => {
  // 8:00–11:00 y 11:00–14:00 -> NO se cruzan
  assert.equal(intervalosSeCruzan(h(8), h(11), h(11), h(14)), false);
  // completamente separados
  assert.equal(intervalosSeCruzan(h(6), h(10), h(14), h(18)), false);
});
