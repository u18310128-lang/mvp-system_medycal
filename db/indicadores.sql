-- =====================================================================
-- INDICADORES DE LA INVESTIGACIÓN
-- Una consulta por cada ficha técnica del Anexo.
--
-- Motor: PostgreSQL 15+
--
-- Todas aceptan el parámetro $1 ('PRETEST' | 'POSTEST') y toman el rango
-- de fechas de la tabla fase_estudio, de modo que el análisis
-- pretest/postest no dependa de fechas escritas a mano.
--
-- Uso desde el sistema:  pasar $1 como parámetro enlazado.
-- Uso para el capítulo V: ejecutar ambas fases y volcar a Excel/SPSS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- FICHA N.° 1 — Tiempo promedio de registro de una cita (minutos)
-- OE1 · Fórmula: Σ tiempo de registro / N.º citas registradas
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(c.id)                                   AS citas_registradas,
  round(avg(c.registro_seg) / 60.0, 2)          AS tiempo_promedio_min,
  round(min(c.registro_seg) / 60.0, 2)          AS minimo_min,
  round(max(c.registro_seg) / 60.0, 2)          AS maximo_min,
  round(stddev_samp(c.registro_seg) / 60.0, 2)  AS desviacion_min
FROM cita c
JOIN fase_estudio f
  ON (c.registro_creado_en AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
  AND c.registro_seg IS NOT NULL
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 2 — Número de citas registradas
-- OE1 · Fórmula: conteo total
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*)                                                  AS citas_registradas,
  count(*) FILTER (WHERE c.origen = 'RECEPCION')            AS por_recepcion,
  count(*) FILTER (WHERE c.origen = 'PACIENTE')             AS por_paciente,
  count(*) FILTER (WHERE c.origen = 'LISTA_ESPERA')         AS por_lista_espera
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 3 — Número de recordatorios enviados
-- OE2 · Fórmula: conteo total  ·  Solo POSTEST
-- ---------------------------------------------------------------------
SELECT
  r.hito,
  r.canal,
  count(*)                                                             AS programados,
  count(*) FILTER (WHERE r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))  AS enviados,
  count(*) FILTER (WHERE r.estado IN ('ENTREGADO','LEIDO'))            AS entregados,
  count(*) FILTER (WHERE r.estado = 'LEIDO')                           AS leidos,
  count(*) FILTER (WHERE r.estado = 'FALLIDO')                         AS fallidos,
  count(*) FILTER (WHERE r.estado = 'SUSPENDIDO')                      AS suspendidos
FROM recordatorio r
JOIN cita c ON c.id = r.cita_id
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = 'POSTEST'
GROUP BY ROLLUP (r.hito, r.canal);


-- ---------------------------------------------------------------------
-- FICHA N.° 4 — Porcentaje de recordatorios enviados exitosamente
-- OE2 · Fórmula: (Enviados / Programados) × 100
-- ---------------------------------------------------------------------
SELECT
  count(*)                                                             AS programados,
  count(*) FILTER (WHERE r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))  AS enviados,
  round(
    100.0 * count(*) FILTER (WHERE r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))
    / nullif(count(*), 0)
  , 2)                                                                 AS pct_envio,
  round(
    100.0 * count(*) FILTER (WHERE r.estado IN ('ENTREGADO','LEIDO'))
    / nullif(count(*), 0)
  , 2)                                                                 AS pct_entrega
FROM recordatorio r
JOIN cita c ON c.id = r.cita_id
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = 'POSTEST'
  AND r.estado <> 'SUSPENDIDO';   -- los suspendidos no debían enviarse


-- ---------------------------------------------------------------------
-- FICHA N.° 5 — Porcentaje de citas confirmadas
-- OE3 · Fórmula: (Confirmadas / Total citas) × 100
-- ---------------------------------------------------------------------
WITH citas_fase AS (
  SELECT
    f.fase,
    c.id,
    (c.estado = 'CONFIRMADA'
     OR EXISTS (SELECT 1 FROM respuesta_paciente rp
                WHERE rp.cita_id = c.id AND rp.accion = 'CONFIRMAR')) AS fue_confirmada
  FROM cita c
  JOIN fase_estudio f
    ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
  WHERE f.fase = $1::fase_medicion
)
SELECT
  fase,
  count(*)                                    AS total_citas,
  count(*) FILTER (WHERE fue_confirmada)      AS confirmadas,
  round(100.0 * count(*) FILTER (WHERE fue_confirmada) / nullif(count(*), 0), 2)
                                              AS pct_confirmacion
