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

**Turnos partidos (confirmado — sí ocurren):** una misma `empleada_id` puede
tener **más de un `turno` en la misma `fecha`** (ej. bloque de mañana y
bloque de tarde). La tabla ya lo soporta sin cambios — no hay restricción de
unicidad por `(empleada_id, fecha)`. Los agregados de quincena simplemente
suman todos los turnos del rango de fechas, sin importar cuántos bloques
haya por día.

**Invariante que hace esto seguro:** el sistema garantiza que una empleada
**nunca tiene más de un bloque abierto a la vez** (ver regla en sección 6).
Gracias a esto, cualquier "Salí" — por botón o por corrección en texto —
nunca es ambiguo: siempre hay como máximo un bloque esperando cerrarse.

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
2. Determina si la fecha es domingo o está en `festivos` → si sí, **todo** el
   turno se clasifica como recargo dominical/festivo (manda sobre la ventana
   ordinaria), no como hora extra ordinaria.
3. Si no es festivo: son **ordinarias** las horas trabajadas DENTRO de la
   ventana de reloj que tiene esa empleada ese día de la semana (ver 5.1). Lo
   trabajado **fuera** de la ventana —o en un día sin ventana— es **extra**,
   clasificada como diurna o nocturna según el corte de `inicio_nocturno` (hoy
   19:00). La hora ordinaria nunca lleva recargo nocturno.
4. Aplica los recargos de `config_rates` vigentes a la fecha del turno sobre
   cada tramo.
5. Guarda el desglose completo en `desglose_tramos` y el total en
   `valor_calculado`.

### 5.1 Ventanas ordinarias por empleada (horarios reales)

Corregido tras el primer día de prueba: la jornada ordinaria NO es un umbral de
horas por turno, sino una **ventana de reloj fija por empleada y día de la
semana**. Cada semana suma 42 horas ordinarias.

| | Lun–Jue | Vie | Sáb | Dom |
|---|---|---|---|---|
| **Maye** | 7:00–16:00 (9h) | 7:00–13:00 (6h) | — (todo extra) | — |
| **Nena** | 7:00–15:00 (8h) | 7:00–15:00 (8h) | 7:00–09:00 (2h) | — |

- Ordinaria = intersección de lo trabajado con la ventana. Si llega tarde o sale
  temprano, simplemente hace menos ordinarias (no genera extra); si llega antes o
  se queda después, esos minutos de afuera son extra.
- Los horarios viven **hardcodeados** en `src/core/horarios.ts` (dato puro,
  editable con un cambio de código + redeploy). Decisión deliberada: cambian rara
  vez y así no hay migración ni riesgo en la base. Si a futuro se quieren editables
  sin desplegar, se mueven a una tabla versionada como `config_rates`.
- Antes de esta corrección el motor usaba un umbral diario derivado del divisor
  (`divisor/30` ≈ 7h/día); se reemplazó por estas ventanas reales. El `divisor`
  sigue usándose solo para el valor de la hora ordinaria (`salario/divisor`).

**Nota deliberada:** no se está optimizando este motor para blindaje legal
frente al Ministerio de Trabajo (Nico y Nati fueron explícitos: no es
prioridad ahora). Se optimiza para que el cálculo sea consistente, editable y
transparente. Si en el futuro se requiere precisión legal, se ajustan los
valores en `config_rates` — el motor ya está diseñado para eso.

## 6. Flujo: marcación normal

### 6.0 Activación del menú

El bot despliega el menú de botones (Entré / Salí / Actividad / Generar
novedad) cuando detecta un saludo común ("hola", "buenas", "buenos días",
etc.) **o** el comando `/start` — ambos funcionan, ninguno es obligatorio.
Cualquier otro texto que no sea un saludo ni parezca una hora (ver sección
7.0) se ignora sin respuesta — el bot no reacciona a conversación normal
entre las empleadas.

### 6.1 "Generar novedad" (flujo guiado)

