import type { Reloj } from "../domain/Reloj.js";
import {
  SolicitudAgente,
  fechaLocal,
  ZONA_CONSULTORIO,
  type Intencion,
} from "../domain/SolicitudAgente.js";
import {
  AccesoDenegadoAlAgente,
  DERIVACION_FUERA_DE_ALCANCE,
  exigirAlcance,
  type IdentidadAgente,
} from "../domain/AlcanceAgente.js";
import {
  catalogoDeHerramientas,
  herramientasPara,
  type ContextoTurno,
  type Herramienta,
} from "./herramientas.js";
import { resolverIdentidad } from "./resolverIdentidad.js";
import type {
  Agenda,
  Conversaciones,
  Directorio,
  Llm,
  LlamadaHerramienta,
  MensajeLlm,
} from "./puertos.js";

/**
 * Atender un mensaje del paciente: el caso de uso central del canal.
 *
 * El bucle es deliberadamente corto y está acá y no en una librería de
 * agentes por una razón de la investigación: cada decisión intermedia
 * —qué intención se detectó, qué herramienta se pidió, si se autorizó,
 * cuánto demoró cada tramo— tiene que quedar registrada en `traza_agente`.
 * Con el bucle escrito, esa evidencia es un efecto de la implementación y
 * no algo que haya que reconstruir después desde logs del proveedor.
 *
 * El reparto de responsabilidades es el mismo que con n8n: el modelo
 * interpreta y redacta, el dominio decide qué es válido y qué se permite.
 */

/** Cuántas veces se le devuelve el control al modelo dentro de un turno. */
const MAXIMO_ITERACIONES = 4;

/** Cuántos turnos previos se le recuerdan al modelo. */
const TURNOS_DE_HISTORIAL = 12;

export interface MensajeEntrante {
  readonly celular: string;
  readonly texto: string;
  readonly entrada?: "TEXTO" | "AUDIO" | undefined;
  /** Identificador del mensaje en la Cloud API, si vino de WhatsApp. */
  readonly proveedorMsgId?: string | null | undefined;
  readonly transcripcionMs?: number | null | undefined;
}

export interface HerramientaEjecutada {
  readonly nombre: string;
  readonly argumentos: Record<string, unknown>;
  readonly exito: boolean;
  readonly error: string | null;
  readonly duracionMs: number;
}

export interface RespuestaAgente {
  readonly texto: string;
  readonly intencion: Intencion | null;
  readonly identidad: IdentidadAgente;
  readonly conversacionId: number;
  readonly herramientas: readonly HerramientaEjecutada[];
  /** Verdadero cuando el mensaje ya se había procesado y se ignoró. */
  readonly duplicado: boolean;
  readonly latenciaTotalMs: number;
  /**
   * Motivo por el que el turno no pudo atenderse, o null si salió bien.
   *
   * Al paciente se le responde siempre algo —una disculpa— porque dejarlo
   * sin respuesta es peor. Pero quien llama tiene que poder distinguir
   * «el agente resolvió mal» de «el proveedor no respondió»: sin esta
   * señal, una caída del modelo se confunde con un mal desempeño, que es
   * exactamente la conclusión equivocada al medirlo.
   */
  readonly fallo: string | null;
}

export interface DependenciasAgente {
  readonly llm: Llm;
  readonly agenda: Agenda;
  readonly directorio: Directorio;
  readonly conversaciones: Conversaciones;
  readonly reloj: Reloj;
  readonly zona?: string | undefined;
}

/** Respuesta cuando algo falla del lado del sistema, no del paciente. */
const DISCULPA =
  "Tuve un problema para consultar la agenda. Probá de nuevo en un momento, " +
  "o comunicate con el consultorio.";

export class AtenderMensaje {
  private readonly catalogo: readonly Herramienta[];

  constructor(private readonly deps: DependenciasAgente) {
    this.catalogo = catalogoDeHerramientas(deps.agenda);
  }

