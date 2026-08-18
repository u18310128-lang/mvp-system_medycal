import { describe, it, expect } from "vitest";
import {
  puede,
  exigir,
  accionesDe,
  alcanceAgenda,
  PermisoDenegado,
  type Rol,
  type Accion,
} from "../src/domain/Rol.js";

const TODOS: Rol[] = ["RECEPCIONISTA", "MEDICO", "ADMINISTRADOR"];

describe("Rol — recepcionista", () => {
  it("opera la agenda del día completa", () => {
    expect(puede("RECEPCIONISTA", "VER_AGENDA")).toBe(true);
    expect(puede("RECEPCIONISTA", "REGISTRAR_CITA")).toBe(true);
    expect(puede("RECEPCIONISTA", "CONFIRMAR_CITA")).toBe(true);
    expect(puede("RECEPCIONISTA", "CANCELAR_CITA")).toBe(true);
    expect(puede("RECEPCIONISTA", "CERRAR_ASISTENCIA")).toBe(true);
  });

  it("no accede a los indicadores de la investigación", () => {
    expect(puede("RECEPCIONISTA", "VER_INDICADORES")).toBe(false);
    expect(puede("RECEPCIONISTA", "EXPORTAR_DATOS")).toBe(false);
  });

  it("no administra usuarios", () => {
    expect(puede("RECEPCIONISTA", "GESTIONAR_USUARIOS")).toBe(false);
  });
});

describe("Rol — médico", () => {
  it("consulta su agenda y cierra la asistencia", () => {
    expect(puede("MEDICO", "VER_AGENDA")).toBe(true);
    expect(puede("MEDICO", "CERRAR_ASISTENCIA")).toBe(true);
    expect(puede("MEDICO", "GESTIONAR_HORARIOS")).toBe(true);
  });

  it("no registra ni cancela citas: eso es tarea de recepción", () => {
    expect(puede("MEDICO", "REGISTRAR_CITA")).toBe(false);
    expect(puede("MEDICO", "CANCELAR_CITA")).toBe(false);
    expect(puede("MEDICO", "CONFIRMAR_CITA")).toBe(false);
  });

  it("no accede a los indicadores", () => {
    expect(puede("MEDICO", "VER_INDICADORES")).toBe(false);
  });
});

describe("Rol — administrador", () => {
  it("tiene todas las acciones del sistema", () => {
    const acciones = accionesDe("ADMINISTRADOR");
    const otras = new Set<Accion>([
      ...accionesDe("RECEPCIONISTA"),
      ...accionesDe("MEDICO"),
    ]);
    for (const a of otras) expect(acciones).toContain(a);
  });

  it("es el único que ve indicadores y exporta datos", () => {
    for (const rol of TODOS) {
      const esperado = rol === "ADMINISTRADOR";
      expect(puede(rol, "VER_INDICADORES")).toBe(esperado);
      expect(puede(rol, "EXPORTAR_DATOS")).toBe(esperado);
      expect(puede(rol, "GESTIONAR_USUARIOS")).toBe(esperado);
    }
  });
});

describe("Rol — alcance de la agenda", () => {
  it("el médico solo ve su propia agenda", () => {
    // Regla de confidencialidad: la agenda revela qué pacientes atiende
    // cada profesional, y eso no se comparte entre médicos.
    expect(alcanceAgenda("MEDICO")).toBe("PROPIA");
  });

  it("recepción y dirección ven la agenda completa", () => {
    expect(alcanceAgenda("RECEPCIONISTA")).toBe("COMPLETA");
    expect(alcanceAgenda("ADMINISTRADOR")).toBe("COMPLETA");
  });
});

describe("Rol — exigir", () => {
  it("no lanza cuando el permiso existe", () => {
    expect(() => exigir("RECEPCIONISTA", "REGISTRAR_CITA")).not.toThrow();
  });

  it("lanza PermisoDenegado cuando no existe", () => {
    expect(() => exigir("MEDICO", "REGISTRAR_CITA")).toThrow(PermisoDenegado);
  });

  it("el error identifica el rol y la acción denegada", () => {
    try {
      exigir("RECEPCIONISTA", "VER_INDICADORES");
      expect.unreachable("debió lanzar");
    } catch (error) {
      const e = error as PermisoDenegado;
      expect(e.rol).toBe("RECEPCIONISTA");
      expect(e.accion).toBe("VER_INDICADORES");
    }
  });
});

describe("Rol — integridad de la matriz", () => {
  it("ningún rol queda sin permisos", () => {
    for (const rol of TODOS) {
      expect(accionesDe(rol).length).toBeGreaterThan(0);
    }
  });

  it("ningún rol declara una acción repetida", () => {
    for (const rol of TODOS) {
      const acciones = accionesDe(rol);
      expect(new Set(acciones).size).toBe(acciones.length);
    }
  });

  it("todos los roles pueden ver la agenda: es la pantalla base", () => {
    for (const rol of TODOS) {
      expect(puede(rol, "VER_AGENDA")).toBe(true);
    }
  });
});
