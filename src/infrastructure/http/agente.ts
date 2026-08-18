import { Router, type Request, type Response } from "express";
import { consultar } from "../db/pool.js";
import { RelojSistema } from "../../domain/Reloj.js";
import { esFranja, type Franja } from "../../domain/SolicitudAgente.js";
import { AtenderMensaje } from "../../application/AtenderMensaje.js";
import { AgendaPostgres } from "../agenda/AgendaPostgres.js";
import { agendaSegunEntorno } from "../agenda/AgendaHttp.js";
import { DirectorioPostgres } from "../agenda/DirectorioPostgres.js";
import { ConversacionesPostgres } from "../agenda/ConversacionesPostgres.js";
import { LlmOpenAI } from "../llm/LlmOpenAI.js";
import { LlmSimulado } from "../llm/LlmSimulado.js";
import { requiereClaveServicio } from "./middleware.js";

/**
 * Superficie del canal conversacional.
 *
 * Se separa de las rutas del personal por una diferencia de fondo: acá no
 * actúa un usuario del consultorio con su sesión, sino el agente en nombre
 * de un paciente. Son dos actores distintos y necesitan autorizaciones
 * distintas. Reutilizar `/api/citas` con la sesión de una recepcionista le
 * habría dado al agente permisos de personal sobre la agenda completa.
 *
 * La clave de servicio autentica al proceso que llama, igual que con n8n.
 * Qué puede hacer ese proceso sobre las citas lo decide `AlcanceAgente`,
 * a partir de si el número corresponde o no a un paciente registrado.
 */
export const agente = Router();

/** El agente no ofrece más de esto de una vez, aunque se lo pidan. */
const LIMITE_MAXIMO = 20;

const reloj = new RelojSistema();
const agendaDirecta = new AgendaPostgres();

/**
 * Modelo simulado cuando no hay clave de OpenAI.
 *
 * Es deliberado que el sistema arranque igual sin credenciales: la
 * conversación se puede desarrollar y probar entera sin proveedor externo,
 * y el canal no queda inutilizable si la clave falta o vence.
 */
const llm = LlmOpenAI.desdeEntorno() ?? new LlmSimulado();

const casoDeUso = new AtenderMensaje({
  llm,
  agenda: agendaSegunEntorno(),
  directorio: new DirectorioPostgres(),
  conversaciones: new ConversacionesPostgres(),
  reloj,
});

function ruta(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// =====================================================================
// Interoperabilidad: lo que el agente consulta del sistema de citas
// =====================================================================

agente.get(
  "/especialidades",
  requiereClaveServicio,
  ruta(async (_req, res) => {
    res.json({ especialidades: await agendaDirecta.especialidades() });
  })
);

/**
 * Cupos libres por especialidad.
 *
 * Es la consulta que `/api/cupos` no cubre: recepción busca por médico
 * porque tiene la agenda a la vista, el paciente pide por especialidad
 * porque es lo único que sabe nombrar.
 */
agente.get(
  "/disponibilidad",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const t0 = performance.now();

    const especialidad = String(req.query["especialidad"] ?? "").trim();
    const fecha = String(req.query["fecha"] ?? "").trim();
    const franjaCruda = String(req.query["franja"] ?? "CUALQUIERA").trim().toUpperCase();

    if (especialidad === "" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({
        error: "Se requieren especialidad y fecha en formato YYYY-MM-DD.",
      });
      return;
    }

    const franja: Franja = esFranja(franjaCruda) ? franjaCruda : "CUALQUIERA";
    const limite = Math.min(
      Math.max(Number(req.query["limite"] ?? 6) || 6, 1),
      LIMITE_MAXIMO
    );

    const cupos = await agendaDirecta.disponibilidad({
      especialidad,
      fecha,
      franja,
      limite,
    });

    res.json({
      especialidad,
      fecha,
      franja,
      total: cupos.length,
      consulta_ms: Math.round(performance.now() - t0),
      cupos,
    });
  })
);

/**
 * Registra una cita en nombre de un paciente.
 *
 * Se separa de `POST /api/citas` porque el actor es otro: allá hay una
 * recepcionista con sesión y permiso `REGISTRAR_CITA`; acá hay un proceso
 * autenticado por clave de servicio actuando por un paciente concreto. El
 * registro en sí es el mismo código, así que ambas rutas no pueden
 * divergir; lo que cambia es quién decide que corresponde hacerlo.
 *
 * El horario llega como fecha y hora, tal como el paciente lo eligió del
 * listado que vio, y se vuelve a validar contra la disponibilidad real.
 */
agente.post(
  "/citas",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const cuerpo = req.body as {
      paciente_id?: number;
      especialidad?: string;
      fecha?: string;
      hora?: string;
      medico?: string | null;
    };

    const pacienteId = Number(cuerpo.paciente_id);
    const especialidad = String(cuerpo.especialidad ?? "").trim();
    const fecha = String(cuerpo.fecha ?? "").trim();
    const hora = String(cuerpo.hora ?? "").trim();

    if (
      !Number.isInteger(pacienteId) ||
      pacienteId <= 0 ||
      especialidad === "" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
      !/^\d{2}:\d{2}$/.test(hora)
    ) {
      res.status(400).json({
        error: "Se requieren paciente_id, especialidad, fecha (YYYY-MM-DD) y hora (HH:MM).",
      });
      return;
    }

    const resultado = await agendaDirecta.agendar({
      pacienteId,
      especialidad,
      fecha,
      hora,
      medico:
        typeof cuerpo.medico === "string" && cuerpo.medico.trim() !== ""
          ? cuerpo.medico.trim()
          : undefined,
    });

    // El cupo tomado no es un error del que llamó: es una carrera que se
    // perdió, y el agente tiene que poder ofrecer otro horario.
    res.status(resultado.estado === "AGENDADA" ? 201 : 200).json(resultado);
  })
);

