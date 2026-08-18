import type { Reloj } from "../domain/Reloj.js";
import {
  SolicitudAgente,
  esFranja,
  esIntencion,
  intencionesConocidas,
  type DatosSolicitud,
} from "../domain/SolicitudAgente.js";
import type { AccionAgente, IdentidadAgente } from "../domain/AlcanceAgente.js";
import {
  accionParaIntencion,
  exigirAlcance,
  puedeAgente,
  AccesoDenegadoAlAgente,
} from "../domain/AlcanceAgente.js";
import type {
  Agenda,
  DefinicionHerramienta,
  ResultadoGestionCita,
} from "./puertos.js";

/**
 * Las herramientas que el agente puede pedir.
 *
 * Cada una declara qué acción del `AlcanceAgente` requiere. El bucle
 * comprueba ese permiso antes de ejecutarla, de modo que el modelo puede
 * pedir cualquier cosa pero solo se ejecuta lo autorizado.
 *
 * Los argumentos que llegan del modelo son texto sin garantías: se validan
 * acá uno por uno y lo que no se reconoce se descarta. Nunca se pasan
 * directamente a la agenda ni a la base.
 */

export interface ContextoTurno {
  readonly identidad: IdentidadAgente;
  readonly pacienteId: number | null;
  readonly solicitud: SolicitudAgente;
  readonly reloj: Reloj;
}

export interface ResultadoHerramienta {
  /** Lo que se le devuelve al modelo. Debe ser serializable a JSON. */
  readonly contenido: Record<string, unknown>;
  /** La solicitud actualizada, si la herramienta incorporó datos nuevos. */
  readonly solicitud?: SolicitudAgente | undefined;
}

export interface Herramienta {
  readonly definicion: DefinicionHerramienta;
  /** Permiso que exige. `null` cuando no toca datos del consultorio. */
  readonly accion: AccionAgente | null;
  ejecutar(
    argumentos: Record<string, unknown>,
    contexto: ContextoTurno
  ): Promise<ResultadoHerramienta>;
}

/** Cuántos cupos se le ofrecen al paciente de una vez. */
export const MAXIMO_CUPOS_OFRECIDOS = 6;

// =====================================================================
// anotar_pedido — la memoria de la conversación, hecha explícita
// =====================================================================

/**
 * El modelo registra acá lo que entendió, y el dominio le responde qué
 * falta todavía.
 *
 * Existe por dos motivos. Uno funcional: que la repregunta la decida
 * `SolicitudAgente` y no el prompt, para que sea determinista y probable.
 * Otro experimental: cada llamada deja en `traza_agente` la intención
 * detectada, que es la materia prima del indicador de exactitud del canal.
 */
