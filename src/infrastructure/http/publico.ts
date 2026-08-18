import express from "express";
import { consultar, consultarUna, enTransaccion, pool } from "../db/pool.js";
import { generarToken, resumir } from "../auth/credenciales.js";
import { Cita } from "../../domain/Cita.js";
import { RelojSistema } from "../../domain/Reloj.js";
import { PoliticaRecordatorios } from "../../domain/PoliticaRecordatorios.js";
import { ipDe } from "./middleware.js";

/**
 * Rutas públicas del paciente.
 *
 * No exigen sesión: el paciente se identifica con un enlace único que le
 * llega por mensajería (RF-16). El token es la credencial, así que todo lo
 * que se devuelve por acá está deliberadamente reducido al mínimo: nombre
 * de pila, fecha, hora y profesional. Nunca documento, teléfono ni dato
 * clínico, por exigencia de la Ley N.° 29733.
 */

export const publico = express.Router();

const ZONA = "America/Lima";
const reloj = new RelojSistema();
const politica = new PoliticaRecordatorios();

/** Días hacia adelante que se ofrecen al reprogramar (RF-19). */
const DIAS_REPROGRAMACION = 15;

function ruta(
  fn: (req: express.Request, res: express.Response) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Emite el enlace único de una cita, o devuelve el vigente si ya existe.
 *
 * Se llama al despachar el recordatorio. Los tres mensajes de la secuencia
 * comparten el mismo enlace: si el paciente confirma en T-48h y luego
 * necesita cancelar en T-24h, el enlace sigue sirviendo. Lo que gobierna
 * qué acciones son válidas es la máquina de estados de la cita, no el
 * consumo del token.
 */
export async function emitirEnlace(citaId: number): Promise<string | null> {
  const vigente = await consultarUna(
    `SELECT token_hash FROM respuesta_paciente
     WHERE cita_id = $1 AND expira_en > now()
     ORDER BY emitido_en DESC LIMIT 1`,
    [citaId]
  );

  // El resumen almacenado no permite reconstruir el token original, así que
  // si ya existe uno vigente pero no lo tenemos en claro, se emite otro.
  if (vigente) {
    const enClaro = enlacesEnMemoria.get(citaId);
    if (enClaro) return enClaro;
  }

  const cita = await consultarUna(
    `SELECT inicio FROM cita WHERE id = $1 AND estado IN ('PROGRAMADA','CONFIRMADA')`,
    [citaId]
  );
  if (!cita) return null;

  const { token, resumen } = generarToken();

  await pool.query(
    `INSERT INTO respuesta_paciente (cita_id, token_hash, expira_en)
     VALUES ($1, $2, $3)`,
    [citaId, resumen, cita["inicio"]]
  );

  enlacesEnMemoria.set(citaId, token);
  return token;
}

/**
 * Tokens emitidos en esta ejecución del proceso.
 *
 * Solo evita emitir un token nuevo por cada uno de los tres recordatorios
 * de la misma cita. Si el servidor se reinicia se emite uno nuevo, lo cual
 * es correcto: los enlaces anteriores siguen siendo válidos hasta la hora
 * de la cita.
 */
const enlacesEnMemoria = new Map<number, string>();

/** Resuelve la cita a partir del token del enlace. */
async function citaDeToken(token: string) {
  return consultarUna(
    `SELECT
       rp.id                                            AS respuesta_id,
       c.id                                             AS cita_id,
       c.estado,
       c.inicio,
       c.fin,
       c.paciente_id,
       c.medico_id,
       rp.expira_en,
       p.nombres                                        AS paciente,
       to_char(c.inicio AT TIME ZONE $2, 'DD/MM/YYYY')  AS fecha,
       to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')     AS hora,
       'Dr(a). ' || m.nombres || ' ' || m.apellidos     AS medico,
       m.especialidad
     FROM respuesta_paciente rp
     JOIN cita c     ON c.id = rp.cita_id
     JOIN paciente p ON p.id = c.paciente_id
     JOIN medico m   ON m.id = c.medico_id
     WHERE rp.token_hash = $1`,
    [resumir(token), ZONA]
  );
}

/** Reconstruye la entidad de dominio para que ella valide las transiciones. */
function comoCita(fila: Record<string, unknown>): Cita {
  return new Cita({
    id: Number(fila["cita_id"]),
    pacienteId: Number(fila["paciente_id"]),
    medicoId: Number(fila["medico_id"]),
    inicio: new Date(fila["inicio"] as string),
    fin: new Date(fila["fin"] as string),
    estado: fila["estado"] as never,
  });
}

/** Registra la acción del paciente sobre su enlace. */
async function anotarRespuesta(
  respuestaId: number,
  accion: string,
  req: express.Request
): Promise<void> {
  await pool.query(
    `UPDATE respuesta_paciente
     SET accion = $2::accion_respuesta, respondido_en = now(),
         ip = $3::inet, user_agent = $4
     WHERE id = $1`,
    [respuestaId, accion, ipDe(req), (req.header("user-agent") ?? "").slice(0, 300)]
  );
}

// =====================================================================
// CONSULTAR LA CITA
// =====================================================================

publico.get(
  "/cita/:token",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));

    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    const vencido = new Date(fila["expira_en"]).getTime() <= Date.now();
    const estado = String(fila["estado"]);
    const activa = estado === "PROGRAMADA" || estado === "CONFIRMADA";

    res.json({
      estado,
      paciente: fila["paciente"],
      fecha: fila["fecha"],
      hora: fila["hora"],
      medico: fila["medico"],
      especialidad: fila["especialidad"],
      vencido,
      puede_confirmar: activa && !vencido && estado === "PROGRAMADA",
      puede_reprogramar: activa && !vencido,
      puede_cancelar: activa && !vencido,
    });
  })
);

