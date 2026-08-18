/**
 * Evaluación del canal conversacional.
 *
 * Corre el mismo banco de mensajes contra cada modelo disponible y compara
 * exactitud de intención, exactitud de selección de herramienta, respeto
 * de los límites del canal, latencia y consumo.
 *
 *   npm run evaluar
 *
 * Sin OPENAI_API_KEY evalúa solo el modelo simulado, que es la condición
 * de control. Con la clave evalúa los dos y muestra la comparación, que es
 * la tabla que va al capítulo de resultados.
 *
 * No toca la base de datos: la agenda, el padrón y el hilo están
 * sustituidos por dobles. Se puede correr tantas veces como haga falta.
 */
import { writeFileSync } from "node:fs";
import { RelojFalso } from "../src/domain/Reloj.js";
import { AtenderMensaje } from "../src/application/AtenderMensaje.js";
import type { Llm } from "../src/application/puertos.js";
import { LlmSimulado } from "../src/infrastructure/llm/LlmSimulado.js";
import { LlmOpenAI } from "../src/infrastructure/llm/LlmOpenAI.js";
import {
  AgendaDeEvaluacion,
  ConversacionesEnMemoria,
  DirectorioFijo,
  LlmMedido,
} from "../evaluacion/dobles.js";
import {
  CASOS,
  FECHA_DE_REFERENCIA,
  type CasoDePrueba,
  type Dificultad,
} from "../evaluacion/casos.js";

/** Herramienta que el agente puede usar siempre; no cuenta como gestión. */
const NEUTRAL = "anotar_pedido";

const PACIENTE = { id: 12, nombres: "Rosa", apellidos: "Vega Salas" };

interface Resultado {
  readonly caso: CasoDePrueba;
  readonly intencion: string | null;
  readonly herramientas: readonly string[];
  readonly intencionOk: boolean;
  readonly herramientaOk: boolean;
  readonly violoLimite: boolean;
  /** Motivo por el que la comprobación adicional del caso falló. */
  readonly fallaDeArgumentos: string | null;
  readonly latenciaMs: number;
  readonly texto: string;
  readonly error: string | null;
}