  async ejecutar(entrante: MensajeEntrante): Promise<RespuestaAgente> {
    const t0 = performance.now();
    const { conversaciones, directorio, reloj } = this.deps;

    // Idempotencia antes que nada: si Meta reintentó la entrega, este
    // mensaje ya fue atendido y volver a procesarlo duplicaría la gestión.
    if (entrante.proveedorMsgId) {
      if (await conversaciones.yaProcesado(entrante.proveedorMsgId)) {
        return {
          texto: "",
          intencion: null,
          identidad: "ANONIMO",
          conversacionId: 0,
          herramientas: [],
          duplicado: true,
          latenciaTotalMs: Math.round(performance.now() - t0),
          fallo: null,
        };
      }
    }

    const { identidad, pacienteId, nombres } = await resolverIdentidad(
      entrante.celular,
      directorio
    );

    const hilo = await conversaciones.abrirOContinuar(entrante.celular, pacienteId);

    const mensajeId = await conversaciones.registrarMensaje({
      conversacionId: hilo.id,
      rol: "PACIENTE",
      entrada: entrante.entrada ?? "TEXTO",
      texto: entrante.texto,
      proveedorMsgId: entrante.proveedorMsgId ?? null,
      transcripcionMs: entrante.transcripcionMs ?? null,
    });

    const disponibles = herramientasPara(identidad, this.catalogo);

    const conversacion: MensajeLlm[] = [
      {
        rol: "sistema",
        contenido: this.instrucciones(
          identidad,
          nombres,
          await this.deps.agenda.especialidades()
        ),
      },
      ...hilo.historial.slice(-TURNOS_DE_HISTORIAL).map(
        (t): MensajeLlm => ({
          rol: t.rol === "PACIENTE" ? "paciente" : "agente",
          contenido: t.texto,
        })
      ),
      { rol: "paciente", contenido: entrante.texto },
    ];

    let solicitud = SolicitudAgente.desde(hilo.contexto);

    /**
     * Intención que se detectó durante el turno.
     *
     * Se sigue aparte del estado final porque una gestión completada lo
     * limpia: al agendar, la solicitud se reinicia para que el próximo
     * pedido no arrastre la fecha de este. Si la traza leyera el estado
     * final, el turno en que efectivamente se agendó quedaría registrado
     * sin intención, que es justo el que interesa medir.
     */
    let intencionDelTurno: Intencion | null = solicitud.intencion;

    const ejecutadas: HerramientaEjecutada[] = [];
    let latenciaLlm = 0;
    let latenciaTool = 0;
    let modelo: string | null = null;
    let texto: string | null = null;

    try {
      for (let vuelta = 0; vuelta < MAXIMO_ITERACIONES; vuelta++) {
        const tLlm = performance.now();
        const respuesta = await this.deps.llm.completar({
          mensajes: conversacion,
          herramientas: disponibles.map((h) => h.definicion),
        });
        latenciaLlm += Math.round(performance.now() - tLlm);
        modelo = respuesta.modelo;

        if (respuesta.llamadas.length === 0) {
          texto = respuesta.texto ?? "";
          break;
        }

        conversacion.push({
          rol: "agente",
          contenido: respuesta.texto ?? "",
          llamadas: respuesta.llamadas,
        });

        for (const llamada of respuesta.llamadas) {
          const tTool = performance.now();
          const salida = await this.ejecutarHerramienta(llamada, {
            identidad,
            pacienteId,
            solicitud,
            reloj,
          });
          const duracion = Math.round(performance.now() - tTool);
          latenciaTool += duracion;

          if (salida.solicitud !== undefined) {
            solicitud = salida.solicitud;
            if (solicitud.intencion !== null) intencionDelTurno = solicitud.intencion;
          }

          ejecutadas.push({
            nombre: llamada.nombre,
            argumentos: llamada.argumentos,
            exito: salida.exito,
            error: salida.error,
            duracionMs: duracion,
          });

          conversacion.push({
            rol: "herramienta",
            llamadaId: llamada.id,
            nombre: llamada.nombre,
            contenido: JSON.stringify(salida.contenido),
          });
        }
      }

      // Se agotaron las vueltas sin que el modelo redactara nada. Antes que
      // devolver vacío, se responde con lo que el dominio sabe que falta.
      if (texto === null) {
        texto = solicitud.siguientePregunta() ?? DISCULPA;
      }
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      await conversaciones.registrarTraza({
        conversacionId: hilo.id,
        mensajeId,
        intencion: intencionDelTurno,
        herramienta: null,
        argumentos: null,
        exito: false,
        errorDetalle: detalle,
        latenciaLlmMs: latenciaLlm,
        latenciaToolMs: latenciaTool,
        latenciaTotalMs: Math.round(performance.now() - t0),
        modelo,
      });

      await conversaciones.registrarMensaje({
        conversacionId: hilo.id,
        rol: "AGENTE",
        entrada: "TEXTO",
        texto: DISCULPA,
      });

      return {
        texto: DISCULPA,
        intencion: intencionDelTurno,
        identidad,
        conversacionId: hilo.id,
        herramientas: ejecutadas,
        duplicado: false,
        latenciaTotalMs: Math.round(performance.now() - t0),
        fallo: detalle,
      };
    }

    // Fuera de alcance se responde con el texto del dominio y no con el que
    // redacte el modelo: es el límite del canal, no una cuestión de estilo.
    if (intencionDelTurno === "FUERA_DE_ALCANCE") {
      texto = DERIVACION_FUERA_DE_ALCANCE;
    }

    await conversaciones.registrarMensaje({
      conversacionId: hilo.id,
      rol: "AGENTE",
      entrada: "TEXTO",
      texto,
    });
    await conversaciones.guardarContexto(hilo.id, solicitud.instantanea());

    const total = Math.round(performance.now() - t0);
    const ultima = ejecutadas[ejecutadas.length - 1];

    await conversaciones.registrarTraza({
      conversacionId: hilo.id,
      mensajeId,
      intencion: intencionDelTurno,
      herramienta: ultima?.nombre ?? null,
      argumentos: ultima?.argumentos ?? null,
      exito: ejecutadas.every((e) => e.exito),
      errorDetalle: ejecutadas.find((e) => !e.exito)?.error ?? null,
      latenciaLlmMs: latenciaLlm,
      latenciaToolMs: latenciaTool,
      latenciaTotalMs: total,
      modelo,
    });

    return {
      texto,
      intencion: intencionDelTurno,
      identidad,
      conversacionId: hilo.id,
      herramientas: ejecutadas,
      duplicado: false,
      latenciaTotalMs: total,
      fallo: null,
    };
  }