FROM citas_fase
GROUP BY fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 6 — Número de citas reprogramadas
-- OE3 · Fórmula: conteo total
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*) FILTER (WHERE c.estado = 'REPROGRAMADA')  AS citas_reprogramadas,
  round(100.0 * count(*) FILTER (WHERE c.estado = 'REPROGRAMADA') / nullif(count(*), 0), 2)
                                                     AS pct_reprogramacion
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 7 — Número de cancelaciones oportunas
-- OE3 · Cancelaciones realizadas antes de la hora programada.
--       Se reporta además el corte de 4 h, que es el umbral a partir
--       del cual el cupo puede reasignarse a la lista de espera.
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*) FILTER (WHERE c.estado = 'CANCELADA')                           AS cancelaciones_total,
  count(*) FILTER (WHERE c.estado = 'CANCELADA' AND c.antelacion_horas > 0)  AS cancelaciones_oportunas,
  count(*) FILTER (WHERE c.estado = 'CANCELADA' AND c.antelacion_horas >= 4) AS cancelaciones_reasignables,
  round(avg(c.antelacion_horas) FILTER (WHERE c.estado = 'CANCELADA'), 2)  AS antelacion_promedio_h
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 8 — Número de reportes generados
-- OE4 · Fórmula: conteo total  ·  Solo POSTEST
-- ---------------------------------------------------------------------
SELECT
  rg.tipo,
  count(*) AS reportes_generados
FROM reporte_generado rg
JOIN fase_estudio f
  ON (rg.generado_en AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = 'POSTEST'
GROUP BY ROLLUP (rg.tipo);


-- ---------------------------------------------------------------------
-- FICHA N.° 9 — Tiempo de consulta de información (segundos)
-- OE4 · Fórmula: Σ tiempo / N.º consultas
-- ---------------------------------------------------------------------
SELECT
  m.fase,
  m.operacion,
  count(*)                                        AS n_consultas,
  round(avg(m.duracion_ms) / 1000.0, 3)           AS tiempo_promedio_seg,
  round(stddev_samp(m.duracion_ms) / 1000.0, 3)   AS desviacion_seg,
  round(max(m.duracion_ms) / 1000.0, 3)           AS maximo_seg
FROM medicion_consulta m
WHERE m.fase = $1::fase_medicion
GROUP BY ROLLUP (m.fase, m.operacion);


-- ---------------------------------------------------------------------
-- FICHA N.° 10 — TASA DE AUSENTISMO  ★ indicador principal (OG)
-- Fórmula aprobada en el Anexo: (Ausentes / Programadas) × 100
--
-- Se reporta también la variante que excluye del denominador las citas
-- canceladas y reprogramadas. Conviene incluir ambas en el capítulo V:
-- la primera es la comprometida en la ficha técnica, la segunda evita
-- que el sistema parezca más efectivo solo porque generó más
-- cancelaciones anticipadas. Declarar las dos fortalece la discusión.
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*)                                                  AS citas_programadas,
  count(*) FILTER (WHERE c.estado = 'ATENDIDA')             AS atendidas,
  count(*) FILTER (WHERE c.estado = 'AUSENTE')              AS ausentes,
  count(*) FILTER (WHERE c.estado = 'CANCELADA')            AS canceladas,
  count(*) FILTER (WHERE c.estado = 'REPROGRAMADA')         AS reprogramadas,

  -- Ficha técnica N.° 10 (fórmula aprobada)
  round(100.0 * count(*) FILTER (WHERE c.estado = 'AUSENTE') / nullif(count(*), 0), 2)
                                                            AS tasa_ausentismo_pct,

  -- Variante de control para la discusión
  round(100.0 * count(*) FILTER (WHERE c.estado = 'AUSENTE')
        / nullif(count(*) FILTER (WHERE c.estado IN ('ATENDIDA','AUSENTE')), 0), 2)
                                                            AS tasa_ausentismo_efectiva_pct
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
  AND c.inicio < now()          -- solo citas cuya hora ya pasó
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 11 — Porcentaje de asistencia
-- OG · Fórmula: (Atendidos / Programadas) × 100
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*)                                        AS citas_programadas,
  count(*) FILTER (WHERE c.estado = 'ATENDIDA')   AS atendidas,
  round(100.0 * count(*) FILTER (WHERE c.estado = 'ATENDIDA') / nullif(count(*), 0), 2)
                                                  AS pct_asistencia
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
  AND c.inicio < now()
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 12 — Número de citas perdidas
-- Total de citas en las que el paciente no asistió.
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(*) FILTER (WHERE c.estado = 'AUSENTE')    AS citas_perdidas,
  round(
    sum(extract(epoch FROM (c.fin - c.inicio))) FILTER (WHERE c.estado = 'AUSENTE')
    / 3600.0
  , 2)                                            AS horas_medicas_perdidas
