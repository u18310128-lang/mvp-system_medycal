import { consultarUna } from "../db/pool.js";
import type { Directorio, PacienteIdentificado } from "../../application/puertos.js";

/**
 * Resuelve quién escribe a partir del número de WhatsApp.
 *
 * La Cloud API entrega el número sin el signo más y a veces con prefijos
 * que el padrón no guarda ('51987654321' frente a '+51 987 654 321'). En vez
 * de confiar en que ambos lados coincidan carácter por carácter, se comparan
 * los últimos nueve dígitos, que es el número de abonado en el Perú.
 *
 * No devolver ningún paciente es un resultado normal, no un error: significa
 * que ese número todavía no está registrado, y el `AlcanceAgente` ya define
 * qué se le permite hacer a un desconocido.
 */

/** Longitud del número de abonado peruano, sin código de país. */
const DIGITOS_ABONADO = 9;

export class DirectorioPostgres implements Directorio {
  async porCelular(celular: string): Promise<PacienteIdentificado | null> {
    const digitos = celular.replace(/\D/g, "");
    if (digitos.length < DIGITOS_ABONADO) return null;

    const abonado = digitos.slice(-DIGITOS_ABONADO);

    const fila = await consultarUna<{
      id: string;
      nombres: string;
      apellidos: string;
    }>(
      `SELECT id, nombres, apellidos
       FROM paciente
       WHERE activo
         AND right(regexp_replace(celular, '\\D', '', 'g'), $2) = $1
       -- Si dos registros comparten número (por ejemplo, madre e hijo con el
       -- mismo teléfono), se toma el más antiguo y queda registrado. Resolver
       -- a quién corresponde es una decisión del consultorio, no del agente.
       ORDER BY id
       LIMIT 1`,
      [abonado, DIGITOS_ABONADO]
    );

    if (fila === null) return null;

    return {
      id: Number(fila.id),
      nombres: fila.nombres,
      apellidos: fila.apellidos,
    };
  }
}
