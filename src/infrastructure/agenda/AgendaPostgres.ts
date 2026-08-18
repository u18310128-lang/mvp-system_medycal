import { consultar } from "../db/pool.js";
import { ZONA_CONSULTORIO } from "../../domain/SolicitudAgente.js";
import { RelojSistema } from "../../domain/Reloj.js";
import { PoliticaRecordatorios } from "../../domain/PoliticaRecordatorios.js";
import { registrarCita, HorarioOcupado } from "../citas/registrarCita.js";
import {
  cancelarCita,
  citasDelPaciente,
  confirmarCita,
  reprogramarCita,
} from "../citas/gestionarCita.js";
import type {
  Agenda,
  CitaDelPaciente,
  ConsultaDisponibilidad,
  CupoDisponible,
  PedidoAgendamiento,
  PedidoGestion,
  PedidoReprogramacion,
  ResultadoAgendamiento,
  ResultadoGestionCita,
  ResultadoReprogramacionCita,
} from "../../application/puertos.js";

/**
 * Disponibilidad real leída de la base.
 *
 * Es la versión por especialidad de la consulta que ya usa `/api/cupos`,
 * con tres diferencias que el canal conversacional necesita:
 *
 * 1. Busca por especialidad y no por médico. El paciente pide «medicina
 *    general», no el identificador del doctor Pérez.
 *
 * 2. Excluye los cupos ya vencidos. Recepción puede registrar una cita a
 *    las 09:00 siendo las 11:00 —hay motivos administrativos para hacerlo—,
 *    pero ofrecerle ese horario a un paciente por WhatsApp no tiene sentido.
 *
 * 3. Tiene en cuenta las excepciones parciales de agenda. `/api/cupos` solo
 *    descarta los días bloqueados enteros y deja pasar los bloqueos de unas
 *    horas, que es la forma habitual de cargar una reunión o una guardia.
 */
export class AgendaPostgres implements Agenda {
  private readonly reloj = new RelojSistema();
  private readonly politica = new PoliticaRecordatorios();

  constructor(private readonly zona: string = ZONA_CONSULTORIO) {}

  /**
   * Registra la cita en el horario que el paciente eligió.
   *
   * El cupo se vuelve a buscar en la disponibilidad real en lugar de
   * confiar en la hora que llegó en el pedido. Entre que el agente ofreció
   * los horarios y el paciente contestó pueden pasar minutos, y en ese
   * intervalo recepción pudo tomar el mismo cupo. Volver a mirar convierte
   * ese caso en un mensaje claro y no en una cita imposible.
   */
  async agendar(pedido: PedidoAgendamiento): Promise<ResultadoAgendamiento> {
    const eleccion = await this.elegirCupo(
      pedido.especialidad,
      pedido.fecha,
      pedido.hora,
      pedido.medico
    );

    if (eleccion.estado !== "ELEGIDO") return eleccion;
    const elegido = eleccion.cupo;

    try {
      const creada = await registrarCita(
        {
          pacienteId: pedido.pacienteId,
          medicoId: elegido.medicoId,
          inicio: elegido.inicio,
          origen: "AGENTE",
          // El canal conversacional no le pregunta al paciente si es su
          // primera consulta: eso ya está en su historial.
          tipo: "AUTO",
          creadoPor: null,
        },
        this.reloj,
        this.politica
      );

      return {
        estado: "AGENDADA",
        citaId: creada.id,
        fecha: pedido.fecha,
        hora: elegido.hora,
        medico: elegido.medico,
        tipo: creada.tipo,
        recordatorios: creada.recordatorios,
      };
    } catch (error) {
      // La restricción de exclusión es la que decide de verdad: alguien pudo
      // tomar el cupo entre la consulta de arriba y este INSERT.
      if (error instanceof HorarioOcupado) return { estado: "OCUPADO" };
      throw error;
    }
  }

  async citasDe(pacienteId: number): Promise<readonly CitaDelPaciente[]> {
    const citas = await citasDelPaciente(pacienteId, this.zona);
    return citas.map((c) => ({
      id: c.id,
      fecha: c.fecha,
      hora: c.hora,
      medico: c.medico,
      especialidad: c.especialidad,
      estado: c.estado,
    }));
  }

