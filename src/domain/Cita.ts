import type { Reloj } from "./Reloj.js";

/**
 * Estados del ciclo de vida de una cita.
 *
 * PROGRAMADA   — registrada, con recordatorios activos
 * CONFIRMADA   — el paciente respondió que asistirá
 * ATENDIDA     — el paciente asistió (estado terminal)
 * AUSENTE      — el paciente no asistió ni canceló (estado terminal)  ← numerador del indicador
 * CANCELADA    — cancelada antes de la hora (estado terminal), libera el cupo
 * REPROGRAMADA — movida a una nueva cita (estado terminal), libera el cupo
 */
export type EstadoCita =
  | "PROGRAMADA"
  | "CONFIRMADA"
  | "ATENDIDA"
  | "AUSENTE"
  | "CANCELADA"
  | "REPROGRAMADA";

const TERMINALES: ReadonlySet<EstadoCita> = new Set<EstadoCita>([
  "ATENDIDA",
  "AUSENTE",
  "CANCELADA",
  "REPROGRAMADA",
]);

/** Estados en los que la cita todavía ocupa el cupo del médico. */
const OCUPAN_CUPO: ReadonlySet<EstadoCita> = new Set<EstadoCita>([
  "PROGRAMADA",
  "CONFIRMADA",
  "ATENDIDA",
  "AUSENTE",
]);

/**
 * Transiciones válidas. Cualquier otra combinación es un error de dominio.
 * Esta tabla es la definición normativa: la máquina de estados de la Figura 4
 * y las pruebas se derivan de aquí, no al revés.
 */
const TRANSICIONES: Readonly<Record<EstadoCita, readonly EstadoCita[]>> = {
  PROGRAMADA: ["CONFIRMADA", "ATENDIDA", "AUSENTE", "CANCELADA", "REPROGRAMADA"],
  CONFIRMADA: ["ATENDIDA", "AUSENTE", "CANCELADA", "REPROGRAMADA"],
  ATENDIDA: [],
  AUSENTE: [],
  CANCELADA: [],
  REPROGRAMADA: [],
};

export class TransicionInvalida extends Error {
  constructor(desde: EstadoCita, hacia: EstadoCita) {
    super(`Transición inválida: ${desde} → ${hacia}`);
    this.name = "TransicionInvalida";
  }
}

export class ReglaDeNegocioViolada extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ReglaDeNegocioViolada";
  }
}

export type OrigenCancelacion = "PACIENTE" | "CONSULTORIO";

export interface DatosCita {
  readonly id: number;
  readonly pacienteId: number;
  readonly medicoId: number;
  readonly inicio: Date;
  readonly fin: Date;
  readonly estado?: EstadoCita;
  readonly citaOrigenId?: number | null;
}

/**
 * Umbral a partir del cual un cupo liberado alcanza a reasignarse a la
 * lista de espera. Por debajo de esto, avisar a otro paciente y que llegue
 * a tiempo deja de ser realista.
 */
export const HORAS_MINIMAS_PARA_REASIGNAR = 4;

export class Cita {
  readonly id: number;
  readonly pacienteId: number;
  readonly medicoId: number;
  readonly inicio: Date;
  readonly fin: Date;
  readonly citaOrigenId: number | null;

  private _estado: EstadoCita;
  private _canceladaEn: Date | null = null;
  private _motivoCancelacion: string | null = null;
  private _origenCancelacion: OrigenCancelacion | null = null;
  private _antelacionHoras: number | null = null;
  private _cerradaEn: Date | null = null;

  constructor(datos: DatosCita) {
    if (datos.fin.getTime() <= datos.inicio.getTime()) {
      throw new ReglaDeNegocioViolada(
        "El fin de la cita debe ser posterior a su inicio."
      );
    }
    this.id = datos.id;
    this.pacienteId = datos.pacienteId;
    this.medicoId = datos.medicoId;
    this.inicio = new Date(datos.inicio);
    this.fin = new Date(datos.fin);
    this.citaOrigenId = datos.citaOrigenId ?? null;
    this._estado = datos.estado ?? "PROGRAMADA";
  }

  // ---------------------------------------------------------------- lecturas

  get estado(): EstadoCita {
    return this._estado;
  }

  get canceladaEn(): Date | null {
    return this._canceladaEn;
  }

  get motivoCancelacion(): string | null {
    return this._motivoCancelacion;
  }

  get origenCancelacion(): OrigenCancelacion | null {
    return this._origenCancelacion;
  }

