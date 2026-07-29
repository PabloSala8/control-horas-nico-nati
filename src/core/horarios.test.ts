import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ventanaParaFecha } from './horarios.ts';

// Semana conocida de 2026 (convención Bogotá = campos UTC).
// 2026-01-04 = domingo … 2026-01-10 = sábado.
const dia = (d: number) => new Date(Date.UTC(2026, 0, d));
const DOM = dia(4);
const LUN = dia(5);
const JUE = dia(8);
const VIE = dia(9);
const SAB = dia(10);

// Auto-verificación de que las fechas caen en el día de la semana que creo.
test('las fechas de referencia tienen el día de semana esperado', () => {
  assert.equal(DOM.getUTCDay(), 0);
  assert.equal(LUN.getUTCDay(), 1);
  assert.equal(JUE.getUTCDay(), 4);
  assert.equal(VIE.getUTCDay(), 5);
  assert.equal(SAB.getUTCDay(), 6);
});

test('Maye: lun–jue 7:00–16:00, vie 7:00–13:00, sáb/dom sin ventana', () => {
  assert.deepEqual(ventanaParaFecha('Maye', LUN), { desde: '07:00', hasta: '16:00' });
  assert.deepEqual(ventanaParaFecha('Maye', JUE), { desde: '07:00', hasta: '16:00' });
  assert.deepEqual(ventanaParaFecha('Maye', VIE), { desde: '07:00', hasta: '13:00' });
  assert.equal(ventanaParaFecha('Maye', SAB), null);
  assert.equal(ventanaParaFecha('Maye', DOM), null);
});

test('Nena: lun–vie 7:00–15:00, sáb 7:00–09:00, dom sin ventana', () => {
  assert.deepEqual(ventanaParaFecha('Nena', LUN), { desde: '07:00', hasta: '15:00' });
  assert.deepEqual(ventanaParaFecha('Nena', VIE), { desde: '07:00', hasta: '15:00' });
  assert.deepEqual(ventanaParaFecha('Nena', SAB), { desde: '07:00', hasta: '09:00' });
  assert.equal(ventanaParaFecha('Nena', DOM), null);
});

test('alias desconocido -> null', () => {
  assert.equal(ventanaParaFecha('Pablo', LUN), null);
});
