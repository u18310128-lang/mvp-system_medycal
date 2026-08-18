import { consultar, consultarUna, enTransaccion } from "../db/pool.js";
import type pg from "pg";
import { Cita, ReglaDeNegocioViolada, TransicionInvalida } from "../../domain/Cita.js";
import type { Reloj } from "../../domain/Reloj.js";
import { PoliticaRecordatorios } from "../../domain/PoliticaRecordatorios.js";
import { ZONA_CONSULTORIO } from "../../domain/SolicitudAgente.js";
import { registrarCitaEn, HorarioOcupado } from "./registrarCita.js";

/**
 * Gestiones del paciente sobre una cita que ya existe.
 *
 * Las tres comparten una comprobación que no puede saltearse: la cita tiene
 * que ser suya. El identificador lo propone el modelo a partir de lo que el
 * paciente escribió, así que verificarlo del lado del tool no alcanzaría —
 * se comprueba acá, contra el dato persistido, dentro de la misma
 * transacción que hace el cambio.
 *
 * Las reglas de cuándo se puede cancelar, confirmar o reprogramar ya viven
 * en `Cita`. Este módulo no las reimplementa: carga la entidad, le pide la
 * transición y traduce el resultado a filas.
 */

export interface CitaDelPaciente {
  readonly id: number;
  readonly fecha: string;
  readonly hora: string;
  readonly medico: string;
  readonly especialidad: string;
  readonly estado: string;
  readonly inicio: string;
}

export type ResultadoGestion =
  | {
      readonly estado: "HECHA";
      readonly citaId: number;
      readonly fecha: string;
      readonly hora: string;
      readonly medico: string;
    }
  | { readonly estado: "NO_ES_TUYA" }
  /** La cita existe y es suya, pero el dominio no permite la transición. */
  | { readonly estado: "NO_CORRESPONDE"; readonly motivo: string };

export type ResultadoReprogramacion =
  | {
      readonly estado: "HECHA";
      readonly citaId: number;
      readonly citaAnteriorId: number;
      readonly fecha: string;
      readonly hora: string;
      readonly medico: string;
    }
  | { readonly estado: "NO_ES_TUYA" }
  | { readonly estado: "NO_CORRESPONDE"; readonly motivo: string }
  | { readonly estado: "OCUPADO" };

// =====================================================================
// Consulta
// =====================================================================

/**
 * Próximas citas del paciente.
 *
 * Solo las que siguen vigentes: mostrarle las canceladas o las que ya pasó
 * lo obligaría a descartarlas él, y no hay nada que pueda gestionar sobre
 * ellas. Es la lista con la que después elige cuál cancelar o mover.
 */
export async function citasDelPaciente(
  pacienteId: number,
  zona: string = ZONA_CONSULTORIO
): Promise<readonly CitaDelPaciente[]> {
  const filas = await consultar<{
    id: string;
    fecha: string;
    hora: string;
    medico: string;
    especialidad: string;
    estado: string;
    inicio: Date;
  }>(
    `SELECT c.id,
            to_char(c.inicio AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
            to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')    AS hora,
            'Dr(a). ' || m.nombres || ' ' || m.apellidos    AS medico,
            m.especialidad,
            c.estado,
            c.inicio
     FROM cita c
     JOIN medico m ON m.id = c.medico_id
     WHERE c.paciente_id = $1
       AND c.estado IN ('PROGRAMADA', 'CONFIRMADA')
       AND c.inicio > now()
     ORDER BY c.inicio
     LIMIT 10`,
    [pacienteId, zona]
  );

  return filas.map((f) => ({
    id: Number(f.id),
    fecha: f.fecha,
    hora: f.hora,
    medico: f.medico,
    especialidad: f.especialidad,
    estado: f.estado,
    inicio: new Date(f.inicio).toISOString(),
  }));
}

// =====================================================================
// Cancelar
// =====================================================================