  /** Horas de antelación con que se canceló. `null` si no fue cancelada. */
  get antelacionHoras(): number | null {
    return this._antelacionHoras;
  }

  get cerradaEn(): Date | null {
    return this._cerradaEn;
  }

  esTerminal(): boolean {
    return TERMINALES.has(this._estado);
  }

  /** ¿Sigue bloqueando el horario del médico? */
  ocupaCupo(): boolean {
    return OCUPAN_CUPO.has(this._estado);
  }

  /** ¿Debe seguir recibiendo recordatorios? */
  admiteRecordatorios(): boolean {
    return this._estado === "PROGRAMADA";
  }

  /**
   * ¿La liberación de este cupo alcanza a reasignarse?
   * Solo tiene sentido para citas canceladas o reprogramadas.
   */
  cupoEsReasignable(): boolean {
    if (this._estado !== "CANCELADA" && this._estado !== "REPROGRAMADA") {
      return false;
    }
    return (this._antelacionHoras ?? 0) >= HORAS_MINIMAS_PARA_REASIGNAR;
  }

  // ------------------------------------------------------------ transiciones

  private transicionarA(destino: EstadoCita): void {
    const permitidas = TRANSICIONES[this._estado];
    if (!permitidas.includes(destino)) {
      throw new TransicionInvalida(this._estado, destino);
    }
    this._estado = destino;
  }

  /** El paciente responde que asistirá. */
  confirmar(reloj: Reloj): void {
    if (reloj.ahora().getTime() >= this.inicio.getTime()) {
      throw new ReglaDeNegocioViolada(
        "No se puede confirmar una cita cuya hora ya pasó."
      );
    }
    this.transicionarA("CONFIRMADA");
  }

  /**
   * El paciente cancela. Registra el motivo, el origen y la antelación,
   * que es el dato que decide si el cupo alcanza a reasignarse.
   */
  cancelar(
    reloj: Reloj,
    motivo: string,
    origen: OrigenCancelacion = "PACIENTE"
  ): void {
    const ahora = reloj.ahora();
    if (ahora.getTime() >= this.inicio.getTime()) {
      throw new ReglaDeNegocioViolada(
        "No se puede cancelar una cita cuya hora ya pasó; corresponde marcarla como ausente o atendida."
      );
    }
    this.transicionarA("CANCELADA");
    this._canceladaEn = ahora;
    this._motivoCancelacion = motivo;
    this._origenCancelacion = origen;
    this._antelacionHoras = this.horasHasta(ahora);
  }

  /**
   * El paciente mueve la cita. Esta queda como REPROGRAMADA y libera el cupo;
   * la cita nueva se crea aparte con `citaOrigenId` apuntando a esta, lo que
   * forma la cadena de trazabilidad que mide la Ficha técnica N.° 13.
   */
  reprogramar(reloj: Reloj): void {
    const ahora = reloj.ahora();
    if (ahora.getTime() >= this.inicio.getTime()) {
      throw new ReglaDeNegocioViolada(
        "No se puede reprogramar una cita cuya hora ya pasó."
      );
    }
    this.transicionarA("REPROGRAMADA");
    this._canceladaEn = ahora;
    this._antelacionHoras = this.horasHasta(ahora);
  }

  /** Cierre del día: el paciente asistió. */
  marcarAtendida(reloj: Reloj): void {
    const ahora = reloj.ahora();
    if (ahora.getTime() < this.inicio.getTime()) {
      throw new ReglaDeNegocioViolada(
        "No se puede marcar como atendida una cita que aún no ha comenzado."
      );
    }
    this.transicionarA("ATENDIDA");
    this._cerradaEn = ahora;
  }

  /**
   * Cierre del día: el paciente no asistió ni canceló.
   * Esta transición define la variable dependiente de la investigación.
   */
  marcarAusente(reloj: Reloj): void {
    const ahora = reloj.ahora();
    if (ahora.getTime() < this.fin.getTime()) {
      throw new ReglaDeNegocioViolada(
        "No se puede marcar como ausente una cita que aún no ha terminado."
      );
    }
    this.transicionarA("AUSENTE");
    this._cerradaEn = ahora;
  }

  // ---------------------------------------------------------------- utilidad

  /** Horas desde `instante` hasta el inicio de la cita, con dos decimales. */
  private horasHasta(instante: Date): number {
    const ms = this.inicio.getTime() - instante.getTime();
    return Math.round((ms / 3_600_000) * 100) / 100;
  }
}