function anotarPedido(): Herramienta {
  return {
    accion: null,
    definicion: {
      nombre: "anotar_pedido",
      descripcion:
        "Registrá lo que entendiste del paciente: su intención y los datos que haya dado " +
        "(especialidad, fecha, franja, cita). Llamala apenas entiendas algo nuevo, incluso " +
        "si todavía falta información. Te responde qué falta y qué conviene preguntar.",
      esquema: {
        type: "object",
        properties: {
          intencion: {
            type: "string",
            enum: intencionesConocidas(),
            description:
              "Qué quiere hacer el paciente. Usá FUERA_DE_ALCANCE si pregunta por " +
              "síntomas, tratamientos o medicamentos.",
          },
          especialidad: {
            type: "string",
            description: "Especialidad médica tal como la nombra el consultorio.",
          },
          fecha: {
            type: "string",
            description:
              "Día pedido en formato YYYY-MM-DD. Resolvé vos expresiones como " +
              "«mañana» o «el miércoles» usando la fecha de hoy que figura en tus " +
              "instrucciones. Si el paciente no dio un día, no envíes este campo.",
          },
          franja: {
            type: "string",
            enum: ["MANANA", "TARDE", "CUALQUIERA"],
            description: "Solo si el paciente expresó preferencia horaria.",
          },
          cita_id: {
            type: "integer",
            description: "Identificador de la cita, cuando la gestión es sobre una existente.",
          },
        },
        required: ["intencion"],
        additionalProperties: false,
      },
    },

    async ejecutar(argumentos, contexto) {
      const parcial = leerSolicitud(argumentos);
      const actualizada = contexto.solicitud.actualizar(parcial);

      const problema = actualizada.problemaConLaFecha(contexto.reloj);
      if (problema !== null) {
        // La fecha se descarta pero el resto se conserva: el paciente no
        // tiene que repetir la especialidad por haberse equivocado de día.
        const sinFecha = contexto.solicitud.actualizar({
          ...parcial,
          fecha: undefined,
        });
        return {
          solicitud: sinFecha,
          contenido: {
            registrado: true,
            problema,
            decile_al_paciente: problema,
          },
        };
      }

      // El rechazo se resuelve acá y no al ejecutar la operación: preguntarle
      // a un número no registrado cuál de sus citas quiere cancelar sería
      // llevarlo por un camino que no termina en ningún lado.
      const intencion = actualizada.intencion;
      const accion = intencion === null ? null : accionParaIntencion(intencion);
      if (accion !== null) {
        try {
          exigirAlcance(contexto.identidad, accion);
        } catch (error) {
          if (!(error instanceof AccesoDenegadoAlAgente)) throw error;
          return {
            solicitud: actualizada,
            contenido: {
              registrado: true,
              intencion,
              no_autorizado: true,
              decile_al_paciente: error.mensajeParaElPaciente,
            },
          };
        }
      }

      const faltan = actualizada.faltantes();
      return {
        solicitud: actualizada,
        contenido: {
          registrado: true,
          intencion: actualizada.intencion,
          especialidad: actualizada.especialidad,
          fecha: actualizada.fecha,
          franja: actualizada.franja,
          faltan,
          siguiente_pregunta: actualizada.siguientePregunta(),
          listo_para_consultar: faltan.length === 0,
        },
      };
    },
  };
}

// =====================================================================
// consultar_disponibilidad — la primera ventana al sistema de citas
// =====================================================================

function consultarDisponibilidad(agenda: Agenda): Herramienta {
  return {
    accion: "CONSULTAR_DISPONIBILIDAD",
    definicion: {
      nombre: "consultar_disponibilidad",
      descripcion:
        "Devuelve los cupos realmente libres para una especialidad en una fecha. " +
        "Es la única fuente válida de horarios: nunca ofrezcas un horario que no " +
        "haya salido de acá.",
      esquema: {
        type: "object",
        properties: {
          especialidad: { type: "string", description: "Especialidad médica." },
          fecha: { type: "string", description: "Día en formato YYYY-MM-DD." },
          franja: {
            type: "string",
            enum: ["MANANA", "TARDE", "CUALQUIERA"],
            description: "Preferencia horaria. Omitila para ver todo el día.",
          },
        },
        required: ["especialidad", "fecha"],
        additionalProperties: false,
      },
    },

    async ejecutar(argumentos, contexto) {
      const parcial = leerSolicitud(argumentos);
      const solicitud = contexto.solicitud.actualizar(parcial);

      const problema = solicitud.problemaConLaFecha(contexto.reloj);
      if (problema !== null) {
        return { contenido: { error: problema, decile_al_paciente: problema } };
      }

      const especialidad = solicitud.especialidad;
      const fecha = solicitud.fecha;
      if (especialidad === null || fecha === null) {
        return {
          solicitud,
          contenido: {
            error: "Faltan datos para consultar la agenda.",
            faltan: solicitud.faltantes(),
            siguiente_pregunta: solicitud.siguientePregunta(),
          },
        };
      }

      // El consultorio atiende un conjunto acotado de especialidades. Si el
      // paciente pide otra, se le dice cuáles hay en vez de devolver vacío:
      // «no hay cupos» y «no atendemos eso» son problemas distintos.
      const catalogo = await agenda.especialidades();
      const reconocida = catalogo.find(
        (e) => normalizar(e) === normalizar(especialidad)
      );
      if (reconocida === undefined) {
        return {
          solicitud,
          contenido: {
            error: "especialidad_no_atendida",
            especialidad_pedida: especialidad,
            especialidades_disponibles: catalogo,
            decile_al_paciente:
              `El consultorio no atiende «${especialidad}». ` +
              `Por ahora atendemos: ${catalogo.join(", ")}.`,
          },
        };
      }

      const cupos = await agenda.disponibilidad({
        especialidad: reconocida,
        fecha,
        franja: solicitud.franja,
        limite: MAXIMO_CUPOS_OFRECIDOS,
      });

      return {
        solicitud,
        contenido: {
          fecha,
          especialidad: reconocida,
          franja: solicitud.franja,
          total: cupos.length,
          cupos: cupos.map((c) => ({
            medico: c.medico,
            medico_id: c.medicoId,
            hora: c.hora,
            inicio: c.inicio,
          })),
          // Sin esta señal, un día sin cupos y un día no laborable se ven
          // igual desde el modelo y las dos veces respondería lo mismo.
          sin_cupos: cupos.length === 0,
        },
      };
    },
  };
}

