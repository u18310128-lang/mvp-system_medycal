import type {
  Agenda,
  CitaDelPaciente,
  ConsultaDisponibilidad,
  Conversaciones,
  CupoDisponible,
  Directorio,
  HiloConversacion,
  Llm,
  PacienteIdentificado,
  PedidoAgendamiento,
  PedidoGestion,
  PedidoReprogramacion,
  PeticionLlm,
  RespuestaLlm,
  ResultadoAgendamiento,
  ResultadoGestionCita,
  ResultadoReprogramacionCita,
  TurnoPrevio,
} from "../src/application/puertos.js";
import type { DatosSolicitud } from "../src/domain/SolicitudAgente.js";

/**
 * Dobles para la evaluación.
 *
 * La evaluación corre el canal **entero** —bucle, herramientas, permisos,
 * dominio— pero contra una agenda que no modifica nada. Es la única forma
 * de medir treinta y tantos mensajes muchas veces sin llenar la base de
 * citas de prueba ni alterar los indicadores de la investigación.
 *
 * Lo que se sustituye es solo el borde: el sistema de citas, el padrón y
 * el almacenamiento del hilo. Todo lo que se está evaluando queda intacto.
 */

/** Cupos que la agenda de evaluación ofrece siempre, para cualquier día. */
const CUPOS_FIJOS: readonly { hora: string; medicoId: number; medico: string }[] = [
  { hora: "09:00", medicoId: 1, medico: "Dr(a). Ana Quispe" },
  { hora: "09:20", medicoId: 1, medico: "Dr(a). Ana Quispe" },
  { hora: "15:00", medicoId: 1, medico: "Dr(a). Ana Quispe" },
  { hora: "15:20", medicoId: 1, medico: "Dr(a). Ana Quispe" },
  { hora: "15:40", medicoId: 2, medico: "Dr(a). José Torres" },
  { hora: "19:40", medicoId: 2, medico: "Dr(a). José Torres" },
];

export class AgendaDeEvaluacion implements Agenda {
  /** Todo lo que el agente intentó hacer, sin que nada haya ocurrido. */
  readonly intentos: { operacion: string; datos: unknown }[] = [];

  async especialidades(): Promise<readonly string[]> {
    return ["Medicina General"];
  }

  async disponibilidad(
    consulta: ConsultaDisponibilidad
  ): Promise<readonly CupoDisponible[]> {
    this.intentos.push({ operacion: "disponibilidad", datos: consulta });

    return CUPOS_FIJOS.filter((c) => {
      if (consulta.franja === "MANANA") return c.hora < "12:00";
      if (consulta.franja === "TARDE") return c.hora >= "12:00";
      return true;
    }).map((c) => ({
      medicoId: c.medicoId,
      medico: c.medico,
      especialidad: "Medicina General",
      fecha: consulta.fecha,
      hora: c.hora,
      inicio: `${consulta.fecha}T${c.hora}:00.000Z`,
    }));
  }

  async agendar(pedido: PedidoAgendamiento): Promise<ResultadoAgendamiento> {
    this.intentos.push({ operacion: "agendar", datos: pedido });

    const cupo = CUPOS_FIJOS.find((c) => c.hora === pedido.hora);
    if (cupo === undefined) return { estado: "NO_DISPONIBLE" };

    return {
      estado: "AGENDADA",
      citaId: 9001,
      fecha: pedido.fecha,
      hora: pedido.hora,
      medico: cupo.medico,
      tipo: "CONTINUADOR",
      recordatorios: 3,
    };
  }

  async citasDe(pacienteId: number): Promise<readonly CitaDelPaciente[]> {
    this.intentos.push({ operacion: "citasDe", datos: pacienteId });
    return [
      {
        id: 1,
        fecha: "2026-08-21",
        hora: "15:20",
        medico: "Dr(a). Ana Quispe",
        especialidad: "Medicina General",
        estado: "PROGRAMADA",
      },
    ];
  }

  async cancelar(
    pedido: PedidoGestion & { motivo: string }
  ): Promise<ResultadoGestionCita> {
    this.intentos.push({ operacion: "cancelar", datos: pedido });
    return {
      estado: "HECHA",
      citaId: pedido.citaId,
      fecha: "2026-08-21",
      hora: "15:20",
      medico: "Dr(a). Ana Quispe",
    };
  }

  async confirmar(pedido: PedidoGestion): Promise<ResultadoGestionCita> {
    this.intentos.push({ operacion: "confirmar", datos: pedido });
    return {
      estado: "HECHA",
      citaId: pedido.citaId,
      fecha: "2026-08-21",
      hora: "15:20",
      medico: "Dr(a). Ana Quispe",
    };
  }

  async reprogramar(
    pedido: PedidoReprogramacion
  ): Promise<ResultadoReprogramacionCita> {
    this.intentos.push({ operacion: "reprogramar", datos: pedido });
    return {
      estado: "HECHA",
      citaId: 9002,
      citaAnteriorId: pedido.citaId,
      fecha: pedido.fecha,
      hora: pedido.hora,
      medico: "Dr(a). Ana Quispe",
    };
  }
}

/** Padrón con un único paciente: el que escribe. */
export class DirectorioFijo implements Directorio {
  constructor(private readonly paciente: PacienteIdentificado | null) {}

  async porCelular(_celular: string): Promise<PacienteIdentificado | null> {
    return this.paciente;
  }
}

/**
 * Hilo en memoria, precargado con el estado previo del caso.
 *
 * Cada caso arranca con su propio contexto e historial, que es lo que
 * permite evaluar mensajes como «a las 3 de la tarde» —incomprensibles
 * aislados— sin tener que reproducir la conversación entera cada vez.
 */
export class ConversacionesEnMemoria implements Conversaciones {
  contextoGuardado: DatosSolicitud = {};

  constructor(
    private readonly contextoInicial: DatosSolicitud = {},
    private readonly historial: readonly TurnoPrevio[] = []
  ) {}

  async abrirOContinuar(
    _celular: string,
    pacienteId: number | null
  ): Promise<HiloConversacion> {
    return {
      id: 1,
      pacienteId,
      contexto: this.contextoInicial,
      historial: this.historial,
    };
  }

  async yaProcesado(_proveedorMsgId: string): Promise<boolean> {
    return false;
  }

  async registrarMensaje(): Promise<number> {
    return 1;
  }

  async guardarContexto(
    _conversacionId: number,
    contexto: DatosSolicitud
  ): Promise<void> {
    this.contextoGuardado = contexto;
  }

  async registrarTraza(): Promise<void> {
    // La evaluación arma su propia tabla; no toca traza_agente.
  }
}

/**
 * Envuelve un modelo para contar lo que consumió.
 *
 * Va por fuera del canal y no dentro, para que medir el costo no obligue a
 * que el bucle sepa nada de tokens ni de precios.
 */
export class LlmMedido implements Llm {
  llamadas = 0;
  tokensEntrada = 0;
  tokensSalida = 0;

  constructor(private readonly interno: Llm) {}

  async completar(peticion: PeticionLlm): Promise<RespuestaLlm> {
    this.llamadas++;
    const respuesta = await this.interno.completar(peticion);

    if (respuesta.tokens !== undefined) {
      this.tokensEntrada += respuesta.tokens.entrada;
      this.tokensSalida += respuesta.tokens.salida;
    }

    return respuesta;
  }
}
