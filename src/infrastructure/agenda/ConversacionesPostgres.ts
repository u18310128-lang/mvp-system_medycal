import { consultar, consultarUna, pool } from "../db/pool.js";
import type { DatosSolicitud } from "../../domain/SolicitudAgente.js";
import type {
  Conversaciones,
  HiloConversacion,
  TrazaTurno,
  TurnoPrevio,
} from "../../application/puertos.js";

/**
 * Persistencia del hilo conversacional.
 *
 * Dos puntos donde la implementación importa más de lo que parece:
 *
 * — `abrirOContinuar` usa el índice único parcial sobre el número. Sin
 *   resolver el conflicto en la base, dos mensajes que llegan casi juntos
 *   —habitual cuando alguien manda tres frases seguidas por WhatsApp—
 *   abrirían dos hilos y el segundo perdería el contexto del primero.
 *
 * — `registrarMensaje` tolera el choque sobre `proveedor_msg_id`. El caso de
 *   uso ya consulta `yaProcesado`, pero entre esa consulta y esta inserción
 *   hay una ventana; la restricción de la base es la que cierra de verdad.
 */

/** Cuántos turnos previos se recuperan para dar contexto al modelo. */
const TURNOS_RECUPERADOS = 20;

export class ConversacionesPostgres implements Conversaciones {
  async abrirOContinuar(
    celular: string,
    pacienteId: number | null
  ): Promise<HiloConversacion> {
    const fila = await consultarUna<{
      id: string;
      paciente_id: string | null;
      contexto: unknown;
    }>(
      `INSERT INTO conversacion (celular, paciente_id)
       VALUES ($1, $2)
       ON CONFLICT (celular) WHERE estado = 'ACTIVA'
       DO UPDATE SET
         ultima_actividad_en = now(),
         -- El número pudo registrarse como paciente después de abrirse el
         -- hilo. Se completa, pero nunca se borra una identificación previa.
         paciente_id = COALESCE(conversacion.paciente_id, EXCLUDED.paciente_id)
       RETURNING id, paciente_id, contexto`,
      [celular, pacienteId]
    );

    if (fila === null) {
      throw new Error("No se pudo abrir la conversación.");
    }

    const id = Number(fila.id);

    const turnos = await consultar<{ rol: "PACIENTE" | "AGENTE"; texto: string }>(
      `SELECT rol, texto
       FROM (
         SELECT rol, texto, ocurrido_en, id
         FROM mensaje_conversacion
         WHERE conversacion_id = $1
         ORDER BY ocurrido_en DESC, id DESC
         LIMIT $2
       ) recientes
       ORDER BY ocurrido_en, id`,
      [id, TURNOS_RECUPERADOS]
    );

    return {
      id,
      pacienteId: fila.paciente_id === null ? null : Number(fila.paciente_id),
      contexto: fila.contexto,
      historial: turnos as TurnoPrevio[],
    };
  }

  async yaProcesado(proveedorMsgId: string): Promise<boolean> {
    const fila = await consultarUna<{ id: string }>(
      `SELECT id FROM mensaje_conversacion WHERE proveedor_msg_id = $1`,
      [proveedorMsgId]
    );
    return fila !== null;
  }

  async registrarMensaje(mensaje: {
    conversacionId: number;
    rol: "PACIENTE" | "AGENTE";
    entrada: "TEXTO" | "AUDIO";
    texto: string;
    proveedorMsgId?: string | null;
    transcripcionMs?: number | null;
  }): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO mensaje_conversacion
         (conversacion_id, rol, entrada, texto, proveedor_msg_id, transcripcion_ms)
       VALUES ($1, $2::rol_mensaje, $3::modo_entrada, $4, $5, $6)
       ON CONFLICT (proveedor_msg_id) DO NOTHING
       RETURNING id`,
      [
        mensaje.conversacionId,
        mensaje.rol,
        mensaje.entrada,
        mensaje.texto,
        mensaje.proveedorMsgId ?? null,
        mensaje.transcripcionMs ?? null,
      ]
    );

    const insertado = rows[0];
    if (insertado !== undefined) {
      await pool.query(
        `UPDATE conversacion SET ultima_actividad_en = now() WHERE id = $1`,
        [mensaje.conversacionId]
      );
      return Number(insertado.id);
    }

    // Perdió la carrera contra un reintento del webhook: el mensaje ya está.
    const existente = await consultarUna<{ id: string }>(
      `SELECT id FROM mensaje_conversacion WHERE proveedor_msg_id = $1`,
      [mensaje.proveedorMsgId ?? null]
    );
    return existente === null ? 0 : Number(existente.id);
  }

  async guardarContexto(
    conversacionId: number,
    contexto: DatosSolicitud
  ): Promise<void> {
    await pool.query(
      `UPDATE conversacion
       SET contexto = $2::jsonb, ultima_actividad_en = now()
       WHERE id = $1`,
      [conversacionId, JSON.stringify(contexto)]
    );
  }

  async registrarTraza(traza: TrazaTurno): Promise<void> {
    // La instrumentación nunca debe tumbar una conversación en curso: si
    // falla el registro, el paciente igual recibe su respuesta.
    await pool
      .query(
        `INSERT INTO traza_agente
           (conversacion_id, mensaje_id, intencion, herramienta, argumentos,
            exito, error_detalle, latencia_llm_ms, latencia_tool_ms,
            latencia_total_ms, modelo)
         VALUES ($1, $2, $3::intencion_agente, $4, $5::jsonb,
                 $6, $7, $8, $9, $10, $11)`,
        [
          traza.conversacionId,
          traza.mensajeId,
          traza.intencion,
          traza.herramienta,
          traza.argumentos === null ? null : JSON.stringify(traza.argumentos),
          traza.exito,
          traza.errorDetalle,
          traza.latenciaLlmMs,
          traza.latenciaToolMs,
          traza.latenciaTotalMs,
          traza.modelo,
        ]
      )
      .catch((error: unknown) => {
        console.error("[agente] no se pudo registrar la traza:", error);
      });
  }
}