Para cuando se le olvidó marcar entrada o salida a tiempo. Es la vía
**recomendada** sobre escribir texto libre, porque el tipo queda explícito
por botón en vez de tener que inferirlo del mensaje:

1. Empleada toca **Generar novedad**.
2. El bot pregunta: *¿Qué se te olvidó marcar?* → botones **Entrada** /
   **Salida**.
3. El bot pide la hora (respuesta en texto libre, ej. "7:30 am").
4. A partir de aquí sigue exactamente el mismo mecanismo de aprobación de
   la sección 7 (`pendiente` → notificación a admins con impacto en pesos →
   Confirmar/Ajustar) — la única diferencia es que el **tipo** (entrada o
   salida) ya viene resuelto por el botón, no por interpretación de texto.

### 6.2 Marcación por botón

1. Empleada toca **Entré** en su grupo → el bot revisa si ya existe un
   bloque abierto (una `entrada` `confirmado` sin `salida` `confirmado`
   correspondiente) para esa empleada:
   - **Si no hay bloque abierto:** se crea un `eventos_marcacion` tipo
     `entrada`, estado `confirmado` directo (no requiere aprobación:
     registrar que llegó no tiene impacto financiero por sí solo). Esto
     soporta turnos partidos con normalidad — un segundo "Entré" después de
     haber cerrado el primer bloque con "Salí" simplemente abre un bloque
     nuevo el mismo día.
   - **Si ya hay un bloque abierto** (la empleada toca "Entré" de nuevo sin
     haber marcado "Salí" del anterior): **no se abre un bloque nuevo.** Se
     trata como una corrección a la hora de entrada del bloque abierto —
     sigue el mismo mecanismo de la sección 7 (`pendiente`, notificación a
     admins, aprobación). Regla de negocio confirmada explícitamente: un
     segundo "Entré" sin "Salí" de por medio significa "corregir mi hora de
     entrada", no "empezar un bloque nuevo".
   - *Simplificación aceptada:* si una empleada de verdad trabajó dos
     bloques pero olvidó marcar "Salí" del primero antes de tocar "Entré"
     del segundo, esta regla lo va a interpretar como corrección del primer
     bloque. Es un caso de baja frecuencia, recuperable a mano por un admin
     desde el grupo de admins.
2. Al final del bloque, toca **Salí** → se crea un `eventos_marcacion` tipo
   `salida`, estado `confirmado`. Gracias al invariante de "máximo un
   bloque abierto a la vez", esto siempre cierra el bloque correcto sin
   ambigüedad, incluso con turnos partidos.
3. El motor se dispara automáticamente, crea el `turno`, lo asocia a la
   `quincena` vigente según la fecha. Un mismo día puede tener varios
   `turno` (uno por bloque) para la misma empleada.
4. El bot confirma en el grupo de la empleada solo con horas — nunca con
   pesos.

## 7. Flujo: corrección en lenguaje natural

Ejemplo: la empleada olvidó marcar y escribe "hoy salí a las 3".

**Decisión de diseño (confirmada):** este flujo se construye sin depender
de ningún proveedor de LLM externo (Gemini/Kimi quedó como mejora futura
opcional, ver sección 16). Usa un enfoque de tres pasos que nunca deja al
sistema adivinar sin red de seguridad, y que **nunca reacciona a mensajes
que no son intentos de marcación** (una empleada saludando, charlando, etc.
no debe generar ninguna respuesta del bot).

### 7.0 Paso 1 — Screening: ¿esto parece una hora?

Antes de cualquier otra cosa, el bot revisa si el mensaje contiene algún
indicio de hora: números que parezcan reloj ("a las 3", "3pm", "3:30"), o
palabras clave de marcación ("llegué", "entré", "salí", "entrada",
"salida"). **Si no hay ningún indicio → el bot no hace nada.** No responde,
no crea ningún registro. Esto es lo que evita que el bot reaccione a un
"hola" o cualquier charla normal del grupo como si fuera una corrección.

Si sí hay indicio de hora, sigue al paso 2.

### 7.1 Paso 2 — ¿Está claro el tipo (entrada o salida)?

