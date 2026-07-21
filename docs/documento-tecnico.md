# Documento técnico — Sistema de control de horas (Nico y Nati)

Cliente interno LeanRevenue. Fuente de verdad de la lógica de negocio. Cualquier
comportamiento del sistema que no esté descrito aquí debe tratarse como no
definido — no se inventa silenciosamente, se anota como pregunta abierta y se
resuelve antes de construir sobre esa base.

## 1. Contexto y alcance

**Problema:** Nati lleva a mano, en un Excel, el conteo de horas extra,
actividades pagadas y adelantos de dos empleadas del hogar. El dolor no es el
cálculo — es la captura: alguien tiene que acordarse y transcribir cada
novedad.

**Objetivo de esta fase (Fase 1):** eliminar la captura manual con un bot de
Telegram que las empleadas usan directamente, un motor que clasifica y calcula
solo, y un cierre de quincena que genera los reportes sin que nadie tenga que
sumar nada.

**Fuera de alcance de este documento:**
- Portal web de administración (Fase 2 — se construye después de validar que
  la captura funciona en la práctica).
- Cumplimiento legal certificado por contador. El motor usa una aproximación
  razonable de los recargos vigentes, pero los rates son 100% editables sin
  tocar código — si en algún momento se requiere precisión legal estricta, se
  ajustan ahí, no en el código.
- Consulta individual de la empleada a su propio historial vía el bot. Se
  descartó a propósito: si alguna quiere saber cómo va su quincena, se lo
  pregunta directo a Nico o Nati.

**Arranque de datos:** el sistema empieza en cero el 1 de agosto de 2026. No
se migra el histórico del Excel anterior.

## 2. Actores y canales

Tres chats de Telegram en total, y solo tres:

| Chat | Miembros | Uso |
|---|---|---|
| Grupo Nena | Nena (Yariné) + bot | Entrada, salida, actividad extra, correcciones |
| Grupo Maye | Maye (Mayerlis) + bot | Entrada, salida, actividad extra, correcciones |
| Grupo Admins | Nico + Nati + bot | Aprobaciones, préstamos, bonos, consulta en vivo, cierre de quincena, Excel/PDF |

No existen chats privados individuales con el bot. Esta decisión es
deliberada: reduce superficie de mantenimiento y evita fragmentar la
conversación en demasiados canales.

## 3. Reglas de permisos y privacidad

Estas reglas son de cumplimiento estricto porque protegen tanto la
privacidad financiera de las empleadas entre sí como la integridad de los
datos:

1. **Los montos en pesos nunca se muestran en el grupo de una empleada.** Las
   horas sí (son visibles y esperables), el dinero no.
2. **Ninguna empleada ve información de la otra.** Cada bot-response en un
   grupo de empleada solo contempla los datos de esa empleada.
3. **Las acciones sensibles (aprobar corrección, registrar préstamo o bono,
   disparar cierre) solo se procesan si el mensaje o el botón proviene del
   `chat_id` del grupo de admins.** Si por error un botón administrativo
   quedara visible en otro chat, el bot debe rechazar la acción en silencio
   al validar el `chat_id` de origen — nunca confiar solo en quién aparece
   como remitente.
4. **Los eventos de marcación son inmutables.** Una corrección nunca
   sobrescribe un evento existente — siempre inserta un evento nuevo que
   referencia al que corrige. El histórico completo de qué se marcó, qué se
   pidió corregir y quién aprobó debe quedar reconstruible en todo momento.

## 4. Modelo de datos

Tres categorías de tabla, y la distinción importa para no romper el
histórico:

- **Inmutables** (solo se insertan filas, nunca se editan): `eventos_marcacion`
- **Derivadas** (se recalculan desde las inmutables): `turnos`
- **Configuración** (se editan, versionadas por fecha cuando aplica):
  `config_rates`, `catalogo_actividades`

### `empleadas`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| nombre | text | Nombre completo |
| alias | text | Nena / Maye |
| telegram_user_id | bigint | Id de Telegram de la empleada |
| chat_id_grupo | bigint | Id del grupo específico de esa empleada |
| salario_base_mensual | int | Ej. el mínimo vigente |
| activa | bool | |

### `admins`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| nombre | text | Nico / Nati |
| telegram_user_id | bigint | Para validar quién aprueba |
| chat_id_admin | bigint | Id del grupo de admins (compartido por ambos) |

### `eventos_marcacion` (inmutable)
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| empleada_id | uuid FK | |
| tipo | enum | `entrada` / `salida` |
| momento_declarado | timestamp | La hora real que cuenta para el cálculo |
| momento_mensaje | timestamp | Cuándo se envió el mensaje (puede diferir) |
| estado | enum | `confirmado` / `pendiente` / `rechazado` |
| corrige_evento_id | uuid FK nullable | Si es una corrección, apunta al evento original |
| aprobado_por | uuid FK nullable → admins | Quién aprobó, si aplica |

