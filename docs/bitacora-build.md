# Bitácora de build

Log de solo-agregar. Nunca se borran entradas anteriores — cada sesión
añade la suya al final. Este archivo es lo que Pablo trae de vuelta al chat
estratégico para sincronizar decisiones; no hace falta que ahí se lea cada
commit, solo el resumen de cada sesión.

Formato sugerido por entrada:

```
## [fecha o número de sesión] — [qué se construyó, en una frase]

**Construido:**
-

**Decisiones tomadas:**
-

**Bugs encontrados y cómo se resolvieron:**
-

**Preguntas abiertas / pendiente para la próxima sesión:**
-
```

---

## Sesión 0 — Setup inicial

**Construido:**
- Aún nada. Este archivo y `CLAUDE.md` y `docs/documento-tecnico.md` son el
  punto de partida.

**Decisiones tomadas:**
- Stack: Node.js + TypeScript + Telegraf + PostgreSQL, hosting en Railway.
- Se descartó chat privado individual del bot con cada empleada y con cada
  admin — solo 3 chats: grupo Nena, grupo Maye, grupo Admins.
- No se migra el histórico del Excel anterior — arranque en cero el 1 de
  agosto de 2026.

**Bugs encontrados y cómo se resolvieron:**
- N/A

**Preguntas abiertas / pendiente para la próxima sesión:**
- Definir la regla exacta de desambiguación cuando una corrección de hora
  cae en un turno partido (mañana/tarde).
- Definir qué pasa si una empleada marca "Entré" dos veces sin salida
  intermedia.

---

## Sesión 1 — Flujo de marcación + correcciones de punta a punta (secciones 4-7)

**Construido:**
- Setup del proyecto: `package.json`, `tsconfig.json`, estructura
  `/src/{bot,core,db,jobs,reports}`. Stack: Node 26 + TypeScript corrido con
  `tsx` (imports con extensión `.ts`, ESM). `jobs/` y `reports/` quedan
  creadas pero vacías (son de sesiones futuras).
- Schema PostgreSQL (`src/db/schema.sql`) + migración idempotente
  (`src/db/migrate.ts`): `empleadas`, `admins`, `config_rates`,
  `eventos_marcacion` (inmutable), `turnos` (derivada), `festivos`, y
  `quincenas` (mínima). Enums `evento_tipo`, `evento_estado`,
  `quincena_estado`. Índices para bloques y turnos. Sin `UNIQUE(empleada_id,
  fecha)` en `turnos` — los turnos partidos están soportados por diseño.
- Seed (`src/db/seed.ts`), idempotente: `config_rates` con SMMLV, recargos,
  divisor 210 e inicio nocturno 19:00; Nena y Maye con sus `chat_id_grupo`
  reales; Nico y Nati en `admins`; los 18 festivos colombianos de 2026 (Ley
  Emiliani aplicada).
- Motor de clasificación (`src/core/clasificador.ts`) como funciones PURAS,
  probado sin bot ni DB. Convención de tiempo Bogotá en `src/core/tiempo.ts`.
  8 tests (`clasificador.test.ts`): ordinaria, extra diurna, extra nocturna,
  cruce del corte 19:00, dominical/festivo, fracciones, turno partido, y
  guardas de error.
- `interpretarCorreccion()` (`src/core/interpretarCorreccion.ts`), Nivel 1 por
  patrones simples, detrás de UNA sola función (swappable por LLM sin tocar el
  resto). 10 tests, incluyendo casos de fallback y no-confundir-duración.
- Bot Telegraf (`src/bot/`): panel con botones Entré/Salí, flujo de marcación
  (entrada directa, doble "Entré" = corrección, "Salí" cierra bloque y
  materializa turno, turnos partidos), corrección en lenguaje natural (Nivel 1
  + fallback manual a admins), y aprobación en el grupo de admins con
  Confirmar / Ajustar hora. Capa de orquestación en `src/bot/servicio.ts` y
  formateo con separación estricta de audiencias en `src/bot/formato.ts`
  (empleadas: solo horas; admins: con pesos).
- Validación: 18 tests unitarios de `/core` en verde + un smoke test de
  integración contra el Postgres real que ejercitó los 5 escenarios
  requeridos (turno normal con extra, turno partido, doble-Entré→corrección,
  corrección NL interpretada, y fallback→admin escribe la hora) — todos
  pasaron y los montos cuadran (SMMLV/210 = $6.778,57/h). El bot arranca en
  long polling y es miembro (verificado con `getChat`) de los 3 grupos reales
  ADMIN/NENA/MAYE con permiso de envío. Falta solo el tap-through en vivo, que
  hace Pablo en el demo.

**Decisiones tomadas:**
- **Zona horaria:** Bogotá es UTC-5 sin horario de verano. Se codifica la hora
  de pared de Bogotá en los *campos UTC* de los `Date` (`tiempo.ts`), para que
  el motor puro sea determinista sin depender de la TZ del proceso ni de
  `Intl`. Los `timestamp` de Postgres se guardan/parsean como texto en esa
  convención (se desactivó el parseo automático de `date`/`timestamp` en el
  pool).
- **`quincenas` mínima:** se creó la tabla (aunque el cierre es de otra sesión)
  porque `turnos.quincena_id` la referencia y la sección 6.3 exige asociar
  cada turno a la quincena vigente. Helper `ensureQuincenaVigente(fecha)`
  deriva Q1 (1-15) / Q2 (16-fin) y el nombre del periodo a partir de reglas ya
  documentadas (Glosario + sección 12). No inventa lógica de negocio nueva.
- **Ciclo de vida de eventos vs. inmutabilidad:** transicionar el `estado` de
  un evento (`pendiente`→`confirmado`/`rechazado`) SÍ se hace en la misma fila
  — es el ciclo de aprobación que la sección 7.4 describe explícitamente. La
  inmutabilidad de la sección 3 se respeta así: nunca se edita
  `momento_declarado`/`tipo`; una corrección de la *hora* es siempre una fila
  nueva (`ajustarHoraEvento`: el pendiente pasa a `rechazado` y nace un evento
  confirmado encadenado por `corrige_evento_id`).
- **Bloque abierto:** definido como entrada `confirmado` que (a) no fue
  consumida por ningún turno y (b) no fue superada por una corrección
  confirmada. Con eso el invariante de "máximo un bloque abierto" se cumple
  incluso con el doble-Entré (la corrección pendiente no supera hasta que se
  aprueba).
- **`config_rates.vigente_desde` = 2026-01-01** (no 2026-08-01) para que el
  motor tenga rates disponibles en el demo de hoy (2026-07-21). El "arranque en
  cero el 1-ago" es sobre cuándo se empiezan a contar horas, no sobre desde
  cuándo existen los rates.
- **`interpretarCorreccion` — heurística AM/PM:** sin meridiem explícito, horas
  1-6 se asumen PM (tarde), 7-11 AM, 12 mediodía. Un número suelto no se toma
  si va seguido de "horas/min" (evita leer "trabajé 5 horas" como una hora).

**Bugs encontrados y cómo se resolvieron:**
- El seed ponía `config_rates.vigente_desde = 2026-08-01`, así que el motor no
  encontraba rates para hoy (2026-07-21) y el smoke fallaba con "No hay
  config_rates vigente". Se cambió a 2026-01-01 (ver decisión arriba).