// =====================================================================
// CONFIRMAR
// =====================================================================

publico.post(
  "/cita/:token/confirmar",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));
    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    const cita = comoCita(fila);
    try {
      cita.confirmar(reloj);
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    await enTransaccion(async (cliente) => {
      await cliente.query(`UPDATE cita SET estado = 'CONFIRMADA' WHERE id = $1`, [
        cita.id,
      ]);
      // Confirmar silencia los avisos previos pero conserva el del mismo día.
      await cliente.query(
        `UPDATE recordatorio SET estado = 'SUSPENDIDO'
         WHERE cita_id = $1 AND estado = 'PROGRAMADO'
           AND hito = ANY($2::hito_recordatorio[])`,
        [cita.id, politica.hitosASuspenderTrasConfirmar()]
      );
    });

    await anotarRespuesta(Number(fila["respuesta_id"]), "CONFIRMAR", req);
    res.json({ estado: "CONFIRMADA" });
  })
);

// =====================================================================
// CANCELAR
// =====================================================================

publico.post(
  "/cita/:token/cancelar",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));
    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    const motivo = String((req.body as { motivo?: string })?.motivo ?? "").trim();
    const cita = comoCita(fila);

    try {
      cita.cancelar(reloj, motivo || "Cancelación desde el enlace", "PACIENTE");
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    await enTransaccion(async (cliente) => {
      await cliente.query(
        `UPDATE cita
         SET estado = 'CANCELADA', cancelada_en = now(),
             motivo_cancelacion = $2, origen_cancelacion = 'PACIENTE',
             antelacion_horas = $3
         WHERE id = $1`,
        [cita.id, cita.motivoCancelacion, cita.antelacionHoras]
      );
      // Cancelar apaga la secuencia completa.
      await cliente.query(
        `UPDATE recordatorio SET estado = 'SUSPENDIDO'
         WHERE cita_id = $1 AND estado = 'PROGRAMADO'`,
        [cita.id]
      );
    });

    await anotarRespuesta(Number(fila["respuesta_id"]), "CANCELAR", req);

    res.json({
      estado: "CANCELADA",
      antelacion_horas: cita.antelacionHoras,
      cupo_reasignable: cita.cupoEsReasignable(),
    });
  })
);

// =====================================================================
// REPROGRAMAR
// =====================================================================

/** Horarios libres del mismo médico en los próximos quince días (RF-19). */
publico.get(
  "/cita/:token/cupos",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));
    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    const filas = await consultar(
      `WITH dias AS (
         SELECT d::date AS fecha
         FROM generate_series(
                (now() AT TIME ZONE $2)::date + 1,
                (now() AT TIME ZONE $2)::date + $3::int,
                INTERVAL '1 day') AS d
       ),
       rejilla AS (
         SELECT dd.fecha, gs AS inicio
         FROM dias dd
         JOIN horario_atencion h
           ON h.medico_id = $1 AND h.activo
          AND h.dia_semana = extract(isodow FROM dd.fecha)
         CROSS JOIN LATERAL generate_series(
           ((dd.fecha + h.hora_inicio) AT TIME ZONE $2),
           ((dd.fecha + h.hora_fin)    AT TIME ZONE $2)
             - (h.duracion_min * INTERVAL '1 minute'),
           (h.duracion_min * INTERVAL '1 minute')
         ) AS gs
       )
       SELECT to_char(r.fecha, 'YYYY-MM-DD')                  AS fecha,
              to_char(r.fecha, 'DD/MM')                       AS fecha_corta,
              to_char(r.inicio AT TIME ZONE $2, 'HH24:MI')    AS hora,
              r.inicio
       FROM rejilla r
       WHERE r.inicio > now()
         AND NOT EXISTS (
               SELECT 1 FROM cita c
               WHERE c.medico_id = $1
                 AND c.estado NOT IN ('CANCELADA','REPROGRAMADA')
                 AND c.inicio = r.inicio)
         AND NOT EXISTS (
               SELECT 1 FROM excepcion_agenda e
               WHERE e.medico_id = $1 AND e.fecha = r.fecha AND e.todo_el_dia)
       ORDER BY r.inicio
       LIMIT 120`,
      [Number(fila["medico_id"]), ZONA, DIAS_REPROGRAMACION]
    );

    res.json({ medico: fila["medico"], cupos: filas });
  })
);

