-- =====================================================================
-- DATOS DE DEMOSTRACIÓN
-- Consultorio Perú Ruso — para pruebas y demostración del sistema.
--
-- Genera:
--   · 2 médicos con horarios de atención
--   · 60 pacientes
--   · Citas del PRETEST (línea base retrospectiva, ene–jul 2026) con una
--     tasa de ausentismo alta, propia del proceso manual
--   · Citas del POSTEST (piloto, nov–dic 2026) con recordatorios y
--     confirmaciones, y una tasa de ausentismo menor
--   · Agenda del día de hoy para la demostración en vivo
--
-- ADVERTENCIA: son datos sintéticos. Sirven para demostrar el sistema y
-- validar las consultas de indicadores, NO para el capítulo de resultados.
-- Las cifras reales salen de los registros del consultorio.
-- =====================================================================

BEGIN;

-- Genera la grilla real de cupos de atención: por cada médico, cada día
-- hábil del rango, un cupo cada 20 minutos en 08:00–13:00 y 15:00–19:00.
-- Cada combinación (médico, instante) aparece una sola vez, de modo que
-- las citas sembradas nunca chocan contra ex_cita_sin_solape.
CREATE OR REPLACE FUNCTION cupos_disponibles(p_desde DATE, p_hasta DATE)
RETURNS TABLE (medico_id BIGINT, inicio TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT m.id,
         ((f.fecha + t.hora) AT TIME ZONE 'America/Lima')
  FROM (
    SELECT d::date AS fecha
    FROM generate_series(p_desde, p_hasta, INTERVAL '1 day') AS d
    WHERE extract(isodow FROM d) <= 5
  ) f
  CROSS JOIN medico m
  CROSS JOIN (
    SELECT (TIME '08:00' + n * INTERVAL '20 minutes') AS hora
    FROM generate_series(0, 14) AS n
    UNION ALL
    SELECT (TIME '15:00' + n * INTERVAL '20 minutes')
    FROM generate_series(0, 11) AS n
  ) t;
$$;

TRUNCATE auditoria, reporte_generado, medicion_consulta, oferta_cupo,
         lista_espera, respuesta_paciente, recordatorio, cita,
         consentimiento, paciente, excepcion_agenda, horario_atencion,
         medico, usuario RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------- usuarios
INSERT INTO usuario (email, hash_password, nombres, rol) VALUES
  ('recepcion@peruruso.pe', '$argon2id$demo', 'Carmen Salazar',  'RECEPCIONISTA'),
  ('admin@peruruso.pe',     '$argon2id$demo', 'Dirección',       'ADMINISTRADOR'),
  ('a.quispe@peruruso.pe',  '$argon2id$demo', 'Ana Quispe',      'MEDICO'),
  ('j.torres@peruruso.pe',  '$argon2id$demo', 'José Torres',     'MEDICO');

-- ---------------------------------------------------------------- médicos
INSERT INTO medico (usuario_id, nombres, apellidos, cmp, especialidad) VALUES
  (3, 'Ana',  'Quispe', 'CMP-45821', 'Medicina General'),
  (4, 'José', 'Torres', 'CMP-38109', 'Medicina General');

-- Horarios: lunes a viernes, 08:00–13:00 y 15:00–19:00, citas de 20 min
INSERT INTO horario_atencion (medico_id, dia_semana, hora_inicio, hora_fin, duracion_min)
SELECT m.id, d, h.ini, h.fin, 20
FROM medico m
CROSS JOIN generate_series(1, 5) AS d
CROSS JOIN (VALUES ('08:00'::time, '13:00'::time),
                   ('15:00'::time, '19:00'::time)) AS h(ini, fin);

-- ---------------------------------------------------------------- pacientes
INSERT INTO paciente (tipo_doc, num_doc, nombres, apellidos, fecha_nac, celular, email, canal_pref, riesgo, seudonimo)
SELECT
  'DNI',
  lpad((40000000 + i)::text, 8, '0'),
  (ARRAY['Luis','Rosa','Carlos','María','Jorge','Ana','Pedro','Lucía','Miguel','Elena',
         'Raúl','Carmen','Diego','Sofía','Andrés','Patricia','Julio','Rocío','Víctor','Nadia'])[1 + (i % 20)],
  (ARRAY['Ramos','Vega','Huamán','Flores','Castillo','Mendoza','Rojas','Paredes','Cárdenas','Bautista'])[1 + (i % 10)]
    || ' ' ||
  (ARRAY['Quiroz','Salas','Ticona','Ñahui','Guerrero','Ipanaqué','Zavala','Mamani','Del Águila','Bustamante'])[1 + (i % 10)],
  DATE '1960-01-01' + (i * 137)::int,
  '+519' || lpad((10000000 + i * 7919)::text, 8, '0'),
  CASE WHEN i % 4 = 0 THEN 'paciente' || i || '@correo.pe' ELSE NULL END,
  CASE WHEN i % 11 = 0 THEN 'SMS'::canal_contacto ELSE 'WHATSAPP'::canal_contacto END,
  CASE WHEN i % 9 = 0 THEN 'ALTO'::nivel_riesgo
       WHEN i % 5 = 0 THEN 'MEDIO'::nivel_riesgo
       ELSE 'BAJO'::nivel_riesgo END,
  'PX' || lpad(i::text, 10, '0')
FROM generate_series(1, 60) AS i;

-- Consentimiento vigente para todos (Ley N.° 29733)
INSERT INTO consentimiento (paciente_id, version, finalidad, medio, otorgado_en)
SELECT p.id, 'v1.0', f.finalidad, 'FISICO', TIMESTAMPTZ '2026-01-05 12:00:00-05'
FROM paciente p
CROSS JOIN (VALUES ('TRATAMIENTO_DATOS'::finalidad_consentimiento),
                   ('CONTACTO_RECORDATORIOS'::finalidad_consentimiento)) AS f(finalidad);

-- =====================================================================
-- CITAS DEL PRETEST — línea base retrospectiva (ene–jul 2026)
-- Proceso manual: sin recordatorios, sin confirmación registrada.
-- Ausentismo alto (~28 %), típico de la gestión en papel.
-- =====================================================================
INSERT INTO cita (paciente_id, medico_id, inicio, fin, estado, tipo, origen,
                  registro_creado_en, registro_seg, creado_por)
SELECT
  1 + (rn * 7 % 60),
  medico_id,
  inicio,
  inicio + INTERVAL '20 minutes',
  CASE
    WHEN rn % 25 = 0 THEN 'CANCELADA'::estado_cita
    WHEN rn % 7  = 0 THEN 'AUSENTE'::estado_cita
    WHEN rn % 11 = 0 THEN 'AUSENTE'::estado_cita
    ELSE 'ATENDIDA'::estado_cita
  END,
  CASE WHEN rn % 6 = 0 THEN 'PRIMERA_VEZ'::tipo_cita ELSE 'CONTINUADOR'::tipo_cita END,
  'RECEPCION',
  inicio - INTERVAL '5 days',
  -- Registro manual: entre 3 y 6 minutos por cita
  180 + (rn * 37) % 180,
  1
FROM (
  SELECT s.medico_id, s.inicio,
         row_number() OVER (ORDER BY s.inicio, s.medico_id) AS rn
  FROM cupos_disponibles(DATE '2026-01-05', DATE '2026-04-30') s
) g
WHERE rn % 12 = 0;   -- ocupa 1 de cada 12 cupos → ~420 citas

-- Antelación de las cancelaciones del pretest
UPDATE cita SET cancelada_en = inicio - INTERVAL '6 hours',
                antelacion_horas = 6,
                origen_cancelacion = 'PACIENTE',
                motivo_cancelacion = 'Aviso telefónico del paciente'
WHERE estado = 'CANCELADA';

-- =====================================================================
-- CITAS DEL POSTEST — piloto con el sistema (nov–dic 2026)
-- Con recordatorios, confirmación y lista de espera.
-- Ausentismo menor (~14 %).
-- =====================================================================
INSERT INTO cita (paciente_id, medico_id, inicio, fin, estado, tipo, origen,
                  registro_creado_en, registro_seg, creado_por)
SELECT
  1 + (rn * 7 % 60),
  medico_id,
  inicio,
  inicio + INTERVAL '20 minutes',
  CASE
    WHEN rn % 17 = 0 THEN 'CANCELADA'::estado_cita
    WHEN rn % 29 = 0 THEN 'REPROGRAMADA'::estado_cita
    WHEN rn % 13 = 0 THEN 'AUSENTE'::estado_cita
    ELSE 'ATENDIDA'::estado_cita
  END,
  CASE WHEN rn % 6 = 0 THEN 'PRIMERA_VEZ'::tipo_cita ELSE 'CONTINUADOR'::tipo_cita END,
  CASE WHEN rn % 19 = 0 THEN 'LISTA_ESPERA'::origen_cita ELSE 'RECEPCION'::origen_cita END,
  inicio - INTERVAL '7 days',
  -- Registro con el sistema: entre 40 y 90 segundos
  40 + (rn * 13) % 50,
  1
FROM (
  SELECT s.medico_id, s.inicio,
         row_number() OVER (ORDER BY s.inicio, s.medico_id) AS rn
  FROM cupos_disponibles(DATE '2026-05-04', DATE '2026-08-11') s
) g
WHERE rn % 12 = 0;   -- ocupa 1 de cada 12 cupos → ~260 citas

UPDATE cita SET cancelada_en = inicio - INTERVAL '9 hours',
                antelacion_horas = 9,
                origen_cancelacion = 'PACIENTE',
                motivo_cancelacion = 'Cancelación desde el enlace de WhatsApp'
WHERE estado IN ('CANCELADA','REPROGRAMADA')
  AND inicio >= TIMESTAMPTZ '2026-05-04 00:00:00-05';

-- ------------------------------------------------- recordatorios del postest
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, estado,
                          programado_para, enviado_en, entregado_en, plantilla)