// =====================================================================
// agendar_cita — la primera operación que modifica la agenda
// =====================================================================

function agendarCita(agenda: Agenda): Herramienta {
  return {
    accion: "AGENDAR_CITA",
    definicion: {
      nombre: "agendar_cita",
      descripcion:
        "Registra la cita en el horario que el paciente eligió del listado que ya le " +
        "mostraste. Usala solo cuando el paciente haya elegido una hora concreta. " +
        "Si había dos profesionales a esa hora, indicá cuál eligió.",
      esquema: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Día de la cita, en formato YYYY-MM-DD." },
          hora: {
            type: "string",
            description: "Hora elegida en formato HH:MM, exactamente como se la ofreciste.",
          },
          medico: {
            type: "string",
            description: "Profesional elegido, si el paciente lo nombró.",
          },
        },
        required: ["fecha", "hora"],
        additionalProperties: false,
      },
    },

    async ejecutar(argumentos, contexto) {
      // El paciente es el de la conversación, nunca uno que venga en los
      // argumentos: el modelo no tiene por qué poder elegir para quién agenda.
      if (contexto.pacienteId === null) {
        return {
          contenido: {
            error: "sin_paciente",
            decile_al_paciente:
              "Necesito identificarte antes de registrar la cita.",
          },
        };
      }

      const parcial = leerSolicitud(argumentos);
      const solicitud = contexto.solicitud.actualizar(parcial);

      const problema = solicitud.problemaConLaFecha(contexto.reloj);
      if (problema !== null) {
        return { contenido: { error: problema, decile_al_paciente: problema } };
      }

      const especialidad = solicitud.especialidad;
      const fecha = solicitud.fecha;
      const hora = typeof argumentos["hora"] === "string" ? argumentos["hora"].trim() : "";

      if (especialidad === null || fecha === null || !/^\d{1,2}:\d{2}$/.test(hora)) {
        return {
          solicitud,
          contenido: {
            error: "faltan_datos",
            faltan: solicitud.faltantes(),
            decile_al_paciente:
              "Antes de registrarla necesito confirmar el día y la hora. ¿Me los repetís?",
          },
        };
      }

      const medico =
        typeof argumentos["medico"] === "string" && argumentos["medico"].trim() !== ""
          ? argumentos["medico"].trim()
          : undefined;

      const resultado = await agenda.agendar({
        pacienteId: contexto.pacienteId,
        especialidad,
        fecha,
        hora: hora.padStart(5, "0"),
        medico,
      });

      switch (resultado.estado) {
        case "AGENDADA":
          return {
            // Trámite cerrado: si el paciente arranca otro, no debe arrastrar
            // la fecha de este.
            solicitud: solicitud.reiniciar(),
            contenido: {
              agendada: true,
              cita_id: resultado.citaId,
              fecha: resultado.fecha,
              hora: resultado.hora,
              medico: resultado.medico,
              recordatorios_programados: resultado.recordatorios,
              decile_al_paciente:
                `Listo, quedó registrada para el ${resultado.fecha} a las ` +
                `${resultado.hora} con ${resultado.medico}. Te vamos a mandar un ` +
                `recordatorio antes de la cita.`,
            },
          };

        case "OCUPADO":
          return {
            solicitud,
            contenido: {
              error: "horario_ocupado",
              decile_al_paciente:
                "Justo tomaron ese horario. Pedime la disponibilidad de nuevo y te muestro los que quedan.",
            },
          };

        case "AMBIGUO":
          return {
            solicitud,
            contenido: {
              error: "falta_elegir_profesional",
              medicos: resultado.medicos,
              decile_al_paciente:
                `A esa hora atienden ${resultado.medicos.join(" y ")}. ¿Con cuál preferís?`,
            },
          };

        case "NO_DISPONIBLE":
          return {
            solicitud,
            contenido: {
              error: "hora_no_disponible",
              decile_al_paciente:
                "Esa hora no figura entre las disponibles. Consultá de nuevo los horarios y elegí uno de la lista.",
            },
          };
      }
    },
  };
}

