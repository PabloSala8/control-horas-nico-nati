import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valorExtrasDe, salarioBaseQuincena, calcularNetoPreliminar, esFechaDeCorte } from './quincena.ts';

test('valorExtrasDe suma recargos y excluye la parte ordinaria', () => {
  const vt = { ordinaria: 47_450, extra_diurna: 16_946, extra_nocturna: 0, dominical: 0 };
  assert.equal(valorExtrasDe(vt), 16_946);
});

test('salarioBaseQuincena = mensual / 2', () => {
  assert.equal(salarioBaseQuincena(1_423_500), 711_750);
});

test('neto preliminar = base + extras + actividades + bonos − préstamos', () => {
  const neto = calcularNetoPreliminar({
    salarioBaseQuincena: 711_750,
    valorExtras: 16_946,
    valorActividades: 20_000, // 2 actividades de 10.000
    bonos: 50_000,
    prestamos: 200_000,
  });
  // 711750 + 16946 + 20000 + 50000 - 200000 = 598696
  assert.equal(neto, 598_696);
});

test('esFechaDeCorte: día 15 y último día del mes', () => {
  const bog = (y: number, mIdx: number, d: number) => new Date(Date.UTC(y, mIdx, d));
  assert.equal(esFechaDeCorte(bog(2026, 6, 15)), true); // 15 jul
  assert.equal(esFechaDeCorte(bog(2026, 6, 31)), true); // 31 jul (último)
  assert.equal(esFechaDeCorte(bog(2026, 1, 28)), true); // 28 feb 2026 (último, no bisiesto)
  assert.equal(esFechaDeCorte(bog(2026, 6, 20)), false);
  assert.equal(esFechaDeCorte(bog(2026, 6, 16)), false);
});
