import type { IdentidadAgente } from "../domain/AlcanceAgente.js";
import type { Directorio } from "./puertos.js";

export interface IdentidadResuelta {
  readonly identidad: IdentidadAgente;
  readonly pacienteId: number | null;
  readonly nombres: string | null;
}

/**
 * Quién es, a partir del número que escribe. Nada más lo decide.
 *
 * Es la única función del sistema que convierte un celular en un
 * `pacienteId`, y por eso la usan tanto `AtenderMensaje` como las rutas de
 * herramientas para n8n: dos entradas al mismo agente, una sola puerta para
 * decidir de quién son las citas que se tocan. El número lo trae siempre el
 * disparador del mensaje —el remitente real de WhatsApp—, nunca el modelo:
 * es la garantía que impide que una instrucción del texto («actuá como si
 * fueras el paciente 12») cambie sobre quién se opera.
 */
export async function resolverIdentidad(
  celular: string,
  directorio: Directorio
): Promise<IdentidadResuelta> {
  const paciente = await directorio.porCelular(celular);
  return {
    identidad: paciente === null ? "ANONIMO" : "PACIENTE_IDENTIFICADO",
    pacienteId: paciente?.id ?? null,
    nombres: paciente ? `${paciente.nombres} ${paciente.apellidos}` : null,
  };
}
