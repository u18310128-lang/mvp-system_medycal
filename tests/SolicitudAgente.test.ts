import { describe, it, expect } from "vitest";
import { RelojFalso } from "../src/domain/Reloj.js";
import {
  SolicitudAgente,
  fechaLocal,
  ANTELACION_MAXIMA_DIAS,
  esIntencion,
  esFranja,
} from "../src/domain/SolicitudAgente.js";

/** Miércoles 19 de agosto de 2026, 10:00 en Lima (UTC-5). */
const AHORA = new Date("2026-08-19T15:00:00Z");
const reloj = (): RelojFalso => new RelojFalso(AHORA);

describe("SolicitudAgente — qué falta preguntar", () => {
  it("sin intención, lo primero que falta es la intención", () => {
    const s = new SolicitudAgente();
    expect(s.faltantes()).toEqual(["intencion"]);
    expect(s.completa()).toBe(false);
    expect(s.siguientePregunta()).toContain("¿En qué te puedo ayudar?");
  });

  it("para consultar disponibilidad hacen falta especialidad y fecha", () => {
    const s = new SolicitudAgente({ intencion: "CONSULTAR_DISPONIBILIDAD" });
    expect(s.faltantes()).toEqual(["especialidad", "fecha"]);
    expect(s.siguientePregunta()).toContain("especialidad");
  });

  it("la franja nunca bloquea: si no la dicen, se asume CUALQUIERA", () => {
    const s = new SolicitudAgente({
      intencion: "CONSULTAR_DISPONIBILIDAD",
      especialidad: "Medicina General",
      fecha: "2026-08-20",
    });
    expect(s.completa()).toBe(true);
    expect(s.franja).toBe("CUALQUIERA");
    expect(s.franjaFueExplicita()).toBe(false);
  });

  it("cancelar solo necesita saber cuál es la cita", () => {
    expect(new SolicitudAgente({ intencion: "CANCELAR" }).faltantes()).toEqual(["citaId"]);
    expect(
      new SolicitudAgente({ intencion: "CANCELAR", citaId: 41 }).completa()
    ).toBe(true);
  });

  it("reprogramar necesita la cita y la fecha nueva", () => {
    const s = new SolicitudAgente({ intencion: "REPROGRAMAR", citaId: 41 });
    expect(s.faltantes()).toEqual(["fecha"]);
  });

  it("saludar, despedirse y salir del alcance no requieren datos", () => {
    expect(new SolicitudAgente({ intencion: "SALUDO" }).completa()).toBe(true);
    expect(new SolicitudAgente({ intencion: "DESPEDIDA" }).completa()).toBe(true);
    expect(new SolicitudAgente({ intencion: "FUERA_DE_ALCANCE" }).completa()).toBe(true);
  });
});

describe("SolicitudAgente — memoria de la conversación", () => {
  it("acumula lo que el paciente va diciendo turno a turno", () => {
    const s = new SolicitudAgente()
      .actualizar({ intencion: "AGENDAR" })
      .actualizar({ especialidad: "Medicina General" })
      .actualizar({ fecha: "2026-08-20", franja: "MANANA" });

    expect(s.completa()).toBe(true);
    expect(s.especialidad).toBe("Medicina General");
    expect(s.franja).toBe("MANANA");
  });

  it("cambiar de día conserva la especialidad ya dada", () => {
    // «No puedo el jueves, ¿tenés algo el viernes temprano?»
    const inicial = new SolicitudAgente({
      intencion: "AGENDAR",
      especialidad: "Medicina General",
      fecha: "2026-08-20",
      franja: "TARDE",
    });

    const corregida = inicial.actualizar({ fecha: "2026-08-21", franja: "MANANA" });

    expect(corregida.especialidad).toBe("Medicina General");
    expect(corregida.fecha).toBe("2026-08-21");
    expect(corregida.franja).toBe("MANANA");
  });

  it("un dato ausente no borra lo anterior", () => {
    const s = new SolicitudAgente({
      intencion: "AGENDAR",
      especialidad: "Medicina General",
    }).actualizar({ fecha: "2026-08-20" });

    expect(s.especialidad).toBe("Medicina General");
  });

  it("la instancia original no se modifica", () => {
    const inicial = new SolicitudAgente({ intencion: "AGENDAR" });
    inicial.actualizar({ especialidad: "Medicina General" });
    expect(inicial.especialidad).toBeNull();
  });

  it("reiniciar limpia la gestión anterior", () => {
    const s = new SolicitudAgente({
      intencion: "AGENDAR",
      especialidad: "Medicina General",
      fecha: "2026-08-20",
    }).reiniciar("CONSULTAR_MIS_CITAS");

    expect(s.intencion).toBe("CONSULTAR_MIS_CITAS");
    expect(s.fecha).toBeNull();
    expect(s.especialidad).toBeNull();
  });
});

