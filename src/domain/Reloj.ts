/**
 * Puerto de tiempo.
 *
 * Toda la lógica de este sistema es temporal: cuándo disparar un recordatorio,
 * si una cancelación fue oportuna, si un enlace ya expiró. Si el dominio
 * llamara directamente a `new Date()`, esas reglas serían imposibles de probar
 * sin esperar horas reales.
 *
 * Regla: NINGÚN archivo de src/domain ni de src/application puede usar
 * `new Date()` ni `Date.now()`. Siempre a través de este puerto.
 */
export interface Reloj {
  ahora(): Date;
}

/** Implementación de producción. Vive en el borde, no en el dominio. */
export class RelojSistema implements Reloj {
  ahora(): Date {
    return new Date();
  }
}

/** Implementación para pruebas: el tiempo se controla a mano. */
export class RelojFalso implements Reloj {
  constructor(private instante: Date) {}

  ahora(): Date {
    return new Date(this.instante);
  }

  fijar(instante: Date): void {
    this.instante = new Date(instante);
  }

  avanzarHoras(horas: number): void {
    this.instante = new Date(this.instante.getTime() + horas * 3_600_000);
  }

  avanzarMinutos(minutos: number): void {
    this.instante = new Date(this.instante.getTime() + minutos * 60_000);
  }
}
