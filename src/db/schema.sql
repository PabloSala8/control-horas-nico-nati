-- Schema inicial — Sistema de control de horas (Nico y Nati).
-- Fuente de verdad de la lógica: docs/documento-tecnico.md (sección 4).
--
-- Idempotente: usa CREATE ... IF NOT EXISTS y crea los enums solo si faltan,
-- para poder re-ejecutar `npm run migrate` sin destruir datos. gen_random_uuid()
-- es nativo en Postgres 13+.
--
-- Categorías (sección 4):
--   Inmutable  : eventos_marcacion  (solo INSERT, nunca UPDATE de una fila)
--   Derivada   : turnos             (se materializa/recalcula desde eventos)
--   Config     : config_rates       (versionada por fecha, nunca UPDATE en sitio)

-- ---------- Enums ----------
DO $$ BEGIN
  CREATE TYPE evento_tipo AS ENUM ('entrada', 'salida');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE evento_estado AS ENUM ('confirmado', 'pendiente', 'rechazado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE quincena_estado AS ENUM ('abierta', 'cerrada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- empleadas ----------
CREATE TABLE IF NOT EXISTS empleadas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                text        NOT NULL,
  alias                 text        NOT NULL,
  telegram_user_id      bigint,
  chat_id_grupo         bigint      NOT NULL UNIQUE,
  salario_base_mensual  integer     NOT NULL,
  activa                boolean     NOT NULL DEFAULT true
);

-- ---------- admins ----------
CREATE TABLE IF NOT EXISTS admins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre            text    NOT NULL,
  telegram_user_id  bigint,
  chat_id_admin     bigint  NOT NULL
);

-- ---------- config_rates (versionada por fecha — nunca UPDATE en sitio) ----------
CREATE TABLE IF NOT EXISTS config_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vigente_desde       date          NOT NULL,
  salario_base        integer       NOT NULL,
  divisor_horas       integer       NOT NULL,          -- ej. 210 (jornada 42h)
  rec_extra_diurna    numeric(5,4)  NOT NULL,          -- fracción, ej. 0.25
  rec_extra_nocturna  numeric(5,4)  NOT NULL,
  rec_dominical       numeric(5,4)  NOT NULL,
  inicio_nocturno     time          NOT NULL,          -- ej. 19:00
  creado_por          uuid          REFERENCES admins(id),
  creado_en           timestamp     NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')
);

-- Desempate cuando hay dos cambios de rate el mismo día (sección 17): la fila
-- más reciente por `creado_en` gana. Idempotente para bases ya creadas.
ALTER TABLE config_rates ADD COLUMN IF NOT EXISTS creado_en timestamp
  NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota');

-- ---------- quincenas ----------
-- Mínima para esta fase: `turnos.quincena_id` la referencia y el motor asocia
-- cada turno a la quincena vigente por fecha (sección 6, paso 3). El flujo de
-- cierre (snapshot, Excel/PDF) es de una sesión posterior.
CREATE TABLE IF NOT EXISTS quincenas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo       text             NOT NULL,             -- ej. "Q1-Agosto 2026"
  fecha_inicio  date             NOT NULL,
  fecha_fin     date             NOT NULL,
  estado        quincena_estado  NOT NULL DEFAULT 'abierta',
  snapshot      jsonb,                                 -- se llena al cerrar; nunca se recalcula
  cerrada_en    timestamp,
  UNIQUE (fecha_inicio, fecha_fin)
);

-- ---------- eventos_marcacion (INMUTABLE — solo INSERT) ----------
CREATE TABLE IF NOT EXISTS eventos_marcacion (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empleada_id        uuid          NOT NULL REFERENCES empleadas(id),
  tipo               evento_tipo   NOT NULL,
  momento_declarado  timestamp     NOT NULL,           -- hora real que cuenta para el cálculo
  momento_mensaje    timestamp     NOT NULL,           -- cuándo se envió el mensaje
  estado             evento_estado NOT NULL,
  corrige_evento_id  uuid          REFERENCES eventos_marcacion(id),
  aprobado_por       uuid          REFERENCES admins(id),
  creado_en          timestamp     NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')
);