SELECT
  c.id,
  h.hito,
  'WHATSAPP',
  'cita:' || c.id || ':' || h.hito || ':WHATSAPP',
  CASE
    WHEN c.estado IN ('CANCELADA','REPROGRAMADA') AND h.hito = 'T_3H' THEN 'SUSPENDIDO'::estado_recordatorio
    WHEN c.id % 23 = 0 THEN 'FALLIDO'::estado_recordatorio
    WHEN c.id % 3  = 0 THEN 'LEIDO'::estado_recordatorio
    ELSE 'ENTREGADO'::estado_recordatorio
  END,
  c.inicio - h.horas,
  CASE WHEN c.id % 23 = 0 THEN NULL ELSE c.inicio - h.horas + INTERVAL '12 seconds' END,
  CASE WHEN c.id % 23 = 0 THEN NULL ELSE c.inicio - h.horas + INTERVAL '40 seconds' END,
  'recordatorio_cita_v1'
FROM cita c
CROSS JOIN (VALUES ('T_48H'::hito_recordatorio, INTERVAL '48 hours'),
                   ('T_24H'::hito_recordatorio, INTERVAL '24 hours'),
                   ('T_3H'::hito_recordatorio,  INTERVAL '3 hours')) AS h(hito, horas)
WHERE c.inicio >= TIMESTAMPTZ '2026-05-04 00:00:00-05';