Un evento con `momento_declarado` distinto de `momento_mensaje` es siempre
una corrección y nace en estado `pendiente`.

### `turnos` (derivada — se materializa solo cuando el par entrada/salida está confirmado)
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| empleada_id | uuid FK | |
| fecha | date | |
| horas_totales | numeric | |
| desglose_tramos | jsonb | `{ ordinaria: h, extra_diurna: h, extra_nocturna: h, dominical: h }` |
| valor_calculado | int | Resultado en pesos del desglose |
| rates_id | uuid FK → config_rates | Qué versión de rates se usó |
| quincena_id | uuid FK → quincenas | |

**Importante:** mientras la salida de un turno está `pendiente` de
aprobación, el turno **no existe todavía** — solo existen los eventos. El
turno se crea (o recalcula) en el momento en que ambos eventos del día quedan
`confirmado`.

### `config_rates` (versionada por fecha — nunca se actualiza en sitio)
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| vigente_desde | date | Cada cambio es una fila nueva |
| salario_base | int | |
| divisor_horas | int | Hoy 210 (jornada 42h) |
| rec_extra_diurna | numeric | Fracción, ej. 0.25 |
| rec_extra_nocturna | numeric | |
| rec_dominical | numeric | |
| inicio_nocturno | time | Hoy 19:00 |
| creado_por | uuid FK → admins | |

La hora ordinaria nunca se guarda como número fijo — se deriva siempre de
`salario_base / divisor_horas`. Cuando Nico o Nati cambien el salario base,
insertan una fila nueva; todo lo calculado después usa la fila más reciente
vigente a esa fecha, y lo ya congelado en quincenas cerradas no se toca.

### `catalogo_actividades`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| nombre | text | Ej. "Rococó", "Gatas" |
| valor | int | Hoy $10.000 ambas, pero editable independientemente |
| activa | bool | Permite desactivar sin borrar histórico |

### `actividades`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| empleada_id | uuid FK | |
| catalogo_id | uuid FK | |
| fecha | date | |
| quincena_id | uuid FK | |

### `movimientos` (préstamos y bonos)
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| empleada_id | uuid FK | |
| tipo | enum | `prestamo` (resta del neto) / `bono` (suma) |
| monto | int | |
| fecha | date | |
| quincena_id | uuid FK | A qué quincena se descuenta o suma |
| registrado_por | uuid FK → admins | |
| nota | text nullable | |

### `quincenas`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| periodo | text | Ej. "Q2-Agosto 2026" |
| fecha_inicio | date | |
| fecha_fin | date | |
| estado | enum | `abierta` / `cerrada` |
| snapshot | jsonb nullable | Se llena al cerrar; nunca se recalcula después |
| cerrada_en | timestamp nullable | |

### `festivos`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| fecha | date | |
| nombre | text | |

Precargada con el calendario colombiano de festivos. El motor la consulta
para saber si un día cuenta como dominical/festivo sin que nadie lo marque a
mano.

## 5. Motor de clasificación de horas

Dado un turno (entrada + salida confirmadas), el motor:

1. Calcula horas totales del turno.
2. Determina si la fecha es domingo o está en `festivos` → si sí, todo el
   turno se clasifica como recargo dominical/festivo, no como hora extra
   ordinaria.
3. Si no es festivo: parte el turno en tramos usando `inicio_nocturno` (hoy
   19:00) como corte entre diurno y nocturno.
4. Dentro de cada tramo, separa lo que cae dentro de la jornada ordinaria
   (proporcional a 42h/semana) de lo que es adicional (extra).
5. Aplica los recargos de `config_rates` vigentes a la fecha del turno sobre
   cada tramo.
6. Guarda el desglose completo en `desglose_tramos` y el total en
   `valor_calculado`.

**Nota deliberada:** no se está optimizando este motor para blindaje legal
frente al Ministerio de Trabajo (Nico y Nati fueron explícitos: no es
prioridad ahora). Se optimiza para que el cálculo sea consistente, editable y
transparente. Si en el futuro se requiere precisión legal, se ajustan los
valores en `config_rates` — el motor ya está diseñado para eso.

## 6. Flujo: marcación normal

1. Empleada toca **Entré** en su grupo → se crea un `eventos_marcacion` tipo
   `entrada`, estado `confirmado` (no requiere aprobación: registrar que
   llegó no tiene impacto financiero por sí solo).
2. Al final del turno, toca **Salí** → se crea un `eventos_marcacion` tipo
   `salida`, estado `confirmado`.
3. El motor se dispara automáticamente, crea el `turno`, lo asocia a la
   `quincena` vigente según la fecha.
4. El bot confirma en el grupo de la empleada solo con horas — nunca con
   pesos.

## 7. Flujo: corrección en lenguaje natural

Ejemplo: la empleada olvidó marcar y escribe "hoy salí a las 3".

1. El bot interpreta la hora contra el turno esperado de esa empleada ese
   día (usa el horario habitual como referencia de desambiguación, nunca
   adivina sin mostrar su interpretación).