// =====================================================================
// Gestiones sobre una cita que ya existe
// =====================================================================

/**
 * Las citas del propio paciente.
 *
 * Es la herramienta que hace posibles a las otras tres: nadie dice
 * «cancelá la cita 727», dicen «la del viernes». Sin este listado el
 * agente no tiene de dónde sacar el identificador, y adivinarlo sería
 * exactamente lo que no debe hacer.
 */
function consultarMisCitas(agenda: Agenda): Herramienta {
  return {
    accion: "CONSULTAR_MIS_CITAS",
    definicion: {
      nombre: "consultar_mis_citas",
      descripcion:
        "Devuelve las próximas citas del paciente con su identificador. Usala antes " +
        "de cancelar, confirmar o reprogramar, para saber de cuál está hablando.",
      esquema: { type: "object", properties: {}, additionalProperties: false },
    },

    async ejecutar(_argumentos, contexto) {
      if (contexto.pacienteId === null) {
        return { contenido: { error: "sin_paciente", citas: [] } };
      }

      const citas = await agenda.citasDe(contexto.pacienteId);

      return {
        contenido: {
          total: citas.length,
          citas,
          sin_citas: citas.length === 0,
          ...(citas.length === 0
            ? {
                decile_al_paciente:
                  "No tenés ninguna cita próxima registrada. ¿Querés que busquemos un horario?",
              }
            : {}),
        },
      };
    },
  };
}

/** Argumentos comunes a las gestiones sobre una cita concreta. */
const ESQUEMA_SOBRE_UNA_CITA = {
  type: "object",
  properties: {
    cita_id: {
      type: "integer",
      description:
        "Identificador de la cita, tal como lo devolvió consultar_mis_citas. " +
        "Nunca lo inventes ni lo deduzcas de lo que dijo el paciente.",
    },
  },
  required: ["cita_id"],
  additionalProperties: false,
} as const;

function cancelarCita(agenda: Agenda): Herramienta {
  return {
    accion: "CANCELAR_CITA",
    definicion: {
      nombre: "cancelar_cita",
      descripcion:
        "Cancela una cita del paciente y libera el cupo. Confirmá con el paciente " +
        "cuál es antes de usarla.",
      esquema: {
        type: "object",
        properties: {
          ...ESQUEMA_SOBRE_UNA_CITA.properties,
          motivo: {
            type: "string",
            description: "Motivo que dio el paciente, si lo dio.",
          },
        },
        required: ["cita_id"],
        additionalProperties: false,
      },
    },

    async ejecutar(argumentos, contexto) {
      const citaId = leerCitaId(argumentos);
      if (contexto.pacienteId === null || citaId === null) return faltaLaCita();

      const motivo =
        typeof argumentos["motivo"] === "string" && argumentos["motivo"].trim() !== ""
          ? argumentos["motivo"].trim()
          : "Cancelada por el paciente";

      const resultado = await agenda.cancelar({
        pacienteId: contexto.pacienteId,
        citaId,
        motivo,
      });

      return traducirGestion(resultado, contexto, (r) => ({
        cancelada: true,
        cita_id: r.citaId,
        decile_al_paciente:
          `Listo, cancelé tu cita del ${r.fecha} a las ${r.hora} con ${r.medico}. ` +
          `Si después querés otra, decime y buscamos horario.`,
      }));
    },
  };
}

function confirmarCita(agenda: Agenda): Herramienta {
  return {
    accion: "CONFIRMAR_CITA",
    definicion: {
      nombre: "confirmar_cita",
      descripcion: "Registra que el paciente asistirá a su cita.",
      esquema: ESQUEMA_SOBRE_UNA_CITA as unknown as Record<string, unknown>,
    },

    async ejecutar(argumentos, contexto) {
      const citaId = leerCitaId(argumentos);
      if (contexto.pacienteId === null || citaId === null) return faltaLaCita();

      const resultado = await agenda.confirmar({
        pacienteId: contexto.pacienteId,
        citaId,
      });

      return traducirGestion(resultado, contexto, (r) => ({
        confirmada: true,
        cita_id: r.citaId,
        decile_al_paciente:
          `Perfecto, queda confirmada para el ${r.fecha} a las ${r.hora} con ${r.medico}. ` +
          `Te vamos a mandar un recordatorio el mismo día.`,
      }));
    },
  };
}

