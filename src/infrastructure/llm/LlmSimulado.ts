import type {
  Llm,
  MensajeLlm,
  PeticionLlm,
  RespuestaLlm,
} from "../../application/puertos.js";

/**
 * Modelo simulado: reglas fijas en lugar de un modelo de lenguaje.
 *
 * Cumple dos funciones distintas y las dos importan.
 *
 * Como herramienta de desarrollo, permite ejercitar el bucle completo
 * —herramientas, permisos, persistencia, traza— sin clave de API, sin red
 * y sin costo, y con resultados idénticos en cada corrida, que es lo que
 * hace posible probarlo automáticamente.
 *
 * Como pieza del diseño experimental, es la condición de control: reconoce
 * intenciones por palabras clave, igual que un chatbot de reglas. Comparar
 * su desempeño con el del modelo real sobre el mismo conjunto de mensajes
 * es lo que permite sostener con evidencia qué aporta el agente, en vez de
 * afirmarlo.
 *
 * No pretende parecerse a un modelo de lenguaje: falla justamente donde se
 * espera que fallen las reglas fijas, y esa es la comparación buscada.
 */
export class LlmSimulado implements Llm {
  private contador = 0;

  async completar(peticion: PeticionLlm): Promise<RespuestaLlm> {
    const modelo = "simulado-reglas-v1";
    const sistema = textoDe(peticion.mensajes, "sistema");
    const ultimaHerramienta = ultimoMensajeDe(peticion.mensajes, "herramienta");

    // ---------------------------------------------------- ya hubo herramienta
    if (ultimaHerramienta !== null) {
      const salida = leerJson(ultimaHerramienta.contenido);

      if (ultimaHerramienta.nombre === "anotar_pedido") {
        const aviso = texto(salida["decile_al_paciente"]);
        if (aviso !== null) return { texto: aviso, llamadas: [], modelo };

        const intencion = texto(salida["intencion"]);
        const dicho = textoDe(peticion.mensajes, "paciente") ?? "";
        const horaElegida = detectarHora(dicho);

        // El paciente eligió una de las horas que ya se le ofrecieron.
        if (intencion === "AGENDAR" && horaElegida !== null && texto(salida["fecha"]) !== null) {
          const medico = detectarMedico(dicho);
          return {
            texto: null,
            modelo,
            llamadas: [
              {
                id: `sim-${++this.contador}`,
                nombre: "agendar_cita",
                argumentos: {
                  fecha: texto(salida["fecha"]) ?? "",
                  hora: horaElegida,
                  ...(medico === null ? {} : { medico }),
                },
              },
            ],
          };
        }

        // Toda gestión sobre una cita existente arranca por ver cuáles
        // tiene: el identificador sale de ahí y de ningún otro lado.
        if (
          intencion === "CANCELAR" ||
          intencion === "CONFIRMAR" ||
          intencion === "REPROGRAMAR" ||
          intencion === "CONSULTAR_MIS_CITAS"
        ) {
          return {
            texto: null,
            modelo,
            llamadas: [
              {
                id: `sim-${++this.contador}`,
                nombre: "consultar_mis_citas",
                argumentos: {},
              },
            ],
          };
        }

        if (salida["listo_para_consultar"] === true &&
            (intencion === "CONSULTAR_DISPONIBILIDAD" || intencion === "AGENDAR")) {
          return {
            texto: null,
            modelo,
            llamadas: [
              {
                id: `sim-${++this.contador}`,
                nombre: "consultar_disponibilidad",
                argumentos: {
                  especialidad: texto(salida["especialidad"]) ?? "",
                  fecha: texto(salida["fecha"]) ?? "",
                  franja: texto(salida["franja"]) ?? "CUALQUIERA",
                },
              },
            ],
          };
        }

        if (intencion === "SALUDO") {
          return {
            texto:
              "¡Hola! Soy el asistente del Consultorio Perú Ruso. " +
              "Puedo ayudarte a ver horarios o gestionar tus citas. ¿Qué necesitás?",
            llamadas: [],
            modelo,
          };
        }

        if (intencion === "DESPEDIDA") {
          return { texto: "¡Gracias a vos! Que estés bien.", llamadas: [], modelo };
        }

        return {
          texto:
            texto(salida["siguiente_pregunta"]) ??
            "¿Me contás un poco más para poder ayudarte?",
          llamadas: [],
          modelo,
        };
      }

      if (ultimaHerramienta.nombre === "consultar_disponibilidad") {
        return { texto: redactarCupos(salida), llamadas: [], modelo };
      }

      if (ultimaHerramienta.nombre === "consultar_mis_citas") {
        const aviso = texto(salida["decile_al_paciente"]);
        if (aviso !== null) return { texto: aviso, llamadas: [], modelo };

        const citas = (Array.isArray(salida["citas"]) ? salida["citas"] : []).map(
          (c) => c as Record<string, unknown>
        );
        const intencion = intencionDelHilo(peticion.mensajes);

        if (intencion === "CONSULTAR_MIS_CITAS") {
          return { texto: redactarCitas(citas), llamadas: [], modelo };
        }

        // Con más de una cita, elegir por el paciente sería adivinar.
        if (citas.length > 1) {
          return {
            texto: `${redactarCitas(citas)}\n¿Sobre cuál querés que trabajemos?`,
            llamadas: [],
            modelo,
          };
        }

        const cita = citas[0];
        if (cita === undefined) {
          return {
            texto: "No tenés citas próximas registradas.",
            llamadas: [],
            modelo,
          };
        }

        const citaId = Number(cita["id"]);
        const dicho = textoDe(peticion.mensajes, "paciente") ?? "";

        if (intencion === "CANCELAR" || intencion === "CONFIRMAR") {
          return {
            texto: null,
            modelo,
            llamadas: [
              {
                id: `sim-${++this.contador}`,
                nombre: intencion === "CANCELAR" ? "cancelar_cita" : "confirmar_cita",
                argumentos: { cita_id: citaId },
              },
            ],
          };
        }

        // Reprogramar necesita además el horario nuevo.
        const hora = detectarHora(dicho);
        const fecha = detectarFecha(dicho, extraerHoy(sistema));

        if (hora === null || fecha === null) {
          return {
            texto:
              `Tenés la cita del ${texto(cita["fecha"]) ?? ""} a las ` +
              `${texto(cita["hora"]) ?? ""}. ¿Para qué día y hora la movemos?`,
            llamadas: [],
            modelo,
          };
        }

        const medico = detectarMedico(dicho);
        return {
          texto: null,
          modelo,
          llamadas: [
            {
              id: `sim-${++this.contador}`,
              nombre: "reprogramar_cita",
              argumentos: {
                cita_id: citaId,
                fecha,
                hora,
                ...(medico === null ? {} : { medico }),
              },
            },
          ],
        };
      }

      return { texto: texto(salida["decile_al_paciente"]) ?? "", llamadas: [], modelo };
    }

    // ------------------------------------------- primer paso: interpretar
    const mensaje = textoDe(peticion.mensajes, "paciente") ?? "";
    const hoy = extraerHoy(sistema);
    const especialidades = extraerEspecialidades(sistema);

    const argumentos: Record<string, unknown> = {
      intencion: intencionDelHilo(peticion.mensajes),
    };

    const especialidad = detectarEspecialidad(mensaje, especialidades);
    if (especialidad !== null) argumentos["especialidad"] = especialidad;

    const fecha = detectarFecha(mensaje, hoy);
    if (fecha !== null) argumentos["fecha"] = fecha;

    const franja = detectarFranja(mensaje);
    if (franja !== null) argumentos["franja"] = franja;

    return {
      texto: null,
      modelo,
      llamadas: [
        { id: `sim-${++this.contador}`, nombre: "anotar_pedido", argumentos },
      ],
    };
  }
}

