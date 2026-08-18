-- =====================================================================
-- Verificación de las restricciones críticas del esquema.
-- Cada bloque intenta violar una regla y debe fallar.
-- Ejecutar con:  psql -v ON_ERROR_STOP=0 -f verificar_restricciones.sql
-- =====================================================================

BEGIN;

-- Datos mínimos
INSERT INTO usuario (id, email, hash_password, nombres, rol)
VALUES (1, 'recepcion@test.pe', 'x', 'Recepción', 'RECEPCIONISTA');

INSERT INTO medico (id, nombres, apellidos, cmp)
VALUES (1, 'Ana', 'Quispe', 'CMP-11111');

INSERT INTO paciente (id, num_doc, nombres, apellidos, celular, seudonimo)
VALUES (1, '40000001', 'Luis', 'Ramos', '+51987654321', 'PX0000000001'),
       (2, '40000002', 'Rosa', 'Vega',  '+51987654322', 'PX0000000002');

-- Cita base: 9 nov 2026, 10:00–10:20 hora de Lima
INSERT INTO cita (id, paciente_id, medico_id, inicio, fin)
VALUES (1, 1, 1, '2026-11-09 15:00:00+00', '2026-11-09 15:20:00+00');

-- Se insertó con id explícito, así que las secuencias siguen en 1 y los
-- INSERT posteriores chocarían contra la clave primaria antes de llegar a
-- la restricción que se quiere probar. Se avanzan al valor real.
SELECT setval('usuario_id_seq',  (SELECT max(id) FROM usuario));
SELECT setval('medico_id_seq',   (SELECT max(id) FROM medico));
SELECT setval('paciente_id_seq', (SELECT max(id) FROM paciente));
SELECT setval('cita_id_seq',     (SELECT max(id) FROM cita));

\echo '=== 1. Solapamiento exacto del mismo medico (debe FALLAR) ==='
SAVEPOINT s1;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-09 15:00:00+00', '2026-11-09 15:20:00+00');
ROLLBACK TO s1;

\echo '=== 2. Solapamiento parcial del mismo medico (debe FALLAR) ==='
SAVEPOINT s2;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-09 15:10:00+00', '2026-11-09 15:30:00+00');
ROLLBACK TO s2;

\echo '=== 3. Cita contigua sin solape, 10:20-10:40 (debe PASAR) ==='
SAVEPOINT s3;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-09 15:20:00+00', '2026-11-09 15:40:00+00');
ROLLBACK TO s3;

\echo '=== 4. Mismo horario pero OTRO medico (debe PASAR) ==='
SAVEPOINT s4;
INSERT INTO medico (id, nombres, apellidos, cmp) VALUES (2, 'Jose', 'Torres', 'CMP-22222');
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 2, '2026-11-09 15:00:00+00', '2026-11-09 15:20:00+00');
ROLLBACK TO s4;

\echo '=== 5. Al CANCELAR la cita, el cupo se libera y otra puede ocuparlo (debe PASAR) ==='
SAVEPOINT s5;
UPDATE cita SET estado = 'CANCELADA', cancelada_en = now(), antelacion_horas = 24 WHERE id = 1;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-09 15:00:00+00', '2026-11-09 15:20:00+00');
ROLLBACK TO s5;

\echo '=== 6. Una cita AUSENTE sigue bloqueando el horario (debe FALLAR) ==='
SAVEPOINT s6;
UPDATE cita SET estado = 'AUSENTE' WHERE id = 1;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-09 15:00:00+00', '2026-11-09 15:20:00+00');
ROLLBACK TO s6;

\echo '=== 7. Rango invertido: fin anterior al inicio (debe FALLAR) ==='
SAVEPOINT s7;
INSERT INTO cita (paciente_id, medico_id, inicio, fin)
VALUES (2, 1, '2026-11-10 16:00:00+00', '2026-11-10 15:00:00+00');
ROLLBACK TO s7;

\echo '=== 8. Idempotencia: dos recordatorios con la misma clave (debe FALLAR) ==='
SAVEPOINT s8;
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, programado_para)
VALUES (1, 'T_24H', 'WHATSAPP', 'cita:1:T_24H:WHATSAPP', '2026-11-08 15:00:00+00');
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, programado_para)
VALUES (1, 'T_24H', 'WHATSAPP', 'cita:1:T_24H:WHATSAPP', '2026-11-08 15:00:00+00');
ROLLBACK TO s8;

\echo '=== 9. Mismo hito por OTRO canal si es clave distinta (debe PASAR) ==='
SAVEPOINT s9;
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, programado_para)
VALUES (1, 'T_24H', 'WHATSAPP', 'cita:1:T_24H:WHATSAPP', '2026-11-08 15:00:00+00');
INSERT INTO recordatorio (cita_id, hito, canal, clave_idempotencia, programado_para)
VALUES (1, 'T_24H', 'SMS', 'cita:1:T_24H:SMS', '2026-11-08 15:00:00+00');
ROLLBACK TO s9;

\echo '=== 10. Documento de paciente duplicado (debe FALLAR) ==='
SAVEPOINT s10;
INSERT INTO paciente (num_doc, nombres, apellidos, celular, seudonimo)
VALUES ('40000001', 'Otro', 'Paciente', '+51900000000', 'PX0000000003');
ROLLBACK TO s10;

ROLLBACK;
