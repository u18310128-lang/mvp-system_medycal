import { describe, it, expect } from "vitest";
import {
  puedeAgente,
  accionParaIntencion,
  accionesDeAgente,
  exigirAlcance,
  exigirPropiedadDeLaCita,
  AccesoDenegadoAlAgente,
  DERIVACION_FUERA_DE_ALCANCE,
  type AccionAgente,
} from "../src/domain/AlcanceAgente.js";

const OPERACIONES: AccionAgente[] = [
  "AGENDAR_CITA",
  "REPROGRAMAR_CITA",
  "CANCELAR_CITA",
  "CONFIRMAR_CITA",
  "CONSULTAR_MIS_CITAS",
];

describe("AlcanceAgente — número no identificado", () => {
  it("puede consultar horarios: es información pública", () => {
    expect(puedeAgente("ANONIMO", "CONSULTAR_DISPONIBILIDAD")).toBe(true);
  });

  it("no puede operar sobre ninguna cita", () => {
    for (const accion of OPERACIONES) {
      expect(puedeAgente("ANONIMO", accion)).toBe(false);
    }
  });

  it("al denegarse, explica cómo registrarse en vez de solo negar", () => {
    try {
      exigirAlcance("ANONIMO", "AGENDAR_CITA");
      expect.unreachable("debió lanzar");
    } catch (error) {
      const e = error as AccesoDenegadoAlAgente;
      expect(e).toBeInstanceOf(AccesoDenegadoAlAgente);
      expect(e.mensajeParaElPaciente).toContain("recepción");
      // El texto para el paciente no filtra el nombre interno de la acción.
      expect(e.mensajeParaElPaciente).not.toContain("AGENDAR_CITA");
    }
  });
});

describe("AlcanceAgente — paciente identificado", () => {
  it("puede realizar todas las gestiones del canal", () => {
    for (const accion of OPERACIONES) {
      expect(puedeAgente("PACIENTE_IDENTIFICADO", accion)).toBe(true);
    }
    expect(puedeAgente("PACIENTE_IDENTIFICADO", "CONSULTAR_DISPONIBILIDAD")).toBe(true);
  });

  it("exigirAlcance lo deja pasar", () => {
    expect(() => exigirAlcance("PACIENTE_IDENTIFICADO", "CANCELAR_CITA")).not.toThrow();
  });

  it("el catálogo de acciones cubre todo lo declarado", () => {
    expect(accionesDeAgente("PACIENTE_IDENTIFICADO")).toHaveLength(6);
    expect(accionesDeAgente("ANONIMO")).toEqual(["CONSULTAR_DISPONIBILIDAD"]);
  });
});

describe("AlcanceAgente — la cita tiene que ser propia", () => {
  it("deja operar sobre la cita del propio paciente", () => {
    expect(() => exigirPropiedadDeLaCita(12, 12, "CANCELAR_CITA")).not.toThrow();
  });

  it("rechaza la cita de otro paciente", () => {
    expect(() => exigirPropiedadDeLaCita(99, 12, "CANCELAR_CITA")).toThrow(
      AccesoDenegadoAlAgente
    );
  });

  it("rechaza una cita inexistente", () => {
    expect(() => exigirPropiedadDeLaCita(null, 12, "CANCELAR_CITA")).toThrow(
      AccesoDenegadoAlAgente
    );
  });

  it("rechaza si la conversación no tiene paciente identificado", () => {
    expect(() => exigirPropiedadDeLaCita(12, null, "CANCELAR_CITA")).toThrow(
      AccesoDenegadoAlAgente
    );
  });

  it("no distingue «no es tuya» de «no existe»", () => {
    // Si los mensajes difirieran, probar identificadores permitiría deducir
    // qué citas tiene otra persona.
    const ajena = mensajeDe(() => exigirPropiedadDeLaCita(99, 12, "CANCELAR_CITA"));
    const inexistente = mensajeDe(() => exigirPropiedadDeLaCita(null, 12, "CANCELAR_CITA"));
    expect(ajena).toBe(inexistente);
  });
});

describe("AlcanceAgente — permiso que exige cada intención", () => {
  it("cada gestión sobre citas exige su acción", () => {
    expect(accionParaIntencion("AGENDAR")).toBe("AGENDAR_CITA");
    expect(accionParaIntencion("REPROGRAMAR")).toBe("REPROGRAMAR_CITA");
    expect(accionParaIntencion("CANCELAR")).toBe("CANCELAR_CITA");
    expect(accionParaIntencion("CONFIRMAR")).toBe("CONFIRMAR_CITA");
    expect(accionParaIntencion("CONSULTAR_MIS_CITAS")).toBe("CONSULTAR_MIS_CITAS");
    expect(accionParaIntencion("CONSULTAR_DISPONIBILIDAD")).toBe(
      "CONSULTAR_DISPONIBILIDAD"
    );
  });

  it("conversar no exige permiso alguno", () => {
    expect(accionParaIntencion("SALUDO")).toBeNull();
    expect(accionParaIntencion("DESPEDIDA")).toBeNull();
    expect(accionParaIntencion("FUERA_DE_ALCANCE")).toBeNull();
  });

  it("un número no registrado que quiere cancelar se rechaza al entenderlo", () => {
    // Y no después de preguntarle cuál de sus citas quiere cancelar.
    const accion = accionParaIntencion("CANCELAR");
    expect(accion).not.toBeNull();
    expect(puedeAgente("ANONIMO", accion as AccionAgente)).toBe(false);
  });

  it("ese mismo número sí puede consultar horarios", () => {
    const accion = accionParaIntencion("CONSULTAR_DISPONIBILIDAD");
    expect(puedeAgente("ANONIMO", accion as AccionAgente)).toBe(true);
  });
});

describe("AlcanceAgente — límite del canal", () => {
  it("la derivación ofrece lo que sí puede hacer", () => {
    expect(DERIVACION_FUERA_DE_ALCANCE).toContain("citas");
    expect(DERIVACION_FUERA_DE_ALCANCE).toContain("consultorio");
  });
});

/** Devuelve el mensaje para el paciente de una operación que debe fallar. */
function mensajeDe(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as AccesoDenegadoAlAgente).mensajeParaElPaciente;
  }
  throw new Error("Se esperaba que lanzara.");
}
