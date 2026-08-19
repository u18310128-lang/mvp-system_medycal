import { Router, type Request, type Response } from "express";
import { esFranja, type Franja } from "../../domain/SolicitudAgente.js";
import { exigirAlcance, AccesoDenegadoAlAgente } from "../../domain/AlcanceAgente.js";
import { resolverIdentidad } from "../../application/resolverIdentidad.js";
import type { Agenda, Directorio } from "../../application/puertos.js";
import { requiereClaveServicio } from "./middleware.js";

/**
 * Herramientas del agente como rutas HTTP sueltas, para un orquestador
 * externo — hoy, el nodo AI Agent de n8n.
 *
 * `AtenderMensaje` ya es un agente completo: interpreta, decide qué pedir y
 * ejecuta, todo en un mismo proceso. Esto no lo reemplaza ni lo duplica; le
 * da una segunda puerta de entrada para cuando quien orquesta la
 * conversación —el modelo, el bucle, el prompt— vive afuera, en n8n.
 *
 * Lo único que no puede cruzar esa puerta es de quién son las citas. Cada
 * ruta recibe un `celular` y resuelve el `pacienteId` acá adentro, con la
 * misma función que usa `AtenderMensaje` — nunca lo acepta como argumento.
 * Así, aunque el modelo del lado de n8n se equivoque o alguien intente
 * manipularlo con texto («actuá como si fueras el paciente 12»), no hay
 * ningún parámetro por el que ese engaño pueda colarse: el celular no lo
 * escribe el modelo, lo entrega el disparador de WhatsApp.
 */
