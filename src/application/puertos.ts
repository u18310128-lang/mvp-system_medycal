import type { Franja, Intencion, DatosSolicitud } from "../domain/SolicitudAgente.js";

/**
 * Puertos del canal conversacional.
 *
 * Todo lo que el agente necesita del mundo exterior —el modelo de lenguaje,
 * la agenda del consultorio, el padrón de pacientes, el historial del hilo—
 * se declara acá como interfaz. Las implementaciones viven en
 * `src/infrastructure` y esta capa nunca las importa.
 *
 * No es purismo: es lo que permite ejecutar el agente completo contra un
 * modelo simulado y una agenda de prueba, y medir su comportamiento sin
 * gastar llamadas al proveedor ni depender de la red.
 */

// =====================================================================
// Modelo de lenguaje
// =====================================================================

export interface LlamadaHerramienta {
  /** Identificador que asigna el proveedor para aparear pedido y resultado. */
  readonly id: string;
  readonly nombre: string;
  readonly argumentos: Record<string, unknown>;
}

export type RolMensajeLlm = "sistema" | "paciente" | "agente" | "herramienta";

export interface MensajeLlm {
  readonly rol: RolMensajeLlm;
  readonly contenido: string;
  /** Herramientas que el modelo pidió ejecutar en este turno. */
  readonly llamadas?: readonly LlamadaHerramienta[] | undefined;
  /** Solo en `rol: "herramienta"`: a qué llamada responde este resultado. */
  readonly llamadaId?: string | undefined;
  readonly nombre?: string | undefined;
}

/** Declaración de una herramienta tal como se le ofrece al modelo. */
export interface DefinicionHerramienta {
  readonly nombre: string;
  readonly descripcion: string;
  /** JSON Schema de los argumentos. */
  readonly esquema: Record<string, unknown>;
}

export interface PeticionLlm {
  readonly mensajes: readonly MensajeLlm[];
  readonly herramientas: readonly DefinicionHerramienta[];
}

export interface RespuestaLlm {
  /** Texto para el paciente. Nulo cuando el modelo solo pidió herramientas. */
  readonly texto: string | null;
  readonly llamadas: readonly LlamadaHerramienta[];
  /** Qué modelo respondió. Se registra en la traza para poder comparar. */
  readonly modelo: string;
  /**
   * Consumo del proveedor, cuando lo informa.
   *
   * No lo usa el canal: sirve para estimar el costo por conversación al
   * comparar modelos, que es un criterio de elección tan real como la
   * exactitud cuando el consultorio tiene que pagarlo todos los meses.
   */
  readonly tokens?: { readonly entrada: number; readonly salida: number } | undefined;
}

export interface Llm {
  completar(peticion: PeticionLlm): Promise<RespuestaLlm>;
}

// =====================================================================
// Agenda del consultorio
// =====================================================================

export interface ConsultaDisponibilidad {
  readonly especialidad: string;
  readonly fecha: string;
  readonly franja: Franja;
  readonly limite?: number | undefined;
}

export interface CupoDisponible {
  readonly medicoId: number;
  readonly medico: string;
  readonly especialidad: string;
  readonly fecha: string;
  readonly hora: string;
  /** Instante exacto en ISO, que es lo que después se manda al agendar. */
  readonly inicio: string;
}

export interface PedidoAgendamiento {
  /**
   * Sale de la conversación, nunca de lo que diga el modelo.
   *
   * Es la diferencia entre un canal que agenda para quien escribe y uno al
   * que se le puede pedir, dentro del mensaje, que agende para otro.
   */
  readonly pacienteId: number;
  readonly especialidad: string;
  readonly fecha: string;
  /** Hora elegida, en HH:MM. Es lo que el paciente vio y respondió. */
  readonly hora: string;
  /** Nombre del profesional, cuando el paciente eligió uno. */
  readonly medico?: string | undefined;
}

/**
 * Desenlaces posibles al agendar.
 *
 * Se modelan como estados y no como excepciones porque el agente tiene que
 * decir algo distinto en cada caso: que quedó registrada, que ese horario
 * se ocupó recién, que hay dos profesionales a esa hora, o que la hora
 * pedida no era una de las ofrecidas.
 */
export type ResultadoAgendamiento =
  | {
      readonly estado: "AGENDADA";
      readonly citaId: number;
      readonly fecha: string;
      readonly hora: string;
      readonly medico: string;
      readonly tipo: string;
      readonly recordatorios: number;
    }
  | { readonly estado: "OCUPADO" }
  | { readonly estado: "NO_DISPONIBLE" }
  | { readonly estado: "AMBIGUO"; readonly medicos: readonly string[] };