- `tsc` fallaba por importar con extensión `.ts`: se agregó
  `allowImportingTsExtensions: true` al `tsconfig` (compatible con `noEmit`).
- `DesgloseTramos` no era asignable a `Record<string, number>` (falta index
  signature) en `crearTurno`: se tipó el parámetro con `DesgloseTramos`.
- `tsx -e` con top-level await falla (salida CJS); para el reset puntual de la
  DB se usó `docker exec ... psql` en su lugar (no afecta el código).

**Preguntas abiertas / pendiente para la próxima sesión:**

*Valores de negocio a confirmar con Pablo (sembrados con placeholders razonables,
editables sin tocar código porque son filas de `config_rates`):*
- **SMMLV 2026 exacto:** se sembró $1.423.500 (valor 2025 confirmado) como
  placeholder. Actualizar al decreto 2026 cuando se confirme.
- **`rec_extra_nocturna` y `rec_dominical`:** el documento técnico solo fija
  numéricamente `rec_extra_diurna = 0.25`. Se sembraron ambas en 0.75
  (aproximación estándar colombiana). Confirmar.
- **Umbral de jornada ordinaria diaria:** el doc fija el divisor mensual (210)
  pero no el umbral diario a partir del cual una hora del turno es "extra". Se
  implementó como `divisor_horas / 30` (= 7 h/día con 210), transparente y
  editable. Confirmar que es la intención.
- **`config_rates.salario_base` vs. `empleadas.salario_base_mensual`:** ambos
  existen. El motor usa `config_rates.salario_base` (sección 5). Hoy coinciden
  (ambas al mínimo). Definir cuál manda si en el futuro difieren por empleada.

*Limitaciones conocidas (no bugs, decisiones acotadas):*
- **Turnos que cruzan medianoche / fin del tramo nocturno:** `config_rates`
  tiene `inicio_nocturno` (19:00) pero no fin (ej. 06:00). Un minuto con hora de
  reloj ≥ 19:00 es nocturno; 00:00-19:00 es diurno. Turnos que cruzan
  medianoche clasifican la madrugada como diurna. Aceptable para el alcance
  actual; revisar si aparecen turnos nocturnos reales.
- **Turno partido y jornada ordinaria:** la clasificación es por turno, no por
  día, así que cada bloque recibe su propia asignación de 7h ordinarias. Un día
  con dos bloques cortos podría sumar más "ordinarias" que un día completo.
  Baja frecuencia; revisar en el cierre de quincena si hace ruido.
- **Fallback de corrección sin hora:** las solicitudes que caen al fallback
  (Nivel 1 no interpreta) se guardan en MEMORIA hasta que el admin escribe la
  hora. Un reinicio del proceso las pierde. Mejora futura: tabla
  `solicitudes_correccion` para persistirlas (también ayudaría a la regla de
  sección 7.5 de que un pendiente bloquea el cierre).

*Funcionalidad pendiente (fuera del alcance de esta sesión, por diseño):*
- Actividades extra (Rococó/Gatas), préstamos, bonos, consulta en vivo.
- Cierre de quincena automático + generación de Excel/PDF (job en `/src/jobs`,
  reportes en `/src/reports`).
- Integración opcional con LLM externo para subir el % de interpretación del
  Nivel 1 (solo si la evidencia real muestra muchos fallbacks).

---

## Sesión 2 — Actividades extra, préstamos/bonos y consulta en vivo (secciones 8-11)

**Construido:**
- Schema Fase 2 (idempotente, en `schema.sql`): tablas `catalogo_actividades`,
  `actividades`, `movimientos` + enum `movimiento_tipo` (`prestamo`/`bono`) +
  columna nueva `turnos.valor_tramos jsonb` (`ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`). Índices por quincena.
- Seed: `catalogo_actividades` con Rococó y Gatas a $10.000 c/u (editables).
- Core (funciones puras + tests, ahora 32 en total):
  - `src/core/comandosAdmin.ts`: `interpretarComandoAdmin()` + `parseMonto()`
    (préstamo/bono/consulta), detrás de una sola función como
    `interpretarCorreccion` — swappable por LLM. 11 tests.
  - `src/core/quincena.ts`: `valorExtrasDe`, `salarioBaseQuincena`,
    `calcularNetoPreliminar`. 3 tests.
- Persistencia de `valor_tramos` en cada turno (del motor
  `detalle.valorPorTramo`), para poder mostrar "extras" (solo recargos) sin
  recomputar y para congelarlo luego en el cierre.
- Queries nuevas: CRUD de actividades/movimientos, `getCatalogoActivo/ById`,
  `getEmpleadasActivas`, `getQuincenaById`, y agregados de quincena
  (`agregadosTurnos/Actividades/Movimientos`, `contarPendientesPorEmpleada`).
- Servicio: `construirResumen(quincenaId)` — arma la consulta en vivo componiendo
  los agregados con el neto del core.
- Bot:
  - Botones de actividad en el panel de la empleada (una fila por
    `catalogo_activo`, callback `act:<id>`) → registra sin aprobación y confirma
    a la empleada **sin pesos**.
  - Comandos del grupo admin en lenguaje natural: préstamo/bono con paso de
    confirmación (Confirmar/Cancelar) antes de escribir, y consulta en vivo
    («cómo va la quincena»). Guard de `chat_id` en toda escritura sensible.
  - Formato: mensajes de actividad, confirmación/registro de movimientos y
    resumen de quincena (empleada solo horas; admins con pesos).
- Validación: 32 tests unitarios en verde + smoke de integración Fase 2 contra
  el Postgres real (turno con `valor_extras` persistido, 2 actividades, un
  préstamo, un bono, consulta en vivo con neto = $598.696, y Maye en base/2 =
  $711.750). Bot reiniciado, polling limpio, miembro de los 3 grupos.

**Decisiones tomadas:**
- **Fórmula del neto (INTERPRETACIÓN — confirmar con Pablo):** el glosario dice
  `neto = salario_base + extras + actividades + bonos − préstamos`. Se
  implementó con: (a) "extras" = SOLO los recargos (extra diurna + nocturna +
  dominical), NO el valor de las horas ordinarias, porque esas ya están
  cubiertas por el salario base (sumarlas sería doble conteo); (b) "salario_base"
  por quincena = `salario_base_mensual / 2`. Ambas viven en `src/core/quincena.ts`
  y se cambian sin tocar el resto. En la consulta en vivo el neto sale etiquetado
  como *preliminar* y con la fórmula visible.
- **`turnos.valor_tramos`:** se agregó una columna (no estaba en el modelo del
  doc) para guardar el valor en pesos por tramo. Es almacenamiento derivado que
  el cierre necesitará congelar y que evita recomputar. Migración idempotente,
  DB fresca (sin backfill).
- **`parseMonto`:** número pelado < 10.000 sin separador = miles (×1000), porque
  el ejemplo del doc "le presté 200 a Nena" significa $200.000; con separador
  ("200.000") = literal; sufijos "mil"/"millón"/"k". Red de seguridad: la
  confirmación SIEMPRE muestra el monto en pesos antes de escribir, así que un
  error de interpretación se ve y se cancela.