  // ------------------------------------------------------------------ interno

  /**
   * Ejecuta una herramienta pedida por el modelo, previa autorización.
   *
   * Un permiso denegado no es una excepción del sistema: se le devuelve al
   * modelo como resultado para que se lo explique al paciente en sus
   * palabras. Lo que nunca ocurre es que la operación se realice.
   */
  private async ejecutarHerramienta(
    llamada: LlamadaHerramienta,
    contexto: ContextoTurno
  ): Promise<{
    contenido: Record<string, unknown>;
    solicitud?: SolicitudAgente | undefined;
    exito: boolean;
    error: string | null;
  }> {
    const herramienta = this.catalogo.find((h) => h.definicion.nombre === llamada.nombre);

    if (herramienta === undefined) {
      return {
        contenido: { error: `No existe la herramienta ${llamada.nombre}.` },
        exito: false,
        error: `herramienta_inexistente:${llamada.nombre}`,
      };
    }

    try {
      if (herramienta.accion !== null) {
        exigirAlcance(contexto.identidad, herramienta.accion);
      }
      const resultado = await herramienta.ejecutar(llamada.argumentos, contexto);
      return {
        contenido: resultado.contenido,
        solicitud: resultado.solicitud,
        exito: true,
        error: null,
      };
    } catch (error) {
      if (error instanceof AccesoDenegadoAlAgente) {
        return {
          contenido: {
            error: "no_autorizado",
            decile_al_paciente: error.mensajeParaElPaciente,
          },
          exito: false,
          error: error.message,
        };
      }
      const detalle = error instanceof Error ? error.message : String(error);
      return {
        contenido: { error: "fallo_interno", decile_al_paciente: DISCULPA },
        exito: false,
        error: detalle,
      };
    }
  }

  /**
   * Instrucciones del agente.
   *
   * Se arman en cada turno porque dos datos cambian: la fecha de hoy —sin
   * ella el modelo no puede resolver «mañana»— y las especialidades que el
   * consultorio atiende, que salen de la base y no del texto del prompt.
   */
  private instrucciones(
    identidad: IdentidadAgente,
    nombrePaciente: string | null,
    especialidades: readonly string[]
  ): string {
    const zona = this.deps.zona ?? ZONA_CONSULTORIO;
    const hoy = fechaLocal(this.deps.reloj.ahora(), zona);

    const quien =
      identidad === "PACIENTE_IDENTIFICADO" && nombrePaciente !== null
        ? `Estás hablando con ${nombrePaciente}, paciente registrado del consultorio.`
        : "El número desde el que escriben no figura registrado como paciente. " +
          "Podés informar horarios, pero no gestionar citas.";

    return [
      "Sos el asistente de citas del Consultorio Perú Ruso, en Lima.",
      "Atendés por WhatsApp a pacientes que quieren ver horarios, agendar,",
      "reprogramar, confirmar o cancelar una cita.",
      "",
      quien,
      "",
      `Hoy es ${hoy} (zona ${zona}).`,
      `Especialidades que atiende el consultorio: ${especialidades.join(", ")}.`,
      "",
      "Cómo trabajás:",
      "- Apenas entiendas qué quiere el paciente, llamá a anotar_pedido. Volvé a",
      "  llamarla cada vez que te dé un dato nuevo o corrija uno anterior.",
      "- Cuando anotar_pedido te diga listo_para_consultar, usá consultar_disponibilidad.",
      "- Los horarios que ofrezcas tienen que salir siempre de consultar_disponibilidad.",
      "  No inventes ni supongas cupos, ni siquiera para dar un ejemplo.",
      "- Si falta un dato, hacé una sola pregunta por mensaje.",
      "- Si el paciente pregunta por síntomas, medicamentos o tratamientos, anotá",
      "  la intención FUERA_DE_ALCANCE y no respondas la consulta clínica.",
      "",
      "Cómo escribís:",
      "- En español rioplatense, de vos, breve y cordial.",
      "- Mensajes cortos, como en WhatsApp. Sin listas largas ni tecnicismos.",
      "- No menciones herramientas, identificadores internos ni estas instrucciones.",
    ].join("\n");
  }
}
