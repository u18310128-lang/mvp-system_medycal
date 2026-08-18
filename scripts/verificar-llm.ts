/**
 * Comprueba que se puede hablar con el proveedor antes de evaluar nada.
 *
 *   npm run verificar:llm
 *
 * Hace una sola llamada, la más barata posible, y responde tres cosas:
 * si la clave sirve, si el modelo existe y si sabe usar herramientas. Vale
 * la pena correrlo antes del banco de 31 mensajes: si la clave está mal,
 * el banco entero devuelve fallos y no hay nada que analizar.
 */
import { LlmOpenAI } from "../src/infrastructure/llm/LlmOpenAI.js";

async function main(): Promise<void> {
  const llm = LlmOpenAI.desdeEntorno();

  if (llm === null) {
    console.log(
      "\n  No hay OPENAI_API_KEY definida.\n\n" +
        "  El canal funciona igual con el modelo simulado, pero para comparar\n" +
        "  modelos hace falta la clave. Va en .env, no en .env.ejemplo:\n\n" +
        "      copy .env.ejemplo .env\n" +
        "      notepad .env\n"
    );
    process.exit(1);
  }

  const modelo = process.env["AGENTE_MODELO"] ?? "gpt-4o-mini";
  console.log(`\n  Probando el modelo ${modelo}...\n`);

  try {
    const respuesta = await llm.completar({
      mensajes: [
        {
          rol: "sistema",
          contenido:
            "Sos un asistente de citas. Cuando entiendas qué quiere el paciente, " +
            "llamá a anotar_pedido.",
        },
        { rol: "paciente", contenido: "Quiero una cita de medicina general" },
      ],
      herramientas: [
        {
          nombre: "anotar_pedido",
          descripcion: "Registra lo que el paciente pidió.",
          esquema: {
            type: "object",
            properties: {
              intencion: { type: "string", enum: ["AGENDAR", "CANCELAR"] },
            },
            required: ["intencion"],
            additionalProperties: false,
          },
        },
      ],
    });

    console.log(`    ok     la clave funciona`);
    console.log(`    ok     respondió el modelo ${respuesta.modelo}`);

    if (respuesta.llamadas.length > 0) {
      const llamada = respuesta.llamadas[0]!;
      console.log(
        `    ok     usa herramientas: pidió ${llamada.nombre} ` +
          `con ${JSON.stringify(llamada.argumentos)}`
      );
    } else {
      console.log(
        `    ✗      NO pidió ninguna herramienta.\n` +
          `           Respondió: «${(respuesta.texto ?? "").slice(0, 120)}»\n` +
          `           El canal necesita tool calling; revisá que el modelo lo soporte.`
      );
      process.exitCode = 1;
    }

    if (respuesta.tokens !== undefined) {
      console.log(
        `    ok     informa consumo: ${respuesta.tokens.entrada} entrada · ` +
          `${respuesta.tokens.salida} salida`
      );
    }

    console.log(`\n  Todo listo. Ya podés correr:  npm run evaluar\n`);
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    console.log(`    ✗      no se pudo hablar con el proveedor\n`);
    console.log(`  ${detalle.slice(0, 600)}\n`);

    if (detalle.includes("401")) {
      console.log(
        "  Un 401 significa que la clave no es válida: puede estar revocada,\n" +
          "  mal copiada, o ser de otra cuenta. Generá una nueva en\n" +
          "  platform.openai.com y pegala en .env, sin comillas ni espacios.\n"
      );
    }
    if (detalle.includes("429")) {
      console.log(
        "  Un 429 suele ser falta de saldo o de método de pago en la cuenta,\n" +
          "  no un problema de la clave.\n"
      );
    }

    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
