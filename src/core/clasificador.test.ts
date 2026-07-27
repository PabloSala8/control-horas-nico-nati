import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarTurno, type RatesConfig } from './clasificador.ts';

// Rates de prueba con números redondos: vHora = 210000/210 = 1000,
// jornada ordinaria diaria = 210/30 = 7h.
const rates: RatesConfig = {
  salarioBase: 210_000,
  divisorHoras: 210,
  recExtraDiurna: 0.25,
  recExtraNocturna: 0.75,
  recDominical: 0.75,
  inicioNocturno: '19:00',
};

// Helper: construye un Date en convención Bogotá (campos UTC = hora de pared).
const bog = (h: number, m = 0, dia = 6) => new Date(Date.UTC(2026, 7, dia, h, m, 0)); // 2026-08-06 (jueves)

test('turno dentro de la jornada ordinaria: todo ordinaria', () => {
  const r = clasificarTurno({ entrada: bog(8), salida: bog(15), rates, esDominicalOFestivo: false });
  assert.equal(r.horasTotales, 7);
  assert.deepEqual(r.desglose, { ordinaria: 7, extra_diurna: 0, extra_nocturna: 0, dominical: 0 });
  assert.equal(r.valorCalculado, 7000);
});

test('turno con extra diurna: 9h -> 7 ordinaria + 2 extra diurna', () => {
  const r = clasificarTurno({ entrada: bog(8), salida: bog(17), rates, esDominicalOFestivo: false });
  assert.deepEqual(r.desglose, { ordinaria: 7, extra_diurna: 2, extra_nocturna: 0, dominical: 0 });
  // 7*1000 + 2*1000*1.25 = 9500
  assert.equal(r.valorCalculado, 9500);
});

test('turno con extra nocturna: parte extra cae después de las 19:00', () => {
  const r = clasificarTurno({ entrada: bog(14), salida: bog(22), rates, esDominicalOFestivo: false });
  // 14->21 ordinaria (7h, incluye 19-21 pero ordinaria no lleva recargo nocturno)
  // 21->22 extra nocturna (1h)
  assert.deepEqual(r.desglose, { ordinaria: 7, extra_diurna: 0, extra_nocturna: 1, dominical: 0 });
  // 7000 + 1*1000*1.75 = 8750
  assert.equal(r.valorCalculado, 8750);
});

test('extra que straddlea el corte: 1h diurna + 2h nocturna', () => {
  const r = clasificarTurno({ entrada: bog(11), salida: bog(21), rates, esDominicalOFestivo: false });
  // 11->18 ordinaria (7h); 18->19 extra diurna (1h); 19->21 extra nocturna (2h)
  assert.deepEqual(r.desglose, { ordinaria: 7, extra_diurna: 1, extra_nocturna: 2, dominical: 0 });
  // 7000 + 1*1250 + 2*1750 = 11750
  assert.equal(r.valorCalculado, 11750);
});

test('domingo/festivo: todo el turno es dominical', () => {
  const r = clasificarTurno({ entrada: bog(8, 0, 2), salida: bog(13, 0, 2), rates, esDominicalOFestivo: true });
  assert.deepEqual(r.desglose, { ordinaria: 0, extra_diurna: 0, extra_nocturna: 0, dominical: 5 });
  // 5*1000*1.75 = 8750
  assert.equal(r.valorCalculado, 8750);
});

test('fracciones de hora se redondean a 2 decimales', () => {
  const r = clasificarTurno({ entrada: bog(8), salida: bog(8, 30), rates, esDominicalOFestivo: false });
  assert.equal(r.desglose.ordinaria, 0.5);
  assert.equal(r.valorCalculado, 500);
});

test('turno partido: dos bloques el mismo día se clasifican por separado', () => {
  const manana = clasificarTurno({ entrada: bog(7), salida: bog(11), rates, esDominicalOFestivo: false });
  const tarde = clasificarTurno({ entrada: bog(14), salida: bog(18), rates, esDominicalOFestivo: false });
  assert.equal(manana.desglose.ordinaria, 4);
  assert.equal(tarde.desglose.ordinaria, 4);
  // Cada bloque tiene su propia asignación de jornada ordinaria (limitación
  // conocida y documentada de clasificar por turno, no por día).
});

test('salida <= entrada lanza error', () => {
  assert.throws(() => clasificarTurno({ entrada: bog(15), salida: bog(15), rates, esDominicalOFestivo: false }));
  assert.throws(() => clasificarTurno({ entrada: bog(15), salida: bog(14), rates, esDominicalOFestivo: false }));
});