El bot busca palabras clave de tipo: "llegué"/"entré"/"llegada"/"entrada" →
`entrada`; "salí"/"salida" → `salida`.

- **Si el tipo es claro:** sigue directo al paso 3 (interpretación de la
  hora).
- **Si el tipo NO es claro** (hay una hora pero ninguna palabra que indique
  cuál es): el bot **no le pregunta a la empleada** — escala directo al
  grupo de admins con el texto original y tres botones: **Nueva entrada** /
  **Nueva salida** / **No es una novedad**.
  - Si un admin toca **Nueva entrada** o **Nueva salida**, el bot continúa
    al paso 3 con el tipo ya resuelto.
  - Si toca **No es una novedad**, se descarta sin crear ningún registro.
  - **Relay de texto libre:** si en vez de tocar un botón el admin responde
    con texto normal, el bot reenvía ese texto tal cual al grupo de la
    empleada correspondiente, como mensaje del admin. Esto evita que Nico o
    Nati tengan que aprender sintaxis especial para el caso raro — pueden
    simplemente responder como personas y el bot hace de puente.

### 7.2 Paso 3 — Interpretación de la hora (Nivel 1)

El bot intenta extraer una hora del mensaje con reglas/patrones básicos
(números, "a la(s) X", "X am/pm", "X:XX", "el mediodía"). Gracias al
invariante de bloque único abierto (sección 6), no hace falta desambiguar
*a qué bloque* se refiere — solo hay uno esperando cerrarse (o abrirse, si
es una corrección de entrada).

**Regla no negociable: toda hora que el bot muestre, en cualquier mensaje,
siempre lleva AM/PM explícito.** Nunca "6:00" a secas — siempre "6:00 AM" o
"6:00 PM". Esto es lo que le permite a un admin atrapar una interpretación
equivocada *antes* de confirmar, en vez de descubrirla después.

**Si el Nivel 1 interpreta con claridad:**
- Crea un `eventos_marcacion` con `momento_declarado` = la hora
  interpretada, `momento_mensaje` = cuándo se escribió, estado `pendiente`,
  `corrige_evento_id` apuntando al evento que corrige (si aplica).
- Responde en el grupo de la empleada: *"Anoté tu salida a las 3:00 PM — en
  revisión"* — sin mencionar horas extra ni montos.
- Envía al grupo de admins la solicitud con el impacto ya calculado en
  pesos, en el formato de la sección 7.4, con botones **Sí** / **No,
  cambiar**.

**Si el Nivel 1 no logra interpretar la hora con confianza** (esto solo
puede pasar ya con el tipo resuelto — ver 7.1): no adivina. Envía al grupo
de admins el texto original tal cual, sin hora sugerida — el admin escribe
la hora correcta directamente (mismo mecanismo de relay de texto libre que
en 7.1).

### 7.3 Aprobación y "No, cambiar" con rango completo

Si un admin toca **No, cambiar**, el bot pide el horario correcto (ej.
*"Escribe el horario correcto, ej: de 7:00 am a 4:00 pm"*). Esta respuesta
puede ser un **rango completo** (dos horas, ej. "de 7:00 am a 4:00 pm"), no
solo un punto — el Nivel 1 debe reconocer ambos casos. El bot vuelve a
mostrar la vista previa (sección 7.4) con el horario ajustado para
confirmar de nuevo.

Cuando se confirma (con **Sí** directo, o después de uno o más ajustes): el
evento pasa a `confirmado`, se dispara el motor, se crea o recalcula el
`turno`, y el bot avisa en el grupo de la empleada con el **mensaje
completo de lo que quedó confirmado** — nunca un genérico "confirmado".
Ejemplo: *"✅ Se confirmó tu entrada a las 6:00 AM"* — el valor final
aprobado, aunque sea distinto al que ella escribió originalmente.

Si nadie responde: el evento queda `pendiente` indefinidamente. Este estado
**bloquea el cierre de quincena** — no se resuelve solo.

