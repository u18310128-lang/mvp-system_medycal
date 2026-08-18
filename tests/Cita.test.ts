import { describe, it, expect, beforeEach } from "vitest";
import { RelojFalso } from "../src/domain/Reloj.js";
import {
  Cita,
  TransicionInvalida,
  ReglaDeNegocioViolada,
  type EstadoCita,
} from "../src/domain/Cita.js";

/** Cita de referencia: lunes 9 nov 2026, 10:00 – 10:20 (hora de Lima, en UTC). */
const INICIO = new Date("2026-11-09T15:00:00.000Z");
const FIN = new Date("2026-11-09T15:20:00.000Z");

function nuevaCita(estado?: EstadoCita): Cita {
  return new Cita({
    id: 1,
    pacienteId: 10,
    medicoId: 5,
    inicio: INICIO,
    fin: FIN,
    ...(estado ? { estado } : {}),
  });
}

describe("Cita — construcción", () => {
  it("nace en estado PROGRAMADA", () => {
    expect(nuevaCita().estado).toBe("PROGRAMADA");
  });

  it("rechaza un rango horario invertido", () => {
    expect(
      () =>
        new Cita({
          id: 1,
          pacienteId: 10,
          medicoId: 5,
          inicio: FIN,
          fin: INICIO,
        })
    ).toThrow(ReglaDeNegocioViolada);
  });
});

describe("Cita — confirmación", () => {
  let reloj: RelojFalso;

  beforeEach(() => {
    // 48 h antes de la cita
    reloj = new RelojFalso(new Date("2026-11-07T15:00:00.000Z"));
  });

  it("pasa de PROGRAMADA a CONFIRMADA", () => {
    const cita = nuevaCita();
    cita.confirmar(reloj);
    expect(cita.estado).toBe("CONFIRMADA");
  });

  it("deja de admitir recordatorios una vez confirmada", () => {
    const cita = nuevaCita();
    expect(cita.admiteRecordatorios()).toBe(true);
    cita.confirmar(reloj);
    expect(cita.admiteRecordatorios()).toBe(false);
  });

  it("no permite confirmar después de la hora de la cita", () => {
    const cita = nuevaCita();
    reloj.fijar(new Date("2026-11-09T15:00:01.000Z"));
    expect(() => cita.confirmar(reloj)).toThrow(ReglaDeNegocioViolada);
  });

  it("no permite confirmar dos veces", () => {
    const cita = nuevaCita();
    cita.confirmar(reloj);
    expect(() => cita.confirmar(reloj)).toThrow(TransicionInvalida);
  });
});

describe("Cita — cancelación y antelación", () => {
  it("registra motivo, origen y antelación en horas", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T05:00:00.000Z")); // 10 h antes
    cita.cancelar(reloj, "El paciente viaja", "PACIENTE");

    expect(cita.estado).toBe("CANCELADA");
    expect(cita.motivoCancelacion).toBe("El paciente viaja");
    expect(cita.origenCancelacion).toBe("PACIENTE");
    expect(cita.antelacionHoras).toBe(10);
  });

  it("libera el cupo al cancelar", () => {
    const cita = nuevaCita();
    expect(cita.ocupaCupo()).toBe(true);
    cita.cancelar(new RelojFalso(new Date("2026-11-09T05:00:00.000Z")), "motivo");
    expect(cita.ocupaCupo()).toBe(false);
  });

  it("marca el cupo como reasignable si la antelación llega a 4 h", () => {
    const cita = nuevaCita();
    cita.cancelar(new RelojFalso(new Date("2026-11-09T11:00:00.000Z")), "motivo");
    expect(cita.antelacionHoras).toBe(4);
    expect(cita.cupoEsReasignable()).toBe(true);
  });

  it("no considera reasignable un cupo liberado con menos de 4 h", () => {
    const cita = nuevaCita();
    cita.cancelar(new RelojFalso(new Date("2026-11-09T12:00:00.000Z")), "motivo");
    expect(cita.antelacionHoras).toBe(3);
    expect(cita.cupoEsReasignable()).toBe(false);
  });

  it("permite cancelar una cita ya confirmada", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-07T15:00:00.000Z"));
    cita.confirmar(reloj);
    reloj.fijar(new Date("2026-11-09T05:00:00.000Z"));
    cita.cancelar(reloj, "imprevisto");
    expect(cita.estado).toBe("CANCELADA");
  });

  it("no permite cancelar una cita cuya hora ya pasó", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T16:00:00.000Z"));
    expect(() => cita.cancelar(reloj, "tarde")).toThrow(ReglaDeNegocioViolada);
  });
});