/**
 * Mueve una cita a otro horario.
 *
 * No es cancelar y volver a agendar: la cita anterior queda REPROGRAMADA
 * apuntando a la nueva, y esa cadena es la que permite distinguir a quien
 * movió su turno de quien directamente lo dejó.
 */
function reprogramarCita(agenda: Agenda): Herramienta {
  return {
    accion: "REPROGRAMAR_CITA",
    definicion: {
      nombre: "reprogramar_cita",
      descripcion:
        "Mueve una cita del paciente a otro horario de los que consultaste. " +
        "Mantiene la misma especialidad, así que no hace falta indicarla.",
      esquema: {
        type: "object",
        properties: {
          ...ESQUEMA_SOBRE_UNA_CITA.properties,
          fecha: { type: "string", description: "Nuevo día, en formato YYYY-MM-DD." },
          hora: { type: "string", description: "Nueva hora, en formato HH:MM." },
          medico: {
            type: "string",
            description: "Profesional elegido, si el paciente lo nombró.",
          },
        },
        required: ["cita_id", "fecha", "hora"],
        additionalProperties: false,
      },
    },

    async ejecutar(argumentos, contexto) {
      const citaId = leerCitaId(argumentos);
      if (contexto.pacienteId === null || citaId === null) return faltaLaCita();

      const solicitud = contexto.solicitud.actualizar(leerSolicitud(argumentos));
      const problema = solicitud.problemaConLaFecha(contexto.reloj);
      if (problema !== null) {
        return { contenido: { error: problema, decile_al_paciente: problema } };
      }

      const fecha = solicitud.fecha;
      const hora =
        typeof argumentos["hora"] === "string" ? argumentos["hora"].trim() : "";

      if (fecha === null || !/^\d{1,2}:\d{2}$/.test(hora)) {
        return {
          solicitud,
          contenido: {
            error: "faltan_datos",
            decile_al_paciente: "¿Para qué día y hora la movemos?",
          },
        };
      }

      const medico =
        typeof argumentos["medico"] === "string" && argumentos["medico"].trim() !== ""
          ? argumentos["medico"].trim()
          : undefined;

      const resultado = await agenda.reprogramar({
        pacienteId: contexto.pacienteId,
        citaId,
        fecha,
        hora: hora.padStart(5, "0"),
        medico,
      });

      switch (resultado.estado) {
        case "HECHA":
          return {
            solicitud: solicitud.reiniciar(),
            contenido: {
              reprogramada: true,
              cita_id: resultado.citaId,
              cita_anterior_id: resultado.citaAnteriorId,
              decile_al_paciente:
                `Listo, la moví al ${resultado.fecha} a las ${resultado.hora} ` +
                `con ${resultado.medico}.`,
            },
          };

        case "OCUPADO":
          return {
            solicitud,
            contenido: {
              error: "horario_ocupado",
              decile_al_paciente:
                "Justo tomaron ese horario, así que dejé tu cita como estaba. " +
                "Consultá de nuevo y elegimos otro.",
            },
          };

        case "AMBIGUO":
          return {
            solicitud,
            contenido: {
              error: "falta_elegir_profesional",
              medicos: resultado.medicos,
              decile_al_paciente:
                `A esa hora atienden ${resultado.medicos.join(" y ")}. ¿Con cuál preferís?`,
            },
          };

        case "NO_DISPONIBLE":
          return {
            solicitud,
            contenido: {
              error: "hora_no_disponible",
              decile_al_paciente:
                "Esa hora no está disponible. Consultá los horarios y elegí uno de la lista.",
            },
          };

        case "NO_ES_TUYA":
          return { solicitud, contenido: contenidoNoEsTuya() };

        case "NO_CORRESPONDE":
          return {
            solicitud,
            contenido: {
              error: "no_corresponde",
              motivo: resultado.motivo,
              decile_al_paciente: explicar(resultado.motivo),
            },
          };
      }
    },
  };
}

// =====================================================================
// Catálogo
// =====================================================================

