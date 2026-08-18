-- =====================================================================
-- MIGRACIÓN · Autenticación y control de acceso por rol
-- RF-27 (autenticación con roles diferenciados) y RF-28 (auditoría)
--
--   psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/migracion-auth.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Sesiones
--
-- Se guardan en base y no en un token autocontenido para poder revocarlas:
-- si un usuario deja el consultorio, cerrar su sesión debe surtir efecto
-- de inmediato, no cuando venza un token. La cookie transporta el
-- identificador; el resumen se guarda aquí para que una filtración de la
-- base no permita suplantar sesiones vivas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sesion (
  id              BIGSERIAL PRIMARY KEY,
  usuario_id      BIGINT      NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  token_hash      CHAR(64)    NOT NULL UNIQUE,
  creada_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_en       TIMESTAMPTZ NOT NULL,
  ultima_actividad TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrada_en      TIMESTAMPTZ,
  ip              INET,
  user_agent      VARCHAR(300)
);

CREATE INDEX IF NOT EXISTS ix_sesion_vigente
  ON sesion (token_hash) WHERE cerrada_en IS NULL;
CREATE INDEX IF NOT EXISTS ix_sesion_usuario
  ON sesion (usuario_id, creada_en DESC);

COMMENT ON COLUMN sesion.token_hash IS 'SHA-256 del identificador de sesión; el valor original solo viaja en la cookie';

-- ---------------------------------------------------------------------
-- Control de intentos de acceso
--
-- Registra cada intento, exitoso o no, para poder frenar el ensayo de
-- contraseñas y para dejar rastro ante una fiscalización.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intento_acceso (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(160) NOT NULL,
  exitoso      BOOLEAN      NOT NULL,
  ip           INET,
  ocurrido_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_intento_email
  ON intento_acceso (email, ocurrido_en DESC);

-- ---------------------------------------------------------------------
-- Clave de servicio
--
-- n8n no puede autenticarse con usuario y contraseña porque no es una
-- persona: consume la API sin sesión de navegador. Se identifica con una
-- clave de servicio de un solo propósito, limitada a las rutas de
-- despacho de recordatorios.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clave_servicio (
  id            BIGSERIAL PRIMARY KEY,
  nombre        VARCHAR(80)  NOT NULL UNIQUE,
  clave_hash    CHAR(64)     NOT NULL UNIQUE,
  activa        BOOLEAN      NOT NULL DEFAULT TRUE,
  creada_en     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ultimo_uso_en TIMESTAMPTZ
);

COMMENT ON TABLE clave_servicio IS 'Credenciales de sistemas, no de personas. Solo habilitan el despacho de recordatorios.';

-- ---------------------------------------------------------------------
-- La bitácora de auditoría es de solo escritura para la aplicación.
-- Nadie puede alterar ni borrar un registro ya asentado (RF-28).
-- Descomentar y ajustar el nombre del rol al desplegar en producción.
-- ---------------------------------------------------------------------
-- REVOKE UPDATE, DELETE ON auditoria FROM app_rol;

-- ---------------------------------------------------------------------
-- Limpieza de sesiones vencidas.
-- Conviene ejecutarla periódicamente desde n8n.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purgar_sesiones_vencidas()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  eliminadas INTEGER;
BEGIN
  DELETE FROM sesion
  WHERE expira_en < now() - INTERVAL '7 days';
  GET DIAGNOSTICS eliminadas = ROW_COUNT;
  RETURN eliminadas;
END;
$$;
