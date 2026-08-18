import type { Reloj } from "./Reloj.js";

/**
 * Lo que el paciente está pidiendo, acumulado a lo largo de la conversación.
 *
 * Esta clase es la memoria del agente expresada como regla de negocio, y es
 * deliberado que viva en el dominio y no en el prompt del modelo. Un paciente
 * no dice todo de una vez:
 *
 *   — «Quiero una cita»                        → intención, falta todo lo demás
 *   — «De medicina general»                    → especialidad
 *   — «El miércoles, pero temprano»            → fecha y franja
 *
 * Si la decisión de qué falta preguntar dependiera del modelo, no habría forma
 * de probarla ni de garantizar que no invente un dato que el paciente nunca
 * dio. Acá esa decisión es determinista y se prueba sin LLM ni base de datos.
 *
 * La instancia es inmutable: `actualizar` devuelve una solicitud nueva. Eso
 * permite reconstruir el estado turno por turno al analizar una conversación.
 */

export type Intencion =
  | "SALUDO"
  | "CONSULTAR_DISPONIBILIDAD"
  | "AGENDAR"
  | "REPROGRAMAR"
  | "CANCELAR"
  | "CONFIRMAR"
  | "CONSULTAR_MIS_CITAS"
  | "FUERA_DE_ALCANCE"
  | "DESPEDIDA";

/** Coincide con el tipo `franja_horaria` de la base. */
export type Franja = "MANANA" | "TARDE" | "CUALQUIERA";

export type Campo = "intencion" | "especialidad" | "fecha" | "citaId";

export interface DatosSolicitud {
  readonly intencion?: Intencion | undefined;
  readonly especialidad?: string | undefined;
  /** Fecha en formato ISO corto (YYYY-MM-DD), en la zona del consultorio. */
  readonly fecha?: string | undefined;
  readonly franja?: Franja | undefined;
  readonly citaId?: number | undefined;
}

/**
 * Qué necesita saberse antes de poder ejecutar cada intención.
 *
 * Esta tabla es la definición normativa del comportamiento del agente: las
 * repreguntas y las pruebas se derivan de acá, no al revés. `franja` nunca
 * es obligatoria; si el paciente no la menciona, se asume CUALQUIERA y se
 * le ofrecen cupos de todo el día, que es preferible a interrogarlo de más.
 */
const REQUISITOS: Readonly<Record<Intencion, readonly Campo[]>> = {
  SALUDO: [],
  CONSULTAR_DISPONIBILIDAD: ["especialidad", "fecha"],
  AGENDAR: ["especialidad", "fecha"],
  REPROGRAMAR: ["citaId", "fecha"],
  CANCELAR: ["citaId"],
  CONFIRMAR: ["citaId"],
  CONSULTAR_MIS_CITAS: [],
  FUERA_DE_ALCANCE: [],
  DESPEDIDA: [],
};

/** Cómo se le pide al paciente cada dato que falta. */
const PREGUNTAS: Readonly<Record<Campo, string>> = {
  intencion:
    "¿En qué te puedo ayudar? Puedo mostrarte horarios disponibles, agendar, reprogramar, confirmar o cancelar una cita.",
  especialidad: "¿Para qué especialidad necesitás la cita?",
  fecha: "¿Qué día te queda mejor?",
  citaId: "¿A cuál de tus citas te referís?",
};

/**
 * Hasta cuántos días hacia adelante se aceptan pedidos.
 *
 * No es un límite técnico: la agenda del consultorio se publica por
 * temporada, y ofrecer un cupo a seis meses genera una cita que casi con
 * seguridad terminará en inasistencia, que es justamente lo que el sistema
 * busca reducir.
 */
export const ANTELACION_MAXIMA_DIAS = 60;

/** Zona horaria del consultorio. La fecha del paciente se interpreta acá. */
export const ZONA_CONSULTORIO = "America/Lima";

const FORMATO_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fecha calendario de un instante en una zona dada, como YYYY-MM-DD.
 *
 * `toISOString()` no sirve: devuelve la fecha UTC, y en Lima (UTC-5) después
 * de las 19:00 ya corresponde al día siguiente. Un paciente que escribe
 * «mañana» a las 20:00 terminaría con la cita corrida un día.
 */