/**
 * Próximas citas del paciente.
 *
 * Es lo que convierte «cancelá la del viernes» en un identificador: el
 * paciente nunca va a decir un número de cita, así que el agente primero
 * tiene que ver cuáles tiene.
 */
agente.get(
  "/citas",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const pacienteId = Number(req.query["paciente_id"]);

    if (!Number.isInteger(pacienteId) || pacienteId <= 0) {
      res.status(400).json({ error: "Se requiere paciente_id." });
      return;
    }

    res.json({ citas: await agendaDirecta.citasDe(pacienteId) });
  })
);

/**
 * Lee el paciente y la cita de una gestión, o responde 400.
 *
 * El paciente viaja en el cuerpo y no se deduce del identificador de cita:
 * es contra ese valor que se comprueba la propiedad, y tiene que venir de
 * la conversación, no de la fila que se está por modificar.
 */
function gestionPedida(
  req: Request,
  res: Response
): { pacienteId: number; citaId: number } | null {
  const pacienteId = Number((req.body as { paciente_id?: number }).paciente_id);
  const citaId = Number(req.params["id"]);

  if (
    !Number.isInteger(pacienteId) ||
    pacienteId <= 0 ||
    !Number.isInteger(citaId) ||
    citaId <= 0
  ) {
    res.status(400).json({ error: "Se requieren paciente_id y un id de cita válido." });
    return null;
  }

  return { pacienteId, citaId };
}

agente.post(
  "/citas/:id/cancelar",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const pedido = gestionPedida(req, res);
    if (pedido === null) return;

    const motivo = String(
      (req.body as { motivo?: string }).motivo ?? "Cancelada por el paciente"
    ).slice(0, 200);

    res.json(await agendaDirecta.cancelar({ ...pedido, motivo }));
  })
);

agente.post(
  "/citas/:id/confirmar",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const pedido = gestionPedida(req, res);
    if (pedido === null) return;

    res.json(await agendaDirecta.confirmar(pedido));
  })
);

agente.post(
  "/citas/:id/reprogramar",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const pedido = gestionPedida(req, res);
    if (pedido === null) return;

    const cuerpo = req.body as {
      especialidad?: string;
      fecha?: string;
      hora?: string;
      medico?: string | null;
    };

    const especialidad = String(cuerpo.especialidad ?? "").trim();
    const fecha = String(cuerpo.fecha ?? "").trim();
    const hora = String(cuerpo.hora ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(hora)) {
      res.status(400).json({
        error: "Se requieren fecha (YYYY-MM-DD) y hora (HH:MM).",
      });
      return;
    }

    res.json(
      await agendaDirecta.reprogramar({
        ...pedido,
        ...(especialidad === "" ? {} : { especialidad }),
        fecha,
        hora,
        medico:
          typeof cuerpo.medico === "string" && cuerpo.medico.trim() !== ""
            ? cuerpo.medico.trim()
            : undefined,
      })
    );
  })
);

// =====================================================================
// Conversación
// =====================================================================

/**
 * Un mensaje del paciente.
 *
 * Este es el punto que va a invocar el webhook de WhatsApp una vez
 * aprobadas las plantillas de Meta. Hasta entonces lo usan el guion de
 * demostración y las pruebas, con el mismo contrato: lo que cambie después
 * es de dónde viene el mensaje, no cómo se atiende.
 */
agente.post(
  "/mensaje",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const cuerpo = req.body as {
      celular?: string;
      texto?: string;
      entrada?: string;
      proveedor_msg_id?: string;
      transcripcion_ms?: number;
    };

    const celular = String(cuerpo.celular ?? "").trim();
    const texto = String(cuerpo.texto ?? "").trim();

    if (celular === "" || texto === "") {
      res.status(400).json({ error: "Se requieren celular y texto." });
      return;
    }

    const respuesta = await casoDeUso.ejecutar({
      celular,
      texto,
      entrada: cuerpo.entrada === "AUDIO" ? "AUDIO" : "TEXTO",
      proveedorMsgId: cuerpo.proveedor_msg_id ?? null,
      transcripcionMs: cuerpo.transcripcion_ms ?? null,
    });

    // Un reintento de Meta no vuelve a atenderse, pero igual se responde
    // 200: un error haría que el proveedor siguiera reintentando.
    if (respuesta.duplicado) {
      res.json({ duplicado: true });
      return;
    }

    res.json({
      texto: respuesta.texto,
      intencion: respuesta.intencion,
      identidad: respuesta.identidad,
      conversacion_id: respuesta.conversacionId,
      herramientas: respuesta.herramientas,
      latencia_ms: respuesta.latenciaTotalMs,
    });
  })
);

/** Traza de una conversación. Es la evidencia que se exporta para el análisis. */
agente.get(
  "/traza/:conversacionId",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const id = Number(req.params["conversacionId"]);

    res.json(
      await consultar(
        `SELECT t.ocurrido_en, t.intencion, t.herramienta, t.argumentos,
                t.exito, t.error_detalle, t.latencia_llm_ms,
                t.latencia_tool_ms, t.latencia_total_ms, t.modelo,
                m.rol, m.entrada, m.texto
         FROM traza_agente t
         LEFT JOIN mensaje_conversacion m ON m.id = t.mensaje_id
         WHERE t.conversacion_id = $1
         ORDER BY t.ocurrido_en`,
        [id]
      )
    );
  })
);
