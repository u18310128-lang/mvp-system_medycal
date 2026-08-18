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
import { AgendaPostgres } from "./AgendaPostgres.js";

/**
 * La agenda vista a través de la API de interoperabilidad.
 *
 * El agente podría leer la base directamente —está en el mismo proceso—,
 * y aun así consulta por HTTP. La razón es de diseño, no de comodidad: es
 * la frontera que permite reemplazar el sistema de citas por otro sin
 * tocar el agente, que es lo que se busca demostrar. Si el agente
 * conociera el esquema de tablas, esa afirmación sería falsa.
 *
 * El costo de esa frontera es una llamada de red por consulta. Como es
 * medible, conviene medirlo: `AGENTE_AGENDA=directo` usa el acceso en
 * proceso y permite comparar ambas latencias sobre el mismo escenario.
 */

const TIEMPO_MAXIMO_MS = 10_000;

export class AgendaHttp implements Agenda {
  constructor(
    private readonly base: string,
    private readonly claveServicio: string
  ) {}

  async especialidades(): Promise<readonly string[]> {
    const datos = await this.pedir<{ especialidades: string[] }>(
      "/api/agente/especialidades"
    );
    return datos.especialidades;
  }

  async disponibilidad(
    consulta: ConsultaDisponibilidad
  ): Promise<readonly CupoDisponible[]> {
    const parametros = new URLSearchParams({
      especialidad: consulta.especialidad,
      fecha: consulta.fecha,
      franja: consulta.franja,
    });
    if (consulta.limite !== undefined) {
      parametros.set("limite", String(consulta.limite));
    }

    const datos = await this.pedir<{ cupos: CupoDisponible[] }>(
      `/api/agente/disponibilidad?${parametros.toString()}`
    );
    return datos.cupos;
  }

  async agendar(pedido: PedidoAgendamiento): Promise<ResultadoAgendamiento> {
    return this.pedir<ResultadoAgendamiento>("/api/agente/citas", {
      paciente_id: pedido.pacienteId,
      especialidad: pedido.especialidad,
      fecha: pedido.fecha,
      hora: pedido.hora,
      medico: pedido.medico ?? null,
    });
  }

  async citasDe(pacienteId: number): Promise<readonly CitaDelPaciente[]> {
    const datos = await this.pedir<{ citas: CitaDelPaciente[] }>(
      `/api/agente/citas?paciente_id=${encodeURIComponent(String(pacienteId))}`
    );
    return datos.citas;
  }

  async cancelar(
    pedido: PedidoGestion & { motivo: string }
  ): Promise<ResultadoGestionCita> {
    return this.pedir<ResultadoGestionCita>(
      `/api/agente/citas/${pedido.citaId}/cancelar`,
      { paciente_id: pedido.pacienteId, motivo: pedido.motivo }
    );
  }

  async confirmar(pedido: PedidoGestion): Promise<ResultadoGestionCita> {
    return this.pedir<ResultadoGestionCita>(
      `/api/agente/citas/${pedido.citaId}/confirmar`,
      { paciente_id: pedido.pacienteId }
    );
  }

  async reprogramar(
    pedido: PedidoReprogramacion
  ): Promise<ResultadoReprogramacionCita> {
    return this.pedir<ResultadoReprogramacionCita>(
      `/api/agente/citas/${pedido.citaId}/reprogramar`,
      {
        paciente_id: pedido.pacienteId,
        especialidad: pedido.especialidad,
        fecha: pedido.fecha,
        hora: pedido.hora,
        medico: pedido.medico ?? null,
      }
    );
  }

  private async pedir<T>(ruta: string, cuerpo?: unknown): Promise<T> {
    const respuesta = await fetch(`${this.base}${ruta}`, {
      method: cuerpo === undefined ? "GET" : "POST",
      headers: {
        "x-api-key": this.claveServicio,
        ...(cuerpo === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => "");
      throw new Error(
        `La API de citas respondió ${respuesta.status} en ${ruta}. ${detalle.slice(0, 200)}`
      );
    }

    return (await respuesta.json()) as T;
  }
}

/**
 * Elige cómo llega el agente a la agenda.
 *
 * Por omisión, a través de la API: es la configuración que corresponde al
 * diseño. `directo` existe para medir cuánto cuesta esa frontera.
 */
export function agendaSegunEntorno(): Agenda {
  if (process.env["AGENTE_AGENDA"] === "directo") {
    return new AgendaPostgres();
  }

  const base = process.env["AGENTE_API_URL"] ?? "http://localhost:3000";
  const clave = process.env["CLAVE_SERVICIO"] ?? "";
  return new AgendaHttp(base, clave);
}
