import type pg from "pg";
import { enTransaccion } from "../db/pool.js";
import { Cita } from "../../domain/Cita.js";
import type { Reloj } from "../../domain/Reloj.js";
import {
  PoliticaRecordatorios,
  type Canal,
  type NivelRiesgo,
} from "../../domain/PoliticaRecordatorios.js";

/**
 * Registro de una cita, con su secuencia de recordatorios.
 *
 * Vive acá y no dentro de una ruta porque ahora hay dos caminos que crean
 * citas —recepción y el agente conversacional— y tienen que comportarse
 * igual. Si cada uno armara su propio INSERT, tarde o temprano uno
 * programaría los recordatorios y el otro no, o uno respetaría la duración
 * del bloque de atención y el otro asumiría veinte minutos. Lo único que
 * cambia entre ambos es el origen y quién quedó registrado como autor.
 */

/** Duración de un cupo cuando el médico no tiene bloque cargado ese día. */
const DURACION_POR_DEFECTO_MIN = 20;

export type OrigenCita = "RECEPCION" | "PACIENTE" | "AGENTE" | "LISTA_ESPERA";

/**
 * `AUTO` deduce si es primera vez mirando el historial del paciente.
 * Recepción no lo usa: su formulario ya pregunta el tipo, y cambiarle el
 * valor por omisión alteraría datos que la investigación ya está midiendo.
 */
export type TipoCita = "PRIMERA_VEZ" | "CONTINUADOR" | "AUTO";

export interface DatosRegistro {
  readonly pacienteId: number;
  readonly medicoId: number;
  /** Instante de inicio, en ISO con zona. */
  readonly inicio: string;
  readonly origen: OrigenCita;
  readonly tipo?: TipoCita | null | undefined;
  readonly registroSeg?: number | null | undefined;
  /** Usuario que la registró. Nulo cuando la creó el agente. */
  readonly creadoPor?: number | null | undefined;
  readonly citaOrigenId?: number | null | undefined;
}

export interface CitaRegistrada {
  readonly id: number;
  readonly inicio: Date;
  readonly fin: Date;
  readonly tipo: string;
  readonly recordatorios: number;
}

/** El horario ya está tomado. Lo decide la restricción de exclusión. */
export class HorarioOcupado extends Error {
  constructor() {
    super("Ese horario ya está ocupado para el médico seleccionado.");
    this.name = "HorarioOcupado";
  }
}

export async function registrarCita(
  datos: DatosRegistro,
  reloj: Reloj,
  politica: PoliticaRecordatorios
): Promise<CitaRegistrada> {
  return enTransaccion((cliente) => registrarCitaEn(cliente, datos, reloj, politica));
}

/**
 * Igual que `registrarCita`, dentro de una transacción que abrió otro.
 *
 * Reprogramar necesita liberar el cupo viejo y tomar el nuevo sin que
 * quede un instante en que el paciente no tenga ninguno de los dos, y eso
 * exige que ambas operaciones compartan la misma transacción.
 */
export async function registrarCitaEn(
  cliente: pg.PoolClient,
  datos: DatosRegistro,
  reloj: Reloj,
  politica: PoliticaRecordatorios
): Promise<CitaRegistrada> {
  try {
    {
      const duracion = await duracionDelCupo(cliente, datos.medicoId, datos.inicio);
      const tipo = await resolverTipo(cliente, datos);

      const { rows } = await cliente.query<{
        id: string;
        inicio: Date;
        fin: Date;
        tipo: string;
      }>(
        `INSERT INTO cita (paciente_id, medico_id, inicio, fin, tipo, origen,
                           registro_seg, creado_por, cita_origen_id)
         VALUES ($1, $2, $3::timestamptz,
                 $3::timestamptz + ($4 * INTERVAL '1 minute'),
                 $5::tipo_cita, $6::origen_cita, $7, $8, $9)
         RETURNING id, inicio, fin, tipo`,
        [
          datos.pacienteId,
          datos.medicoId,
          datos.inicio,
          duracion,
          tipo,
          datos.origen,
          datos.registroSeg ?? null,
          datos.creadoPor ?? null,
          datos.citaOrigenId ?? null,
        ]
      );

      const fila = rows[0]!;
      const id = Number(fila.id);

      // El dominio decide qué recordatorios corresponden y cuándo.
      const cita = new Cita({
        id,
        pacienteId: datos.pacienteId,
        medicoId: datos.medicoId,
        inicio: new Date(fila.inicio),
        fin: new Date(fila.fin),
      });

      const preferencias = await cliente.query<{
        canal_pref: Canal;
        riesgo: NivelRiesgo;
      }>(`SELECT canal_pref, riesgo FROM paciente WHERE id = $1`, [
        datos.pacienteId,
      ]);

      const envios = politica.calcularEnvios(cita, reloj, {
        canalPreferido: preferencias.rows[0]?.canal_pref ?? "WHATSAPP",
        riesgo: preferencias.rows[0]?.riesgo ?? "BAJO",
      });

      for (const envio of envios) {
        await cliente.query(
          `INSERT INTO recordatorio
             (cita_id, hito, canal, clave_idempotencia, programado_para, plantilla)
           VALUES ($1, $2::hito_recordatorio, $3::canal_contacto, $4, $5,
                   'recordatorio_cita_v1')
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

      return {
        id,
        inicio: new Date(fila.inicio),
        fin: new Date(fila.fin),
        tipo: fila.tipo,
        recordatorios: envios.length,
      };
    }
  } catch (error) {
    const err = error as { code?: string; constraint?: string };
    if (err.code === "23P01" || err.constraint === "ex_cita_sin_solape") {
      throw new HorarioOcupado();
    }
    throw error;
  }
}

/**
 * Duración del cupo según el bloque de atención del médico ese día.
 *
 * No todos los profesionales atienden en tramos de veinte minutos, y dar
 * por sentado que sí desalinearía la rejilla de cupos con las citas reales.
 */
async function duracionDelCupo(
  cliente: pg.PoolClient,
  medicoId: number,
  inicio: string
): Promise<number> {
  const { rows } = await cliente.query<{ duracion_min: number }>(
    `SELECT h.duracion_min
     FROM horario_atencion h
     WHERE h.medico_id = $1
       AND h.activo
       AND h.dia_semana = extract(isodow FROM ($2::timestamptz AT TIME ZONE 'America/Lima'))
       AND ($2::timestamptz AT TIME ZONE 'America/Lima')::time >= h.hora_inicio
       AND ($2::timestamptz AT TIME ZONE 'America/Lima')::time <  h.hora_fin
     LIMIT 1`,
    [medicoId, inicio]
  );

  return rows[0]?.duracion_min ?? DURACION_POR_DEFECTO_MIN;
}

/** Resuelve el tipo de cita, deduciéndolo solo cuando se pide `AUTO`. */
async function resolverTipo(
  cliente: pg.PoolClient,
  datos: DatosRegistro
): Promise<"PRIMERA_VEZ" | "CONTINUADOR"> {
  if (datos.tipo === "PRIMERA_VEZ" || datos.tipo === "CONTINUADOR") {
    return datos.tipo;
  }
  if (datos.tipo !== "AUTO") return "CONTINUADOR";

  const { rows } = await cliente.query<{ atendida: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM cita
       WHERE paciente_id = $1 AND estado = 'ATENDIDA'
     ) AS atendida`,
    [datos.pacienteId]
  );

  return rows[0]?.atendida === true ? "CONTINUADOR" : "PRIMERA_VEZ";
}
