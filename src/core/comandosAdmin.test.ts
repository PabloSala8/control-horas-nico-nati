import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretarComandoAdmin,
  parseMonto,
  parseFechaEspanol,
  interpretarCambioRate,
} from './comandosAdmin.ts';

const ALIAS = ['Nena', 'Maye'];

test('parseMonto: número pelado se toma como miles', () => {
  assert.equal(parseMonto('le presté 200 a Nena'), 200_000);
  assert.equal(parseMonto('50'), 50_000);
  assert.equal(parseMonto('1500'), 1_500_000);
});

test('parseMonto: separadores de miles se toman literales', () => {
  assert.equal(parseMonto('200.000'), 200_000);
  assert.equal(parseMonto('1.500.000'), 1_500_000);
  assert.equal(parseMonto('15000'), 15_000); // >= 10.000 sin separador -> literal
});

test('parseMonto: sufijos mil/millón/k', () => {
  assert.equal(parseMonto('200 mil'), 200_000);
  assert.equal(parseMonto('1 millon'), 1_000_000);
  assert.equal(parseMonto('1.5 millones'), 1_500_000);
  assert.equal(parseMonto('200k'), 200_000);
});

test('parseMonto: sin número -> null', () => {
  assert.equal(parseMonto('le presté plata a Nena'), null);
});

test('préstamo completo', () => {
  const c = interpretarComandoAdmin('le presté 200 a Nena', ALIAS);
  assert.deepEqual(c, { tipo: 'prestamo', monto: 200_000, alias: 'Nena' });
});

test('préstamo por adelanto', () => {
  const c = interpretarComandoAdmin('adelanto de 100 mil para Maye', ALIAS);
  assert.equal(c.tipo, 'prestamo');
  if (c.tipo === 'prestamo') {
    assert.equal(c.monto, 100_000);
    assert.equal(c.alias, 'Maye');
  }
});

test('bono con nota (motivo tras "por")', () => {
  const c = interpretarComandoAdmin('bono de 50 a Maye por navidad', ALIAS);
  assert.equal(c.tipo, 'bono');
  if (c.tipo === 'bono') {
    assert.equal(c.monto, 50_000);
    assert.equal(c.alias, 'Maye');
    assert.equal(c.nota, 'navidad');
  }
});

test('préstamo incompleto: falta empleada', () => {
  const c = interpretarComandoAdmin('le presté 200', ALIAS);
  assert.deepEqual(c, { tipo: 'incompleto', intento: 'prestamo', faltaMonto: false, faltaEmpleada: true });
});

test('préstamo incompleto: falta monto', () => {
  const c = interpretarComandoAdmin('le presté algo a Nena', ALIAS);
  assert.deepEqual(c, { tipo: 'incompleto', intento: 'prestamo', faltaMonto: true, faltaEmpleada: false });
});

test('consulta en vivo', () => {
  assert.equal(interpretarComandoAdmin('cómo va la quincena', ALIAS).tipo, 'consulta');
  assert.equal(interpretarComandoAdmin('dame un resumen', ALIAS).tipo, 'consulta');
  assert.equal(interpretarComandoAdmin('cuánto llevamos', ALIAS).tipo, 'consulta');
});

test('cerrar quincena', () => {
  assert.equal(interpretarComandoAdmin('cerrar quincena', ALIAS).tipo, 'cerrar');
  assert.equal(interpretarComandoAdmin('hagamos el cierre', ALIAS).tipo, 'cerrar');
  assert.equal(interpretarComandoAdmin('cierre de quincena', ALIAS).tipo, 'cerrar');
});

test('reporte: excel / pdf / ambos', () => {
  assert.deepEqual(interpretarComandoAdmin('dame el excel', ALIAS), { tipo: 'reporte', formato: 'excel' });
  assert.deepEqual(interpretarComandoAdmin('pásame el pdf', ALIAS), { tipo: 'reporte', formato: 'pdf' });
  assert.deepEqual(interpretarComandoAdmin('quiero el reporte', ALIAS), { tipo: 'reporte', formato: 'ambos' });
  assert.deepEqual(interpretarComandoAdmin('dame el excel y el pdf', ALIAS), { tipo: 'reporte', formato: 'ambos' });
});

test('consulta y reporte no se confunden', () => {
  assert.equal(interpretarComandoAdmin('cómo va la quincena', ALIAS).tipo, 'consulta');
  assert.equal(interpretarComandoAdmin('dame el resumen', ALIAS).tipo, 'consulta');
  assert.equal(interpretarComandoAdmin('dame el informe en excel', ALIAS).tipo, 'reporte');
});

