# CLAUDE.md

Este archivo lo lee Claude Code automáticamente al iniciar cada sesión en
este repositorio. Define cómo trabajar aquí — no repite la lógica de
negocio, que vive en `docs/documento-tecnico.md`.

## Qué es este proyecto

Sistema de control de horas para Nico y Nati (cliente interno de
LeanRevenue). Dos empleadas (Nena y Maye) marcan su turno vía bot de
Telegram; el sistema clasifica horas automáticamente, gestiona
correcciones, préstamos y bonos, y cierra la quincena generando Excel y PDF.

**La lógica de negocio completa está en `docs/documento-tecnico.md`. Léelo
entero antes de escribir cualquier línea de código.** Si una situación no
está cubierta ahí, no la resuelvas inventando una regla de negocio — anótala
en `docs/bitacora-build.md` bajo "Preguntas abiertas" y sigue con otra parte
del trabajo que sí esté bien definida.

## Stack técnico

- Node.js + TypeScript
- Telegraf (framework de bot de Telegram)
- PostgreSQL (Railway)
- `node-cron` (o el cron nativo de Railway) para el job de cierre de
  quincena
- `exceljs` para generar el Excel, `pdfkit` (o similar) para el PDF

Si en algún momento se decide cambiar alguna de estas piezas, actualiza esta
sección y anota el motivo en la bitácora — no cambies el stack a mitad de
camino sin dejar rastro escrito.

## Estructura de carpetas

```
/src
  /bot        — handlers de Telegram (comandos, botones, mensajes de texto libre)
  /core       — motor de clasificación de horas: funciones puras, sin dependencia de Telegram ni DB
  /db         — schema, migraciones, queries
  /jobs       — cierre de quincena, recordatorios de turno sin cerrar
  /reports    — generación de Excel y PDF
/docs
  documento-tecnico.md   — fuente de verdad de la lógica de negocio
  bitacora-build.md      — log de decisiones y fixes, sesión por sesión
CLAUDE.md
```

El motor de clasificación (`/core`) debe poder probarse con datos de
ejemplo sin levantar el bot ni la base de datos. Si una función de `/core`
necesita importar algo de `/bot`, algo está mal ubicado.

## Convenciones no negociables

- **Nunca sobrescribir un registro en `eventos_marcacion`.** Toda
  corrección es una fila nueva con `corrige_evento_id` apuntando a la
  anterior.
- **Nunca actualizar una fila de `config_rates` en sitio.** Todo cambio de
  rate es una fila nueva con `vigente_desde`.
- **Los montos en pesos nunca se envían a los chats de Nena o Maye.** Solo
  horas. El dinero vive exclusivamente en el grupo de admins.
- **Toda acción sensible (aprobar, registrar préstamo/bono, cerrar
  quincena) debe validar `chat_id` de origen contra el grupo de admins**,
  no solo el `user_id` del remitente.
- **`quincenas.snapshot` es de solo escritura una vez cerrada.** Ningún
  proceso posterior debe recalcularlo.
- **Toda hora que el bot muestre en cualquier mensaje lleva AM/PM
  explícito, sin excepción.** Nunca "6:00" a secas.
- **El bot nunca reacciona a texto que no contiene ningún indicio de
  hora.** Ver sección 7.0 del documento técnico — evita spam en mensajes
  de charla normal entre empleadas.

## Al iniciar una sesión

1. Lee `docs/documento-tecnico.md` completo.
2. Lee `docs/bitacora-build.md` para ver qué se hizo en la sesión anterior
   y qué quedó pendiente.
3. Si vas a tomar una decisión de lógica de negocio no cubierta en el
   documento técnico, no la resuelvas en silencio — anótala explícitamente
   para que Pablo la revise.

## Al cerrar una sesión

Actualiza `docs/bitacora-build.md` con una entrada nueva (nunca borres
entradas anteriores) que incluya:

- Qué se construyó.
- Qué decisiones de implementación se tomaron y por qué.
- Qué bugs aparecieron y cómo se resolvieron.
- Qué queda pendiente para la próxima sesión.

## Variables de entorno esperadas

```
TELEGRAM_BOT_TOKEN=
DATABASE_URL=
ADMIN_CHAT_ID=
NENA_CHAT_ID=
MAYE_CHAT_ID=
```

## Notas

Este es un cliente interno de LeanRevenue — no hay presión comercial, pero
sí vale la pena construirlo con el mismo rigor que un entregable a cliente
externo: es el caso de estudio con métricas reales para el portafolio de la
firma.