-- ------------------------------------------- respuestas del paciente (postest)
INSERT INTO respuesta_paciente (cita_id, token_hash, accion, emitido_en, expira_en, respondido_en)
SELECT
  c.id,
  encode(digest('token-' || c.id, 'sha256'), 'hex'),
  CASE
    WHEN c.estado = 'CANCELADA'     THEN 'CANCELAR'::accion_respuesta
    WHEN c.estado = 'REPROGRAMADA'  THEN 'REPROGRAMAR'::accion_respuesta
    WHEN c.estado = 'AUSENTE'       THEN NULL
    ELSE 'CONFIRMAR'::accion_respuesta
  END,
  c.inicio - INTERVAL '48 hours',
  c.inicio,
  CASE WHEN c.estado = 'AUSENTE' THEN NULL ELSE c.inicio - INTERVAL '30 hours' END
FROM cita c
WHERE c.inicio >= TIMESTAMPTZ '2026-05-04 00:00:00-05'
  AND c.id % 6 <> 0;   -- no todos responden

-- ------------------------------------------------------ lista de espera y cupos
INSERT INTO lista_espera (paciente_id, medico_id, desde, hasta, franja, prioridad, estado)
SELECT 1 + (i % 60), 1 + (i % 2), DATE '2026-05-04', DATE '2026-08-11',
       'CUALQUIERA', 100 - i, 'ACTIVA'
FROM generate_series(1, 12) AS i;

INSERT INTO oferta_cupo (cita_liberada_id, lista_espera_id, enviada_en, expira_en, estado)
SELECT c.id,
       1 + (c.id % 12),
       c.cancelada_en,
       c.cancelada_en + INTERVAL '2 hours',
       CASE WHEN c.id % 3 = 0 THEN 'ACEPTADA'::estado_oferta ELSE 'VENCIDA'::estado_oferta END
FROM cita c
WHERE c.estado IN ('CANCELADA','REPROGRAMADA')
  AND c.inicio >= TIMESTAMPTZ '2026-05-04 00:00:00-05'
  AND c.antelacion_horas >= 4;