test('mensaje no relacionado -> desconocido (el bot se queda callado)', () => {
  assert.equal(interpretarComandoAdmin('buenos días equipo', ALIAS).tipo, 'desconocido');
});

// ---------- Fechas en español (sección 18) ----------

test('parseFechaEspanol: distintos formatos', () => {
  assert.equal(parseFechaEspanol('del 20 de julio', 2026), '2026-07-20');
  assert.equal(parseFechaEspanol('20 de julio de 2025', 2026), '2025-07-20');
  assert.equal(parseFechaEspanol('20/07/2026', 2026), '2026-07-20');
  assert.equal(parseFechaEspanol('20-07', 2026), '2026-07-20');
  assert.equal(parseFechaEspanol('2026-07-20', 2026), '2026-07-20');
  assert.equal(parseFechaEspanol('1 de enero', 2026), '2026-01-01');
  assert.equal(parseFechaEspanol('sin fecha aquí', 2026), null);
});

// ---------- Editar rates (sección 17) ----------

test('interpretarCambioRate: cada campo', () => {
  assert.deepEqual(interpretarCambioRate('cambiar salario base a 1.800.000'), {
    campo: 'salario_base', etiqueta: 'salario base', valor: 1_800_000,
  });
  assert.equal(interpretarCambioRate('cambiar divisor a 220')?.valor, 220);
  assert.equal(interpretarCambioRate('recargo extra diurna a 0.30')?.campo, 'rec_extra_diurna');
  assert.equal(interpretarCambioRate('recargo extra diurna a 0.30')?.valor, 0.3);
  assert.equal(interpretarCambioRate('recargo nocturno a 80%')?.campo, 'rec_extra_nocturna');
  assert.equal(interpretarCambioRate('recargo nocturno a 80%')?.valor, 0.8);
  assert.equal(interpretarCambioRate('recargo dominical a 100%')?.valor, 1);
  assert.deepEqual(interpretarCambioRate('inicio nocturno a 21:00'), {
    campo: 'inicio_nocturno', etiqueta: 'inicio del recargo nocturno', valor: '21:00',
  });
  assert.equal(interpretarCambioRate('esto no es un rate'), null);
});

test('interpretarComandoAdmin: rates ver / cambiar', () => {
  assert.equal(interpretarComandoAdmin('cuáles son los rates', ALIAS).tipo, 'rates-ver');
  assert.equal(interpretarComandoAdmin('muéstrame las tarifas', ALIAS).tipo, 'rates-ver');
  const c = interpretarComandoAdmin('cambiar salario base a 1.800.000', ALIAS);
  assert.equal(c.tipo, 'rates-cambiar');
  if (c.tipo === 'rates-cambiar') assert.equal(c.cambio.campo, 'salario_base');
});

test('interpretarComandoAdmin: corregir turno pasado', () => {
  const c = interpretarComandoAdmin('corregir turno de Nena del 20 de julio', ALIAS, 2026);
  assert.equal(c.tipo, 'corregir-turno');
  if (c.tipo === 'corregir-turno') {
    assert.equal(c.alias, 'Nena');
    assert.equal(c.fecha, '2026-07-20');
  }
});

test('rates/corregir no roban préstamos ni bonos', () => {
  assert.equal(interpretarComandoAdmin('le presté 200 a Nena', ALIAS).tipo, 'prestamo');
  assert.equal(interpretarComandoAdmin('bono de 50 a Maye por navidad', ALIAS).tipo, 'bono');
});

test('guía / instrucciones', () => {
  assert.equal(interpretarComandoAdmin('guía', ALIAS).tipo, 'guia');
  assert.equal(interpretarComandoAdmin('instrucciones', ALIAS).tipo, 'guia');
  assert.equal(interpretarComandoAdmin('ayuda', ALIAS).tipo, 'guia');
});

test('reset de base de datos (solo desarrollo)', () => {
  for (const s of ['borrar base de datos', 'resetear', 'reset', 'empezar de cero', 'borrar todo', 'limpiar la base de datos']) {
    assert.equal(interpretarComandoAdmin(s, ALIAS).tipo, 'reset-db', `debería ser reset: ${s}`);
  }
  // No debe confundirse con charla ni con otros comandos.
  assert.equal(interpretarComandoAdmin('cómo va la quincena', ALIAS).tipo, 'consulta');
  assert.equal(interpretarComandoAdmin('buenos días equipo', ALIAS).tipo, 'desconocido');
});