describe("Cita — cierre del día", () => {
  it("marca ATENDIDA una vez iniciada la cita", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T15:10:00.000Z"));
    cita.marcarAtendida(reloj);
    expect(cita.estado).toBe("ATENDIDA");
    expect(cita.cerradaEn).toEqual(new Date("2026-11-09T15:10:00.000Z"));
  });

  it("marca AUSENTE una vez terminada la cita", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T15:20:00.000Z"));
    cita.marcarAusente(reloj);
    expect(cita.estado).toBe("AUSENTE");
  });

  it("permite marcar AUSENTE a una cita que había sido confirmada", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-07T15:00:00.000Z"));
    cita.confirmar(reloj);
    reloj.fijar(new Date("2026-11-09T16:00:00.000Z"));
    cita.marcarAusente(reloj);
    expect(cita.estado).toBe("AUSENTE");
  });

  it("no permite marcar AUSENTE antes de que la cita termine", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T15:10:00.000Z"));
    expect(() => cita.marcarAusente(reloj)).toThrow(ReglaDeNegocioViolada);
  });

  it("no permite marcar ATENDIDA antes de que la cita empiece", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-09T14:00:00.000Z"));
    expect(() => cita.marcarAtendida(reloj)).toThrow(ReglaDeNegocioViolada);
  });
});

describe("Cita — integridad de la máquina de estados", () => {
  const reloj = new RelojFalso(new Date("2026-11-09T16:00:00.000Z"));

  it.each<EstadoCita>(["ATENDIDA", "AUSENTE", "CANCELADA", "REPROGRAMADA"])(
    "%s es terminal y no admite ninguna transición",
    (estado) => {
      const cita = nuevaCita(estado);
      expect(cita.esTerminal()).toBe(true);
      expect(() => cita.marcarAtendida(reloj)).toThrow(TransicionInvalida);
      expect(() => cita.marcarAusente(reloj)).toThrow(TransicionInvalida);
    }
  );

  it("una cita cancelada no puede marcarse como ausente", () => {
    // Es la regla que protege el indicador: sin ella, una cancelación
    // se contaría como inasistencia e inflaría la tasa de ausentismo.
    const cita = nuevaCita("CANCELADA");
    expect(() => cita.marcarAusente(reloj)).toThrow(TransicionInvalida);
  });

  it("una cita reprogramada no puede marcarse como ausente", () => {
    const cita = nuevaCita("REPROGRAMADA");
    expect(() => cita.marcarAusente(reloj)).toThrow(TransicionInvalida);
  });

  it("solo PROGRAMADA y CONFIRMADA ocupan cupo", () => {
    expect(nuevaCita("PROGRAMADA").ocupaCupo()).toBe(true);
    expect(nuevaCita("CONFIRMADA").ocupaCupo()).toBe(true);
    expect(nuevaCita("ATENDIDA").ocupaCupo()).toBe(true);
    expect(nuevaCita("AUSENTE").ocupaCupo()).toBe(true);
    expect(nuevaCita("CANCELADA").ocupaCupo()).toBe(false);
    expect(nuevaCita("REPROGRAMADA").ocupaCupo()).toBe(false);
  });
});

describe("Cita — reprogramación", () => {
  it("libera el cupo y conserva la antelación", () => {
    const cita = nuevaCita();
    const reloj = new RelojFalso(new Date("2026-11-08T15:00:00.000Z")); // 24 h antes
    cita.reprogramar(reloj);

    expect(cita.estado).toBe("REPROGRAMADA");
    expect(cita.ocupaCupo()).toBe(false);
    expect(cita.antelacionHoras).toBe(24);
    expect(cita.cupoEsReasignable()).toBe(true);
  });

  it("la cita nueva apunta a la original mediante citaOrigenId", () => {
    const nueva = new Cita({
      id: 2,
      pacienteId: 10,
      medicoId: 5,
      inicio: new Date("2026-11-16T15:00:00.000Z"),
      fin: new Date("2026-11-16T15:20:00.000Z"),
      citaOrigenId: 1,
    });
    expect(nueva.citaOrigenId).toBe(1);
    expect(nueva.estado).toBe("PROGRAMADA");
  });
});