-- ------------------------------------------------------- mediciones de consulta
INSERT INTO medicion_consulta (usuario_id, operacion, duracion_ms, ocurrido_en, fase)
SELECT 1,
       (ARRAY['BUSCAR_PACIENTE','VER_AGENDA_DIA','VER_HISTORIAL','GENERAR_REPORTE'])[1 + (i % 4)]::operacion_medida,
       CASE WHEN i % 4 = 0 THEN 900 + (i * 31) % 600 ELSE 150 + (i * 17) % 400 END,
       TIMESTAMPTZ '2026-06-15 10:00:00-05' + (i * 37) * INTERVAL '1 minute',
       'POSTEST'
FROM generate_series(1, 120) AS i;

INSERT INTO reporte_generado (usuario_id, tipo, desde, hasta, filas, generado_en)
SELECT 2,
       (ARRAY['INDICADORES','AGENDA_DIA','AUSENTISMO','EXPORTACION_CSV'])[1 + (i % 4)]::tipo_reporte,
       DATE '2026-05-04', DATE '2026-08-11', 100 + i,
       TIMESTAMPTZ '2026-06-20 09:00:00-05' + i * INTERVAL '1 day'
FROM generate_series(1, 18) AS i;

-- =====================================================================
-- AGENDA DE HOY — para la demostración en vivo
-- =====================================================================
INSERT INTO cita (paciente_id, medico_id, inicio, fin, estado, tipo, origen,
                  registro_creado_en, registro_seg, creado_por)
SELECT
  1 + (i * 7 % 60),
  1 + (i % 2),
  inicio,
  inicio + INTERVAL '20 minutes',
  CASE WHEN i % 3 = 0 THEN 'CONFIRMADA'::estado_cita ELSE 'PROGRAMADA'::estado_cita END,
  'CONTINUADOR',
  'RECEPCION',
  now() - INTERVAL '2 days',
  55 + (i * 11) % 40,
  1
FROM (
  SELECT i,
         (CURRENT_DATE + (8 + (i / 3)) * INTERVAL '1 hour'
                       + ((i % 3) * 20) * INTERVAL '1 minute') AT TIME ZONE 'America/Lima' AS inicio
  FROM generate_series(0, 17) AS i
) s;

-- Recordatorios activos de las citas de hoy
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, estado,
                          programado_para, enviado_en, entregado_en, plantilla)
SELECT
  c.id, h.hito, 'WHATSAPP',
  'cita:' || c.id || ':' || h.hito || ':WHATSAPP',
  CASE WHEN c.inicio - h.horas < now() THEN 'ENTREGADO'::estado_recordatorio
       ELSE 'PROGRAMADO'::estado_recordatorio END,
  c.inicio - h.horas,
  CASE WHEN c.inicio - h.horas < now() THEN c.inicio - h.horas + INTERVAL '10 seconds' END,
  CASE WHEN c.inicio - h.horas < now() THEN c.inicio - h.horas + INTERVAL '35 seconds' END,
  'recordatorio_cita_v1'
FROM cita c
CROSS JOIN (VALUES ('T_48H'::hito_recordatorio, INTERVAL '48 hours'),
                   ('T_24H'::hito_recordatorio, INTERVAL '24 hours'),
                   ('T_3H'::hito_recordatorio,  INTERVAL '3 hours')) AS h(hito, horas)
WHERE (c.inicio AT TIME ZONE 'America/Lima')::date = CURRENT_DATE;

-- Ventanas de la DEMOSTRACIÓN.
-- Ambas se ubican en el pasado para que el panel de indicadores muestre una
-- comparación con resultados reales el día de la demo (12 ago 2026).
--
-- Al iniciar el piloto verdadero hay que reemplazarlas por las del proyecto:
--   PRETEST  2026-01-01 → 2026-07-31   (línea base retrospectiva)
--   POSTEST  2026-11-09 → 2026-12-27   (piloto en operación)
UPDATE fase_estudio SET desde = '2026-01-05', hasta = '2026-04-30' WHERE fase = 'PRETEST';
UPDATE fase_estudio SET desde = '2026-05-04', hasta = '2026-08-11' WHERE fase = 'POSTEST';

COMMIT;

-- ---------------------------------------------------------------- resumen
SELECT 'pacientes'     AS entidad, count(*) FROM paciente
UNION ALL SELECT 'citas totales',   count(*) FROM cita
UNION ALL SELECT 'citas hoy',       count(*) FROM cita WHERE (inicio AT TIME ZONE 'America/Lima')::date = CURRENT_DATE
UNION ALL SELECT 'recordatorios',   count(*) FROM recordatorio
UNION ALL SELECT 'respuestas',      count(*) FROM respuesta_paciente
UNION ALL SELECT 'ofertas de cupo', count(*) FROM oferta_cupo;