export function fechaLocal(instante: Date, zona: string = ZONA_CONSULTORIO): string {
  // en-CA formatea como YYYY-MM-DD, que es exactamente el formato buscado.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

/** Diferencia en días calendario entre dos fechas ISO cortas. */
function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export class SolicitudAgente {
  private readonly datos: DatosSolicitud;

  constructor(datos: DatosSolicitud = {}) {
    this.datos = { ...datos };
  }

  /**
   * Rehidrata la solicitud desde `conversacion.contexto`.
   * Descarta lo que no reconoce: un contexto viejo o corrupto no debe
   * tumbar la conversación, solo hacer que el agente vuelva a preguntar.
   */
  static desde(json: unknown): SolicitudAgente {
    if (typeof json !== "object" || json === null) return new SolicitudAgente();
    const bruto = json as Record<string, unknown>;

    const datos: DatosSolicitud = {
      intencion: esIntencion(bruto["intencion"]) ? bruto["intencion"] : undefined,
      especialidad:
        typeof bruto["especialidad"] === "string" ? bruto["especialidad"] : undefined,
      fecha:
        typeof bruto["fecha"] === "string" && FORMATO_ISO.test(bruto["fecha"])
          ? bruto["fecha"]
          : undefined,
      franja: esFranja(bruto["franja"]) ? bruto["franja"] : undefined,
      citaId: typeof bruto["citaId"] === "number" ? bruto["citaId"] : undefined,
    };

    return new SolicitudAgente(datos);
  }

  // ---------------------------------------------------------------- lecturas

  get intencion(): Intencion | null {
    return this.datos.intencion ?? null;
  }

  get especialidad(): string | null {
    return this.datos.especialidad ?? null;
  }

  get fecha(): string | null {
    return this.datos.fecha ?? null;
  }

  get citaId(): number | null {
    return this.datos.citaId ?? null;
  }

  /** La franja pedida, o CUALQUIERA si el paciente no la mencionó. */
  get franja(): Franja {
    return this.datos.franja ?? "CUALQUIERA";
  }

  /** ¿El paciente mencionó explícitamente una franja? */
  franjaFueExplicita(): boolean {
    return this.datos.franja !== undefined;
  }

  /** Copia serializable, para guardar en `conversacion.contexto`. */
  instantanea(): DatosSolicitud {
    return { ...this.datos };
  }

  // ------------------------------------------------------------ actualización

  /**
   * Incorpora lo nuevo que dijo el paciente y conserva lo anterior.
   *
   * Conservar es lo que hace que «no puedo el martes, ¿tenés algo el
   * miércoles temprano?» no obligue a repetir la especialidad. Los valores
   * `undefined` no borran: solo un cambio explícito reemplaza un dato.
   */
  actualizar(parcial: DatosSolicitud): SolicitudAgente {
    const siguiente: DatosSolicitud = {
      intencion: parcial.intencion ?? this.datos.intencion,
      especialidad: parcial.especialidad ?? this.datos.especialidad,
      fecha: parcial.fecha ?? this.datos.fecha,
      franja: parcial.franja ?? this.datos.franja,
      citaId: parcial.citaId ?? this.datos.citaId,
    };
    return new SolicitudAgente(siguiente);
  }

  /**
   * Vacía los datos de la gestión pero mantiene la intención.
   *
   * Se usa cuando el paciente cierra un trámite y arranca otro en el mismo
   * hilo: arrastrar la fecha del pedido anterior haría que el agente diera
   * por sabido algo que el paciente no volvió a decir.
   */
  reiniciar(intencion?: Intencion): SolicitudAgente {
    return new SolicitudAgente(
      intencion === undefined ? {} : { intencion }
    );
  }

  // ------------------------------------------------------------- completitud

  /** Datos que todavía faltan para poder ejecutar la intención. */
  faltantes(): readonly Campo[] {
    const intencion = this.datos.intencion;
    if (intencion === undefined) return ["intencion"];

    return REQUISITOS[intencion].filter((campo) => {
      switch (campo) {
        case "especialidad":
          return this.datos.especialidad === undefined;
        case "fecha":
          return this.datos.fecha === undefined;
        case "citaId":
          return this.datos.citaId === undefined;
        case "intencion":
          return false;
      }
    });
  }

  /** ¿Alcanza lo que se sabe para consultar el sistema de citas? */
  completa(): boolean {
    return this.faltantes().length === 0;
  }

  /** La repregunta que corresponde hacer, o null si no falta nada. */
  siguientePregunta(): string | null {
    const campo = this.faltantes()[0];
    return campo === undefined ? null : PREGUNTAS[campo];
  }

  // ------------------------------------------------------- validez de la fecha

  /**
   * Motivo por el que la fecha pedida no es atendible, o null si lo es.
   *
   * Se devuelve el texto y no un booleano porque el agente tiene que poder
   * explicarle al paciente qué pasó; «no puedo con esa fecha» sin motivo es
   * exactamente el comportamiento de chatbot que este canal busca evitar.
   */
  problemaConLaFecha(reloj: Reloj, zona: string = ZONA_CONSULTORIO): string | null {
    const fecha = this.datos.fecha;
    if (fecha === undefined) return null;

    if (!FORMATO_ISO.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) {
      return "No entendí bien la fecha. ¿Me la decís de nuevo?";
    }

    const hoy = fechaLocal(reloj.ahora(), zona);
    const dias = diasEntre(hoy, fecha);

    if (dias < 0) {
      return "Esa fecha ya pasó. ¿Para qué día lo querés?";
    }
    if (dias > ANTELACION_MAXIMA_DIAS) {
      return `Por ahora la agenda llega hasta ${ANTELACION_MAXIMA_DIAS} días. ¿Buscamos algo más cercano?`;
    }
    return null;
  }

  /** ¿La fecha pedida es hoy? El agente no debe ofrecer cupos ya vencidos. */
  esParaHoy(reloj: Reloj, zona: string = ZONA_CONSULTORIO): boolean {
    return this.datos.fecha === fechaLocal(reloj.ahora(), zona);
  }
}

// ------------------------------------------------------------------ guardas

const INTENCIONES = Object.keys(REQUISITOS) as Intencion[];

export function esIntencion(valor: unknown): valor is Intencion {
  return typeof valor === "string" && INTENCIONES.includes(valor as Intencion);
}

export function esFranja(valor: unknown): valor is Franja {
  return valor === "MANANA" || valor === "TARDE" || valor === "CUALQUIERA";
}

/** Todas las intenciones, para construir el esquema de la herramienta. */
export function intencionesConocidas(): readonly Intencion[] {
  return INTENCIONES;
}