2. Crea un `eventos_marcacion` con `momento_declarado` = la hora indicada,
   `momento_mensaje` = cuándo se escribió, estado `pendiente`,
   `corrige_evento_id` apuntando al evento original si existía uno.
3. Responde en el grupo de la empleada: *"Anoté tu salida a las 3:00 PM — en
   revisión"* — sin mencionar horas extra ni montos.
4. Envía al grupo de admins la solicitud con el impacto ya calculado en
   pesos, y dos botones: Confirmar / Ajustar hora.
5. Si Nico o Nati confirman: el evento pasa a `confirmado`, se dispara el
   motor, se crea o recalcula el `turno`, y el bot avisa en el grupo de la
   empleada que quedó confirmado (sin montos).
6. Si nadie responde: el evento queda `pendiente` indefinidamente. Este
   estado **bloquea el cierre de quincena** — no se resuelve solo.

## 8. Flujo: actividad extra (Rococó / Gatas)

1. Empleada toca el botón de la actividad en su grupo.
2. Se crea un registro en `actividades` contra el `catalogo_actividades`
   correspondiente, asociado a la quincena vigente.
3. No requiere aprobación — es de bajo riesgo e impacto fijo y conocido.

## 9. Flujo: préstamos

1. Solo desde el grupo de admins: *"le presté 200 a Nena"*.
2. El bot confirma monto, empleada y a qué quincena se descuenta (por
   defecto la quincena vigente, ajustable).
3. Se crea un `movimiento` tipo `prestamo`. Resta del neto de esa quincena.

## 10. Flujo: bonos

Mismo mecanismo que préstamos pero tipo `bono`, suma en vez de restar, y su
catálogo de motivos es configurable por los admins igual que las actividades.

## 11. Consulta en vivo

Desde el grupo de admins, en cualquier momento: *"cómo va la quincena"* →
el bot calcula al instante contra la base de datos (horas, extras,
actividades, pendientes) y responde en el chat. **No genera ningún archivo.**
Esta es la vía principal para "ver en vivo" — está disponible desde el primer
día, sin esperar al portal de Fase 2.

## 12. Cierre de quincena

Disparado por un job programado en la fecha de corte (día 15 y último día
de cada mes) o manualmente por un admin.

1. Revisa si quedan `eventos_marcacion` en estado `pendiente`. Si hay
   alguno, **no cierra** — lista los pendientes y pide resolverlos primero.
2. Con todo resuelto, calcula el neto por empleada:
   `salario_base + extras + actividades + bonos − préstamos = neto`.
3. Congela el resultado completo en `quincenas.snapshot` — este valor nunca
   se recalcula después, aunque cambien rates o salarios a futuro.
4. Genera y envía automáticamente al grupo de admins el Excel de tracking y
   el PDF resumen, marcados como versión cerrada/definitiva.

## 13. Excel y PDF bajo demanda

Comando en el grupo de admins (ej. *"dame el excel"*) genera el archivo al
instante con el estado actual de la quincena y lo envía directo como archivo
adjunto en el chat.

- Si se pide **antes del cierre**: el archivo lleva un encabezado explícito
  **"Parcial — al [fecha y hora]"**. No se actualiza solo después; es una
  foto del momento en que se pidió.
- Si se pide **después del cierre**: es la versión ya congelada y definitiva.

## 14. Glosario

| Término | Significado |
|---|---|
| Quincena | Periodo de pago, del 1-15 o 16-fin de mes |
| Neto | Salario base + extras + actividades + bonos − préstamos |
| Rococó / Gatas | Actividades extra pagadas por evento (hoy $10.000 c/u) |
| Turno | Par entrada/salida ya confirmado y clasificado |
| Snapshot | Resultado congelado de una quincena cerrada |

## 15. Orden de construcción sugerido

Sin fechas asociadas — es el orden lógico de dependencias, no un cronograma:

1. Modelo de datos y migraciones.
2. Motor de clasificación de horas como función pura, testeada sin el bot.
3. Bot: comandos de entrada/salida/actividad en los grupos de empleadas.
4. Flujo de corrección en lenguaje natural + aprobación en grupo de admins.
5. Préstamos y bonos.
6. Consulta en vivo.
7. Cierre de quincena automático + generación de Excel/PDF.
8. Excel/PDF bajo demanda con marca de parcial.

## 16. Preguntas abiertas (resolver antes de construir esa parte)

- ¿Cómo se desambigua exactamente "salí a las 3" cuando el turno esperado
  tiene tramos de mañana y tarde (caso histórico de Maye en el Excel viejo)?
  Definir la regla de referencia antes de construir el paso 4.
- ¿Qué pasa si una empleada marca "Entré" dos veces seguidas sin salida
  intermedia? Debe quedar una regla explícita (ej. la segunda entrada se
  ignora con aviso, o sobrescribe la anterior como corrección).