// =====================================================================
// Reconocimiento por palabras clave
// =====================================================================

/**
 * Intención del hilo, no solo del último mensaje.
 *
 * «De medicina general» no contiene ninguna palabra que delate una
 * intención: es la respuesta a una pregunta que el agente hizo antes. Si se
 * mirara solo ese mensaje, la gestión en curso se perdería en cada turno.
 *
 * La regla es que un mensaje sin señal no borra lo que ya se sabía, pero
 * uno con señal propia sí manda: si el paciente pasa a preguntar por un
 * síntoma en medio de la gestión, eso se reconoce y se deriva.
 */
export function intencionDelHilo(mensajes: readonly MensajeLlm[]): string {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m === undefined || m.rol !== "paciente") continue;

    const detectada = detectarIntencion(m.contenido);
    if (detectada !== null) return detectada;
  }
  // Nada reconocible en todo el hilo: el dominio responde qué sí puede hacer.
  return "FUERA_DE_ALCANCE";
}

/** Intención de un mensaje suelto, o null si no hay ninguna señal. */
export function detectarIntencion(mensaje: string): string | null {
  const t = normalizar(mensaje);

  // Las gestiones concretas se comprueban antes que el saludo: «hola, quiero
  // cancelar mi cita» es una cancelación, no un saludo.
  // Se comparan prefijos y no palabras completas: el paciente escribe
  // «moverla», «cambiarla», «cancelala», con el pronombre pegado al verbo.
  if (/\bcancel/.test(t)) return "CANCELAR";
  if (/\b(reprogram|cambi|mover|muev|pasar la|correr la)/.test(t)) return "REPROGRAMAR";
  if (/\bconfirm/.test(t)) return "CONFIRMAR";
  if (/(mis citas|mi cita|citas tengo|tengo (una )?cita|cuando (es|tengo))/.test(t)) {
    return "CONSULTAR_MIS_CITAS";
  }
  if (/(cita|turno|hora|horario|disponib|agend|reserv|sacar)/.test(t)) {
    return /(horario|disponib|hay lugar|hay cupo)/.test(t)
      ? "CONSULTAR_DISPONIBILIDAD"
      : "AGENDAR";
  }
  // Consulta clínica: el canal la reconoce para derivarla, no para responderla.
  if (/(sintoma|duele|dolor|medicament|pastilla|tratamiento|receta|analisis)/.test(t)) {
    return "FUERA_DE_ALCANCE";
  }
  if (/(gracias|chau|adios|hasta luego|nada mas)/.test(t)) return "DESPEDIDA";
  if (/(hola|buenas|buenos dias|buenas tardes|que tal)/.test(t)) return "SALUDO";

  return null;
}