### 7.4 Formato de confirmación al grupo de admins

```
✅ Turno — Nena
📅 22/07/2026 · 6:00 AM – 5:00 PM (11h)

Ordinarias: 7h
Extra diurna: 4h
Total: $100.052

¿Confirmas este horario?
[Sí]  [No, cambiar]
```

Notación siempre en formato 12 horas + AM/PM, nunca mezclada con 24 horas
(evita ambigüedades como "17:00pm").

**Nota de arquitectura:** la función de interpretación (Nivel 1) debe vivir
detrás de una única función en `/src/core` (ej. `interpretarCorreccion()`),
sin que el resto del código sepa cómo está implementada por dentro. Si en
el futuro se decide reemplazarla por una llamada a un LLM (Gemini, Kimi,
u otro) para subir el porcentaje de mensajes interpretados en el Nivel 1,
solo se toca esa función — el flujo de aprobación y todo lo demás queda
igual.

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

**Detalle de horas en la hoja "Turno":** además de las horas totales por
tipo, la hoja debe mostrar el rango de reloj de cada tramo — hora de entrada
y salida del turno, y de qué hora a qué hora corresponde cada tramo
(ordinaria, extra diurna, extra nocturna, dominical/festivo). Estos rangos
**se recalculan al generar el reporte** a partir de la entrada/salida real y

### 13.1 Estructura del Excel (legibilidad por empleada — pedido de Nati)

- **Separación por empleada:** en vez de una sola hoja de turnos con Nena y
  Maye mezcladas por fecha, el libro separa el detalle diario en hojas
  independientes: **"Turnos — Nena"** y **"Turnos — Maye"**. Lo mismo aplica
  a **"Movimientos — Nena"** / **"Movimientos — Maye"** (préstamos y bonos).
  La hoja **"Resumen"** se mantiene combinada — es la vista comparativa de
  ambas, y ahí sí tiene sentido verlas una al lado de la otra.
- **Columna de actividad:** cada hoja de turnos gana una columna
  **"Actividad"** que muestra el nombre de la actividad extra (Rococó,
  Gatas, ambas) registrada ese mismo día para esa empleada. Si un día tiene
  actividad pero ningún turno registrado, se agrega igual una fila para esa
  fecha (columnas de horas en blanco) para no perder el dato.
- **Resaltado de horas extra:** las celdas de horas y valor de extra diurna,
  extra nocturna y dominical/festivo llevan un color de relleno distinto al
  de las horas ordinarias, para que salten a la vista de inmediato. Cada
  hoja de turnos cierra con una fila de **total de horas extra** (horas y
  valor en pesos) para esa empleada en el período.
- **Pulido visual general:** encabezados en negrita, ancho de columna
  ajustado al contenido, formato de moneda consistente, bordes sutiles.
  Cambio de presentación únicamente — ningún valor calculado cambia.

las mismas reglas del motor de clasificación (sección 5) — no se guardan
duplicados en la base de datos, para no tener dos fuentes de verdad que
puedan desincronizarse. Notación siempre en formato 12 horas + AM/PM (ver
sección 7.4).

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
3. Bot: comandos de entrada/salida/actividad en los grupos de empleadas,
   incluyendo la regla de doble "Entré" → corrección (sección 6).
4. Flujo de corrección en lenguaje natural (Nivel 1 + fallback a admin) +
   aprobación en grupo de admins (sección 7). Ya no depende de ninguna
   decisión de proveedor LLM pendiente.
5. Préstamos y bonos.
6. Consulta en vivo.
7. Cierre de quincena automático + generación de Excel/PDF.
8. Excel/PDF bajo demanda con marca de parcial.

## 17. Editar rates (admins)

Hoy los rates solo se cargan por seed/migración — no hay comando en el bot.
Se agrega siguiendo el mismo patrón ya usado en préstamos y bonos (mensaje
en lenguaje natural → vista previa → Confirmar/Cancelar):

- **Consultar:** *"cuáles son los rates"* → el bot muestra la fila vigente
  de `config_rates` completa (salario base, divisor, recargos, inicio
  nocturno).