- **Préstamo/bono con confirmación** (Confirmar/Cancelar) antes de persistir
  (sección 9.2). El pendiente vive en memoria, igual que las solicitudes de
  fallback de la sesión anterior.
- **Actividades sin aprobación ni notificación a admins** (sección 8.3): impacto
  fijo y conocido. La empleada solo ve el nombre, nunca el valor.

**Bugs encontrados y cómo se resolvieron:**
- Ninguno de código. Un `Edit` a `queries.ts` chocó con dos coincidencias del
  mismo patrón de cierre de función; se resolvió dando más contexto. `typecheck`
  y los 32 tests quedaron en verde a la primera tras cablear todo.

**Preguntas abiertas / pendiente para la próxima sesión:**
- **CONFIRMAR la fórmula del neto** (extras = solo recargos; base/2 por
  quincena). Es lo más importante a resolver antes de construir el cierre, porque
  el snapshot congela ese número para siempre.
- **Quincena "ajustable" en préstamos** (sección 9.2): hoy siempre usa la
  quincena vigente. Elegir otra quincena destino queda pendiente.
- **Catálogo de motivos de bonos configurable por admins** (sección 10): hoy el
  motivo es una nota libre (texto tras "por"). Falta el catálogo editable.
- **Estado en memoria:** los movimientos y solicitudes pendientes de confirmación
  se pierden si el proceso reinicia. Persistir a futuro (tabla
  `solicitudes_correccion` / equivalente).
- **Fase final:** cierre de quincena (snapshot, bloqueo por pendientes) +
  generación de Excel (`exceljs`) y PDF (secciones 12, 13). Depende de confirmar
  rates (sesión 1) y la fórmula del neto (arriba).

---

## Sesión 3 — Confirmación de rates y fórmula del neto (desbloqueo del cierre)

**Construido / decidido:**
- Pablo confirmó los valores que estaban como placeholder o abiertos. Ya quedaron
  cargados en el seed (`config_rates` fila vigente desde 2026-07-01) y en
  `empleadas.salario_base_mensual`:
  - **SMMLV 2026 = $1.750.905** (antes placeholder $1.423.500).
  - **rec_extra_diurna = 0.25**, **rec_extra_nocturna = 0.75** (sin cambio).
  - **rec_dominical = 1.00 (+100%)** — vigente desde el 1-jul-2026 por la reforma
    laboral (antes 0.75).
  - **Neto:** "extras" = solo recargos (no la parte ordinaria); salario base por
    quincena = mensual / 2. CONFIRMADO — comentario actualizado en
    `src/core/quincena.ts`.
- Reset de `config_rates` (DELETE + re-seed) porque la fila placeholder tenía
  `vigente_desde 2026-01-01`; la nueva entra como 2026-07-01. `empleadas` ahora
  también actualiza `salario_base_mensual` en el ON CONFLICT del seed.

**Decisiones tomadas:**
- `config_rates.vigente_desde = 2026-07-01`: cubre el arranque real (1-ago) y el
  demo de hoy; no se sembró una fila para el período enero–junio 2026 porque no
  habrá datos antes del 1-ago y evita inventar el valor dominical pre-reforma. Si
  algún día se necesita clasificar una fecha anterior, se agrega una fila previa.

**Bugs encontrados y cómo se resolvieron:**
- N/A.

**Preguntas abiertas / pendiente para la próxima sesión:**
- Ninguna bloqueante nueva. Todo listo para construir la **fase final**: cierre de
  quincena (§12) + Excel/PDF (§13). Siguen pendientes (no bloqueantes) los ítems
  de endurecimiento ya anotados en la sesión 2 (estado en memoria, quincena
  ajustable en préstamos, catálogo de motivos de bonos, turnos que cruzan
  medianoche).

---

## Sesión 4 — Cierre de quincena + Excel/PDF (secciones 12 y 13) · FASE 1 COMPLETA

**Construido:**
- Dependencias nuevas: `exceljs`, `pdfkit`, `node-cron`.
- `src/jobs/cierre.ts`: `prepararCierre` (revisa pendientes SIN escribir, para
  previsualizar) y `confirmarCierre` (congela snapshot + marca `cerrada`).
- `src/jobs/scheduler.ts`: `node-cron` diario 23:00 hora Bogotá que dispara el
  cierre en fecha de corte. La lógica de "día 15 o último del mes" es una función
  pura testeada en core (`esFechaDeCorte`).
- `src/reports/excel.ts` (exceljs): hojas Resumen / Turnos / Movimientos, con
  formato de moneda y marca parcial/definitivo.
- `src/reports/pdf.ts` (pdfkit): resumen por empleada + total neto, marca
  parcial/definitivo. Devuelve Buffer.
- `src/bot/servicio.ts` → `resumenParaReporte`: si la quincena está cerrada sirve
  el snapshot congelado (definitivo); si está abierta calcula en vivo (parcial).
- `src/core/comandosAdmin.ts`: intents nuevos `cerrar` y `reporte`
  (excel/pdf/ambos) + tests. Total core: 36 tests.
- Bot: comando «cerrar quincena» (preview del resumen + botones Confirmar/Cancelar
  porque es irreversible), «dame el excel/pdf/reporte» bajo demanda (envía los
  archivos como documentos, marcados parcial o definitivo), y el scheduler cableado
  al arranque (cierre automático que además envía los reportes al grupo de admins).
- Validación: 36 tests unitarios + smoke de integración de la fase final contra el
  Postgres real: (1) cierre bloqueado por un pendiente en rango, (2) cierre OK con
  snapshot + `cerrada_en` escritos, (3) reporte definitivo desde snapshot, (4) el
  snapshot NO se recalcula —tras un préstamo posterior el reporte definitivo sigue
  en $766.297 mientras el cálculo en vivo baja a $666.297—, (5) re-cierre
  idempotente (`ya_cerrada`), (6) Excel y PDF reales generados y validados
  (cabeceras PK / %PDF; el PDF se revisó visualmente).

**Decisiones tomadas:**
- **Cierre manual con confirmación** (preview + Confirmar/Cancelar) porque congela
  pagos de forma permanente. El **cierre automático** (cron) cierra directo tras
  pasar el chequeo de pendientes y envía los reportes. El `quincenaId` viaja en el
  `callback_data` del botón de confirmar, así que el cierre manual sobrevive a un
  reinicio (a diferencia de los movimientos, que sí usan memoria).
- **Snapshot = objeto `Resumen` completo** (agregados + neto por empleada).
  Escritura única garantizada: `marcarQuincenaCerrada` solo procede si la quincena
  está `abierta`, y `confirmarCierre` maneja la carrera devolviendo `ya_cerrada`.
- **Detalle de turnos/movimientos en los reportes se lee en vivo** (son
  inmutables/append-only, no cambian tras el cierre); el neto autoritativo viene
  del snapshot cuando la quincena está cerrada.
- **Pendientes que bloquean** = eventos `pendiente` cuya hora declarada cae en el
  rango de fechas de la quincena (acotado a la quincena, no global).
- La **consulta en vivo** ahora también respeta el snapshot si la quincena está
  cerrada (usa `resumenParaReporte`), para no “recalcular” lo congelado.

