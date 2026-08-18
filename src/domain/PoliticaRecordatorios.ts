import type { Reloj } from "./Reloj.js";
import type { Cita } from "./Cita.js";

/**
 * Hitos de la secuencia de recordatorios.
 * Los tres primeros son la secuencia estándar declarada en la especificación.
 */
export type Hito = "T_48H" | "T_24H" | "T_3H";

export type Canal = "WHATSAPP" | "SMS" | "EMAIL";

export type NivelRiesgo = "BAJO" | "MEDIO" | "ALTO";

export interface EnvioProgramado {
  readonly citaId: number;
  readonly hito: Hito;
  readonly canal: Canal;
  readonly programadoPara: Date;
  /**
   * Clave de idempotencia. Es lo que impide que un reintento de la cola
   * genere un segundo mensaje al mismo paciente (RNF-04). Va con restricción
   * UNIQUE en la tabla `recordatorio`.
   */
  readonly claveIdempotencia: string;
}

const HORAS_ANTES: Readonly<Record<Hito, number>> = {
  T_48H: 48,
  T_24H: 24,
  T_3H: 3,
};

/** Secuencia estándar y secuencia intensificada para pacientes de riesgo alto. */
const SECUENCIA_ESTANDAR: readonly Hito[] = ["T_48H", "T_24H", "T_3H"];
const SECUENCIA_RIESGO_ALTO: readonly Hito[] = ["T_48H", "T_24H", "T_3H"];

export interface OpcionesPolitica {
  readonly canalPreferido?: Canal;
  readonly riesgo?: NivelRiesgo;
}

/**
 * Decide QUÉ recordatorios se envían y CUÁNDO.
 *
 * Es una política pura: no toca la base de datos, no llama a WhatsApp y no
 * consulta el reloj del sistema. Recibe la cita y el instante actual, y
 * devuelve la lista de envíos a programar. Por eso se puede probar con una
 * tabla de casos y sin ninguna infraestructura.
 */
export class PoliticaRecordatorios {
  /**
   * Envíos a programar al registrarse una cita.
   *
   * Un hito cuyo instante de disparo ya pasó no se programa: si la cita se
   * registra con menos de 48 h de antelación, el recordatorio de T-48h
   * simplemente no aplica. Sin esta regla, la cola dispararía de inmediato
   * todos los hitos vencidos y el paciente recibiría tres mensajes seguidos.
   */
  calcularEnvios(
    cita: Cita,
    reloj: Reloj,
    opciones: OpcionesPolitica = {}
  ): EnvioProgramado[] {
    if (!cita.admiteRecordatorios()) return [];

    const canal = opciones.canalPreferido ?? "WHATSAPP";
    const secuencia =
      opciones.riesgo === "ALTO" ? SECUENCIA_RIESGO_ALTO : SECUENCIA_ESTANDAR;

    const ahora = reloj.ahora().getTime();

    return secuencia
      .map((hito) => ({
        hito,
        programadoPara: new Date(
          cita.inicio.getTime() - HORAS_ANTES[hito] * 3_600_000
        ),
      }))
      .filter(({ programadoPara }) => programadoPara.getTime() > ahora)
      .map(({ hito, programadoPara }) => ({
        citaId: cita.id,
        hito,
        canal,
        programadoPara,
        claveIdempotencia: PoliticaRecordatorios.clave(cita.id, hito, canal),
      }));
  }

  /**
   * Hitos que deben suspenderse cuando el paciente confirma.
   *
   * Confirmar no silencia toda la secuencia: se conserva el recordatorio de
   * T-3h porque su función deja de ser pedir confirmación y pasa a ser evitar
   * el olvido el mismo día. Los anteriores ya cumplieron su propósito.
   */
  hitosASuspenderTrasConfirmar(): readonly Hito[] {
    return ["T_48H", "T_24H"];
  }

  /** Al cancelar o reprogramar se suspende la secuencia completa. */
  hitosASuspenderTrasCancelar(): readonly Hito[] {
    return SECUENCIA_ESTANDAR;
  }

  static clave(citaId: number, hito: Hito, canal: Canal): string {
    return `cita:${citaId}:${hito}:${canal}`;
  }
}
