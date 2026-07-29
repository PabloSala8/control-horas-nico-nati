import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarTurno, type RatesConfig } from './clasificador.ts';
import type { VentanaOrdinaria } from './horarios.ts';

// Rates de prueba con números redondos: vHora = 210000/210 = 1000.
const rates: RatesConfig = {
  salarioBase: 210_000,
  divisorHoras: 210,
  recExtraDiurna: 0.25,
  recExtraNocturna: 0.75,
  recDominical: 0.75,
  inicioNocturno: '19:00',
};

// Ventana tipo Maye lun–jue: 7:00–16:00 (9h ordinarias).
const V_7_16: VentanaOrdinaria = { desde: '07:00', hasta: '16:00' };

// Helper: Date en convención Bogotá (campos UTC = hora de pared). Fecha fija; el
// día de la semana no importa porque la ventana se pasa explícita.
const bog = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 6, h, m, 0));

test('todo dentro de la ventana -> todo ordinaria', () => {
  const r = clasificarTurno({ entrada: bog(8), salida: bog(15), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 });
  assert.equal(r.horasTotales, 7);
  assert.deepEqual(r.desglose, { ordinaria: 7, extra_diurna: 0, extra_nocturna: 0, dominical: 0 });
  assert.equal(r.valorCalculado, 7000);
});

test('ventana completa 7–16 = 9h ordinarias', () => {
  const r = clasificarTurno({ entrada: bog(7), salida: bog(16), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 });
  assert.deepEqual(r.desglose, { ordinaria: 9, extra_diurna: 0, extra_nocturna: 0, dominical: 0 });
  assert.equal(r.valorCalculado, 9000);
});

test('sale después de la ventana -> extra diurna al final', () => {
  // 7–16 ordinaria (9h) + 16–18 extra diurna (2h)
  const r = clasificarTurno({ entrada: bog(7), salida: bog(18), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 });
  assert.deepEqual(r.desglose, { ordinaria: 9, extra_diurna: 2, extra_nocturna: 0, dominical: 0 });
  // 9*1000 + 2*1000*1.25 = 11500
  assert.equal(r.valorCalculado, 11500);
});

test('entra antes de la ventana -> extra diurna al inicio', () => {
  // 6–7 extra diurna (1h) + 7–16 ordinaria (9h)
  const r = clasificarTurno({ entrada: bog(6), salida: bog(16), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 });
  assert.deepEqual(r.desglose, { ordinaria: 9, extra_diurna: 1, extra_nocturna: 0, dominical: 0 });
  // 9000 + 1*1000*1.25 = 10250
  assert.equal(r.valorCalculado, 10250);
});

test('extra fuera de ventana que cruza el corte nocturno (19:00)', () => {
  // Todo fuera de la ventana (empieza en el fin de la ventana, 16:00):
  // 16–19 extra diurna (3h) + 19–21 extra nocturna (2h)
  const r = clasificarTurno({ entrada: bog(16), salida: bog(21), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 });
  assert.deepEqual(r.desglose, { ordinaria: 0, extra_diurna: 3, extra_nocturna: 2, dominical: 0 });
  // 3*1000*1.25 + 2*1000*1.75 = 3750 + 3500 = 7250
  assert.equal(r.valorCalculado, 7250);
});

test('día SIN ventana (null) -> todo extra', () => {
  // Sábado de Maye / domingo: 8–12 = 4h extra diurna
  const r = clasificarTurno({ entrada: bog(8), salida: bog(12), rates, esDominicalOFestivo: false, ventanaOrdinaria: null });
  assert.deepEqual(r.desglose, { ordinaria: 0, extra_diurna: 4, extra_nocturna: 0, dominical: 0 });
  assert.equal(r.valorCalculado, 5000); // 4*1000*1.25
});

test('dominical/festivo -> todo dominical (la ventana no aplica)', () => {
  const r = clasificarTurno({ entrada: bog(8), salida: bog(13), rates, esDominicalOFestivo: true, ventanaOrdinaria: V_7_16 });
  assert.deepEqual(r.desglose, { ordinaria: 0, extra_diurna: 0, extra_nocturna: 0, dominical: 5 });
  assert.equal(r.valorCalculado, 8750); // 5*1000*1.75
});

test('Nena sábado (ventana 7–9): 7–11 = 2h ordinaria + 2h extra diurna', () => {
  const r = clasificarTurno({ entrada: bog(7), salida: bog(11), rates, esDominicalOFestivo: false, ventanaOrdinaria: { desde: '07:00', hasta: '09:00' } });
  assert.deepEqual(r.desglose, { ordinaria: 2, extra_diurna: 2, extra_nocturna: 0, dominical: 0 });
  assert.equal(r.valorCalculado, 4500); // 2000 + 2*1000*1.25
});

test('salida antes que entrada -> error', () => {
  assert.throws(() => clasificarTurno({ entrada: bog(10), salida: bog(9), rates, esDominicalOFestivo: false, ventanaOrdinaria: V_7_16 }));
});
