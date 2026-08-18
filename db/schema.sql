-- =====================================================================
-- Sistema web automatizado para reducir el ausentismo de pacientes
-- Consultorio Perú Ruso — Lima, 2026
--
-- Motor: PostgreSQL 15+  ·  Codificación: UTF8  ·  Zona: America/Lima
--
-- Nota de diseño: los instantes se almacenan en TIMESTAMPTZ (UTC) y la
-- conversión a America/Lima (UTC-5, sin horario de verano) ocurre en la
-- capa de presentación. Esto evita errores en el cálculo de los disparos
-- programados de los recordatorios.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- restricciones EXCLUDE sobre rangos
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest()

-- =====================================================================
-- 1. USUARIOS Y SEGURIDAD
-- =====================================================================

CREATE TYPE rol_usuario AS ENUM ('RECEPCIONISTA', 'MEDICO', 'ADMINISTRADOR');

CREATE TABLE usuario (
  id             BIGSERIAL PRIMARY KEY,
  email          VARCHAR(160)  NOT NULL UNIQUE,
  hash_password  VARCHAR(255)  NOT NULL,
  nombres        VARCHAR(120)  NOT NULL,
  rol            rol_usuario   NOT NULL,
  activo         BOOLEAN       NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2. MÉDICOS Y AGENDA
-- =====================================================================

CREATE TABLE medico (
  id            BIGSERIAL PRIMARY KEY,
  usuario_id    BIGINT REFERENCES usuario(id),
  nombres       VARCHAR(120) NOT NULL,
  apellidos     VARCHAR(120) NOT NULL,
  cmp           VARCHAR(20)  UNIQUE,
  especialidad  VARCHAR(120) NOT NULL DEFAULT 'Medicina General',
  activo        BOOLEAN      NOT NULL DEFAULT TRUE
);

COMMENT ON COLUMN medico.cmp IS 'Colegio Médico del Perú';

CREATE TABLE horario_atencion (
  id            BIGSERIAL PRIMARY KEY,
  medico_id     BIGINT      NOT NULL REFERENCES medico(id),
  dia_semana    SMALLINT    NOT NULL CHECK (dia_semana BETWEEN 1 AND 7), -- 1=lunes ... 7=domingo
  hora_inicio   TIME        NOT NULL,
  hora_fin      TIME        NOT NULL CHECK (hora_fin > hora_inicio),
  duracion_min  SMALLINT    NOT NULL DEFAULT 20,
  activo        BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE INDEX ix_horario_medico ON horario_atencion (medico_id, dia_semana);

CREATE TABLE excepcion_agenda (
  id           BIGSERIAL PRIMARY KEY,
  medico_id    BIGINT      NOT NULL REFERENCES medico(id),
  fecha        DATE        NOT NULL,
  todo_el_dia  BOOLEAN     NOT NULL DEFAULT TRUE,
  hora_inicio  TIME,
  hora_fin     TIME,
  motivo       VARCHAR(200) NOT NULL,
  UNIQUE (medico_id, fecha, hora_inicio)
);

-- =====================================================================
-- 3. PACIENTES Y CONSENTIMIENTO (Ley N.° 29733)
-- =====================================================================

CREATE TYPE tipo_documento AS ENUM ('DNI', 'CE', 'PAS');
CREATE TYPE canal_contacto AS ENUM ('WHATSAPP', 'SMS', 'EMAIL');
CREATE TYPE nivel_riesgo   AS ENUM ('BAJO', 'MEDIO', 'ALTO');

CREATE TABLE paciente (
  id           BIGSERIAL PRIMARY KEY,
  tipo_doc     tipo_documento NOT NULL DEFAULT 'DNI',
  num_doc      VARCHAR(20)    NOT NULL,
  nombres      VARCHAR(120)   NOT NULL,
  apellidos    VARCHAR(120)   NOT NULL,
  fecha_nac    DATE,
  celular      VARCHAR(20)    NOT NULL, -- formato E.164: +51XXXXXXXXX
  email        VARCHAR(160),
  canal_pref   canal_contacto NOT NULL DEFAULT 'WHATSAPP',
  riesgo       nivel_riesgo   NOT NULL DEFAULT 'BAJO',
  seudonimo    CHAR(12)       NOT NULL UNIQUE, -- identificador estable para exportación anonimizada
  activo       BOOLEAN        NOT NULL DEFAULT TRUE,
  creado_en    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE (tipo_doc, num_doc)
);

CREATE INDEX ix_paciente_celular   ON paciente (celular);
CREATE INDEX ix_paciente_apellidos ON paciente (apellidos, nombres);

CREATE TYPE finalidad_consentimiento AS ENUM ('TRATAMIENTO_DATOS', 'CONTACTO_RECORDATORIOS');
CREATE TYPE medio_consentimiento    AS ENUM ('FISICO', 'DIGITAL', 'VERBAL_REGISTRADO');

CREATE TABLE consentimiento (
  id             BIGSERIAL PRIMARY KEY,
  paciente_id    BIGINT NOT NULL REFERENCES paciente(id),
  version        VARCHAR(20) NOT NULL,       -- versión del texto de consentimiento
  finalidad      finalidad_consentimiento NOT NULL,
  medio          medio_consentimiento NOT NULL,
  otorgado_en    TIMESTAMPTZ NOT NULL,
  revocado_en    TIMESTAMPTZ,
  evidencia_url  VARCHAR(300)
);

CREATE INDEX ix_consent_paciente ON consentimiento (paciente_id, finalidad, revocado_en);

-- =====================================================================
-- 4. CITAS  — entidad central de la medición
-- =====================================================================

CREATE TYPE estado_cita AS ENUM (
  'PROGRAMADA', 'CONFIRMADA', 'ATENDIDA', 'AUSENTE', 'CANCELADA', 'REPROGRAMADA'
);
CREATE TYPE tipo_cita   AS ENUM ('PRIMERA_VEZ', 'CONTINUADOR');
CREATE TYPE origen_cita AS ENUM ('RECEPCION', 'PACIENTE', 'LISTA_ESPERA');
CREATE TYPE origen_cancelacion AS ENUM ('PACIENTE', 'CONSULTORIO');

CREATE TABLE cita (
  id                    BIGSERIAL PRIMARY KEY,
  paciente_id           BIGINT      NOT NULL REFERENCES paciente(id),
  medico_id             BIGINT      NOT NULL REFERENCES medico(id),

  inicio                TIMESTAMPTZ NOT NULL,
  fin                   TIMESTAMPTZ NOT NULL,
  rango                 TSTZRANGE GENERATED ALWAYS AS (tstzrange(inicio, fin, '[)')) STORED,

  estado                estado_cita NOT NULL DEFAULT 'PROGRAMADA',
  tipo                  tipo_cita   NOT NULL DEFAULT 'CONTINUADOR',
  origen                origen_cita NOT NULL DEFAULT 'RECEPCION',

  -- Trazabilidad de reprogramación (cadena de citas)
  cita_origen_id        BIGINT REFERENCES cita(id),

  -- Cancelación
  motivo_cancelacion    VARCHAR(200),
  origen_cancelacion    origen_cancelacion,
  cancelada_en          TIMESTAMPTZ,
  antelacion_horas      NUMERIC(6,2), -- horas entre la cancelación y el inicio

  -- Cierre del día
  cerrada_en            TIMESTAMPTZ,
  cerrada_por           BIGINT REFERENCES usuario(id),

  -- === INSTRUMENTACIÓN PARA FICHA TÉCNICA N.° 1 ===
  -- Tiempo promedio de registro de una cita (minutos)
  registro_iniciado_en  TIMESTAMPTZ, -- instante en que se abre el formulario
  registro_creado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  registro_seg          INTEGER,     -- duración del registro en segundos

  creado_por            BIGINT REFERENCES usuario(id),

  CONSTRAINT ck_cita_rango CHECK (fin > inicio),

  -- Impide dos citas activas que se solapen para el mismo médico (RF-07).
  -- El motor rechaza el solapamiento aunque dos recepcionistas guarden a la
  -- vez; los estados terminales (CANCELADA, REPROGRAMADA, ATENDIDA, AUSENTE
  -- ya cerrado) no participan salvo ATENDIDA/AUSENTE, que sí deben conservar
  -- el bloqueo histórico del horario. Se excluye explícitamente solo lo que
  -- libera el cupo: CANCELADA y REPROGRAMADA.
  CONSTRAINT ex_cita_sin_solape EXCLUDE USING gist (
    medico_id WITH =,
    rango WITH &&
  ) WHERE (estado NOT IN ('CANCELADA', 'REPROGRAMADA'))
);

CREATE INDEX ix_cita_medico_inicio ON cita (medico_id, inicio);
CREATE INDEX ix_cita_estado_inicio ON cita (estado, inicio);
CREATE INDEX ix_cita_paciente      ON cita (paciente_id, inicio);

-- =====================================================================
-- 5. RECORDATORIOS  — lo que el sistema intentó comunicar
-- =====================================================================

CREATE TYPE hito_recordatorio AS ENUM ('T_48H', 'T_24H', 'T_3H', 'OFERTA_CUPO', 'POST_INASISTENCIA');
CREATE TYPE estado_recordatorio AS ENUM (
  'PROGRAMADO', 'ENCOLADO', 'ENVIADO', 'ENTREGADO', 'LEIDO', 'FALLIDO', 'SUSPENDIDO'
);

CREATE TABLE recordatorio (
  id                  BIGSERIAL PRIMARY KEY,
  cita_id             BIGINT NOT NULL REFERENCES cita(id),

  hito                hito_recordatorio NOT NULL,
  canal               canal_contacto    NOT NULL,

  -- Clave de idempotencia: cita + hito + canal.
  -- Es la restricción que impide el doble envío ante un reintento (RNF-04).
  clave_idempotencia  VARCHAR(120) NOT NULL UNIQUE,

  estado              estado_recordatorio NOT NULL DEFAULT 'PROGRAMADO',

  programado_para     TIMESTAMPTZ NOT NULL, -- instante de disparo
  encolado_en         TIMESTAMPTZ,
  enviado_en          TIMESTAMPTZ,
  entregado_en        TIMESTAMPTZ,
  leido_en            TIMESTAMPTZ,

  intentos            SMALLINT NOT NULL DEFAULT 0,
  proveedor_msg_id    VARCHAR(120),
  error_detalle       VARCHAR(400),

  plantilla           VARCHAR(80) -- nombre de la plantilla aprobada por Meta
);

CREATE INDEX ix_recordatorio_despacho ON recordatorio (estado, programado_para);
CREATE INDEX ix_recordatorio_cita     ON recordatorio (cita_id, hito);

-- =====================================================================
-- 6. RESPUESTA DEL PACIENTE  — lo que el paciente decidió
-- =====================================================================

CREATE TYPE accion_respuesta AS ENUM ('CONFIRMAR', 'REPROGRAMAR', 'CANCELAR', 'BAJA');

CREATE TABLE respuesta_paciente (
  id             BIGSERIAL PRIMARY KEY,
  cita_id        BIGINT NOT NULL REFERENCES cita(id),
  token_hash     CHAR(64) NOT NULL UNIQUE, -- SHA-256 del token; el original solo viaja en el enlace
  accion         accion_respuesta,
  emitido_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en      TIMESTAMPTZ NOT NULL,
  respondido_en  TIMESTAMPTZ,
  ip             INET,
  user_agent     VARCHAR(300)
);

CREATE INDEX ix_respuesta_cita ON respuesta_paciente (cita_id);

-- =====================================================================
-- 7. LISTA DE ESPERA Y RECUPERACIÓN DE CUPOS
-- =====================================================================

CREATE TYPE franja_horaria AS ENUM ('MANANA', 'TARDE', 'CUALQUIERA');
CREATE TYPE estado_espera  AS ENUM ('ACTIVA', 'ATENDIDA', 'VENCIDA', 'CANCELADA');
CREATE TYPE estado_oferta  AS ENUM ('ENVIADA', 'ACEPTADA', 'RECHAZADA', 'VENCIDA', 'CERRADA');

CREATE TABLE lista_espera (
  id           BIGSERIAL PRIMARY KEY,
  paciente_id  BIGINT NOT NULL REFERENCES paciente(id),
  medico_id    BIGINT REFERENCES medico(id), -- NULL = cualquier médico
  desde        DATE NOT NULL,
  hasta        DATE NOT NULL CHECK (hasta >= desde),
  franja       franja_horaria NOT NULL DEFAULT 'CUALQUIERA',
  prioridad    SMALLINT NOT NULL DEFAULT 100, -- menor = mayor prioridad
  estado       estado_espera NOT NULL DEFAULT 'ACTIVA',
  creada_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_espera_busqueda ON lista_espera (estado, medico_id, desde, hasta, prioridad);

CREATE TABLE oferta_cupo (
  id                BIGSERIAL PRIMARY KEY,
  cita_liberada_id  BIGINT NOT NULL REFERENCES cita(id),         -- cita cancelada o reprogramada que liberó el cupo
  lista_espera_id   BIGINT NOT NULL REFERENCES lista_espera(id),
  cita_generada_id  BIGINT REFERENCES cita(id),                  -- cita creada si la oferta fue aceptada
  enviada_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en         TIMESTAMPTZ NOT NULL,
  respondida_en     TIMESTAMPTZ,
  estado            estado_oferta NOT NULL DEFAULT 'ENVIADA',
  UNIQUE (cita_liberada_id, lista_espera_id)
);

CREATE INDEX ix_oferta_estado ON oferta_cupo (estado, expira_en);

-- =====================================================================
-- 8. INSTRUMENTACIÓN DE LA INVESTIGACIÓN
--    Tablas que existen exclusivamente para poder llenar las fichas
--    técnicas. Sin ellas, los indicadores de los OE1 y OE4 no se
--    pueden calcular al cierre del estudio.
-- =====================================================================

CREATE TYPE operacion_medida AS ENUM (
  'BUSCAR_PACIENTE', 'VER_AGENDA_DIA', 'VER_HISTORIAL', 'GENERAR_REPORTE'
);
CREATE TYPE fase_medicion AS ENUM ('PRETEST', 'POSTEST');

-- Ficha técnica N.° 9 — Tiempo de consulta de información (segundos)
CREATE TABLE medicion_consulta (
  id           BIGSERIAL PRIMARY KEY,
  usuario_id   BIGINT REFERENCES usuario(id),
  operacion    operacion_medida NOT NULL,
  duracion_ms  INTEGER NOT NULL,
  ocurrido_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fase         fase_medicion NOT NULL DEFAULT 'POSTEST'
);

CREATE INDEX ix_medicion_op ON medicion_consulta (operacion, fase, ocurrido_en);

-- Ficha técnica N.° 8 — Número de reportes generados
CREATE TYPE tipo_reporte AS ENUM ('INDICADORES', 'AGENDA_DIA', 'AUSENTISMO', 'EXPORTACION_CSV');

CREATE TABLE reporte_generado (
  id           BIGSERIAL PRIMARY KEY,
  usuario_id   BIGINT REFERENCES usuario(id),
  tipo         tipo_reporte NOT NULL,
  desde        DATE NOT NULL,
  hasta        DATE NOT NULL,
  filas        INTEGER,
  generado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_reporte_tipo ON reporte_generado (tipo, generado_en);

-- Marca la ventana pretest/postest del diseño O1 – X – O2.
-- Permite que las consultas de indicadores separen ambas mediciones
-- sin depender de fechas escritas a mano en el análisis.
CREATE TABLE fase_estudio (
  id     SMALLSERIAL PRIMARY KEY,
  fase   fase_medicion NOT NULL UNIQUE,
  desde  DATE NOT NULL,
  hasta  DATE NOT NULL,
  nota   VARCHAR(200)
);

-- =====================================================================
-- 9. AUDITORÍA  (RF-28 · Ley N.° 29733)
-- =====================================================================

CREATE TYPE accion_auditoria AS ENUM ('LECTURA', 'CREACION', 'MODIFICACION', 'ELIMINACION', 'EXPORTACION');

CREATE TABLE auditoria (
  id            BIGSERIAL PRIMARY KEY,
  usuario_id    BIGINT REFERENCES usuario(id),
  entidad       VARCHAR(60) NOT NULL,
  entidad_id    BIGINT,
  accion        accion_auditoria NOT NULL,
  datos_antes   JSONB,
  datos_despues JSONB,
  ip            INET,
  ocurrido_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_auditoria_entidad ON auditoria (entidad, entidad_id, ocurrido_en);
CREATE INDEX ix_auditoria_usuario ON auditoria (usuario_id, ocurrido_en);

-- La bitácora es de solo lectura para el rol de la aplicación: se revocan
-- UPDATE y DELETE y solo se concede INSERT/SELECT (RF-28). Ajustar el
-- nombre de rol al que use la aplicación en producción.
-- REVOKE UPDATE, DELETE ON auditoria FROM app_rol;

-- =====================================================================
-- 10. DATOS INICIALES
-- =====================================================================

INSERT INTO fase_estudio (fase, desde, hasta, nota) VALUES
  ('PRETEST', '2026-01-01', '2026-07-31', 'Línea base retrospectiva — registros previos a la implementación'),
  ('POSTEST', '2026-11-09', '2026-12-27', 'Piloto con el sistema en operación');