**Bugs encontrados y cómo se resolvieron:**
- El PDF mostraba el signo menos U+2212 («−») como comilla porque la fuente
  Helvetica de pdfkit no lo tiene. Se cambió por guion ASCII «-» (y el símbolo ⚠
  por «(!)»). Verificado regenerando y revisando el PDF.
- **(Encontrado en prueba real en Telegram)** Pablo escribió «dame el pdf» y no
  llegó nada. Dos problemas encadenados:
  1. *Robustez:* el error del envío no estaba atrapado y **tumbó el proceso** (la
     promesa de `bot.launch` se rechazó → `process.exit(1)`). Arreglos: `bot.catch`
     global, `process.on('unhandledRejection')`, y el handler de comandos admin
     envuelto en try/catch con aviso al usuario. Ahora ningún error de handler
     mata el bot.
  2. *Causa raíz del envío:* `sendDocument` fallaba SIEMPRE con «socket hang up»
     (no era transitorio), mientras `sendMessage` funcionaba. Diagnóstico: `curl`
     al mismo endpoint `sendDocument` funciona (HTTP 200) → la red está bien; el
     problema es el cliente `node-fetch` viejo que trae Telegraf, cuyas subidas
     *multipart* se cuelgan en **Node 26**. Fix: `enviarDocumentoAdmins` ahora usa
     el `fetch`/`FormData`/`Blob` **nativos** de Node (no el cliente de Telegraf)
     para subir el archivo, con reintentos. Verificado enviando un documento real
     desde el runtime de Node (llegó ✅). `sendMessage` (JSON) se sigue usando vía
     Telegraf sin problema.
  Lección: en Node 26, evitar el `node-fetch@2` de Telegraf para *uploads*; usar
  el fetch nativo.

**Preguntas abiertas / pendiente para la próxima sesión:**
- **La Fase 1 del documento técnico quedó COMPLETA** (secciones 1–13). No hay más
  fases de construcción pendientes del alcance definido.
- Mejoras futuras / endurecimientos (no bloqueantes), ya anotados: persistir el
  estado en memoria (movimientos y solicitudes de fallback), quincena ajustable en
  préstamos (§9.2), catálogo de motivos de bonos (§10), y turnos que cruzan
  medianoche (no hay `fin_nocturno`).
- Fuera de alcance por diseño: portal web de administración (Fase 2) y reemplazar
  el Nivel 1 de interpretación por un LLM (§16).

---

## Sesión 5 — Correcciones post-demo (sección 19): saludo, novedad, screening, escalación, rangos, rates, corregir turno

**Construido:**
- **Core nuevo `src/core/screening.ts`** (funciones puras + 6 tests): `esSaludo`
  (activación por saludo, 6.0), `tieneIndicioDeHora` (screening 7.0: ¿el mensaje
  parece una marcación?) y `detectarTipoMarcacion` (entrada/salida por palabras
  clave, 7.1). `interpretarCorreccion` ahora reusa `detectarTipoMarcacion` (una
  sola fuente del vocabulario de marcación).
- **Rango completo en `interpretarCorreccion`** (item 7, +6 tests): reconoce
  "de 7:00 am a 4:00 pm" (y variantes "7am a 4pm", "7:00 - 16:00", "de 6 a 3")
  además de un punto. Nuevo campo `rango: { entrada, salida }`. Se refactorizó la
  extracción de un punto a `extraerHora(t, sesgo?)`; en rangos la entrada sesga a
  AM y la salida a PM para evitar inversiones cuando no hay meridiem explícito.
- **`segmentosDeTurno` en `clasificador.ts`** (item 9, +5 tests): devuelve los
  tramos como rangos de reloj contiguos (recorre minuto a minuto con la MISMA
  lógica que `clasificarTurno` y agrupa) — para el Excel/PDF. No se guarda nada
  duplicado: se recalcula al generar el reporte.
- **Comandos de admin nuevos en `comandosAdmin.ts`** (+3 tests): `parseFechaEspanol`
  ("20 de julio", "20/07/2026", ISO), `interpretarCambioRate` (campo + valor, con
  parsers de fracción/hora), e intents `rates-ver`, `rates-cambiar`,
  `corregir-turno`. `interpretarComandoAdmin` toma ahora un tercer parámetro
  `añoActual` (el bot pasa el año de Bogotá) para resolver fechas relativas.
- **`formato.ts`**: plantilla EXACTA de la sección 7.4 (`msgConfirmacionTurno`,
  item 8), mensaje final completo a la empleada (`msgCorreccionConfirmadaEmpleada`
  ahora dice "Se confirmó tu entrada/salida a las H:MM AM/PM", item 6), escalación
  de tipo (`msgAdminTipoDesconocido`), y formatters de rates y de corregir-turno.
  Se agregó a `tiempo.ts`: `formatoHora12Desde`, `formatoFechaDMY(Desde)`.
- **Bot (`index.ts`) reescrito** con todos los flujos de la sección 19:
  - Activación por saludo además de `/start` (6.0) y botón **Generar novedad** →
    Entrada/Salida → pide la hora → mismo mecanismo de aprobación con el tipo ya
    resuelto (6.1).
  - Screening (7.0): sin indicio de hora, el bot NO responde ni registra nada.
  - Detección de tipo (7.1): si no se puede determinar, escala al grupo de admins
    (NO a la empleada) con [Nueva entrada] [Nueva salida] [No es una novedad] +
    **relay**: texto libre del admin (no reconocido como comando) se reenvía a la
    empleada.
  - "No, cambiar" con re-preview y rango (7.3): la corrección de salida ya no se
    confirma en seco — vuelve a mostrar la vista previa 7.4 con el horario
    ajustado (punto o rango completo) antes de confirmar.
  - Comandos de rates (17): "cuáles son los rates" (con hora nocturna en AM/PM) y
    "cambiar salario base a X" → vista previa + Confirmar/Cancelar → inserta una
    fila nueva de `config_rates` (nunca en sitio).
  - Corregir turno pasado (18), incluido turno partido: busca los turnos de la
    fecha; si hay varios, botones para elegir; pide horario (punto/rango); vista
    previa 7.4 → Confirmar/Cancelar; recalcula el turno con eventos corregidos.
- **AM/PM (item 5):** auditado `formato.ts` — todas las horas de reloj pasan por
  `formatoHora12`/`formatoHora12Desde`. Antes ya era conforme; lo nuevo (rango
  7.4, hora de inicio nocturno en la vista de rates) lo mantiene. La única hora
  literal restante es el EJEMPLO de instrucción "de 7:00 am a 4:00 pm" (ya con
  AM/PM).
- **DB/queries:** `config_rates` gana `creado_en` (desempate cuando hay dos
  cambios de rate el mismo día; `getRatesVigentes` ordena por
  `vigente_desde DESC, creado_en DESC`); `insertarConfigRates`;
  `getTurnosDeEmpleadaEnFecha` / `getTurnoConEventosById` /
  `getTurnosConEventosDeQuincena` (turno + eventos + rate para rangos y
  corrección); `actualizarTurnoCorregido`; `getEmpleadaPorId`. Se eliminó
  `getTurnosDeQuincena`/`TurnoDetalle` (quedaron muertos, reemplazados).
