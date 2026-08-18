/**
 * Demostración del canal conversacional.
 *
 * Recorre cuatro escenarios contra el sistema en ejecución y muestra, turno
 * por turno, qué intención se detectó, qué herramienta se pidió y cuánto
 * demoró. Es el guion que conviene proyectar en la sustentación, porque
 * hace visible lo que de otro modo queda escondido detrás del texto.
 *
 *   npm run start           (en otra terminal)
 *   npm run demo:agente
 *
 * Sin OPENAI_API_KEY corre con el modelo simulado, que reconoce por
 * palabras clave. Con la clave, el mismo guion corre contra el modelo real
 * y las respuestas se pueden comparar una al lado de la otra.
 */
import { pool, consultarUna } from "../src/infrastructure/db/pool.js";

const BASE = process.env["AGENTE_API_URL"] ?? "http://localhost:3000";
const CLAVE = process.env["CLAVE_SERVICIO"] ?? "";

/** Número que no figura en el padrón: sirve para mostrar el caso anónimo. */
const NUMERO_DESCONOCIDO = "+51 999 000 111";

interface RespuestaMensaje {
  texto?: string;
  intencion?: string | null;
  identidad?: string;
  conversacion_id?: number;
  herramientas?: { nombre: string; exito: boolean; duracionMs: number }[];
  latencia_ms?: number;
  duplicado?: boolean;
  error?: string;
}

async function enviar(
  celular: string,
  texto: string,
  extra: { proveedorMsgId?: string; entrada?: "TEXTO" | "AUDIO" } = {}
): Promise<RespuestaMensaje> {
  const respuesta = await fetch(`${BASE}/api/agente/mensaje`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CLAVE },
    body: JSON.stringify({
      celular,
      texto,
      entrada: extra.entrada ?? "TEXTO",
      proveedor_msg_id: extra.proveedorMsgId ?? null,
    }),
  });
  return (await respuesta.json()) as RespuestaMensaje;
}

/** Imprime un turno como se ve en el teléfono, más lo que pasó por detrás. */
async function turno(
  celular: string,
  texto: string,
  extra: { proveedorMsgId?: string; entrada?: "TEXTO" | "AUDIO" } = {}
): Promise<RespuestaMensaje> {
  const marca = extra.entrada === "AUDIO" ? " 🎤" : "";
  console.log(`\n  paciente${marca} │ ${texto}`);

  const r = await enviar(celular, texto, extra);

  if (r.error !== undefined) {
    console.log(`  ERROR    │ ${r.error}`);
    return r;
  }

  if (r.duplicado === true) {
    console.log("  sistema  │ mensaje repetido: se ignoró (idempotencia)");
    return r;
  }

  for (const linea of (r.texto ?? "").split("\n")) {
    console.log(`  agente   │ ${linea}`);
  }

  const usadas = (r.herramientas ?? [])
    .map((h) => `${h.nombre}${h.exito ? "" : " ✗"} ${h.duracionMs}ms`)
    .join(" · ");

  console.log(
    `           └ intención: ${r.intencion ?? "—"} · ${r.identidad ?? "—"}` +
      `${usadas === "" ? "" : ` · ${usadas}`} · total ${r.latencia_ms ?? 0}ms`
  );

  return r;
}

function titulo(texto: string): void {
  console.log(`\n\n${"═".repeat(72)}\n  ${texto}\n${"═".repeat(72)}`);
}