/** Todas las herramientas del canal. */
export function catalogoDeHerramientas(agenda: Agenda): readonly Herramienta[] {
  return [
    anotarPedido(),
    consultarDisponibilidad(agenda),
    agendarCita(agenda),
    consultarMisCitas(agenda),
    cancelarCita(agenda),
    confirmarCita(agenda),
    reprogramarCita(agenda),
  ];
}

/**
 * Las herramientas que corresponde ofrecerle al modelo según quién escribe.
 *
 * No ofrecer lo que de todos modos se rechazaría evita que el agente le
 * prometa al paciente una gestión que después no va a poder hacer.
 */
export function herramientasPara(
  identidad: IdentidadAgente,
  catalogo: readonly Herramienta[]
): readonly Herramienta[] {
  return catalogo.filter(
    (h) => h.accion === null || puedeAgente(identidad, h.accion)
  );
}

// =====================================================================
// Traducción de las gestiones sobre una cita
// =====================================================================

function leerCitaId(argumentos: Record<string, unknown>): number | null {
  const valor = argumentos["cita_id"];
  return Number.isInteger(valor) && (valor as number) > 0 ? (valor as number) : null;
}

function faltaLaCita(): ResultadoHerramienta {
  return {
    contenido: {
      error: "falta_cita",
      decile_al_paciente:
        "Necesito saber de qué cita se trata. Dejame ver cuáles tenés registradas.",
    },
  };
}

/**
 * El mismo texto para «no existe» y «no es tuya».
 *
 * Distinguirlos convertiría el canal en una forma de averiguar qué citas
 * tiene otra persona probando identificadores.
 */
function contenidoNoEsTuya(): Record<string, unknown> {
  return {
    error: "no_encontrada",
    decile_al_paciente:
      "No encuentro esa cita entre las tuyas. ¿Querés que te muestre las que tenés registradas?",
  };
}

/**
 * Convierte el rechazo del dominio en algo que el paciente entienda.
 *
 * Los mensajes de `Cita` están escritos para quien lee el código —hablan de
 * transiciones y de estados— y no sirven tal cual en un WhatsApp.
 */
function explicar(motivo: string): string {
  if (/ya pasó|ya ha pasado/i.test(motivo)) {
    return "Esa cita ya pasó, así que no puedo modificarla. ¿Querés que busquemos un nuevo horario?";
  }
  if (/Transición inválida/i.test(motivo)) {
    return "Esa cita ya no está activa: puede que se haya cancelado o cerrado. ¿Te muestro las que tenés vigentes?";
  }
  return "No puedo hacer ese cambio sobre esa cita. Comunicate con el consultorio y lo resuelven ahí.";
}

function traducirGestion(
  resultado: ResultadoGestionCita,
  contexto: ContextoTurno,
  alSalirBien: (r: ResultadoGestionCita & { estado: "HECHA" }) => Record<string, unknown>
): ResultadoHerramienta {
  switch (resultado.estado) {
    case "HECHA":
      // Trámite cerrado: la próxima gestión arranca limpia.
      return { solicitud: contexto.solicitud.reiniciar(), contenido: alSalirBien(resultado) };

    case "NO_ES_TUYA":
      return { contenido: contenidoNoEsTuya() };

    case "NO_CORRESPONDE":
      return {
        contenido: {
          error: "no_corresponde",
          motivo: resultado.motivo,
          decile_al_paciente: explicar(resultado.motivo),
        },
      };
  }
}

// =====================================================================
// Lectura defensiva de los argumentos del modelo
// =====================================================================

/** Toma solo los campos reconocibles; descarta el resto sin fallar. */
function leerSolicitud(argumentos: Record<string, unknown>): DatosSolicitud {
  const intencion = argumentos["intencion"];
  const especialidad = argumentos["especialidad"];
  const fecha = argumentos["fecha"];
  const franja = argumentos["franja"];
  const citaId = argumentos["cita_id"];

  return {
    intencion: esIntencion(intencion) ? intencion : undefined,
    especialidad:
      typeof especialidad === "string" && especialidad.trim() !== ""
        ? especialidad.trim()
        : undefined,
    fecha: typeof fecha === "string" && fecha.trim() !== "" ? fecha.trim() : undefined,
    franja: esFranja(franja) ? franja : undefined,
    citaId: Number.isInteger(citaId) ? (citaId as number) : undefined,
  };
}

/** Compara nombres de especialidad sin distinguir tildes ni mayúsculas. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}