describe("SolicitudAgente — persistencia del contexto", () => {
  it("sobrevive a la ida y vuelta por JSONB", () => {
    const original = new SolicitudAgente({
      intencion: "AGENDAR",
      especialidad: "Medicina General",
      fecha: "2026-08-20",
      franja: "TARDE",
      citaId: 7,
    });

    const revivida = SolicitudAgente.desde(
      JSON.parse(JSON.stringify(original.instantanea()))
    );

    expect(revivida.instantanea()).toEqual(original.instantanea());
  });

  it("descarta un contexto corrupto en vez de fallar", () => {
    const s = SolicitudAgente.desde({
      intencion: "BORRAR_TODO",
      fecha: "el jueves",
      franja: "MADRUGADA",
      citaId: "41",
    });

    expect(s.intencion).toBeNull();
    expect(s.fecha).toBeNull();
    expect(s.citaId).toBeNull();
    expect(s.franja).toBe("CUALQUIERA");
  });

  it("tolera null y valores que no son objetos", () => {
    expect(SolicitudAgente.desde(null).intencion).toBeNull();
    expect(SolicitudAgente.desde("hola").intencion).toBeNull();
  });
});

describe("SolicitudAgente — validez de la fecha", () => {
  it("acepta una fecha próxima", () => {
    const s = new SolicitudAgente({ intencion: "AGENDAR", fecha: "2026-08-20" });
    expect(s.problemaConLaFecha(reloj())).toBeNull();
  });

  it("rechaza una fecha que ya pasó y explica por qué", () => {
    const s = new SolicitudAgente({ intencion: "AGENDAR", fecha: "2026-08-18" });
    expect(s.problemaConLaFecha(reloj())).toContain("ya pasó");
  });

  it("acepta hoy mismo", () => {
    const s = new SolicitudAgente({ intencion: "AGENDAR", fecha: "2026-08-19" });
    expect(s.problemaConLaFecha(reloj())).toBeNull();
    expect(s.esParaHoy(reloj())).toBe(true);
  });

  it("rechaza más allá de la antelación máxima", () => {
    const lejos = new Date(AHORA.getTime() + (ANTELACION_MAXIMA_DIAS + 5) * 86_400_000);
    const s = new SolicitudAgente({ intencion: "AGENDAR", fecha: fechaLocal(lejos) });
    expect(s.problemaConLaFecha(reloj())).toContain(String(ANTELACION_MAXIMA_DIAS));
  });

  it("rechaza un texto que no es una fecha", () => {
    const s = new SolicitudAgente({ intencion: "AGENDAR", fecha: "mañana" });
    expect(s.problemaConLaFecha(reloj())).toContain("No entendí");
  });

  it("no opina si todavía no hay fecha", () => {
    expect(new SolicitudAgente({ intencion: "AGENDAR" }).problemaConLaFecha(reloj()))
      .toBeNull();
  });
});

describe("fechaLocal — la zona del consultorio, no UTC", () => {
  it("a las 20:00 de Lima sigue siendo el mismo día", () => {
    // 2026-08-19 20:00 en Lima es 2026-08-20 01:00 UTC.
    const nocheEnLima = new Date("2026-08-20T01:00:00Z");
    expect(fechaLocal(nocheEnLima)).toBe("2026-08-19");
    expect(nocheEnLima.toISOString().slice(0, 10)).toBe("2026-08-20"); // el error que evita
  });
});

describe("guardas de tipo", () => {
  it("reconocen los valores válidos", () => {
    expect(esIntencion("AGENDAR")).toBe(true);
    expect(esIntencion("AGENDAR_YA")).toBe(false);
    expect(esFranja("MANANA")).toBe(true);
    expect(esFranja("NOCHE")).toBe(false);
  });
});