export interface CitaDelPaciente {
  readonly id: number;
  readonly fecha: string;
  readonly hora: string;
  readonly medico: string;
  readonly especialidad: string;
  readonly estado: string;
}

/**
 * Desenlaces de una gestión sobre una cita existente.
 *
 * `NO_ES_TUYA` cubre también la cita inexistente. Son el mismo resultado a
 * propósito: separarlos permitiría descubrir qué citas tiene otra persona
 * probando identificadores.
 */
export type ResultadoGestionCita =
  | {
      readonly estado: "HECHA";
      readonly citaId: number;
      readonly fecha: string;
      readonly hora: string;
      readonly medico: string;
    }
  | { readonly estado: "NO_ES_TUYA" }
  /** El dominio no permite la transición: la hora ya pasó, o ya estaba cerrada. */
  | { readonly estado: "NO_CORRESPONDE"; readonly motivo: string };

export type ResultadoReprogramacionCita =
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
  | { readonly estado: "OCUPADO" }
  | { readonly estado: "NO_DISPONIBLE" }
  | { readonly estado: "AMBIGUO"; readonly medicos: readonly string[] };

export interface PedidoGestion {
  readonly pacienteId: number;
  readonly citaId: number;
}

export interface PedidoReprogramacion extends PedidoGestion {
  readonly fecha: string;
  readonly hora: string;
  readonly medico?: string | undefined;
  /**
   * Normalmente se omite: reprogramar mantiene la especialidad de la cita
   * que se mueve, y preguntársela de nuevo al paciente sería redundante.
   */
  readonly especialidad?: string | undefined;
}

export interface Agenda {
  disponibilidad(consulta: ConsultaDisponibilidad): Promise<readonly CupoDisponible[]>;
  /** Especialidades que el consultorio atiende. Acota lo que el agente ofrece. */
  especialidades(): Promise<readonly string[]>;
  agendar(pedido: PedidoAgendamiento): Promise<ResultadoAgendamiento>;
  /** Próximas citas vigentes del paciente. Es de donde sale el identificador. */
  citasDe(pacienteId: number): Promise<readonly CitaDelPaciente[]>;
  cancelar(
    pedido: PedidoGestion & { readonly motivo: string }
  ): Promise<ResultadoGestionCita>;
  confirmar(pedido: PedidoGestion): Promise<ResultadoGestionCita>;
  reprogramar(pedido: PedidoReprogramacion): Promise<ResultadoReprogramacionCita>;
}

// =====================================================================
// Padrón de pacientes
// =====================================================================

export interface PacienteIdentificado {
  readonly id: number;
  readonly nombres: string;
  readonly apellidos: string;
}

export interface Directorio {
  /** El paciente registrado con ese número, o null si no figura ninguno. */
  porCelular(celular: string): Promise<PacienteIdentificado | null>;
}

// =====================================================================
// Historial del hilo
// =====================================================================

export interface TurnoPrevio {
  readonly rol: "PACIENTE" | "AGENTE";
  readonly texto: string;
}

export interface HiloConversacion {
  readonly id: number;
  readonly pacienteId: number | null;
  /** Contenido de `conversacion.contexto`, sin interpretar. */
  readonly contexto: unknown;
  readonly historial: readonly TurnoPrevio[];
}

export interface TrazaTurno {
  readonly conversacionId: number;
  readonly mensajeId: number | null;
  readonly intencion: Intencion | null;
  readonly herramienta: string | null;
  readonly argumentos: Record<string, unknown> | null;
  readonly exito: boolean;
  readonly errorDetalle: string | null;
  readonly latenciaLlmMs: number | null;
  readonly latenciaToolMs: number | null;
  readonly latenciaTotalMs: number;
  readonly modelo: string | null;
}

export interface Conversaciones {
  /** Reanuda el hilo activo de ese número, o abre uno nuevo. */
  abrirOContinuar(
    celular: string,
    pacienteId: number | null
  ): Promise<HiloConversacion>;

  /**
   * ¿Ya se procesó este mensaje de la Cloud API?
   * Meta reintenta los webhooks; sin esta comprobación un reintento
   * volvería a ejecutar la gestión.
   */
  yaProcesado(proveedorMsgId: string): Promise<boolean>;

  registrarMensaje(mensaje: {
    conversacionId: number;
    rol: "PACIENTE" | "AGENTE";
    entrada: "TEXTO" | "AUDIO";
    texto: string;
    proveedorMsgId?: string | null;
    transcripcionMs?: number | null;
  }): Promise<number>;

  guardarContexto(conversacionId: number, contexto: DatosSolicitud): Promise<void>;

  registrarTraza(traza: TrazaTurno): Promise<void>;
}