publico.post(
  "/cita/:token/reprogramar",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));
    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    const inicio = String((req.body as { inicio?: string })?.inicio ?? "");
    if (!inicio) {
      res.status(400).json({ error: "Elegí un horario." });
      return;
    }

    const cita = comoCita(fila);
    try {
      cita.reprogramar(reloj);
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    try {
      const nueva = await enTransaccion(async (cliente) => {
        // La cita original pasa a REPROGRAMADA y libera el cupo.
        await cliente.query(
          `UPDATE cita
           SET estado = 'REPROGRAMADA', cancelada_en = now(), antelacion_horas = $2
           WHERE id = $1`,
          [cita.id, cita.antelacionHoras]
        );
        await cliente.query(
          `UPDATE recordatorio SET estado = 'SUSPENDIDO'
           WHERE cita_id = $1 AND estado = 'PROGRAMADO'`,
          [cita.id]
        );

        // La cita nueva conserva el vínculo con la original: es lo que mide
        // la Ficha técnica N.° 13 (tiempo de reprogramación).
        const { rows } = await cliente.query(
          `INSERT INTO cita (paciente_id, medico_id, inicio, fin, tipo, origen,
                             cita_origen_id, creado_por)
           VALUES ($1, $2, $3::timestamptz,
                   $3::timestamptz + INTERVAL '20 minutes',
                   'CONTINUADOR', 'PACIENTE', $4, NULL)
           RETURNING id, inicio, fin`,
          [cita.pacienteId, cita.medicoId, inicio, cita.id]
        );

        const creada = rows[0]!;
        const entidad = new Cita({
          id: Number(creada["id"]),
          pacienteId: cita.pacienteId,
          medicoId: cita.medicoId,
          inicio: new Date(creada["inicio"]),
          fin: new Date(creada["fin"]),
        });

        // El dominio decide la secuencia de recordatorios de la cita nueva.
        for (const envio of politica.calcularEnvios(entidad, reloj)) {
          await cliente.query(
            `INSERT INTO recordatorio
               (cita_id, hito, canal, clave_idempotencia, programado_para, plantilla)
             VALUES ($1, $2::hito_recordatorio, $3::canal_contacto, $4, $5, 'recordatorio_cita_v1')
             ON CONFLICT (clave_idempotencia) DO NOTHING`,
            [
              envio.citaId,
              envio.hito,
              envio.canal,
              envio.claveIdempotencia,
              envio.programadoPara,
            ]
          );
        }

        return Number(creada["id"]);
      });

      await anotarRespuesta(Number(fila["respuesta_id"]), "REPROGRAMAR", req);

      const detalle = await consultarUna(
        `SELECT to_char(inicio AT TIME ZONE $2, 'DD/MM/YYYY') AS fecha,
                to_char(inicio AT TIME ZONE $2, 'HH24:MI')    AS hora
         FROM cita WHERE id = $1`,
        [nueva, ZONA]
      );

      res.json({ estado: "REPROGRAMADA", nueva_cita: nueva, ...detalle });
    } catch (error) {
      const err = error as { code?: string; constraint?: string };
      if (err.code === "23P01" || err.constraint === "ex_cita_sin_solape") {
        res.status(409).json({
          error: "Ese horario acaba de ser tomado. Elegí otro, por favor.",
        });
        return;
      }
      throw error;
    }
  })
);

// =====================================================================
// BAJA DE RECORDATORIOS  (Ley N.° 29733 · derecho de revocación)
// =====================================================================

publico.post(
  "/cita/:token/baja",
  ruta(async (req, res) => {
    const fila = await citaDeToken(String(req.params["token"]));
    if (!fila) {
      res.status(404).json({ error: "Este enlace no es válido." });
      return;
    }

    await enTransaccion(async (cliente) => {
      await cliente.query(
        `UPDATE consentimiento SET revocado_en = now()
         WHERE paciente_id = $1
           AND finalidad = 'CONTACTO_RECORDATORIOS'
           AND revocado_en IS NULL`,
        [Number(fila["paciente_id"])]
      );
      // La baja apaga todos los avisos pendientes del paciente, no solo los
      // de esta cita.
      await cliente.query(
        `UPDATE recordatorio r SET estado = 'SUSPENDIDO'
         FROM cita c
         WHERE r.cita_id = c.id
           AND c.paciente_id = $1
           AND r.estado = 'PROGRAMADO'`,
        [Number(fila["paciente_id"])]
      );
    });

    await anotarRespuesta(Number(fila["respuesta_id"]), "BAJA", req);
    res.json({ ok: true });
  })
);