  async cancelar(
    pedido: PedidoGestion & { motivo: string }
  ): Promise<ResultadoGestionCita> {
    return cancelarCita(
      pedido.pacienteId,
      pedido.citaId,
      pedido.motivo,
      this.reloj,
      this.politica,
      this.zona
    );
  }

  async confirmar(pedido: PedidoGestion): Promise<ResultadoGestionCita> {
    return confirmarCita(
      pedido.pacienteId,
      pedido.citaId,
      this.reloj,
      this.politica,
      this.zona
    );
  }

  /**
   * Reprogramar necesita saber a qué cupo se mueve, y eso se resuelve acá
   * —donde vive la disponibilidad— antes de abrir la transacción que hace
   * el cambio. Si el horario pedido no está libre, no se toca nada.
   */
  async reprogramar(
    pedido: PedidoReprogramacion
  ): Promise<ResultadoReprogramacionCita> {
    // La especialidad sale de la cita que se está moviendo. Esta lectura
    // exige que la cita sea del paciente, así que un identificador ajeno
    // no llega siquiera a consultar disponibilidad.
    const especialidad =
      pedido.especialidad ??
      (await especialidadDeLaCita(pedido.citaId, pedido.pacienteId));

    if (especialidad === null) return { estado: "NO_ES_TUYA" };

    const eleccion = await this.elegirCupo(
      especialidad,
      pedido.fecha,
      pedido.hora,
      pedido.medico
    );

    if (eleccion.estado !== "ELEGIDO") return eleccion;

    return reprogramarCita(
      pedido.pacienteId,
      pedido.citaId,
      eleccion.cupo.medicoId,
      eleccion.cupo.inicio,
      this.reloj,
      this.politica,
      this.zona
    );
  }

  /**
   * Encuentra el cupo concreto detrás de «el de las 15:20 con Quispe».
   *
   * Se busca contra la disponibilidad real y no contra lo que el agente
   * ofreció hace unos minutos, porque entre una cosa y la otra recepción
   * pudo tomar ese horario.
   */
  private async elegirCupo(
    especialidad: string,
    fecha: string,
    hora: string,
    medico: string | undefined
  ): Promise<
    | { estado: "ELEGIDO"; cupo: CupoDisponible }
    | { estado: "NO_DISPONIBLE" }
    | { estado: "AMBIGUO"; medicos: readonly string[] }
  > {
    const libres = await this.disponibilidad({
      especialidad,
      fecha,
      franja: "CUALQUIERA",
      limite: 100,
    });

    const aEsaHora = libres.filter((c) => c.hora === hora);
    if (aEsaHora.length === 0) return { estado: "NO_DISPONIBLE" };

    if (medico === undefined) {
      // Dos profesionales libres a la misma hora y el paciente no dijo
      // cuál: elegir por él sería decidir algo que no delegó.
      if (aEsaHora.length > 1) {
        return { estado: "AMBIGUO", medicos: aEsaHora.map((c) => c.medico) };
      }
      return { estado: "ELEGIDO", cupo: aEsaHora[0]! };
    }

    const elegido = aEsaHora.find((c) => coincideElNombre(c.medico, medico));
    return elegido === undefined
      ? { estado: "NO_DISPONIBLE" }
      : { estado: "ELEGIDO", cupo: elegido };
  }

  async especialidades(): Promise<readonly string[]> {
    const filas = await consultar<{ especialidad: string }>(
      `SELECT DISTINCT especialidad
       FROM medico
       WHERE activo
       ORDER BY especialidad`
    );
    return filas.map((f) => f.especialidad);
  }