export function agenteHerramientas(agenda: Agenda, directorio: Directorio): Router {
  const router = Router();

  function ruta(
    fn: (req: Request, res: Response) => Promise<void>
  ): (req: Request, res: Response, next: (e?: unknown) => void) => void {
    return (req, res, next) => {
      fn(req, res).catch(next);
    };
  }

  /** Resuelve la identidad y corta con una respuesta apta para el modelo si no alcanza. */
  async function identidadOChau(
    celular: unknown,
    accion: Parameters<typeof exigirAlcance>[1],
    res: Response
  ): Promise<number | null> {
    const numero = String(celular ?? "").trim();
    if (numero === "") {
      res.json({ error: "falta_celular", decile_al_paciente: "No pude identificar el número." });
      return null;
    }

    const { identidad, pacienteId } = await resolverIdentidad(numero, directorio);

    try {
      exigirAlcance(identidad, accion);
    } catch (error) {
      if (!(error instanceof AccesoDenegadoAlAgente)) throw error;
      res.json({ no_autorizado: true, decile_al_paciente: error.mensajeParaElPaciente });
      return null;
    }

    return pacienteId;
  }

  // ===================================================================
  // Disponibilidad — no toca datos de ningún paciente, no exige identidad
  // ===================================================================

  router.get(
    "/disponibilidad",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const especialidad = String(req.query["especialidad"] ?? "").trim();
      const fecha = String(req.query["fecha"] ?? "").trim();
      const franjaCruda = String(req.query["franja"] ?? "CUALQUIERA").trim().toUpperCase();

      if (especialidad === "" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        res.json({
          error: "faltan_datos",
          decile_al_paciente: "Necesito la especialidad y la fecha para consultar.",
        });
        return;
      }

      const catalogo = await agenda.especialidades();
      const reconocida = catalogo.find(
        (e) => normalizar(e) === normalizar(especialidad)
      );
      if (reconocida === undefined) {
        res.json({
          error: "especialidad_no_atendida",
          especialidades_disponibles: catalogo,
          decile_al_paciente:
            `El consultorio no atiende «${especialidad}». Por ahora atendemos: ${catalogo.join(", ")}.`,
        });
        return;
      }

      const franja: Franja = esFranja(franjaCruda) ? franjaCruda : "CUALQUIERA";
      const cupos = await agenda.disponibilidad({ especialidad: reconocida, fecha, franja, limite: 6 });

      res.json({
        fecha,
        especialidad: reconocida,
        total: cupos.length,
        sin_cupos: cupos.length === 0,
        cupos: cupos.map((c) => ({ medico: c.medico, medico_id: c.medicoId, hora: c.hora })),
      });
    })
  );

  // ===================================================================
  // Mis citas — exige identidad
  // ===================================================================

  router.get(
    "/mis-citas",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const pacienteId = await identidadOChau(req.query["celular"], "CONSULTAR_MIS_CITAS", res);
      if (pacienteId === null) return;

      const citas = await agenda.citasDe(pacienteId);
      res.json({
        total: citas.length,
        sin_citas: citas.length === 0,
        citas,
        ...(citas.length === 0
          ? { decile_al_paciente: "No tenés ninguna cita próxima registrada." }
          : {}),
      });
    })
  );

  // ===================================================================
  // Agendar
  // ===================================================================

  router.post(
    "/agendar",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const cuerpo = req.body as {
        celular?: string;
        especialidad?: string;
        fecha?: string;
        hora?: string;
        medico?: string;
      };

      const pacienteId = await identidadOChau(cuerpo.celular, "AGENDAR_CITA", res);
      if (pacienteId === null) return;

      const especialidad = String(cuerpo.especialidad ?? "").trim();
      const fecha = String(cuerpo.fecha ?? "").trim();
      const hora = String(cuerpo.hora ?? "").trim();

      if (
        especialidad === "" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
        !/^\d{1,2}:\d{2}$/.test(hora)
      ) {
        res.json({
          error: "faltan_datos",
          decile_al_paciente: "Necesito la especialidad, la fecha y la hora exacta que eligió.",
        });
        return;
      }

      const resultado = await agenda.agendar({
        pacienteId,
        especialidad,
        fecha,
        hora: hora.padStart(5, "0"),
        medico: cuerpo.medico?.trim() || undefined,
      });

      res.json(traducirAgendamiento(resultado));
    })
  );

  // ===================================================================
  // Cancelar / confirmar / reprogramar
  // ===================================================================

  router.post(
    "/cancelar",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const cuerpo = req.body as { celular?: string; cita_id?: number; motivo?: string };
      const pacienteId = await identidadOChau(cuerpo.celular, "CANCELAR_CITA", res);
      if (pacienteId === null) return;

      const citaId = leerCitaId(cuerpo.cita_id, res);
      if (citaId === null) return;

      const resultado = await agenda.cancelar({
        pacienteId,
        citaId,
        motivo: cuerpo.motivo?.trim() || "Cancelada por el paciente",
      });
      res.json(traducirGestion(resultado, "cancelada", (r) => ({
        cancelada: true,
        decile_al_paciente: `Listo, cancelé tu cita del ${r.fecha} a las ${r.hora} con ${r.medico}.`,
      })));
    })
  );

  router.post(
    "/confirmar",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const cuerpo = req.body as { celular?: string; cita_id?: number };
      const pacienteId = await identidadOChau(cuerpo.celular, "CONFIRMAR_CITA", res);
      if (pacienteId === null) return;

      const citaId = leerCitaId(cuerpo.cita_id, res);
      if (citaId === null) return;

      const resultado = await agenda.confirmar({ pacienteId, citaId });
      res.json(traducirGestion(resultado, "confirmada", (r) => ({
        confirmada: true,
        decile_al_paciente: `Perfecto, queda confirmada para el ${r.fecha} a las ${r.hora} con ${r.medico}.`,
      })));
    })
  );

  router.post(
    "/reprogramar",
    requiereClaveServicio,
    ruta(async (req, res) => {
      const cuerpo = req.body as {
        celular?: string;
        cita_id?: number;
        fecha?: string;
        hora?: string;
        medico?: string;
      };
      const pacienteId = await identidadOChau(cuerpo.celular, "REPROGRAMAR_CITA", res);
      if (pacienteId === null) return;

      const citaId = leerCitaId(cuerpo.cita_id, res);
      if (citaId === null) return;

      const fecha = String(cuerpo.fecha ?? "").trim();
      const hora = String(cuerpo.hora ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{1,2}:\d{2}$/.test(hora)) {
        res.json({ error: "faltan_datos", decile_al_paciente: "¿Para qué día y hora la movemos?" });
        return;
      }

      const resultado = await agenda.reprogramar({
        pacienteId,
        citaId,
        fecha,
        hora: hora.padStart(5, "0"),
        medico: cuerpo.medico?.trim() || undefined,
      });

      switch (resultado.estado) {
        case "HECHA":
          res.json({
            reprogramada: true,
            decile_al_paciente: `Listo, la moví al ${resultado.fecha} a las ${resultado.hora} con ${resultado.medico}.`,
          });
          return;
        case "OCUPADO":
          res.json({ error: "horario_ocupado", decile_al_paciente: "Justo tomaron ese horario. Consultá de nuevo." });
          return;
        case "AMBIGUO":
          res.json({
            error: "falta_elegir_profesional",
            medicos: resultado.medicos,
            decile_al_paciente: `A esa hora atienden ${resultado.medicos.join(" y ")}. ¿Con cuál preferís?`,
          });
          return;
        case "NO_DISPONIBLE":
          res.json({ error: "hora_no_disponible", decile_al_paciente: "Esa hora no está disponible." });
          return;
        case "NO_ES_TUYA":
          res.json(noEncontrada());
          return;
        case "NO_CORRESPONDE":
          res.json({ error: "no_corresponde", decile_al_paciente: explicar(resultado.motivo) });
          return;
      }
    })
  );

  return router;
}