export function detectarEspecialidad(
  mensaje: string,
  catalogo: readonly string[]
): string | null {
  const t = normalizar(mensaje);
  const encontrada = catalogo.find((e) => t.includes(normalizar(e)));
  if (encontrada !== undefined) return encontrada;

  // Forma abreviada habitual: «general», «clínico».
  if (/\b(general|clinic|medicina)\b/.test(t)) {
    return catalogo.find((e) => normalizar(e).includes("general")) ?? null;
  }
  return null;
}

const DIAS = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
];

export function detectarFecha(mensaje: string, hoy: string): string | null {
  const t = normalizar(mensaje);

  if (/\bhoy\b/.test(t)) return hoy;
  if (/pasado ma(n|ñ)ana/.test(t)) return sumarDias(hoy, 2);

  // «mañana» es a la vez el día siguiente y el turno de la mañana. Solo
  // cuenta como fecha si no viene precedida de artículo o preposición:
  // «vengo mañana» es el día; «mañana temprano» también; pero «por la
  // mañana» y «en la mañana» hablan del turno, no del día.
  if (/\bma(n|ñ)ana\b/.test(t) && !/(por|en|a|de) la ma(n|ñ)ana/.test(t)) {
    return sumarDias(hoy, 1);
  }

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(mensaje);
  if (iso?.[1] !== undefined) return iso[1];

  // Formato d/m o d-m, habitual al escribir a mano.
  const corta = /\b(\d{1,2})[/-](\d{1,2})\b/.exec(mensaje);
  if (corta?.[1] !== undefined && corta[2] !== undefined) {
    const anio = hoy.slice(0, 4);
    const dia = corta[1].padStart(2, "0");
    const mes = corta[2].padStart(2, "0");
    return `${anio}-${mes}-${dia}`;
  }

  // Cuando se nombra más de un día vale el último: «el jueves no puedo,
  // mejor el viernes» habla del viernes. Buscar el primero de la lista
  // daría jueves, que es justo el día que el paciente descartó.
  let elegido = -1;
  let posicion = -1;
  DIAS.forEach((nombre, indice) => {
    const encontrado = new RegExp(`\\b${nombre}s?\\b`).exec(t);
    if (encontrado !== null && encontrado.index > posicion) {
      posicion = encontrado.index;
      elegido = indice;
    }
  });
  if (elegido >= 0) return proximoDiaSemana(hoy, elegido);

  return null;
}

/**
 * Hora concreta que el paciente eligió del listado.
 *
 * Solo se reconoce el formato con minutos, que es como se le ofrecieron.
 * «a las 3» quedaría fuera, y está bien que así sea: es exactamente el
 * tipo de expresión que un reconocedor por reglas no resuelve y un modelo
 * de lenguaje sí, que es parte de lo que la comparación busca mostrar.
 */