async function main(): Promise<void> {
  if (CLAVE === "") {
    console.error(
      "Falta CLAVE_SERVICIO. Registrala en la tabla clave_servicio y exportala:\n" +
        "  $env:CLAVE_SERVICIO = 'agt_...'"
    );
    process.exit(1);
  }

  const paciente = await consultarUna<{
    id: string;
    nombre: string;
    celular: string;
  }>(
    `SELECT id, nombres || ' ' || apellidos AS nombre, celular
     FROM paciente WHERE activo ORDER BY id LIMIT 1`
  );

  if (paciente === null) {
    console.error("No hay pacientes cargados. Corré db/seed.sql primero.");
    process.exit(1);
  }

  // Cada corrida arranca con el hilo limpio; si no, el agente continuaría
  // la conversación de la demostración anterior, que es correcto pero
  // vuelve la demostración imposible de seguir.
  await pool.query(
    `UPDATE conversacion SET estado = 'CERRADA', cerrada_en = now()
     WHERE estado = 'ACTIVA' AND celular = ANY($1::varchar[])`,
    [[paciente.celular, NUMERO_DESCONOCIDO]]
  );

  // Las citas que dejó la corrida anterior se cancelan para que la
  // demostración vuelva a encontrar los mismos cupos libres. Solo alcanza a
  // lo que creó el propio agente para este paciente, nada más.
  const limpiadas = await pool.query(
    `UPDATE cita SET estado = 'CANCELADA', cancelada_en = now(),
                     motivo_cancelacion = 'Reinicio de la demostración',
                     origen_cancelacion = 'CONSULTORIO'
     WHERE paciente_id = $1 AND origen = 'AGENTE'
       AND estado IN ('PROGRAMADA', 'CONFIRMADA')`,
    [Number(paciente.id)]
  );
  if ((limpiadas.rowCount ?? 0) > 0) {
    console.log(
      `  Se cancelaron ${limpiadas.rowCount} cita(s) de la corrida anterior.`
    );
  }

  console.log(
    `\n  Paciente de la demostración: ${paciente.nombre} (${paciente.celular})`
  );

  // -------------------------------------------------------------------
  titulo("1 · El paciente da los datos de a poco");
  // Ningún mensaje trae todo. Lo que sostiene la continuidad no es el
  // modelo: es SolicitudAgente, que sabe qué falta y qué ya se dijo.

  await turno(paciente.celular, "Hola, quisiera sacar una cita");
  await turno(paciente.celular, "de medicina general");
  const conCupos = await turno(paciente.celular, "el jueves por la tarde");

  // -------------------------------------------------------------------
  titulo("2 · Cambia de idea sin repetir lo que ya dijo");
  // La especialidad no se vuelve a mencionar y el agente la conserva.

  await turno(
    paciente.celular,
    "uy, el jueves no puedo, mejor el viernes temprano"
  );

  // -------------------------------------------------------------------
  titulo("3 · Nota de voz ya transcrita");
  // El audio entra como texto: para el agente es la misma conversación.

  await turno(
    paciente.celular,
    "disculpá, ¿tenés algo el viernes a la tarde? salgo tarde del trabajo",
    { entrada: "AUDIO" }
  );

  // -------------------------------------------------------------------
  titulo("4 · Elige un horario y la cita queda registrada");
  // El paciente contesta con una de las horas que se le ofrecieron. El cupo
  // se vuelve a validar contra la disponibilidad real antes de registrar.

  await turno(paciente.celular, "perfecto, quiero el de las 15:20 con Quispe");

  const cita = await consultarUna<{
    id: string;
    fecha: string;
    hora: string;
    medico: string;
    estado: string;
    tipo: string;
    origen: string;
    recordatorios: string;
  }>(
    `SELECT c.id,
            to_char(c.inicio AT TIME ZONE 'America/Lima', 'DD/MM/YYYY') AS fecha,
            to_char(c.inicio AT TIME ZONE 'America/Lima', 'HH24:MI')    AS hora,
            'Dr(a). ' || m.nombres || ' ' || m.apellidos                AS medico,
            c.estado, c.tipo, c.origen,
            (SELECT count(*) FROM recordatorio r WHERE r.cita_id = c.id) AS recordatorios
     FROM cita c JOIN medico m ON m.id = c.medico_id
     WHERE c.paciente_id = $1 AND c.origen = 'AGENTE'
     ORDER BY c.id DESC LIMIT 1`,
    [Number(paciente.id)]
  );

  if (cita === null) {
    console.log("\n  ⚠ No quedó ninguna cita registrada por el agente.");
  } else {
    console.log("\n  En la base quedó:");
    console.log(
      `    cita ${cita.id} · ${cita.fecha} ${cita.hora} · ${cita.medico}\n` +
        `    estado ${cita.estado} · tipo ${cita.tipo} · origen ${cita.origen}\n` +
        `    ${cita.recordatorios} recordatorios programados por la política del dominio`
    );
    console.log(
      "\n    'origen = AGENTE' es lo que después permite comparar el ausentismo\n" +
        "    de este canal contra el de recepción, en vez de mezclarlos."
    );
  }

  // -------------------------------------------------------------------
  titulo("5 · Consulta sus citas");
  // El paciente nunca dice «la cita 727». Listar es lo que le permite al
  // agente saber de cuál habla antes de tocar nada.

  await turno(paciente.celular, "¿cuáles son mis citas?");

  // -------------------------------------------------------------------
  titulo("6 · Confirma que va a asistir");
  // Confirmar suspende los recordatorios previos pero conserva el del
  // mismo día, y suma al porcentaje de confirmación del panel.

  await turno(paciente.celular, "confirmo que voy");

  // -------------------------------------------------------------------
  titulo("7 · La mueve de horario");
  // La cita anterior queda REPROGRAMADA y la nueva apunta a ella. Ambas
  // operaciones van en una sola transacción.

  await turno(
    paciente.celular,
    "me surgió algo, ¿la puedo cambiar al lunes a las 09:00 con Quispe?"
  );

  const cadena = await consultarUna<{
    nueva: string;
    anterior: string;
    estado_anterior: string;
    fecha_nueva: string;
    hora_nueva: string;
  }>(
    `SELECT n.id AS nueva,
            a.id AS anterior,
            a.estado AS estado_anterior,
            to_char(n.inicio AT TIME ZONE 'America/Lima', 'DD/MM/YYYY') AS fecha_nueva,
            to_char(n.inicio AT TIME ZONE 'America/Lima', 'HH24:MI')    AS hora_nueva
     FROM cita n JOIN cita a ON a.id = n.cita_origen_id
     WHERE n.paciente_id = $1
     ORDER BY n.id DESC LIMIT 1`,
    [Number(paciente.id)]
  );

  if (cadena !== null) {
    console.log("\n  Cadena de trazabilidad (Ficha técnica N.° 13):");
    console.log(
      `    cita ${cadena.anterior} → ${cadena.estado_anterior}\n` +
        `    cita ${cadena.nueva} → ${cadena.fecha_nueva} ${cadena.hora_nueva}, ` +
        `con cita_origen_id = ${cadena.anterior}`
    );
    console.log(
      "\n    Quien mueve su turno no es lo mismo que quien no se presenta.\n" +
        "    Sin esta cadena, ambos casos se contarían igual."
    );
  }

  // -------------------------------------------------------------------
  titulo("8 · Termina cancelándola");
  // Cancelar libera el cupo y suspende la secuencia completa.

  await turno(paciente.celular, "al final no voy a poder, cancelala por favor");

  // -------------------------------------------------------------------
  titulo("9 · Consulta clínica: el agente reconoce el límite y deriva");

  await turno(paciente.celular, "¿qué síntomas tiene la gastritis?");

  // -------------------------------------------------------------------
  titulo("10 · Número no registrado: informa horarios, no opera citas");
  // El modelo puede pedir la herramienta; AlcanceAgente la rechaza.

  await turno(NUMERO_DESCONOCIDO, "hola, quiero cancelar mi cita");

  // -------------------------------------------------------------------
  titulo("11 · Meta reintenta el webhook: el mensaje no se procesa dos veces");

  const idDeMeta = `wamid.demo.${Date.now()}`;
  await turno(paciente.celular, "gracias!", { proveedorMsgId: idDeMeta });
  await turno(paciente.celular, "gracias!", { proveedorMsgId: idDeMeta });

  // -------------------------------------------------------------------
  titulo("Traza registrada — la evidencia que queda para el análisis");

  const conversacionId = conCupos.conversacion_id ?? 0;
  const traza = await fetch(`${BASE}/api/agente/traza/${conversacionId}`, {
    headers: { "x-api-key": CLAVE },
  });
  const filas = (await traza.json()) as {
    intencion: string | null;
    herramienta: string | null;
    exito: boolean;
    latencia_llm_ms: number | null;
    latencia_tool_ms: number | null;
    latencia_total_ms: number;
    modelo: string | null;
    texto: string | null;
  }[];

  console.log(
    `\n  ${"mensaje".padEnd(38)} ${"intención".padEnd(26)} ${"herramienta".padEnd(26)} ${"llm".padStart(6)} ${"tool".padStart(6)} ${"total".padStart(6)}`
  );
  console.log(`  ${"─".repeat(112)}`);

  for (const f of filas) {
    const mensaje = (f.texto ?? "—").replace(/\s+/g, " ").slice(0, 36);
    console.log(
      `  ${mensaje.padEnd(38)} ${(f.intencion ?? "—").padEnd(26)} ` +
        `${(f.herramienta ?? "—").padEnd(26)} ` +
        `${String(f.latencia_llm_ms ?? 0).padStart(6)} ` +
        `${String(f.latencia_tool_ms ?? 0).padStart(6)} ` +
        `${String(f.latencia_total_ms).padStart(6)}`
    );
  }

  console.log(`\n  modelo: ${filas[0]?.modelo ?? "—"}`);
  console.log(`  conversación: ${conversacionId}\n`);

  await pool.end();
}

main().catch(async (error: unknown) => {
  console.error("\nLa demostración falló:", error);
  await pool.end();
  process.exit(1);
});