- **Cambiar:** *"cambiar salario base a 1.800.000"* (o cualquier otro
  campo) → el bot muestra una vista previa de la fila **nueva** que se va a
  insertar (recuerda: `config_rates` nunca se edita en sitio, sección 4) con
  el resto de campos sin cambio, y botones **Sí** / **Cancelar**. Al
  confirmar, `vigente_desde` = fecha del día en que se hace el cambio.

No requiere una segunda aprobación de otro admin — quien lo pide y lo
confirma es la misma persona, igual que con préstamos y bonos.

## 18. Corregir un turno pasado (admins)

Distinto del flujo de corrección de la sección 7: ahí se corrige un bloque
**abierto** (todavía sin cerrar). Aquí se corrige un turno que **ya está
confirmado y cerrado**, de cualquier fecha pasada.

1. Admin escribe algo como *"corregir turno de Nena del 20 de julio"*.
2. El bot busca los turnos de esa empleada en esa fecha:
   - Si hay uno solo, lo muestra (rango de horas + desglose) y pide el
     horario correcto.
   - Si hay más de uno (turno partido ese día), muestra ambos con su rango
     de horas y pregunta cuál se va a corregir.
3. Admin da el horario correcto (punto o rango, igual que en 7.3).
4. El bot muestra la vista previa del turno recalculado (mismo formato de
   7.4) con botones **Sí** / **Cancelar**.
5. Al confirmar, se recalcula ese `turno` con el motor. Si esa quincena ya
   estaba **cerrada** (snapshot congelado), el snapshot **no se toca** — la
   corrección queda reflejada en el turno individual pero no altera un
   cierre ya congelado (mismo principio de la sección 12: lo cerrado no se
   recalcula). El admin debe saber que corregir un turno de una quincena ya
   cerrada no cambia el neto que ya se pagó — si eso es necesario, es una
   conversación aparte, no automática.

Misma regla que en la sección 17: quien lo pide y lo confirma es la misma
persona, sin segunda aprobación.

## 19. Orden de construcción — Sesión 5 (correcciones post-demo)

Sin fechas asociadas — orden lógico de dependencias sobre lo ya construido:

1. Activación por saludo + `/start` (6.0) y flujo guiado "Generar novedad"
   (6.1).
2. Screening de mensajes (7.0) — el bot deja de reaccionar a texto que no
   parece una hora.
3. Detección de tipo por palabras clave + escalación a admins con relay de
   texto libre (7.1).
4. AM/PM explícito en todos los mensajes + mensaje final completo a la
   empleada (7.2-7.3).
5. Reconocimiento de rango completo en "No, cambiar" (7.3).
6. Formato de confirmación unificado (7.4).
7. Rangos de horas por tramo en Excel/PDF (sección 13).
8. Comandos de editar rates (sección 17).
9. Comando de corregir turno pasado (sección 18).

Las dos preguntas abiertas originales quedaron resueltas y ya están
incorporadas en las secciones 4, 6 y 7:

- **Turnos partidos:** sí ocurren. Resuelto con el invariante de "máximo un
  bloque abierto a la vez" (secciones 4 y 6) — elimina la ambigüedad sin
  necesidad de lógica adicional de desambiguación.
- **Doble "Entré" sin "Salí" de por medio:** se trata como corrección a la
  entrada existente, no como apertura de un bloque nuevo (sección 6).
  Simplificación aceptada y documentada: el caso borde de un turno partido
  real donde se olvida marcar "Salí" del primer bloque queda como
  corrección manual vía el grupo de admins, no como bug.

**Mejora futura opcional (no bloqueante):** reemplazar el Nivel 1 de
interpretación de la sección 7 (reglas/patrones simples) por una llamada a
un proveedor de LLM (Gemini Flash-Lite u otro) para subir el porcentaje de
mensajes que el bot interpreta sin intervención de un admin. Se decide
cuando haya evidencia real de cuántos mensajes caen al fallback manual —
no antes.
