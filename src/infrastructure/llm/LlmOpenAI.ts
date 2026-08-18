import type {
  LlamadaHerramienta,
  Llm,
  MensajeLlm,
  PeticionLlm,
  RespuestaLlm,
} from "../../application/puertos.js";

/**
 * Adaptador del puerto `Llm` contra la API de OpenAI.
 *
 * Se llama con `fetch` y sin SDK, por coherencia con el resto del proyecto:
 * la conexión a PostgreSQL tampoco pasa por un ORM. Lo que se gana no es
 * ahorrar una dependencia, sino que el contrato con el proveedor quede
 * escrito y sea legible en el capítulo de implementación, en vez de estar
 * repartido dentro de una librería.
 *
 * El modelo se toma de una variable de entorno a propósito: comparar
 * modelos es parte del diseño experimental, y no debería exigir recompilar.
 */

const URL_POR_DEFECTO = "https://api.openai.com/v1/chat/completions";

/** Corta el turno si el proveedor no responde. Un paciente no espera más. */
const TIEMPO_MAXIMO_MS = 30_000;

interface OpcionesOpenAI {
  readonly apiKey: string;
  readonly modelo?: string | undefined;
  readonly url?: string | undefined;
  readonly temperatura?: number | undefined;
}

export class LlmOpenAI implements Llm {
  private readonly apiKey: string;
  private readonly modelo: string;
  private readonly url: string;
  private readonly temperatura: number;

  constructor(opciones: OpcionesOpenAI) {
    this.apiKey = opciones.apiKey;
    this.modelo = opciones.modelo ?? "gpt-4o-mini";
    this.url = opciones.url ?? URL_POR_DEFECTO;
    // Baja pero no nula: la redacción puede variar, la decisión de qué
    // herramienta usar no debería.
    this.temperatura = opciones.temperatura ?? 0.2;
  }

  /** Construye el adaptador desde el entorno, o null si no hay clave. */
  static desdeEntorno(): LlmOpenAI | null {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey.trim() === "") return null;

    return new LlmOpenAI({
      apiKey: apiKey.trim(),
      modelo: process.env["AGENTE_MODELO"],
      url: process.env["AGENTE_LLM_URL"],
    });
  }

  async completar(peticion: PeticionLlm): Promise<RespuestaLlm> {
    const cuerpo = {
      model: this.modelo,
      temperature: this.temperatura,
      messages: peticion.mensajes.map(aMensajeOpenAI),
      tools: peticion.herramientas.map((h) => ({
        type: "function",
        function: {
          name: h.nombre,
          description: h.descripcion,
          parameters: h.esquema,
        },
      })),
      tool_choice: "auto",
    };

    const respuesta = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => "");
      throw new Error(
        `El proveedor respondió ${respuesta.status}. ${detalle.slice(0, 300)}`
      );
    }

    const datos = (await respuesta.json()) as RespuestaCruda;
    const mensaje = datos.choices?.[0]?.message;

    return {
      texto: mensaje?.content ?? null,
      llamadas: (mensaje?.tool_calls ?? []).map(aLlamada),
      modelo: datos.model ?? this.modelo,
      tokens:
        datos.usage === undefined
          ? undefined
          : {
              entrada: datos.usage.prompt_tokens ?? 0,
              salida: datos.usage.completion_tokens ?? 0,
            },
    };
  }
}

// ------------------------------------------------------------------ traducción

function aMensajeOpenAI(mensaje: MensajeLlm): Record<string, unknown> {
  switch (mensaje.rol) {
    case "sistema":
      return { role: "system", content: mensaje.contenido };

    case "paciente":
      return { role: "user", content: mensaje.contenido };

    case "agente":
      return {
        role: "assistant",
        content: mensaje.contenido === "" ? null : mensaje.contenido,
        ...(mensaje.llamadas === undefined || mensaje.llamadas.length === 0
          ? {}
          : {
              tool_calls: mensaje.llamadas.map((l) => ({
                id: l.id,
                type: "function",
                function: {
                  name: l.nombre,
                  arguments: JSON.stringify(l.argumentos),
                },
              })),
            }),
      };

    case "herramienta":
      return {
        role: "tool",
        tool_call_id: mensaje.llamadaId,
        content: mensaje.contenido,
      };
  }
}

function aLlamada(cruda: LlamadaCruda): LlamadaHerramienta {
  return {
    id: cruda.id,
    nombre: cruda.function.name,
    // El modelo devuelve los argumentos como texto y nada garantiza que sea
    // JSON válido. Un objeto vacío deja que la herramienta responda qué falta,
    // en vez de cortar el turno con una excepción.
    argumentos: leerArgumentos(cruda.function.arguments),
  };
}

function leerArgumentos(texto: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(texto);
    return typeof valor === "object" && valor !== null
      ? (valor as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ----------------------------------------------------- forma de la respuesta

interface LlamadaCruda {
  id: string;
  function: { name: string; arguments: string };
}

interface RespuestaCruda {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: LlamadaCruda[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