export async function cancelarCita(
  pacienteId: number,
  citaId: number,
  motivo: string,
  reloj: Reloj,
  politica: PoliticaRecordatorios,
  zona: string = ZONA_CONSULTORIO
): Promise<ResultadoGestion> {
  return enTransaccion(async (cliente) => {
    const cargada = await cargar(cliente, citaId, pacienteId, zona);
    if (cargada === null) return { estado: "NO_ES_TUYA" };

    try {
      cargada.cita.cancelar(reloj, motivo, "PACIENTE");
    } catch (error) {
      return noCorresponde(error);
    }

    await cliente.query(
      `UPDATE cita
       SET estado = 'CANCELADA', cancelada_en = now(),
           motivo_cancelacion = $2, origen_cancelacion = 'PACIENTE',
           antelacion_horas = $3
       WHERE id = $1`,
      [citaId, motivo, cargada.cita.antelacionHoras]
    );

    // Cancelar suspende la secuencia completa: ya no hay a qué recordar.
    await cliente.query(
      `UPDATE recordatorio SET estado = 'SUSPENDIDO'
       WHERE cita_id = $1 AND estado = 'PROGRAMADO'
         AND hito = ANY($2::hito_recordatorio[])`,
      [citaId, politica.hitosASuspenderTrasCancelar()]
    );

    await registrarRespuesta(cliente, citaId, "CANCELAR");

    return hecha(citaId, cargada);
  });
}

// =====================================================================
// Confirmar
// =====================================================================

export async function confirmarCita(
  pacienteId: number,
  citaId: number,
  reloj: Reloj,
  politica: PoliticaRecordatorios,
  zona: string = ZONA_CONSULTORIO
): Promise<ResultadoGestion> {
  return enTransaccion(async (cliente) => {
    const cargada = await cargar(cliente, citaId, pacienteId, zona);
    if (cargada === null) return { estado: "NO_ES_TUYA" };

    try {
      cargada.cita.confirmar(reloj);
    } catch (error) {
      return noCorresponde(error);
    }

    await cliente.query(`UPDATE cita SET estado = 'CONFIRMADA' WHERE id = $1`, [
      citaId,
    ]);

    // Se conserva el recordatorio del mismo día: al confirmar deja de pedir
    // confirmación y pasa a evitar el olvido.
    await cliente.query(
      `UPDATE recordatorio SET estado = 'SUSPENDIDO'
       WHERE cita_id = $1 AND estado = 'PROGRAMADO'
         AND hito = ANY($2::hito_recordatorio[])`,
      [citaId, politica.hitosASuspenderTrasConfirmar()]
    );

    // Alimenta el porcentaje de confirmación del panel de indicadores, que
    // hasta ahora solo se movía con el enlace único o con recepción.
    await registrarRespuesta(cliente, citaId, "CONFIRMAR");

    return hecha(citaId, cargada);
  });
}

// =====================================================================
// Reprogramar
// =====================================================================

/**
 * Mueve la cita a otro horario.
 *
 * Las dos operaciones van en una sola transacción. Si se hicieran por
 * separado y fallara la segunda, el paciente quedaría sin la cita vieja y
 * sin la nueva; y como liberar el cupo anterior es lo que a veces permite
 * tomar el nuevo, tampoco pueden ir en el orden inverso.
 *
 * La cita anterior queda REPROGRAMADA y la nueva apunta a ella con
 * `cita_origen_id`: esa cadena es la que mide la Ficha técnica N.° 13.
 */
export async function reprogramarCita(
  pacienteId: number,
  citaId: number,
  nuevoMedicoId: number,
  nuevoInicio: string,
  reloj: Reloj,
  politica: PoliticaRecordatorios,
  zona: string = ZONA_CONSULTORIO
): Promise<ResultadoReprogramacion> {
  try {
    return await enTransaccion(async (cliente) => {
      const cargada = await cargar(cliente, citaId, pacienteId, zona);
      if (cargada === null) return { estado: "NO_ES_TUYA" };

      try {
        cargada.cita.reprogramar(reloj);
      } catch (error) {
        return noCorresponde(error);
      }

      await cliente.query(
        `UPDATE cita
         SET estado = 'REPROGRAMADA', cancelada_en = now(),
             antelacion_horas = $2
         WHERE id = $1`,
        [citaId, cargada.cita.antelacionHoras]
      );

      await cliente.query(
        `UPDATE recordatorio SET estado = 'SUSPENDIDO'
         WHERE cita_id = $1 AND estado = 'PROGRAMADO'`,
        [citaId]
      );

      await registrarRespuesta(cliente, citaId, "REPROGRAMAR");

      const nueva = await registrarCitaEn(
        cliente,
        {
          pacienteId,
          medicoId: nuevoMedicoId,
          inicio: nuevoInicio,
          origen: "AGENTE",
          tipo: "AUTO",
          creadoPor: null,
          citaOrigenId: citaId,
        },
        reloj,
        politica
      );

      const datos = await cliente.query<{
        fecha: string;
        hora: string;
        medico: string;
      }>(
        `SELECT to_char(c.inicio AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
                to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')    AS hora,
                'Dr(a). ' || m.nombres || ' ' || m.apellidos    AS medico
         FROM cita c JOIN medico m ON m.id = c.medico_id
         WHERE c.id = $1`,
        [nueva.id, zona]
      );

      const fila = datos.rows[0];

      return {
        estado: "HECHA",
        citaId: nueva.id,
        citaAnteriorId: citaId,
        fecha: fila?.fecha ?? "",
        hora: fila?.hora ?? "",
        medico: fila?.medico ?? "",
      };
    });
  } catch (error) {
    // Alguien tomó el horario nuevo mientras se hacía el cambio. La
    // transacción se deshizo entera: la cita original sigue en pie.
    if (error instanceof HorarioOcupado) return { estado: "OCUPADO" };
    throw error;
  }
}