  async disponibilidad(
    consulta: ConsultaDisponibilidad
  ): Promise<readonly CupoDisponible[]> {
    const filas = await consultar<{
      medico_id: string;
      medico: string;
      especialidad: string;
      hora: string;
      inicio: Date;
    }>(
      `WITH profesionales AS (
         SELECT id, nombres, apellidos, especialidad
         FROM medico
         WHERE activo AND lower(especialidad) = lower($1)
       ),
       rejilla AS (
         -- Un cupo por cada intervalo de atención del día pedido.
         SELECT p.id AS medico_id,
                'Dr(a). ' || p.nombres || ' ' || p.apellidos AS medico,
                p.especialidad,
                gs AS inicio,
                h.duracion_min,
                h.hora_inicio AS bloque_desde
         FROM profesionales p
         JOIN horario_atencion h
           ON h.medico_id = p.id
          AND h.activo
          AND h.dia_semana = extract(isodow FROM $2::date)
         CROSS JOIN LATERAL generate_series(
           (($2::date + h.hora_inicio) AT TIME ZONE $3),
           (($2::date + h.hora_fin)    AT TIME ZONE $3)
             - (h.duracion_min * INTERVAL '1 minute'),
           (h.duracion_min * INTERVAL '1 minute')
         ) AS gs
       )
       SELECT r.medico_id,
              r.medico,
              r.especialidad,
              to_char(r.inicio AT TIME ZONE $3, 'HH24:MI') AS hora,
              r.inicio
       FROM rejilla r
       WHERE
         -- El cupo no está tomado. Coincide con los estados que ocupan
         -- horario en el dominio: cancelar o reprogramar lo libera.
         NOT EXISTS (
           SELECT 1 FROM cita c
           WHERE c.medico_id = r.medico_id
             AND c.estado NOT IN ('CANCELADA', 'REPROGRAMADA')
             AND c.inicio = r.inicio)
         -- Día bloqueado por completo.
         AND NOT EXISTS (
           SELECT 1 FROM excepcion_agenda e
           WHERE e.medico_id = r.medico_id
             AND e.fecha = $2::date
             AND e.todo_el_dia)
         -- Bloqueo de unas horas: el cupo cae dentro del tramo excluido.
         AND NOT EXISTS (
           SELECT 1 FROM excepcion_agenda e
           WHERE e.medico_id = r.medico_id
             AND e.fecha = $2::date
             AND NOT e.todo_el_dia
             AND e.hora_inicio IS NOT NULL
             AND e.hora_fin IS NOT NULL
             AND (r.inicio AT TIME ZONE $3)::time >= e.hora_inicio
             AND (r.inicio AT TIME ZONE $3)::time <  e.hora_fin)
         -- Nunca se ofrece un horario que ya pasó.
         AND r.inicio > now()
         -- Franja pedida.
         --
         -- El turno lo define el bloque de atención del médico, no la hora
         -- del cupo. El bloque de mañana de este consultorio va de 08:00 a
         -- 13:00, así que un cupo de las 12:40 es de la mañana aunque un
         -- corte fijo al mediodía lo contaría como tarde. Quien pide «a la
         -- tarde porque salgo del trabajo» no quiere que le ofrezcan las 12.
         AND ($4 = 'CUALQUIERA'
              OR ($4 = 'MANANA' AND r.bloque_desde <  TIME '12:00')
              OR ($4 = 'TARDE'  AND r.bloque_desde >= TIME '12:00'))
       ORDER BY r.inicio, r.medico_id
       LIMIT $5`,
      [
        consulta.especialidad,
        consulta.fecha,
        this.zona,
        consulta.franja,
        consulta.limite ?? 20,
      ]
    );

    return filas.map((f) => ({
      medicoId: Number(f.medico_id),
      medico: f.medico,
      especialidad: f.especialidad,
      fecha: consulta.fecha,
      hora: f.hora,
      inicio: new Date(f.inicio).toISOString(),
    }));
  }
}

/** Especialidad de una cita, solo si pertenece a ese paciente. */
async function especialidadDeLaCita(
  citaId: number,
  pacienteId: number
): Promise<string | null> {
  const filas = await consultar<{ especialidad: string }>(
    `SELECT m.especialidad
     FROM cita c JOIN medico m ON m.id = c.medico_id
     WHERE c.id = $1 AND c.paciente_id = $2`,
    [citaId, pacienteId]
  );
  return filas[0]?.especialidad ?? null;
}

/**
 * ¿El nombre que dijo el paciente se refiere a este profesional?
 *
 * Nadie contesta «Dr(a). Ana Quispe»: contesta «con Quispe» o «la doctora
 * Ana». Alcanza con que alguna palabra del nombre real aparezca en lo que
 * dijo, ignorando tratamientos y tildes.
 */
function coincideElNombre(nombreReal: string, loQueDijo: string): boolean {
  const dicho = sinTratamiento(loQueDijo);
  if (dicho === "") return false;

  const partes = sinTratamiento(nombreReal)
    .split(/\s+/)
    .filter((p) => p.length > 2);

  return partes.some((parte) => dicho.includes(parte));
}

function sinTratamiento(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(dr|dra|doctor|doctora|el|la|con)\b\.?/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