- **Reports:** hoja "Turnos" del Excel con columnas Entrada, Salida y "Rangos por
  tramo"; el PDF gana una sección "Detalle de turnos" con el rango del turno y de
  cada tramo. Servicio: `turnosParaReporte`/`TurnoReporte` calcula los rangos con
  `segmentosDeTurno`.
- **Validación:** typecheck en verde; 58 tests de core en verde (36 previos + 22
  nuevos); smoke de reportes (sin DB ni Telegram) generó Excel y PDF válidos con
  un turno partido y un día dominical (cabeceras PK / %PDF).

**Decisiones tomadas:**
- **Re-preview en "No, cambiar" (7.3):** antes el ajuste de hora se confirmaba de
  inmediato; ahora se modela una *propuesta de turno* que se vuelve a previsualizar
  (formato 7.4) antes de confirmar — es el punto de la sección 7.4 ("atrapar una
  interpretación equivocada antes de confirmar"). Al confirmar una propuesta con
  rango que cambió la entrada, se crea un evento de corrección de entrada
  (inmutabilidad: fila nueva encadenada por `corrige_evento_id`), se rechaza la
  salida pendiente interpretada y se crea la salida confirmada, y se materializa el
  turno. Un punto solo cambia la salida.
- **Corregir turno pasado (18) respeta inmutabilidad y snapshot:** `turnos` es
  derivada y se actualiza en sitio, pero las horas se corrigen con DOS eventos
  nuevos confirmados (encadenados a los originales por `corrige_evento_id`) y el
  turno se repunta a ellos. Si la quincena está **cerrada**, el snapshot NO se
  toca (el mensaje se lo advierte al admin). El detalle de turnos del reporte se
  lee en vivo, así que un turno corregido de una quincena cerrada muestra su nuevo
  rango/valor mientras el neto congelado no cambia — exactamente lo que pide 18.5.
- **Relay de tipo indeterminado (7.1):** el destino del relay es la escalación de
  tipo *más reciente* sin resolver (`ultimaEscalacionTipoId`). El texto libre solo
  se reenvía si NO es un comando reconocido (los comandos siguen ganando). Si hay
  dos escalaciones simultáneas (Nena y Maye) y se resuelve la más reciente por
  botón, la otra pierde su "turno" de relay pero sus botones siguen sirviendo.
  Aceptado por baja frecuencia.
- **Punto vs. rango donde solo cabe un punto:** en "Generar novedad" y en el
  fallback (tipo ya conocido), si el texto trae un rango se usa el extremo que
  corresponde al tipo (entrada→inicio, salida→fin).
- **`interpretarCambioRate` — heurística de fracción:** "25" sin "%" se toma como
  25% (los recargos reales son < 3); "0.25"/"1"/"100%" se respetan. Red de
  seguridad: la confirmación siempre muestra "antes → después" antes de escribir.
- **Corregir turno con un solo punto:** se interpreta como cambio de la HORA DE
  SALIDA (se conserva la entrada). Un rango cambia ambas. Documentado por si algún
  admin espera lo contrario.

**Bugs encontrados y cómo se resolvieron:**
- `noUnusedLocals`: tras mover `getEmpleadaPorId` a queries quedó un `import
  { query }` sin usar en `index.ts` y `formatoHora12` sin usar → removidos.
- `lineaTurno` recibía `desglose_tramos` como `Record<string, number>` pero
  pedía `DesgloseTramos` → se normaliza dentro con defaults en 0.
- El smoke de reportes falló por top-level await (el scratchpad se transpila como
  CJS, misma nota de la sesión 1) → se envolvió en `async function main()`.

**Preguntas abiertas / pendiente para la próxima sesión:**
- **Falsos positivos del Nivel 1 con tipo conocido:** un mensaje con palabra clave
  de marcación + un número suelto que no es hora (ej. "salí con 3 bolsas") se
  interpreta como salida a las 3:00 PM y llega a admins como pendiente. La vista
  previa 7.4 solo tiene [Sí] [No, cambiar] (así lo define el doc), no un
  "descartar", así que un falso positivo quedaría pendiente y bloquearía el cierre
  hasta resolverlo a mano. Es la limitación inherente de patrones que justifica el
  posible upgrade a LLM (§16). Evaluar si conviene un "descartar" también en este
  flujo.
- **Estado en memoria** (ya anotado sesiones previas, ahora con más piezas):
  solicitudes de fallback y de tipo, propuestas de turno y cambios de rate
  pendientes viven en memoria; un reinicio los pierde. Persistir a futuro.
- **Migración pendiente de correr en Railway:** `ALTER TABLE config_rates ADD
  COLUMN IF NOT EXISTS creado_en` (idempotente) — correr `npm run migrate` en el
  entorno real antes de usar los comandos de rates.
- Sin cambios en el cierre ni el snapshot (fuera de alcance de este batch, como
  pedía la sesión). Endurecimientos previos siguen abiertos (quincena ajustable en
  préstamos §9.2, catálogo de motivos de bonos §10, turnos que cruzan medianoche).

## Sesión 6 — Correcciones post-demo (batch 2), guía en chat, actividades al cerrar/corregir + prep de despliegue Railway

**Construido:**
- **Rango + aviso al cerrar turno (corrección #1):** al tocar *Salí*, la empleada
  ahora ve el rango `entrada – salida` además de la duración. Cada turno que la
  empleada cierra sola dispara un aviso al grupo de admins (`msgAdminTurnoCerrado`)
  con botón *✏️ Corregir* que entra directo al flujo de §18 (reusa `ct:pick:<id>`).
  Solo en la vía botón *Salí* — en las correcciones aprobadas los admins ya vieron
  el turno, sería ruido.
- **Regla de no-solape / máx-2 turnos por día (corrección #2):** vive en
  `materializarTurno` (servicio), el punto único por donde pasa TODA creación de
  turnos. Nueva `turnoEnConflicto(empleadaId, entrada, salida, excluirTurnoId?)` y
  el puro `intervalosSeCruzan` en `tiempo.ts` (+2 tests; extremos que se tocan NO
  cruzan → mañana+tarde válido). `materializarTurno` pasó a devolver
  `ResultadoMaterializacion` (`{ok, resultado, turnoId} | {ok:false, conflicto}`);
  se actualizaron todos sus llamadores. Validado además ANTES de crear eventos en
  las vías de empleada (marca:salida, registrarPropuestaHora) para no dejar
  huérfanos, y como guard en las de admin (ap:confirm, reprevisar-salida,
  corregir-turno).
- **Comando "borrar base de datos" (corrección #3, solo dev):** intent `reset-db`
  en `comandosAdmin` (+test), `resetDatosOperativos()` hace
  `TRUNCATE turnos, actividades, movimientos, eventos_marcacion, quincenas`
  (conserva empleadas/admins/rates/festivos). Confirmación Sí/No con token de un
  solo uso (botón viejo → "expiró", nunca borra por accidente) y limpieza del
  estado en memoria tras el reset. Desbloquea el testing cuando una quincena quedó
  cerrada.
- **Guía en chat:** `esGuia` en `screening.ts` (+tests) e intent `guia` en
  `comandosAdmin` (+test). Escribir «guía»/«instrucciones»/«ayuda»/«comandos» manda
  `msgGuiaEmpleada` (solo botones y horas, sin pesos) en los grupos de empleada, o
  `msgGuiaAdmin` (todos los comandos) en el grupo de admins.
- **Actividades del día al cerrar y al corregir:** `getActividadesDeEmpleadaEnFecha`.
  El resumen en vivo ya las contaba; el hueco era el mensaje de cierre. Nuevo
  `bloqueValorAdmin(valorTurno, acts)` compartido por los tres mensajes de admin
  (turno cerrado, preview de corrección, corrección final): sin actividades muestra
  `Total: $X`; con actividades muestra `Turno` + `Actividades hoy` + `Total del día`.
  La empleada ve solo `➕ Hoy también: ...` (sin pesos).
- **Rename Rococó → Rocco:** en seed (con `UPDATE ... WHERE nombre='Rococó'`
  idempotente para renombrar la fila existente sin duplicar el botón), schema,
  guía y mensajes.
- **Prep de despliegue Railway (sin lógica):**
  - `engines: { node: "26.x" }` en package.json.
  - `tsx` movido de `devDependencies` a `dependencies` (es el runtime en prod).
  - Confirmado: `scheduler.ts` ya fija `timezone: 'America/Bogota'` explícito.
  - Confirmado: `start` corre el mismo entrypoint que `dev` (`tsx src/bot/index.ts`).
  - Confirmado: `migrate`/`seed` leen `DATABASE_URL` de `process.env`; dotenv v16
    NO sobrescribe la variable del shell (verificado empíricamente), así que
    `DATABASE_URL=<url-railway> npm run migrate` apunta a Railway sin tocar código.

**Decisiones de implementación:**
- **No-solape RECHAZA, no reemplaza.** Auto-reemplazar sería pérdida de datos
  silenciosa y ambigua. El "reemplazo" legítimo es *corregir turno* (UPDATE en
  sitio, no duplica); por eso el aviso de conflicto trae el botón *Corregir*.
- **`Total del día` = turno + actividades del día.** En un turno partido puede
  aparecer en el aviso de ambos turnos; el número autoritativo (que cuenta cada
  actividad una vez) sigue siendo el resumen de quincena. Para el caso normal
  (un turno/día) es exacto.
- **Borrar BD conserva la referencia** (empleadas, admins, rates, festivos) para
  que el bot siga funcionando sin re-seed. Reset TOTAL = `npm run reset` en terminal.
- **`tsx` a `dependencies`:** Nixpacks puede instalar con `NODE_ENV=production` y
  omitir devDependencies; sin `tsx` el `npm start` (`tsx src/bot/index.ts`) fallaría.
  `typescript` y `@types/*` se quedan en devDependencies (solo para `typecheck`).

**Bugs / hallazgos:**
- **Causa raíz del solape (capturas del PDF):** reingresar «entré a las 7» después
  de un turno ya cerrado abría un bloque nuevo, y «salí a las 6pm» creaba un segundo
  turno ENCIMA del primero. Ninguna regla lo impedía. El flujo *corregir turno*
  (UPDATE) nunca duplicó — el problema era crear turnos nuevos cruzados.
- **`msgConfirmacionTurno` / `msgTurnoCorregido` perdían las actividades:** al
  corregir un turno con un Rocco registrado, el preview y la confirmación final no
  lo mostraban ni lo sumaban (reportado con captura). Se unificó con `bloqueValorAdmin`.
- **Bloqueador de despliegue:** `tsx` estaba en devDependencies → movido a deps.

**Pendiente para la próxima sesión:**
- **Correr en Railway (idempotentes) antes de usar el bot:** `npm run migrate`
  (incluye el `ALTER TABLE config_rates ADD COLUMN creado_en` de la sesión 5) y
  `npm run seed` (aplica el rename Rococó→Rocco a la fila existente; "borrar base
  de datos" conserva el catálogo, así que la fila vieja persiste hasta sembrar).
- **Bloque abierto huérfano tras rechazo por solape:** si una salida se rechaza por
  cruce, el bloque de entrada queda abierto. Se resuelve corrigiendo el turno
  existente o con "borrar base de datos". Ofrecido (no hecho) un "cancelar turno
  abierto" para la empleada.
- **Consistencia pendiente:** la corrección por texto «salí a las X» aún no muestra
  actividades en su preview (mismo patrón, no aplicado por alcance).
- **`@types/node` en `^22` mientras el runtime es Node 26** — solo afecta typecheck,
  no runtime. Evaluar bump.
- Sigue abierto: estado en memoria volátil (reinicio pierde solicitudes/propuestas
  a medio resolver), quincena ajustable en préstamos §9.2, catálogo de motivos de
  bonos §10, turnos que cruzan medianoche.

## Sesión 7 — Despliegue a producción en Railway · FASE 1 EN PRODUCCIÓN

**Construido:**
- Proyecto en Railway creado (servicio del bot + Postgres), variables de entorno
  configuradas.
- `migrate` + `seed` corridos contra la base de Railway **desde local** usando
  `DATABASE_PUBLIC_URL` (la URL pública del Postgres de Railway; la interna
  `DATABASE_URL` solo resuelve dentro del proyecto). Schema aplicado y datos de
  referencia sembrados. Confirma en la práctica el flujo de la Sesión 6:
  `DATABASE_URL=<url-publica> npm run migrate` apunta a Railway sin tocar código.
- Smoke test real en Telegram contra producción: Nena registró un turno real, y el
  cierre de quincena + generación de Excel funcionaron en prod (el fix de
  `sendDocument` con fetch nativo de la Sesión 4 se sostiene en el entorno real).

**Decisiones tomadas:**
- `engines.node` fijado a `26.x` para que producción corra el MISMO Node mayor que
  desarrollo — donde se verificó el workaround de `sendDocument` (fetch/FormData
  nativos, Sesión 4). Aclaración: fijar a 26.x NO evita el bug de Node 26 (ese lo
  resuelve el código); lo que evita es que Railway auto-seleccione otra versión de
  Node y reintroduzca sorpresas de compatibilidad.

**A tener en cuenta para el arranque real:**
- El smoke test **cerró una quincena real** en la base de producción (snapshot
  congelado). Si era solo prueba, conviene resetear antes del arranque real —
  `borrar base de datos` desde el grupo de admins, o `DATABASE_URL=<url-publica>
  npm run reset` contra Railway — para no arrastrar datos de test.
- Recordar que `npm run seed` en Railway ya aplicó el rename Rococó→Rocco y los
  datos de referencia; no re-sembrar destruye nada (es idempotente), pero un
  `reset` sí re-corre migrate+seed.

## Sesión 8 — Excel por empleada (sección 13.1): hojas separadas, columna de actividad, resaltado de extras

**Construido (solo presentación del Excel — motor, modelo y lógica del bot intactos):**
- Hoja **"Resumen" combinada** (mismos datos, con pulido). El detalle diario se
  separó en **"Turnos — Nena"** / **"Turnos — Maye"** y **"Movimientos — Nena"** /
  **"Movimientos — Maye"**, cada una solo con lo de esa persona y ordenada por fecha.
- Columna **"Actividad"** en cada hoja de turnos (nombre de Rocco/Gatas del día).
  Un día con actividad y sin turno genera igual una fila con las columnas de horas
  en blanco (no se pierde el dato).
- **Resaltado de extras:** las celdas de horas y valor de extra diurna, extra
  nocturna y dominical/festivo llevan relleno distinto al de ordinaria; se resalta
  solo el tramo que tiene horas, para que salte a la vista. Cada hoja de turnos
  cierra con una fila de **total de horas extra** (horas y valor en pesos).
- **Pulido:** encabezados en negrita sobre fondo oscuro, anchos por columna
  ajustados, moneda `"$"#,##0` consistente, horas `0.##`, bordes finos, títulos con
  marca Parcial/Definitivo.

**Cómo se alimentó (lo estrictamente necesario, sin lógica de negocio):**
- `queries.ts` (solo lectura): se agregó `valor_tramos` al SELECT de turnos-con-
  eventos (columna ya existente) para desglosar el valor de los extras; nuevo
  `getActividadesDetalleDeQuincena` (actividades por empleada/día/nombre).
- `servicio.ts`: nuevo `turnosPorEmpleadaParaReporte(quincenaId)` que devuelve los
  datos YA separados por empleada — turnos + actividades del día fusionadas (la
  actividad del día se muestra en el primer turno de esa fecha; los días de solo-
  actividad generan una fila) + totales de extras. Se extrajo `rangosPorTramoDe`
  de `aTurnoReporte` para reutilizarlo SIN cambiar el tipo `TurnoReporte` (el PDF
  sigue igual).
- `index.ts`: una línea en `enviarReportes` para incluir `turnosPorEmpleada` en
  `datos` (ensamblaje del reporte, no lógica de negocio). `DatosReporte` gana el
  campo; el PDF lo ignora.

**Decisiones:**
- El total de horas extra por hoja se calcula sobre los MISMOS turnos que muestra
  la hoja (live), para que la hoja sea internamente consistente. En una quincena
  cerrada con correcciones post-cierre ese total (live) puede diferir del
  "Extras ($)" del Resumen (que sale del snapshot congelado) — es la misma
  distinción live/congelado que ya define §18.5.
- La actividad de un día se muestra solo en el primer turno de esa fecha (evita
  duplicarla visualmente en turnos partidos).
- Se descartó una fila "Neto" que se probó en Movimientos por confusión de signos;
  el neto ya vive en el Resumen.

**Validación:**
- Smoke test sin DB (en scratchpad): genera el `.xlsx` con datos de ejemplo
  (festivo dominical, turno con extra diurna + Rocco, día de solo-actividad, turno
  partido, turno nocturno) y lo re-abre para volcar celdas. Verificado: 5 hojas
  correctas, separación por empleada, columna Actividad, fila de solo-actividad en
  blanco, resaltado solo en tramos con valor, totales de extras, y a nivel de celda
  `"$"#,##0` en pesos, `0.##` en horas, encabezado con fondo/negrita/borde.
- `npm run test:core`: 64/64 (no se tocó /core). Typecheck limpio.

**Pendiente:**
- Confirmar abriendo el `.xlsx` en Excel/Numbers; opción de regenerarlo contra la
  quincena cerrada de Railway en modo lectura (`DATABASE_PUBLIC_URL`) para verlo con
  datos reales.
- El PDF (§13) sigue con el detalle combinado (no era alcance de esta sesión); si se
  quisiera la misma separación por empleada, es un cambio análogo en `pdf.ts`.

## Sesión 9 — Fix: Nena/Maye dejaron de responder al volverse supergrupos (chat_id cambió)

**Incidente (producción):** Nena y Maye convirtieron sus grupos en supergrupos;
Telegram les asignó un `chat_id` nuevo (formato `-100…`). El bot dejó de
responderles, aunque el grupo de admin seguía bien. Se actualizaron
`NENA_CHAT_ID`/`MAYE_CHAT_ID` en Railway pero NO se arregló.

**Causa raíz:** la identificación de empleada en runtime es contra la DB, no contra
el `.env`. `getEmpleadaPorChat(ctx.chat.id)` hace
`SELECT * FROM empleadas WHERE chat_id_grupo = $1`. Las env vars
`NENA_CHAT_ID`/`MAYE_CHAT_ID` **solo se leen en el seed** para poblar
`empleadas.chat_id_grupo`; en runtime nunca. Así que la DB seguía con los IDs
viejos. El grupo de admin sí funciona porque su guard (`esChatAdmin`) compara
directo contra `config.adminChatId` (env), no contra la DB.

**Fix inmediato (SQL, corrido una vez contra Railway):**
```sql
UPDATE empleadas SET chat_id_grupo = -1004354915379 WHERE alias = 'Nena';
UPDATE empleadas SET chat_id_grupo = -1003963436336 WHERE alias = 'Maye';
```
(IDs nuevos: ADMIN `-1004323883053`, NENA `-1004354915379`, MAYE `-1003963436336`.)

**Prevención (para no tocar dos lugares nunca más):** se reescribió el seed para
que el `.env` sea la ÚNICA fuente de los IDs de grupo. `seedEmpleadas` y
`seedAdmins` ahora **sincronizan** `chat_id_grupo` / `chat_id_admin` desde el env
con UPDATE por clave estable (alias / nombre) — preservan el `id` de la fila (FKs
de turnos/eventos/config_rates intactas) y no crean duplicados aunque el chat_id
cambie. Antes `seedEmpleadas` hacía `ON CONFLICT (chat_id_grupo)`, que ante un
chat_id NUEVO no encontraba conflicto e insertaba un duplicado en vez de actualizar.

**Flujo recomendado a futuro si un grupo cambia de ID:** actualizar la env var en
Railway y correr `DATABASE_URL=<url-publica> npm run seed` (idempotente) — re-sincroniza
los tres IDs a la DB sin SQL manual ni duplicados. El fix SQL de arriba fue solo
porque el seed viejo aún estaba desplegado.

**Nota:** el fix del seed hay que **desplegarlo** (push + redeploy) para que el
flujo `npm run seed` quede disponible; el `UPDATE` manual ya dejó el bot operativo
sin esperar al deploy.

## Sesión 10 — Resiliencia del arranque: `bot.launch()` con reintento (Railway)

**Incidente/diagnóstico:** el botón de "borrar base de datos" fallaba en Railway
("oprimo confirmar y no pasa nada"), mientras Entré/Salí funcionaban siempre.
Auditoría del estado en memoria: TODAS las confirmaciones de dos pasos
(`resetPendientes`, `movimientosPendientes`, `ratesPendientes`, `propuestas`,
`awaitingAdmin`, `novedades`, `solicitudesFallback`/`Tipo`) viven en RAM del
proceso. Los flujos cuyo botón lleva un **id de la DB** (aprobar corrección
`ap:confirm`, cerrar quincena `cierre:confirm`, elegir turno `ct:pick`) sobreviven
un reinicio; los que llevan un **token en RAM** se pierden si el proceso se
reinicia entre los dos pasos. Entré/Salí son stateless (DB directa) → nunca fallan.

**Causa de los reinicios:** `bot.launch().catch(() => process.exit(1))` mataba el
proceso ante CUALQUIER rechazo. Confirmado en la fuente de Telegraf 4.16.3
([polling.js]): los errores de red/429/5xx se reintentan internamente; `launch()`
solo rechaza ante **409 Conflict** (otro `getUpdates` activo — típico cuando un
redeploy se solapa con la instancia anterior, transitorio) o **401** (token malo).
El `exit(1)` ante un 409 transitorio reiniciaba el proceso (perdiendo toda la RAM)
y podía entrar en bucle de crashes.

**Fix (solo `index.ts`, sin lógica de negocio):** `arrancarBotConReintento()` —
reintenta `bot.launch()` EN el mismo proceso con backoff exponencial (1→2→4→8→16→30s,
con tope), preservando el estado en memoria. El 401 sí es fatal (sale con log
claro; es config errónea). `bot.stop()` marca `deteniendo` para no re-lanzar durante
el apagado. Re-lanzar es seguro: Telegraf crea un `Polling` nuevo cada vez.
Validado con simulación del bucle (409×2→arranca; 401→exit; backoff correcto).
Reduce drásticamente la ventana de pérdida de estado para TODOS los flujos de
confirmación de golpe.

**Pendiente (fix de fondo, no hecho):** persistir las confirmaciones pendientes
(tabla / TTL) para que sobrevivan también a un redeploy real a mitad de un flujo;
y confirmar **Scale = 1 instancia** en Railway (2 réplicas → 409 permanente).

## Sesión 11 — Registro de incidentes de operación en producción (Railway) y aprendizajes

Consolidación de los sustos que salieron operando el bot en producción. No son
cambios de código nuevos (salvo lo ya anotado en Sesión 10) — es registro para no
repetirlos.

### 1. Los deploys no reflejaban los cambios / "Deployment queued due to upstream GitHub issues"
- **Síntoma:** tras `git push` + redeploy, el bot seguía mandando el Excel viejo; en
  otra ocasión un deploy quedó atascado en "Queued" con ese mensaje, aunque GitHub y
  Railway estaban ambos 100% operativos (verificado en sus status pages).
- **Causa:** el proyecto en Railway NO está conectado directo a la cuenta de GitHub.
  Tiene un **"Source Repo" (mirror interno de Railway) separado del "Upstream Repo"**
  (el repo real). El mirror **no se sincroniza solo** con cada push; hay que
  actualizarlo a mano (Settings → Source → botón de actualizar upstream). Los
  redeploys reconstruían el mirror **viejo**.
- **Fix inmediato:** sincronizar el upstream a mano → esperar el correo → disparar un
  deploy nuevo → confirmar en logs el commit esperado.
- **Prevención (recomendada, no hecha):** Disconnect del Source Repo y reconectar el
  servicio directo a GitHub por la app de Railway → auto-deploy en cada push, sin el
  paso manual.

### 2. (Confirmado, no es bug) Los reportes de quincena cerrada se REGENERAN, no se cachean
Al pedir Excel/PDF de una quincena cerrada, el archivo se **regenera desde cero** con
el código actual (`excel.ts`/`servicio.ts`); solo los NÚMEROS del Resumen salen
congelados del snapshot. No se guarda ningún `.xlsx`. Correcto y consistente con
§18.5. **Implicación:** un formato viejo del reporte nunca es cache del bot → siempre
significa código viejo desplegado (ver #1).

### 3. Botones de admin no hacían NADA ("Loading…" infinito) tras el grupo de admin volverse supergrupo
- **Síntoma:** los comandos de **texto** de admin (ver rates, "le presté 200…")
  funcionaban y mostraban su vista previa, pero al tocar **Confirmar / Sí / Cancelar**
  de cualquier flujo de admin no pasaba nada (spinner infinito). Entré/Salí de las
  empleadas sí funcionaban.
- **Causa raíz:** el grupo de admin TAMBIÉN migró a supergrupo → su chat_id cambió
  (`-100…`). Se actualizó `ADMIN_CHAT_ID` en env, pero la tabla `admins` en la DB
  seguía con el chat_id **viejo**. Los **botones** de admin pasan por `esChatAdmin()`,
  que además del match contra env hace un chequeo en DB:
  `getAdminPorChat(chatId) !== null` (`SELECT … FROM admins WHERE chat_id_admin = $1`).
  Con el id nuevo no había fila → `esChatAdmin` devolvía `false` → los handlers hacían
  `return ctx.answerCbQuery()` sin ejecutar nada. Los comandos de **texto** funcionaban
  porque `manejarTextoAdmin` compara directo contra `config.adminChatId` (env), sin
  tocar la DB. Entré/Salí funcionaban porque usan la tabla `empleadas` (ya actualizada
  en Sesión 9).
- **Fix (SQL, una vez contra Railway):**
  ```sql
  UPDATE admins SET chat_id_admin = -1004323883053;   -- Nico y Nati, mismo grupo de admin
  ```
  (o `DATABASE_URL=<public> npm run seed` — el seed de Sesión 9 también sincroniza
  `chat_id_admin` desde env.)
- **Aprendizaje / deuda:** la Sesión 9 corrigió el chat_id en `empleadas` pero olvidó
  `admins`. Y hay una **inconsistencia de diseño**: el texto de admin confía solo en
  env, pero los callbacks exigen además la fila en DB. Si la DB queda desincronizada:
  "texto sí, botones no". Candidato a simplificar `esChatAdmin` (¿hace falta el chequeo
  en DB?) o a garantizar la sincronía siempre vía seed en el despliegue.

### 4. Conectarse a la DB de Railway desde local
Para migrate/seed/SQL desde la máquina local se usa **`DATABASE_PUBLIC_URL`** (host
`…proxy.rlwy.net`), NO la `DATABASE_URL` interna (`…railway.internal`, que solo
resuelve dentro de la red de Railway). Está en Variables del servicio **Postgres**.

### 5. Modelo "identificación por CHAT, no por usuario" — implicaciones operativas
- El bot identifica el contexto por el **chat_id del grupo**, nunca por el user que
  escribe. En un grupo de empleada, CUALQUIER mensaje (de la empleada o de quien sea)
  se procesa como de esa empleada.
- **Migración basic→supergroup = cambio de chat_id.** Ya pasó en los tres grupos (ids
  `-100…`). Agregar/quitar miembros de un grupo que YA es supergrupo NO cambia el id.
- **El owner (Pablo) puede salirse de los grupos sin afectar nada:** no está
  referenciado en el bot; los admins del bot son Nico/Nati (tabla `admins`). Conviene
  dejar un admin de Telegram (Nati/Nico) en cada grupo para poder re-agregar el bot si
  hiciera falta.
- **Privacidad del dinero intacta:** el bot solo envía pesos al grupo de admin (por
  chat_id), nunca a un grupo de empleada, sin importar quién esté adentro. Nati puede
  estar en el grupo de una empleada y solo verá horas.
- **Caveat con un admin presente en un grupo de empleada:** si escribe algo con pista
  de hora ("a las 3", "salí…"), el bot lo atribuye a la EMPLEADA. Regla operativa: las
  correcciones se hacen desde el grupo de admin; en los grupos de empleada no teclear
  horas/marcaciones.

**Recomendaciones abiertas de esta sesión:**
- Reconectar Railway directo a GitHub (elimina el paso manual de sincronizar upstream, #1).
- Confirmar Scale = 1 réplica en Railway (Sesión 10).
- Simplificar/robustecer `esChatAdmin` para que no vuelva a pasar "texto sí, botones no" (#3).
- Fix de fondo del estado en memoria (persistir confirmaciones) sigue abierto (Sesión 10).