CREATE INDEX IF NOT EXISTS idx_eventos_empleada_estado
  ON eventos_marcacion (empleada_id, tipo, estado);
CREATE INDEX IF NOT EXISTS idx_eventos_corrige
  ON eventos_marcacion (corrige_evento_id);

-- ---------- turnos (DERIVADA — se materializa con el par entrada/salida confirmado) ----------
CREATE TABLE IF NOT EXISTS turnos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empleada_id      uuid     NOT NULL REFERENCES empleadas(id),
  fecha            date     NOT NULL,
  horas_totales    numeric  NOT NULL,
  desglose_tramos  jsonb    NOT NULL,                  -- { ordinaria, extra_diurna, extra_nocturna, dominical }
  valor_calculado  integer  NOT NULL,
  rates_id         uuid     NOT NULL REFERENCES config_rates(id),
  quincena_id      uuid     REFERENCES quincenas(id),
  entrada_evento_id uuid    NOT NULL REFERENCES eventos_marcacion(id),
  salida_evento_id  uuid    NOT NULL REFERENCES eventos_marcacion(id),
  creado_en        timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')
);

-- NOTA: NO hay UNIQUE(empleada_id, fecha) — los turnos partidos (varios bloques
-- el mismo día) están soportados por diseño (sección 4). Sí evitamos duplicar el
-- mismo bloque: un par (entrada, salida) genera un único turno.
CREATE UNIQUE INDEX IF NOT EXISTS uq_turno_por_par
  ON turnos (entrada_evento_id, salida_evento_id);
CREATE INDEX IF NOT EXISTS idx_turnos_empleada_fecha
  ON turnos (empleada_id, fecha);

-- ---------- festivos ----------
CREATE TABLE IF NOT EXISTS festivos (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha   date NOT NULL UNIQUE,
  nombre  text NOT NULL
);

-- ============================================================================
-- Fase 2: actividades extra, préstamos/bonos y consulta en vivo (secciones 8-11)
-- ============================================================================

-- Guardamos el valor en pesos POR TRAMO además de las horas, para poder mostrar
-- "extras" (recargos, sin la parte ordinaria) en la consulta en vivo y congelarlo
-- luego en el cierre. Derivado del motor (detalle.valorPorTramo). Idempotente.
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS valor_tramos jsonb;

DO $$ BEGIN
  CREATE TYPE movimiento_tipo AS ENUM ('prestamo', 'bono');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- catalogo_actividades (config — editable) ----------
CREATE TABLE IF NOT EXISTS catalogo_actividades (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  text     NOT NULL UNIQUE,   -- ej. "Rocco", "Gatas"
  valor   integer  NOT NULL,          -- hoy $10.000 c/u, editable independientemente
  activa  boolean  NOT NULL DEFAULT true
);

-- ---------- actividades (registro por evento — no requiere aprobación) ----------
CREATE TABLE IF NOT EXISTS actividades (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empleada_id  uuid  NOT NULL REFERENCES empleadas(id),
  catalogo_id  uuid  NOT NULL REFERENCES catalogo_actividades(id),
  fecha        date  NOT NULL,
  quincena_id  uuid  NOT NULL REFERENCES quincenas(id),
  creado_en    timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')
);
CREATE INDEX IF NOT EXISTS idx_actividades_quincena ON actividades (quincena_id, empleada_id);

-- ---------- movimientos (préstamos y bonos — solo desde el grupo admin) ----------
CREATE TABLE IF NOT EXISTS movimientos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empleada_id    uuid            NOT NULL REFERENCES empleadas(id),
  tipo           movimiento_tipo NOT NULL,   -- prestamo (resta del neto) / bono (suma)
  monto          integer         NOT NULL,
  fecha          date            NOT NULL,
  quincena_id    uuid            NOT NULL REFERENCES quincenas(id),
  registrado_por uuid            NOT NULL REFERENCES admins(id),
  nota           text,
  creado_en      timestamp       NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')
);
CREATE INDEX IF NOT EXISTS idx_movimientos_quincena ON movimientos (quincena_id, empleada_id);
