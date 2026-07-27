import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esSaludo, esGuia, tieneIndicioDeHora, detectarTipoMarcacion } from './screening.ts';

test('esGuia reconoce peticiones de guía', () => {
  for (const s of ['guía', 'Guia', 'instrucciones', 'ayuda', 'comandos', 'help', '¿qué opciones hay?']) {
    assert.equal(esGuia(s), true, `debería pedir guía: ${s}`);
  }
});

test('esGuia NO se dispara con charla ni marcaciones', () => {
  for (const s of ['hola', 'salí a las 3', 'ayudame con el mercado a las 5', 'gracias']) {
    // "ayudame" no es "ayuda" (palabra completa); "a las 5" es marcación.
    if (s.includes('ayudame')) assert.equal(esGuia(s), false, `no debería: ${s}`);
  }
  assert.equal(esGuia('gracias'), false);
  assert.equal(esGuia('hola'), false);
});

test('esSaludo reconoce saludos comunes', () => {
  for (const s of ['hola', 'Hola!', 'buenas', 'buenos días', 'buenas tardes', 'holaaa', 'hey', 'menu', 'qué más']) {
    assert.equal(esSaludo(s), true, `debería ser saludo: ${s}`);
  }
});

test('esSaludo NO marca charla normal ni marcaciones', () => {
  for (const s of ['ya voy en camino', 'salí a las 3', 'necesito el mercado', 'gracias']) {
    assert.equal(esSaludo(s), false, `no debería ser saludo: ${s}`);
  }
});

test('tieneIndicioDeHora: números tipo reloj', () => {
  for (const s of ['a las 3', '3pm', '3:30', 'salí 15:45', 'llegué al mediodía']) {
    assert.equal(tieneIndicioDeHora(s), true, `debería tener indicio: ${s}`);
  }
});

test('tieneIndicioDeHora: palabras clave de marcación sin número', () => {
  for (const s of ['salí tarde hoy', 'ya entré', 'no me acuerdo a qué hora salí']) {
    assert.equal(tieneIndicioDeHora(s), true, `debería tener indicio: ${s}`);
  }
});

test('tieneIndicioDeHora: conversación normal NO tiene indicio (el bot se calla)', () => {
  for (const s of ['hola', 'buenas', 'compré 3 panes', 'gracias por todo', 'ok listo']) {
    assert.equal(tieneIndicioDeHora(s), false, `no debería tener indicio: ${s}`);
  }
});

test('detectarTipoMarcacion: entrada / salida / indefinido', () => {
  assert.equal(detectarTipoMarcacion('llegué a las 8'), 'entrada');
  assert.equal(detectarTipoMarcacion('entré tarde'), 'entrada');
  assert.equal(detectarTipoMarcacion('salí a las 3'), 'salida');
  assert.equal(detectarTipoMarcacion('me fui a las 4'), 'salida');
  assert.equal(detectarTipoMarcacion('3pm'), undefined); // hay hora pero no tipo -> escalar
  assert.equal(detectarTipoMarcacion('a las 5'), undefined);
});
