import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  valorExtrasDe,
  salarioBaseQuincena,
  calcularNetoPreliminar,
  esFechaDeCorte,
  esVisperaDeCorte,
  etiquetaPeriodoQuincena,
  iniciosProximasQuincenas,
  dividirEnCuotas,
} from './quincena.ts';

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

const bog = (y: number, mIdx: number, d: number) => new Date(Date.UTC(y, mIdx, d));

test('esVisperaDeCorte: día 14, penúltimo del mes (31/30/feb)', () => {
  assert.equal(esVisperaDeCorte(bog(2026, 6, 14)), true); // 14 jul -> mañana 15
  assert.equal(esVisperaDeCorte(bog(2026, 6, 30)), true); // 30 jul -> mañana 31 (último)
  assert.equal(esVisperaDeCorte(bog(2026, 3, 29)), true); // 29 abr -> mañana 30 (último, mes de 30)
  assert.equal(esVisperaDeCorte(bog(2026, 1, 27)), true); // 27 feb 2026 -> mañana 28 (último)
  assert.equal(esVisperaDeCorte(bog(2026, 6, 15)), false); // el corte no es su propia víspera
  assert.equal(esVisperaDeCorte(bog(2026, 6, 20)), false);
});

test('etiquetaPeriodoQuincena', () => {
  assert.equal(etiquetaPeriodoQuincena(bog(2026, 6, 10)), 'Q1-Julio 2026');
  assert.equal(etiquetaPeriodoQuincena(bog(2026, 6, 20)), 'Q2-Julio 2026');
  assert.equal(etiquetaPeriodoQuincena(bog(2026, 11, 31)), 'Q2-Diciembre 2026');
});

test('iniciosProximasQuincenas: salta mes y año correctamente', () => {
  const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 10));
  // Desde Q2-Julio, 3 cuotas -> Q2-Jul, Q1-Ago, Q2-Ago
  assert.deepEqual(iso(iniciosProximasQuincenas(bog(2026, 6, 20), 3)), ['2026-07-16', '2026-08-01', '2026-08-16']);
  // Cruce de año: desde Q2-Diciembre -> Q2-Dic, Q1-Ene(2027)
  assert.deepEqual(iso(iniciosProximasQuincenas(bog(2026, 11, 20), 2)), ['2026-12-16', '2027-01-01']);
  // Desde Q1 -> misma quincena
  assert.deepEqual(iso(iniciosProximasQuincenas(bog(2026, 6, 5), 1)), ['2026-07-01']);
});

test('dividirEnCuotas: suma exacta, sobrante a las primeras', () => {
  assert.deepEqual(dividirEnCuotas(240_000, 2), [120_000, 120_000]);
  assert.deepEqual(dividirEnCuotas(250, 3), [84, 83, 83]);
  assert.deepEqual(dividirEnCuotas(100_000, 1), [100_000]);
  // la suma siempre es el monto
  const partes = dividirEnCuotas(100_001, 4);
  assert.equal(partes.reduce((a, b) => a + b, 0), 100_001);
});