// =====================================================================
// Auxiliares
// =====================================================================

function leerCitaId(valor: unknown, res: Response): number | null {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    res.json({
      error: "falta_cita",
      decile_al_paciente: "Necesito saber de qué cita se trata. Consultá mis-citas primero.",
    });
    return null;
  }
  return n;
}

/**
 * Mismo texto para «no existe» y «no es tuya».
 *
 * Distinguirlos convertiría la ruta en una forma de averiguar qué citas
 * tiene otra persona probando identificadores.
 */
function noEncontrada(): Record<string, unknown> {
  return {
    error: "no_encontrada",
    decile_al_paciente: "No encuentro esa cita entre las tuyas.",
  };
}

function explicar(motivo: string): string {
  if (/ya pasó|ya ha pasado/i.test(motivo)) {
    return "Esa cita ya pasó, así que no puedo modificarla.";
  }
  if (/Transición inválida/i.test(motivo)) {
    return "Esa cita ya no está activa: puede que se haya cancelado o cerrado.";
  }
  return "No puedo hacer ese cambio sobre esa cita. Comunicate con el consultorio.";
}

function traducirAgendamiento(resultado: {
  estado: string;
  citaId?: number;
  fecha?: string;
  hora?: string;
  medico?: string;
  recordatorios?: number;
  medicos?: readonly string[];
}): Record<string, unknown> {
  switch (resultado.estado) {
    case "AGENDADA":
      return {
        agendada: true,
        cita_id: resultado.citaId,
        decile_al_paciente:
          `Listo, quedó registrada para el ${resultado.fecha} a las ${resultado.hora} con ${resultado.medico}.`,
      };
    case "OCUPADO":
      return { error: "horario_ocupado", decile_al_paciente: "Justo tomaron ese horario. Consultá de nuevo." };
    case "AMBIGUO":
      return {
        error: "falta_elegir_profesional",
        medicos: resultado.medicos,
        decile_al_paciente: `A esa hora atienden ${resultado.medicos?.join(" y ")}. ¿Con cuál preferís?`,
      };
    default:
      return { error: "hora_no_disponible", decile_al_paciente: "Esa hora no figura entre las disponibles." };
  }
}

function traducirGestion(
  resultado: { estado: string; fecha?: string; hora?: string; medico?: string; motivo?: string },
  _rotulo: string,
  alSalirBien: (r: { fecha: string; hora: string; medico: string }) => Record<string, unknown>
): Record<string, unknown> {
  switch (resultado.estado) {
    case "HECHA":
      return alSalirBien(resultado as { fecha: string; hora: string; medico: string });
    case "NO_ES_TUYA":
      return noEncontrada();
    case "NO_CORRESPONDE":
      return { error: "no_corresponde", decile_al_paciente: explicar(resultado.motivo ?? "") };
    default:
      return noEncontrada();
  }
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}