async function evaluarCaso(caso: CasoDePrueba, llm: Llm): Promise<Resultado> {
  const agenda = new AgendaDeEvaluacion();
  const conversaciones = new ConversacionesEnMemoria(
    caso.contexto ?? {},
    caso.historial ?? []
  );

  const casoDeUso = new AtenderMensaje({
    llm,
    agenda,
    directorio: new DirectorioFijo(PACIENTE),
    conversaciones,
    // El reloj se fija para que «mañana» y «el viernes» signifiquen siempre
    // lo mismo: sin esto el banco daría resultados distintos cada día.
    reloj: new RelojFalso(FECHA_DE_REFERENCIA),
  });

  try {
    const respuesta = await casoDeUso.ejecutar({
      celular: "+51910007919",
      texto: caso.mensaje,
    });

    const usadas = respuesta.herramientas.map((h) => h.nombre);
    const gestiones = usadas.filter((n) => n !== NEUTRAL);

    const herramientaOk =
      caso.herramientaEsperada === null
        ? gestiones.length === 0
        : usadas.includes(caso.herramientaEsperada);

    return {
      caso,
      intencion: respuesta.intencion,
      herramientas: usadas,
      intencionOk: respuesta.intencion === caso.intencionEsperada,
      herramientaOk,
      violoLimite:
        caso.herramientaProhibida !== undefined &&
        usadas.includes(caso.herramientaProhibida),
      fallaDeArgumentos: caso.verificar?.(agenda.intentos) ?? null,
      latenciaMs: respuesta.latenciaTotalMs,
      texto: respuesta.texto,
      // El canal responde una disculpa cuando el proveedor falla, así que
      // sin esta señal un modelo inalcanzable se leería como un modelo malo.
      error: respuesta.fallo,
    };
  } catch (error) {
    return {
      caso,
      intencion: null,
      herramientas: [],
      intencionOk: false,
      herramientaOk: false,
      violoLimite: false,
      fallaDeArgumentos: null,
      latenciaMs: 0,
      texto: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// =====================================================================
// Presentación
// =====================================================================

function pct(parte: number, total: number): string {
  return total === 0 ? "—" : `${((100 * parte) / total).toFixed(1)} %`;
}

function marca(ok: boolean): string {
  return ok ? "ok" : "  ✗";
}

function tabla(nombre: string, resultados: readonly Resultado[]): void {
  console.log(`\n\n${"═".repeat(100)}`);
  console.log(`  ${nombre}`);
  console.log("═".repeat(100));
  console.log(
    `\n  ${"id".padEnd(4)} ${"mensaje".padEnd(46)} ${"int".padEnd(4)} ${"her".padEnd(4)} ` +
      `${"intención detectada".padEnd(24)} herramientas`
  );
  console.log(`  ${"─".repeat(96)}`);

  for (const r of resultados) {
    const mensaje = r.caso.mensaje.replace(/\s+/g, " ").slice(0, 44);
    console.log(
      `  ${r.caso.id.padEnd(4)} ${mensaje.padEnd(46)} ` +
        `${marca(r.intencionOk).padEnd(4)} ${marca(r.herramientaOk).padEnd(4)} ` +
        `${(r.intencion ?? "—").padEnd(24)} ` +
        `${r.herramientas.filter((h) => h !== NEUTRAL).join(", ") || "—"}` +
        `${r.violoLimite ? "   ⚠ EJECUTÓ LO PROHIBIDO" : ""}` +
        `${r.fallaDeArgumentos === null ? "" : `   ⚠ ${r.fallaDeArgumentos}`}` +
        `${r.error === null ? "" : `   ERROR: ${r.error}`}`
    );
  }
}

function resumen(nombre: string, resultados: readonly Resultado[], medido: LlmMedido): void {
  const total = resultados.length;
  const caidos = resultados.filter((r) => r.error !== null);

  // Medir la exactitud de un modelo con el que no se pudo hablar daría un
  // número que parece un resultado y no lo es. Se informa el fallo y punto.
  if (caidos.length > 0) {
    console.log(`\n  ── ${nombre} ──`);
    console.log(
      `\n  ⚠  EVALUACIÓN INVÁLIDA: ${caidos.length} de ${total} turnos no llegaron al proveedor.\n`
    );
    const motivos = new Map<string, number>();
    for (const r of caidos) {
      const motivo = (r.error ?? "").slice(0, 160);
      motivos.set(motivo, (motivos.get(motivo) ?? 0) + 1);
    }
    for (const [motivo, veces] of motivos) {
      console.log(`     ${veces}×  ${motivo}`);
    }
    console.log(
      "\n     No se informan métricas: no se puede medir la exactitud de un\n" +
        "     modelo con el que no se llegó a hablar.\n"
    );
    return;
  }

  const intenciones = resultados.filter((r) => r.intencionOk).length;
  const herramientas = resultados.filter((r) => r.herramientaOk).length;
  const ambas = resultados.filter((r) => r.intencionOk && r.herramientaOk).length;
  const violaciones = resultados.filter(
    (r) => r.violoLimite || r.fallaDeArgumentos !== null
  ).length;
  const latencias = resultados.map((r) => r.latenciaMs).sort((a, b) => a - b);
  const mediana = latencias[Math.floor(latencias.length / 2)] ?? 0;

  console.log(`\n  ── ${nombre} ──`);
  console.log(`  Exactitud de intención     ${pct(intenciones, total)}  (${intenciones}/${total})`);
  console.log(`  Selección de herramienta   ${pct(herramientas, total)}  (${herramientas}/${total})`);
  console.log(`  Turno completo correcto    ${pct(ambas, total)}  (${ambas}/${total})`);
  console.log(
    `  Límites respetados         ${violaciones === 0 ? "sí" : `NO — ${violaciones} violación(es)`}`
  );
  console.log(`  Latencia mediana           ${mediana} ms`);
  console.log(`  Llamadas al modelo         ${medido.llamadas}`);
  if (medido.tokensEntrada > 0) {
    console.log(
      `  Tokens                     ${medido.tokensEntrada} entrada · ${medido.tokensSalida} salida`
    );
  }

  // El promedio global esconde lo importante: un reconocedor por reglas
  // puede acertar mucho en los casos directos y nada en los reales.
  console.log(`\n  Por tipo de dificultad:`);
  const grupos = new Map<Dificultad, Resultado[]>();
  for (const r of resultados) {
    const g = grupos.get(r.caso.dificultad) ?? [];
    g.push(r);
    grupos.set(r.caso.dificultad, g);
  }
  for (const [dificultad, grupo] of grupos) {
    const ok = grupo.filter((r) => r.intencionOk && r.herramientaOk).length;
    console.log(
      `    ${dificultad.padEnd(12)} ${pct(ok, grupo.length).padStart(7)}  (${ok}/${grupo.length})`
    );
  }
}

// =====================================================================

async function main(): Promise<void> {
  const modelos: { nombre: string; llm: Llm }[] = [
    { nombre: "Simulado (reglas por palabras clave) — condición de control", llm: new LlmSimulado() },
  ];

  const real = LlmOpenAI.desdeEntorno();
  if (real === null) {
    console.log(
      "\n  Sin OPENAI_API_KEY: se evalúa solo el modelo simulado.\n" +
        "  Definila y volvé a correr para obtener la comparación completa."
    );
  } else {
    modelos.push({
      nombre: `Modelo de lenguaje (${process.env["AGENTE_MODELO"] ?? "gpt-4o-mini"})`,
      llm: real,
    });
  }

  console.log(`\n  Banco de evaluación: ${CASOS.length} mensajes`);
  console.log(`  Fecha de referencia: ${FECHA_DE_REFERENCIA.toISOString()}`);

  const informe: Record<string, unknown>[] = [];

  for (const { nombre, llm } of modelos) {
    const medido = new LlmMedido(llm);
    const resultados: Resultado[] = [];

    for (const caso of CASOS) {
      resultados.push(await evaluarCaso(caso, medido));
    }

    tabla(nombre, resultados);
    resumen(nombre, resultados, medido);

    for (const r of resultados) {
      informe.push({
        modelo: nombre,
        id: r.caso.id,
        dificultad: r.caso.dificultad,
        mensaje: r.caso.mensaje,
        intencion_esperada: r.caso.intencionEsperada,
        intencion_detectada: r.intencion,
        herramienta_esperada: r.caso.herramientaEsperada,
        herramientas_usadas: r.herramientas,
        intencion_ok: r.intencionOk,
        herramienta_ok: r.herramientaOk,
        violo_limite: r.violoLimite,
        falla_de_argumentos: r.fallaDeArgumentos,
        latencia_ms: r.latenciaMs,
        respuesta: r.texto,
      });
    }
  }

  // El detalle se exporta para el anexo y para el análisis en SPSS.
  const salida = "evaluacion/resultados.json";
  writeFileSync(salida, JSON.stringify(informe, null, 2), "utf8");
  console.log(`\n\n  Detalle exportado a ${salida}\n`);
}

main().catch((error: unknown) => {
  console.error("\nLa evaluación falló:", error);
  process.exit(1);
});
