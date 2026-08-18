/**
 * Verifica que el registro de citas se comporte igual por los dos caminos.
 *
 * Recepción y el agente conversacional comparten `registrarCita`. Esta
 * comprobación existe para que una modificación pensada para el agente no
 * altere en silencio lo que recepción viene registrando, que es de donde
 * salen los datos de la investigación.
 *
 *   npx tsx scripts/verificar-registro.ts
 *
 * Deja la base como la encontró: las citas que crea quedan canceladas.
 */
import { pool, consultarUna } from "../src/infrastructure/db/pool.js";
import { RelojSistema } from "../src/domain/Reloj.js";
import { PoliticaRecordatorios } from "../src/domain/PoliticaRecordatorios.js";
import { registrarCita, HorarioOcupado } from "../src/infrastructure/citas/registrarCita.js";
import { cancelarCita, confirmarCita } from "../src/infrastructure/citas/gestionarCita.js";

const reloj = new RelojSistema();
const politica = new PoliticaRecordatorios();
const creadas: number[] = [];

function comprobar(condicion: boolean, texto: string): void {
  console.log(`  ${condicion ? "  ok" : "FALLA"}  ${texto}`);
  if (!condicion) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Un horario lejano dentro del bloque de la mañana, para no chocar con
  // las citas del seed ni con las que deje la demostración.
  const base = await consultarUna<{ inicio: string; medico_id: string }>(
    `SELECT (date_trunc('week', now() AT TIME ZONE 'America/Lima')
             + INTERVAL '42 days 9 hours 20 minutes') AT TIME ZONE 'America/Lima' AS inicio,
            (SELECT id FROM medico WHERE activo ORDER BY id LIMIT 1)  AS medico_id`
  );
  const paciente = await consultarUna<{ id: string }>(
    `SELECT id FROM paciente WHERE activo ORDER BY id LIMIT 1`
  );

  if (base === null || paciente === null) {
    console.error("Faltan datos base. Corré db/seed.sql primero.");
    process.exit(1);
  }

  const inicio = new Date(base.inicio).toISOString();
  const medicoId = Number(base.medico_id);
  const pacienteId = Number(paciente.id);

  console.log(`\n  Horario de prueba: ${inicio} · médico ${medicoId}\n`);

  // ---------------------------------------------------- camino de recepción
  const recepcion = await registrarCita(
    {
      pacienteId,
      medicoId,
      inicio,
      origen: "RECEPCION",
      tipo: null,
      registroSeg: 95,
      creadoPor: 1,
    },
    reloj,
    politica
  );
  creadas.push(recepcion.id);

  comprobar(recepcion.tipo === "CONTINUADOR", "el tipo por omisión sigue siendo CONTINUADOR");
  comprobar(
    recepcion.fin.getTime() - recepcion.inicio.getTime() === 20 * 60_000,
    "la cita dura los 20 minutos del bloque"
  );
  comprobar(
    recepcion.recordatorios === 3,
    `programa la secuencia completa de recordatorios (fueron ${recepcion.recordatorios})`
  );

  const fila = await consultarUna<{
    origen: string;
    creado_por: string | null;
    registro_seg: number | null;
  }>(`SELECT origen, creado_por, registro_seg FROM cita WHERE id = $1`, [recepcion.id]);

  comprobar(fila?.origen === "RECEPCION", "queda con origen RECEPCION");
  comprobar(Number(fila?.creado_por) === 1, "queda registrado qué usuario la creó");
  comprobar(
    fila?.registro_seg === 95,
    "conserva el tiempo de registro de la Ficha técnica N.° 1"
  );

  // ------------------------------------------------------------- solapamiento
  let rechazado = false;
  try {
    const duplicada = await registrarCita(
      { pacienteId, medicoId, inicio, origen: "RECEPCION" },
      reloj,
      politica
    );
    creadas.push(duplicada.id);
  } catch (error) {
    rechazado = error instanceof HorarioOcupado;
  }
  comprobar(rechazado, "el mismo horario se rechaza con HorarioOcupado (la ruta responde 409)");

  // ------------------------------------------------------- camino del agente
  const agente = await registrarCita(
    {
      pacienteId,
      medicoId,
      inicio: new Date(new Date(inicio).getTime() + 20 * 60_000).toISOString(),
      origen: "AGENTE",
      tipo: "AUTO",
      creadoPor: null,
    },
    reloj,
    politica
  );
  creadas.push(agente.id);

  const filaAgente = await consultarUna<{ origen: string; creado_por: string | null }>(
    `SELECT origen, creado_por FROM cita WHERE id = $1`,
    [agente.id]
  );

  comprobar(filaAgente?.origen === "AGENTE", "la del agente queda con origen AGENTE");
  comprobar(
    filaAgente?.creado_por === null,
    "sin usuario creador: no la registró una persona"
  );
  comprobar(
    agente.tipo === "PRIMERA_VEZ" || agente.tipo === "CONTINUADOR",
    `AUTO dedujo el tipo del historial del paciente: ${agente.tipo}`
  );
  comprobar(
    agente.recordatorios === recepcion.recordatorios,
    "programa los mismos recordatorios que recepción"
  );

  // ------------------------------------------- la cita tiene que ser propia
  //
  // Esta es la comprobación que sostiene el canal conversacional: el
  // identificador de cita lo propone el modelo a partir del texto del
  // paciente, así que la propiedad se verifica contra la base, dentro de
  // la misma transacción que haría el cambio.
  const otro = await consultarUna<{ id: string }>(
    `SELECT id FROM paciente WHERE activo AND id <> $1 ORDER BY id LIMIT 1`,
    [pacienteId]
  );

  if (otro !== null) {
    const ajeno = Number(otro.id);

    const cancelacionAjena = await cancelarCita(
      ajeno,
      recepcion.id,
      "Intento desde otra conversación",
      reloj,
      politica
    );
    comprobar(
      cancelacionAjena.estado === "NO_ES_TUYA",
      "otro paciente no puede cancelar esta cita"
    );

    const confirmacionAjena = await confirmarCita(ajeno, recepcion.id, reloj, politica);
    comprobar(
      confirmacionAjena.estado === "NO_ES_TUYA",
      "otro paciente no puede confirmarla"
    );

    const inexistente = await confirmarCita(pacienteId, 999_999_999, reloj, politica);
    comprobar(
      inexistente.estado === "NO_ES_TUYA",
      "una cita inexistente da el mismo resultado que una ajena"
    );

    const sigueViva = await consultarUna<{ estado: string }>(
      `SELECT estado FROM cita WHERE id = $1`,
      [recepcion.id]
    );
    comprobar(
      sigueViva?.estado === "PROGRAMADA",
      "después de los intentos ajenos, la cita quedó intacta"
    );
  }

  // --------------------------------------- las gestiones propias sí proceden
  const confirmada = await confirmarCita(pacienteId, recepcion.id, reloj, politica);
  comprobar(confirmada.estado === "HECHA", "el dueño sí puede confirmarla");

  const respuestas = await consultarUna<{ total: string }>(
    `SELECT count(*) AS total FROM respuesta_paciente
     WHERE cita_id = $1 AND accion = 'CONFIRMAR'`,
    [recepcion.id]
  );
  comprobar(
    Number(respuestas?.total) === 1,
    "queda registrada la respuesta que alimenta el % de confirmación"
  );

  const suspendidos = await consultarUna<{ total: string }>(
    `SELECT count(*) AS total FROM recordatorio
     WHERE cita_id = $1 AND estado = 'SUSPENDIDO'`,
    [recepcion.id]
  );
  comprobar(
    Number(suspendidos?.total) === 2,
    `confirmar suspende T-48h y T-24h y conserva el del día (suspendidos: ${suspendidos?.total})`
  );

  // -------------------------------------------------------------- limpieza
  await pool.query(
    `UPDATE cita SET estado = 'CANCELADA', cancelada_en = now(),
                     motivo_cancelacion = 'Verificación de registro',
                     origen_cancelacion = 'CONSULTORIO'
     WHERE id = ANY($1::bigint[])`,
    [creadas]
  );
  await pool.query(
    `UPDATE recordatorio SET estado = 'SUSPENDIDO'
     WHERE cita_id = ANY($1::bigint[]) AND estado = 'PROGRAMADO'`,
    [creadas]
  );

  console.log(`\n  Se cancelaron las ${creadas.length} citas de prueba.\n`);
  await pool.end();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
