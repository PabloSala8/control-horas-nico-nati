import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretarCorreccion } from './interpretarCorreccion.ts';

test('"hoy salí a las 3" -> 3:00 PM (inferido), tipo salida', () => {
  const r = interpretarCorreccion('hoy salí a las 3');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 15);
  assert.equal(r.minuto, 0);
  assert.equal(r.tipo, 'salida');
  assert.equal(r.meridiemInferido, true);
});

test('"entré 8am" -> 8:00 AM explícito, tipo entrada', () => {
  const r = interpretarCorreccion('entré 8am');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 8);
  assert.equal(r.tipo, 'entrada');
  assert.equal(r.meridiemInferido, false);
});

test('"salí a las 3:30 pm" -> 15:30', () => {
  const r = interpretarCorreccion('salí a las 3:30 pm');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 15);
  assert.equal(r.minuto, 30);
});

test('"llegué al mediodía" -> 12:00, tipo entrada', () => {
  const r = interpretarCorreccion('llegué al mediodía');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 12);
  assert.equal(r.minuto, 0);
  assert.equal(r.tipo, 'entrada');
});

test('"salí 15:45" -> 24h directo', () => {
  const r = interpretarCorreccion('salí 15:45');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 15);
  assert.equal(r.minuto, 45);
});

test('"a la 1 de la tarde" -> 13:00', () => {
  const r = interpretarCorreccion('a la 1 de la tarde');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 13);
});

test('"a las 9 de la mañana" -> 9:00 AM explícito por contexto', () => {
  const r = interpretarCorreccion('a las 9 de la mañana');
  assert.equal(r.ok, true);
  assert.equal(r.hora, 9);
  assert.equal(r.meridiemInferido, false);
});

test('fallback: "no me acuerdo a qué hora salí" -> ok false, tipo salida', () => {
  const r = interpretarCorreccion('no me acuerdo a qué hora salí');
  assert.equal(r.ok, false);
  assert.equal(r.tipo, 'salida');
  assert.equal(r.hora, undefined);
});

test('fallback: "salí tarde hoy" (sin número) -> ok false', () => {
  const r = interpretarCorreccion('salí tarde hoy');
  assert.equal(r.ok, false);
});

test('no confunde duración: "trabajé 5 horas" -> ok false', () => {
  const r = interpretarCorreccion('trabajé 5 horas');
  assert.equal(r.ok, false);
});

// ---------- Rango completo (sección 7.3, flujo "No, cambiar") ----------

test('rango explícito: "de 7:00 am a 4:00 pm" -> 7:00–16:00', () => {
  const r = interpretarCorreccion('de 7:00 am a 4:00 pm');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rango, { entrada: { hora: 7, minuto: 0 }, salida: { hora: 16, minuto: 0 } });
});

test('rango sin meridiem: "de 7 a 4" -> entrada AM, salida PM', () => {
  const r = interpretarCorreccion('de 7 a 4');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rango, { entrada: { hora: 7, minuto: 0 }, salida: { hora: 16, minuto: 0 } });
});

test('rango sin "de": "8am a 2pm"', () => {
  const r = interpretarCorreccion('8am a 2pm');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rango, { entrada: { hora: 8, minuto: 0 }, salida: { hora: 14, minuto: 0 } });
});

test('rango con guion: "7:00 - 16:00"', () => {
  const r = interpretarCorreccion('7:00 - 16:00');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rango, { entrada: { hora: 7, minuto: 0 }, salida: { hora: 16, minuto: 0 } });
});

test('rango con sesgo evita inversión: "de 6 a 3" -> 6:00 AM a 3:00 PM', () => {
  const r = interpretarCorreccion('de 6 a 3');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rango, { entrada: { hora: 6, minuto: 0 }, salida: { hora: 15, minuto: 0 } });
});

test('un punto no se confunde con rango: "a las 3" sigue siendo punto', () => {
  const r = interpretarCorreccion('a las 3');
  assert.equal(r.ok, true);
  assert.equal(r.rango, undefined);
  assert.equal(r.hora, 15);
});