// =====================================================================
// Auxiliares
// =====================================================================

interface CitaCargada {
  readonly cita: Cita;
  readonly fecha: string;
  readonly hora: string;
  readonly medico: string;
}

/**
 * Carga la cita y comprueba que sea del paciente que escribe.
 *
 * Devuelve null tanto si no existe como si es de otra persona, y es a
 * propósito: distinguir ambos casos permitiría averiguar qué citas tiene
 * otro paciente probando identificadores.
 */
async function cargar(
  cliente: pg.PoolClient,
  citaId: number,
  pacienteId: number,
  zona: string
): Promise<CitaCargada | null> {
  if (!Number.isInteger(citaId) || citaId <= 0) return null;

  const { rows } = await cliente.query<{
    id: string;
    paciente_id: string;
    medico_id: string;
    inicio: Date;
    fin: Date;
    estado: string;
    cita_origen_id: string | null;
    fecha: string;
    hora: string;
    medico: string;
  }>(
    `SELECT c.id, c.paciente_id, c.medico_id, c.inicio, c.fin, c.estado,
            c.cita_origen_id,
            to_char(c.inicio AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
            to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')    AS hora,
            'Dr(a). ' || m.nombres || ' ' || m.apellidos    AS medico
     FROM cita c JOIN medico m ON m.id = c.medico_id
     WHERE c.id = $1
     FOR UPDATE OF c`,
    [citaId, zona]
  );

  const fila = rows[0];
  if (fila === undefined) return null;
  if (Number(fila.paciente_id) !== pacienteId) return null;

  return {
    cita: new Cita({
      id: Number(fila.id),
      pacienteId: Number(fila.paciente_id),
      medicoId: Number(fila.medico_id),
      inicio: new Date(fila.inicio),
      fin: new Date(fila.fin),
      estado: fila.estado as "PROGRAMADA",
      citaOrigenId: fila.cita_origen_id === null ? null : Number(fila.cita_origen_id),
    }),
    fecha: fila.fecha,
    hora: fila.hora,
    medico: fila.medico,
  };
}

/** Traduce el rechazo del dominio a un resultado que el agente pueda decir. */
function noCorresponde(error: unknown): ResultadoGestion & { estado: "NO_CORRESPONDE" } {
  if (error instanceof ReglaDeNegocioViolada || error instanceof TransicionInvalida) {
    return { estado: "NO_CORRESPONDE", motivo: error.message };
  }
  throw error;
}

function hecha(
  citaId: number,
  cargada: CitaCargada
): ResultadoGestion & { estado: "HECHA" } {
  return {
    estado: "HECHA",
    citaId,
    fecha: cargada.fecha,
    hora: cargada.hora,
    medico: cargada.medico,
  };
}

/**
 * Deja constancia de que el paciente respondió, y por qué canal.
 *
 * `respuesta_paciente` estaba pensada para el enlace único del recordatorio,
 * donde el token identifica al paciente. Acá quien lo identifica es su
 * número de WhatsApp, así que se guarda un resumen sintético: el registro
 * de que respondió es el dato que importa para el indicador.
 */
async function registrarRespuesta(
  cliente: pg.PoolClient,
  citaId: number,
  accion: "CONFIRMAR" | "CANCELAR" | "REPROGRAMAR"
): Promise<void> {
  await cliente.query(
    // El identificador se castea en los dos usos. Sin el cast, el motor
    // deduce bigint por la columna y text por la concatenación, y rechaza
    // la consulta por tipos inconsistentes para el mismo parámetro.
    `INSERT INTO respuesta_paciente (cita_id, token_hash, accion, expira_en, respondido_en)
     VALUES ($1::bigint,
             encode(digest('agente-' || $1::bigint::text || '-' || clock_timestamp()::text,
                           'sha256'), 'hex'),
             $2::accion_respuesta, now(), now())`,
    [citaId, accion]
  );
}
