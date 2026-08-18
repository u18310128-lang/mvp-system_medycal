import { describe, it, expect } from "vitest";
import { RelojFalso } from "../src/domain/Reloj.js";
import { Cita } from "../src/domain/Cita.js";
import {
  PoliticaRecordatorios,
  type Hito,
} from "../src/domain/PoliticaRecordatorios.js";

const INICIO = new Date("2026-11-09T15:00:00.000Z");
const FIN = new Date("2026-11-09T15:20:00.000Z");

function cita(): Cita {
  return new Cita({ id: 7, pacienteId: 10, medicoId: 5, inicio: INICIO, fin: FIN });
}

const politica = new PoliticaRecordatorios();

describe("PoliticaRecordatorios — secuencia completa", () => {
  it("programa los tres hitos cuando hay más de 48 h de antelación", () => {
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z")); // 7 días antes
    const envios = politica.calcularEnvios(cita(), reloj);

    expect(envios.map((e) => e.hito)).toEqual<Hito[]>(["T_48H", "T_24H", "T_3H"]);
  });

  it("calcula correctamente cada instante de disparo", () => {
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));
    const envios = politica.calcularEnvios(cita(), reloj);

    expect(envios[0]!.programadoPara).toEqual(new Date("2026-11-07T15:00:00.000Z"));
    expect(envios[1]!.programadoPara).toEqual(new Date("2026-11-08T15:00:00.000Z"));
    expect(envios[2]!.programadoPara).toEqual(new Date("2026-11-09T12:00:00.000Z"));
  });

  it("usa WhatsApp por defecto", () => {
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));
    const envios = politica.calcularEnvios(cita(), reloj);
    expect(envios.every((e) => e.canal === "WHATSAPP")).toBe(true);
  });

  it("respeta el canal preferido del paciente", () => {
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));
    const envios = politica.calcularEnvios(cita(), reloj, { canalPreferido: "SMS" });
    expect(envios.every((e) => e.canal === "SMS")).toBe(true);
  });
});

describe("PoliticaRecordatorios — hitos ya vencidos", () => {
  // Esta es la regla que evita el peor defecto operativo del sistema:
  // registrar una cita para mañana y que el paciente reciba de golpe los
  // tres mensajes de la secuencia.

  it("omite T-48h si la cita se registra con menos de 48 h de antelación", () => {
    const reloj = new RelojFalso(new Date("2026-11-08T15:00:00.000Z")); // 24 h antes
    const envios = politica.calcularEnvios(cita(), reloj);
    expect(envios.map((e) => e.hito)).toEqual<Hito[]>(["T_3H"]);
  });

  it("omite T-48h y T-24h si se registra con 25 h de antelación", () => {
    const reloj = new RelojFalso(new Date("2026-11-08T14:00:00.000Z")); // 25 h antes
    const envios = politica.calcularEnvios(cita(), reloj);
    expect(envios.map((e) => e.hito)).toEqual<Hito[]>(["T_24H", "T_3H"]);
  });

  it("no programa nada si la cita es dentro de menos de 3 h", () => {
    const reloj = new RelojFalso(new Date("2026-11-09T13:00:00.000Z")); // 2 h antes
    expect(politica.calcularEnvios(cita(), reloj)).toEqual([]);
  });

  it("no programa nada si la hora de la cita ya pasó", () => {
    const reloj = new RelojFalso(new Date("2026-11-09T16:00:00.000Z"));
    expect(politica.calcularEnvios(cita(), reloj)).toEqual([]);
  });

  it("un hito que cae exactamente en el instante actual no se programa", () => {
    const reloj = new RelojFalso(new Date("2026-11-07T15:00:00.000Z")); // justo T-48h
    const envios = politica.calcularEnvios(cita(), reloj);
    expect(envios.map((e) => e.hito)).toEqual<Hito[]>(["T_24H", "T_3H"]);
  });
});

describe("PoliticaRecordatorios — citas que no admiten recordatorios", () => {
  const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));

  it("no programa nada para una cita ya confirmada", () => {
    const c = cita();
    c.confirmar(reloj);
    expect(politica.calcularEnvios(c, reloj)).toEqual([]);
  });

  it("no programa nada para una cita cancelada", () => {
    const c = cita();
    c.cancelar(reloj, "motivo");
    expect(politica.calcularEnvios(c, reloj)).toEqual([]);
  });

  it("no programa nada para una cita reprogramada", () => {
    const c = cita();
    c.reprogramar(reloj);
    expect(politica.calcularEnvios(c, reloj)).toEqual([]);
  });
});

describe("PoliticaRecordatorios — idempotencia", () => {
  it("genera una clave única por cita, hito y canal", () => {
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));
    const envios = politica.calcularEnvios(cita(), reloj);
    const claves = envios.map((e) => e.claveIdempotencia);

    expect(claves).toEqual([
      "cita:7:T_48H:WHATSAPP",
      "cita:7:T_24H:WHATSAPP",
      "cita:7:T_3H:WHATSAPP",
    ]);
    expect(new Set(claves).size).toBe(3);
  });

  it("la clave es estable entre invocaciones sucesivas", () => {
    // Si la cola reintenta el trabajo, la clave debe ser idéntica para que
    // choque contra la restricción UNIQUE y no genere un segundo mensaje.
    const reloj = new RelojFalso(new Date("2026-11-02T15:00:00.000Z"));
    const primera = politica.calcularEnvios(cita(), reloj);
    const segunda = politica.calcularEnvios(cita(), reloj);

    expect(primera.map((e) => e.claveIdempotencia)).toEqual(
      segunda.map((e) => e.claveIdempotencia)
    );
  });

  it("distingue el canal en la clave", () => {
    expect(PoliticaRecordatorios.clave(7, "T_24H", "WHATSAPP")).not.toBe(
      PoliticaRecordatorios.clave(7, "T_24H", "SMS")
    );
  });
});

describe("PoliticaRecordatorios — suspensión de hitos pendientes", () => {
  it("al confirmar conserva el recordatorio del mismo día", () => {
    const suspender = politica.hitosASuspenderTrasConfirmar();
    expect(suspender).toEqual<Hito[]>(["T_48H", "T_24H"]);
    expect(suspender).not.toContain("T_3H");
  });

  it("al cancelar suspende la secuencia completa", () => {
    expect(politica.hitosASuspenderTrasCancelar()).toEqual<Hito[]>([
      "T_48H",
      "T_24H",
      "T_3H",
    ]);
  });
});