FROM cita c
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
GROUP BY f.fase;


-- ---------------------------------------------------------------------
-- FICHA N.° 13 — Tiempo promedio de reprogramación
-- Tiempo transcurrido entre la inasistencia y la nueva cita.
-- ---------------------------------------------------------------------
SELECT
  f.fase,
  count(nueva.id)                                                     AS reprogramaciones,
  round(avg(extract(epoch FROM (nueva.inicio - original.inicio))) / 86400.0, 2)
                                                                      AS dias_promedio,
  round(min(extract(epoch FROM (nueva.inicio - original.inicio))) / 86400.0, 2)
                                                                      AS dias_minimo,
  round(max(extract(epoch FROM (nueva.inicio - original.inicio))) / 86400.0, 2)
                                                                      AS dias_maximo
FROM cita nueva
JOIN cita original ON original.id = nueva.cita_origen_id
JOIN fase_estudio f
  ON (original.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = $1::fase_medicion
GROUP BY f.fase;


-- =====================================================================
-- INDICADOR ADICIONAL — Recuperación de cupos
-- No está en tus fichas técnicas, pero es el que mejor justifica el
-- sistema ante el consultorio: cuántas cancelaciones se convirtieron
-- en consultas efectivamente atendidas.
-- Vale la pena agregarlo como ficha N.° 14.
-- =====================================================================
SELECT
  count(DISTINCT o.cita_liberada_id)                                        AS cupos_liberados,
  count(DISTINCT o.cita_liberada_id) FILTER (WHERE o.estado = 'ACEPTADA')   AS cupos_recuperados,
  round(
    100.0 * count(DISTINCT o.cita_liberada_id) FILTER (WHERE o.estado = 'ACEPTADA')
    / nullif(count(DISTINCT o.cita_liberada_id), 0)
  , 2)                                                                      AS pct_recuperacion
FROM oferta_cupo o
JOIN cita c ON c.id = o.cita_liberada_id
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE f.fase = 'POSTEST';


-- =====================================================================
-- EXPORTACIÓN ANONIMIZADA PARA SPSS / EXCEL
-- Una fila por cita. Es el archivo que alimenta el capítulo V.
-- El paciente se identifica por seudónimo, nunca por documento.
-- =====================================================================
SELECT
  f.fase,
  p.seudonimo                                          AS paciente,
  c.id                                                 AS cita_id,
  (c.inicio AT TIME ZONE 'America/Lima')::date         AS fecha,
  (c.inicio AT TIME ZONE 'America/Lima')::time         AS hora,
  extract(isodow FROM c.inicio AT TIME ZONE 'America/Lima') AS dia_semana,
  c.estado,
  c.tipo,
  c.origen,
  (c.estado = 'AUSENTE')::int                          AS ausente,
  (c.estado = 'ATENDIDA')::int                         AS atendida,
  c.antelacion_horas,
  c.registro_seg,
  (SELECT count(*) FROM recordatorio r
    WHERE r.cita_id = c.id
      AND r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))  AS recordatorios_enviados,
  (SELECT count(*) FROM recordatorio r
    WHERE r.cita_id = c.id
      AND r.estado IN ('ENTREGADO','LEIDO'))            AS recordatorios_entregados,
  (SELECT rp.accion FROM respuesta_paciente rp
    WHERE rp.cita_id = c.id AND rp.respondido_en IS NOT NULL
    ORDER BY rp.respondido_en DESC LIMIT 1)             AS respuesta_paciente,
  p.riesgo                                             AS riesgo_paciente
FROM cita c
JOIN paciente p ON p.id = c.paciente_id
JOIN fase_estudio f
  ON (c.inicio AT TIME ZONE 'America/Lima')::date BETWEEN f.desde AND f.hasta
WHERE c.inicio < now()
ORDER BY f.fase, c.inicio;
