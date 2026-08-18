-- =====================================================================
-- MIGRACIÓN — Agente conversacional de citas
--
-- Agrega el canal conversacional como nueva vía de gestión de citas,
-- sin tocar el modelo existente. Tres decisiones que conviene explicar:
--
-- 1. `origen_cita` gana el valor 'AGENTE'. Sin él, una cita agendada por
--    conversación es indistinguible de una registrada en recepción, y el
--    indicador de ausentismo no podría compararse entre canales. Es el
--    dato que permite responder si el canal conversacional reduce las
--    inasistencias respecto del canal tradicional.
--
-- 2. `mensaje_conversacion.proveedor_msg_id` es UNIQUE. Meta reintenta la
--    entrega de un webhook cuando no recibe 200 a tiempo. Sin esta
--    restricción, un reintento se traduciría en un segundo procesamiento
--    del mismo mensaje y, en el peor caso, en una cita duplicada.
--
-- 3. `traza_agente` no es logging: es el instrumento de medición. Registra
--    qué intención se detectó, qué herramienta se usó y cuánto demoró cada
--    tramo. De esa tabla salen los indicadores de exactitud de intención,
--    de selección de herramienta y de tiempo de respuesta del canal.
--
-- Aplicar con:
--   psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/migracion-agente.sql
-- =====================================================================

-- ALTER TYPE ... ADD VALUE no puede usarse en la misma transacción en que
-- se declara, por eso va suelto y antes de todo lo demás.
ALTER TYPE origen_cita ADD VALUE IF NOT EXISTS 'AGENTE';

-- ---------------------------------------------------------------------

CREATE TYPE estado_conversacion AS ENUM (
  'ACTIVA',    -- el paciente está en medio de una gestión
  'CERRADA',   -- se completó o el paciente se despidió
  'DERIVADA'   -- salió del alcance del agente y pasó a una persona
);

CREATE TYPE rol_mensaje  AS ENUM ('PACIENTE', 'AGENTE');
CREATE TYPE modo_entrada AS ENUM ('TEXTO', 'AUDIO');

-- Las intenciones son un vocabulario cerrado y es deliberado: el agente
-- solo puede clasificar dentro de lo que el consultorio decidió atender.
-- 'FUERA_DE_ALCANCE' es parte del vocabulario, no un fallo: reconocer que
-- una consulta clínica no le corresponde es comportamiento esperado.
CREATE TYPE intencion_agente AS ENUM (
  'SALUDO',
  'CONSULTAR_DISPONIBILIDAD',
  'AGENDAR',
  'REPROGRAMAR',
  'CANCELAR',
  'CONFIRMAR',
  'CONSULTAR_MIS_CITAS',
  'FUERA_DE_ALCANCE',
  'DESPEDIDA'
);

-- ---------------------------------------------------------------------
-- Conversación: el hilo con un paciente por su número de WhatsApp
-- ---------------------------------------------------------------------

CREATE TABLE conversacion (
  id                  BIGSERIAL PRIMARY KEY,
  -- Nulo mientras el número no corresponda a ningún paciente registrado.
  -- Un desconocido puede conversar, pero no operar sobre citas.
  paciente_id         BIGINT REFERENCES paciente(id),
  celular             VARCHAR(20) NOT NULL,       -- E.164, igual que paciente.celular
  estado              estado_conversacion NOT NULL DEFAULT 'ACTIVA',
  -- Datos que el paciente fue dando a lo largo del hilo (especialidad,
  -- fecha, franja). Se guardan aparte del texto para que reanudar una
  -- conversación no dependa de volver a interpretar el historial.
  contexto            JSONB NOT NULL DEFAULT '{}'::jsonb,
  iniciada_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_actividad_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrada_en          TIMESTAMPTZ
);

-- Solo puede haber un hilo abierto por número: es lo que hace que el
-- siguiente mensaje del paciente continúe la gestión en curso.
CREATE UNIQUE INDEX ux_conversacion_activa
  ON conversacion (celular)
  WHERE estado = 'ACTIVA';

CREATE INDEX ix_conversacion_paciente ON conversacion (paciente_id, iniciada_en);

-- ---------------------------------------------------------------------
-- Mensajes del hilo
-- ---------------------------------------------------------------------

CREATE TABLE mensaje_conversacion (
  id               BIGSERIAL PRIMARY KEY,
  conversacion_id  BIGINT      NOT NULL REFERENCES conversacion(id) ON DELETE CASCADE,
  rol              rol_mensaje NOT NULL,
  entrada          modo_entrada NOT NULL DEFAULT 'TEXTO',
  texto            TEXT        NOT NULL,
  -- Identificador del mensaje en la Cloud API. UNIQUE sostiene la
  -- idempotencia frente a los reintentos del webhook de Meta.
  proveedor_msg_id VARCHAR(120) UNIQUE,
  -- Cuánto demoró transcribir, cuando el paciente mandó una nota de voz.
  -- Alimenta el indicador de tiempo de respuesta del canal por audio.
  transcripcion_ms INTEGER,
  ocurrido_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_mensaje_conversacion ON mensaje_conversacion (conversacion_id, ocurrido_en);

-- ---------------------------------------------------------------------
-- Traza: la evidencia experimental de cada turno
-- ---------------------------------------------------------------------

CREATE TABLE traza_agente (
  id                 BIGSERIAL PRIMARY KEY,
  conversacion_id    BIGINT NOT NULL REFERENCES conversacion(id) ON DELETE CASCADE,
  mensaje_id         BIGINT REFERENCES mensaje_conversacion(id) ON DELETE SET NULL,
  intencion          intencion_agente,
  -- Nulo cuando el turno se resolvió sin consultar al sistema de citas,
  -- por ejemplo al pedirle al paciente el dato que falta.
  herramienta        VARCHAR(60),
  argumentos         JSONB,
  exito              BOOLEAN NOT NULL DEFAULT TRUE,
  error_detalle      TEXT,
  -- Latencias separadas: sin esta división no se puede sostener si una
  -- respuesta lenta la causó el modelo o la consulta al sistema de citas.
  latencia_llm_ms    INTEGER,
  latencia_tool_ms   INTEGER,
  latencia_total_ms  INTEGER,
  modelo             VARCHAR(80),
  ocurrido_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_traza_conversacion ON traza_agente (conversacion_id, ocurrido_en);
CREATE INDEX ix_traza_intencion    ON traza_agente (intencion, ocurrido_en);
CREATE INDEX ix_traza_herramienta  ON traza_agente (herramienta, exito);