export function detectarHora(mensaje: string): string | null {
  const encontrada = /\b(\d{1,2})[:.](\d{2})\b/.exec(mensaje);
  if (encontrada?.[1] === undefined || encontrada[2] === undefined) return null;

  const horas = Number(encontrada[1]);
  const minutos = Number(encontrada[2]);
  if (horas > 23 || minutos > 59) return null;

  return `${String(horas).padStart(2, "0")}:${encontrada[2]}`;
}

/** Profesional que el paciente nombró, si nombró alguno. */
export function detectarMedico(mensaje: string): string | null {
  const encontrado =
    /\bcon\s+(?:el\s+|la\s+)?(?:dr|dra|doctor|doctora)?\.?\s*([a-záéíóúñ]{3,})/i.exec(
      mensaje
    );
  return encontrado?.[1] ?? null;
}

export function detectarFranja(mensaje: string): string | null {
  const t = normalizar(mensaje);

  if (/(temprano|(por|en|a|de) la ma(n|ñ)ana|manana temprano|\bam\b)/.test(t)) {
    return "MANANA";
  }
  // «salgo tarde del trabajo» pide un horario tardío tanto como «a la tarde».
  if (/((por|en|a|de) la tarde|\bpm\b|salgo tarde|despues del trabajo|tardecita)/.test(t)) {
    return "TARDE";
  }
  return null;
}

// =====================================================================
// Redacción
// =====================================================================

function redactarCupos(salida: Record<string, unknown>): string {
  const aviso = texto(salida["decile_al_paciente"]);
  if (aviso !== null) return aviso;

  if (salida["sin_cupos"] === true) {
    return `No me quedan cupos para el ${texto(salida["fecha"]) ?? "día pedido"}. ¿Probamos otro día?`;
  }

  const cupos = Array.isArray(salida["cupos"]) ? salida["cupos"] : [];
  const lineas = cupos.map((c) => {
    const cupo = c as Record<string, unknown>;
    return `• ${texto(cupo["hora"]) ?? ""} — ${texto(cupo["medico"]) ?? ""}`;
  });

  return [
    `Para el ${texto(salida["fecha"]) ?? ""} tengo estos horarios:`,
    ...lineas,
    "¿Cuál te sirve?",
  ].join("\n");
}

function redactarCitas(citas: readonly Record<string, unknown>[]): string {
  if (citas.length === 0) return "No tenés citas próximas registradas.";

  const lineas = citas.map(
    (c) =>
      `• ${texto(c["fecha"]) ?? ""} ${texto(c["hora"]) ?? ""} — ` +
      `${texto(c["medico"]) ?? ""} (${texto(c["estado"]) ?? ""})`
  );

  return [
    citas.length === 1 ? "Tenés esta cita:" : "Tenés estas citas:",
    ...lineas,
  ].join("\n");
}

// =====================================================================
// Utilidades
// =====================================================================

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function textoDe(
  mensajes: readonly MensajeLlm[],
  rol: MensajeLlm["rol"]
): string | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m !== undefined && m.rol === rol) return m.contenido;
  }
  return null;
}

function ultimoMensajeDe(
  mensajes: readonly MensajeLlm[],
  rol: MensajeLlm["rol"]
): MensajeLlm | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m !== undefined && m.rol === rol) return m;
  }
  return null;
}

function leerJson(contenido: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(contenido);
    return typeof valor === "object" && valor !== null
      ? (valor as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

/** Fecha de hoy declarada en las instrucciones del agente. */
function extraerHoy(sistema: string | null): string {
  const encontrada = /Hoy es (\d{4}-\d{2}-\d{2})/.exec(sistema ?? "");
  return encontrada?.[1] ?? "1970-01-01";
}

function extraerEspecialidades(sistema: string | null): readonly string[] {
  const linea = /Especialidades que atiende el consultorio: (.+)\./.exec(sistema ?? "");
  if (linea?.[1] === undefined) return [];
  return linea[1].split(",").map((e) => e.trim()).filter((e) => e !== "");
}

function sumarDias(fecha: string, dias: number): string {
  const base = Date.parse(`${fecha}T00:00:00Z`);
  return new Date(base + dias * 86_400_000).toISOString().slice(0, 10);
}

/** El próximo día de semana pedido; si es hoy, la semana que viene. */
function proximoDiaSemana(hoy: string, diaBuscado: number): string {
  const actual = new Date(`${hoy}T00:00:00Z`).getUTCDay();
  const adelanto = (diaBuscado - actual + 7) % 7;
  return sumarDias(hoy, adelanto === 0 ? 7 : adelanto);
}
