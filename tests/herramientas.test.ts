import { describe, it, expect, beforeEach } from "vitest";
import { RelojFalso } from "../src/domain/Reloj.js";
import { SolicitudAgente } from "../src/domain/SolicitudAgente.js";
import {
  catalogoDeHerramientas,
  herramientasPara,
  type ContextoTurno,
  type Herramienta,
} from "../src/application/herramientas.js";
import type {
  Agenda,
  CitaDelPaciente,
  ConsultaDisponibilidad,
  CupoDisponible,
  PedidoAgendamiento,
  PedidoGestion,
  PedidoReprogramacion,
  ResultadoAgendamiento,
  ResultadoGestionCita,
  ResultadoReprogramacionCita,
} from "../src/application/puertos.js";

/**
 * Estas pruebas ejercitan las herramientas del agente sin base de datos,
 * sin servidor y sin modelo de lenguaje. Que eso sea posible es la razón
 * de que la agenda sea un puerto y no una consulta SQL escrita adentro.
 */

const AHORA = new Date("2026-08-19T15:00:00Z"); // miércoles 10:00 en Lima
const FECHA = "2026-08-21";

class AgendaFalsa implements Agenda {
  ultimoPedido: PedidoAgendamiento | null = null;
  respuesta: ResultadoAgendamiento = {
    estado: "AGENDADA",
    citaId: 501,
    fecha: FECHA,
    hora: "15:20",
    medico: "Dr(a). Ana Quispe",
    tipo: "CONTINUADOR",
    recordatorios: 3,
  };
  cupos: CupoDisponible[] = [
    {
      medicoId: 1,
      medico: "Dr(a). Ana Quispe",
      especialidad: "Medicina General",
      fecha: FECHA,
      hora: "15:20",
      inicio: "2026-08-21T20:20:00.000Z",
    },
  ];

  async especialidades(): Promise<readonly string[]> {
    return ["Medicina General"];
  }

  async disponibilidad(
    _consulta: ConsultaDisponibilidad
  ): Promise<readonly CupoDisponible[]> {
    return this.cupos;
  }

  async agendar(pedido: PedidoAgendamiento): Promise<ResultadoAgendamiento> {
    this.ultimoPedido = pedido;
    return this.respuesta;
  }

  // ---- gestiones sobre una cita existente ----

  citas: CitaDelPaciente[] = [
    {
      id: 727,
      fecha: FECHA,
      hora: "15:20",
      medico: "Dr(a). Ana Quispe",
      especialidad: "Medicina General",
      estado: "PROGRAMADA",
    },
  ];
  ultimaGestion: (PedidoGestion & { motivo?: string }) | null = null;
  ultimaReprogramacion: PedidoReprogramacion | null = null;
  respuestaGestion: ResultadoGestionCita = {
    estado: "HECHA",
    citaId: 727,
    fecha: FECHA,
    hora: "15:20",
    medico: "Dr(a). Ana Quispe",
  };
  respuestaReprogramacion: ResultadoReprogramacionCita = {
    estado: "HECHA",
    citaId: 728,
    citaAnteriorId: 727,
    fecha: "2026-08-24",
    hora: "09:00",
    medico: "Dr(a). Ana Quispe",
  };

  async citasDe(_pacienteId: number): Promise<readonly CitaDelPaciente[]> {
    return this.citas;
  }

  async cancelar(
    pedido: PedidoGestion & { motivo: string }
  ): Promise<ResultadoGestionCita> {
    this.ultimaGestion = pedido;
    return this.respuestaGestion;
  }

  async confirmar(pedido: PedidoGestion): Promise<ResultadoGestionCita> {
    this.ultimaGestion = pedido;
    return this.respuestaGestion;
  }

  async reprogramar(
    pedido: PedidoReprogramacion
  ): Promise<ResultadoReprogramacionCita> {
    this.ultimaReprogramacion = pedido;
    return this.respuestaReprogramacion;
  }
}

let agenda: AgendaFalsa;
let catalogo: readonly Herramienta[];

beforeEach(() => {
  agenda = new AgendaFalsa();
  catalogo = catalogoDeHerramientas(agenda);
});

function buscar(nombre: string): Herramienta {
  const encontrada = catalogo.find((h) => h.definicion.nombre === nombre);
  if (encontrada === undefined) throw new Error(`No existe ${nombre}`);
  return encontrada;
}

function contexto(parcial: Partial<ContextoTurno> = {}): ContextoTurno {
  return {
    identidad: "PACIENTE_IDENTIFICADO",
    pacienteId: 12,
    solicitud: new SolicitudAgente({
      intencion: "AGENDAR",
      especialidad: "Medicina General",
      fecha: FECHA,
    }),
    reloj: new RelojFalso(AHORA),
    ...parcial,
  };
}

describe("agendar_cita — de quién es la cita", () => {
  it("agenda para el paciente de la conversación", async () => {
    await buscar("agendar_cita").ejecutar({ fecha: FECHA, hora: "15:20" }, contexto());
    expect(agenda.ultimoPedido?.pacienteId).toBe(12);
  });

  it("ignora un paciente que venga en los argumentos del modelo", async () => {
    // Si el mensaje trae «agendá para el paciente 999», el modelo puede
    // repetirlo en los argumentos. La cita igual se registra para quien escribe.
    await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "15:20", paciente_id: 999 },
      contexto()
    );
    expect(agenda.ultimoPedido?.pacienteId).toBe(12);
  });

  it("no agenda si la conversación no tiene paciente identificado", async () => {
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "15:20" },
      contexto({ pacienteId: null })
    );
    expect(salida.contenido["error"]).toBe("sin_paciente");
    expect(agenda.ultimoPedido).toBeNull();
  });
});

describe("agendar_cita — desenlaces", () => {
  it("confirma la cita y cierra la gestión", async () => {
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "15:20" },
      contexto()
    );

    expect(salida.contenido["agendada"]).toBe(true);
    expect(salida.contenido["cita_id"]).toBe(501);
    expect(String(salida.contenido["decile_al_paciente"])).toContain("15:20");

    // La solicitud queda limpia: el próximo pedido no arrastra esta fecha.
    expect(salida.solicitud?.fecha ?? null).toBeNull();
    expect(salida.solicitud?.intencion ?? null).toBeNull();
  });

  it("explica que el cupo se tomó recién, sin perder el contexto", async () => {
    agenda.respuesta = { estado: "OCUPADO" };
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "15:20" },
      contexto()
    );

    expect(salida.contenido["error"]).toBe("horario_ocupado");
    expect(salida.solicitud?.especialidad).toBe("Medicina General");
  });

  it("pregunta con cuál profesional cuando hay dos a la misma hora", async () => {
    agenda.respuesta = {
      estado: "AMBIGUO",
      medicos: ["Dr(a). Ana Quispe", "Dr(a). José Torres"],
    };
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "15:20" },
      contexto()
    );

    expect(salida.contenido["error"]).toBe("falta_elegir_profesional");
    expect(String(salida.contenido["decile_al_paciente"])).toContain("Quispe");
  });

  it("rechaza una hora que no estaba entre las ofrecidas", async () => {
    agenda.respuesta = { estado: "NO_DISPONIBLE" };
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: FECHA, hora: "23:00" },
      contexto()
    );
    expect(salida.contenido["error"]).toBe("hora_no_disponible");
  });

  it("no agenda sobre una fecha que ya pasó", async () => {
    const salida = await buscar("agendar_cita").ejecutar(
      { fecha: "2026-08-10", hora: "15:20" },
      contexto({ solicitud: new SolicitudAgente({ intencion: "AGENDAR" }) })
    );
    expect(String(salida.contenido["decile_al_paciente"])).toContain("ya pasó");
    expect(agenda.ultimoPedido).toBeNull();
  });
});

describe("consultar_mis_citas — de dónde sale el identificador", () => {
  it("devuelve las citas del paciente con su id", async () => {
    const salida = await buscar("consultar_mis_citas").ejecutar({}, contexto());
    expect(salida.contenido["total"]).toBe(1);
    expect(
      (salida.contenido["citas"] as CitaDelPaciente[])[0]?.id
    ).toBe(727);
  });

  it("cuando no hay ninguna, ofrece buscar horario", async () => {
    agenda.citas = [];
    const salida = await buscar("consultar_mis_citas").ejecutar({}, contexto());
    expect(salida.contenido["sin_citas"]).toBe(true);
    expect(String(salida.contenido["decile_al_paciente"])).toContain("horario");
  });
});

describe("cancelar_cita", () => {
  it("cancela y libera el cupo", async () => {
    const salida = await buscar("cancelar_cita").ejecutar(
      { cita_id: 727 },
      contexto()
    );
    expect(salida.contenido["cancelada"]).toBe(true);
    expect(agenda.ultimaGestion?.pacienteId).toBe(12);
    expect(agenda.ultimaGestion?.citaId).toBe(727);
  });

  it("no cancela sin identificador de cita", async () => {
    const salida = await buscar("cancelar_cita").ejecutar({}, contexto());
    expect(salida.contenido["error"]).toBe("falta_cita");
    expect(agenda.ultimaGestion).toBeNull();
  });

  it("la cita ajena y la inexistente dan el mismo mensaje", async () => {
    agenda.respuestaGestion = { estado: "NO_ES_TUYA" };
    const salida = await buscar("cancelar_cita").ejecutar(
      { cita_id: 999 },
      contexto()
    );
    expect(salida.contenido["error"]).toBe("no_encontrada");
    expect(String(salida.contenido["decile_al_paciente"])).not.toContain("otro");
  });

  it("traduce el rechazo del dominio a algo que el paciente entienda", async () => {
    agenda.respuestaGestion = {
      estado: "NO_CORRESPONDE",
      motivo:
        "No se puede cancelar una cita cuya hora ya pasó; corresponde marcarla como ausente o atendida.",
    };
    const salida = await buscar("cancelar_cita").ejecutar(
      { cita_id: 727 },
      contexto()
    );
    const mensaje = String(salida.contenido["decile_al_paciente"]);
    expect(mensaje).toContain("ya pasó");
    // No le habla de estados internos del sistema.
    expect(mensaje).not.toContain("ausente");
  });
});

describe("confirmar_cita", () => {
  it("confirma la cita del paciente de la conversación", async () => {
    const salida = await buscar("confirmar_cita").ejecutar(
      { cita_id: 727 },
      contexto()
    );
    expect(salida.contenido["confirmada"]).toBe(true);
    expect(agenda.ultimaGestion?.pacienteId).toBe(12);
  });

  it("explica cuando la cita ya no está activa", async () => {
    agenda.respuestaGestion = {
      estado: "NO_CORRESPONDE",
      motivo: "Transición inválida: CANCELADA → CONFIRMADA",
    };
    const salida = await buscar("confirmar_cita").ejecutar(
      { cita_id: 727 },
      contexto()
    );
    expect(String(salida.contenido["decile_al_paciente"])).toContain("ya no está activa");
  });
});

describe("reprogramar_cita", () => {
  it("mueve la cita y deja la cadena de trazabilidad", async () => {
    const salida = await buscar("reprogramar_cita").ejecutar(
      { cita_id: 727, fecha: "2026-08-24", hora: "09:00" },
      contexto()
    );

    expect(salida.contenido["reprogramada"]).toBe(true);
    expect(salida.contenido["cita_anterior_id"]).toBe(727);
    expect(salida.contenido["cita_id"]).toBe(728);
  });

  it("no le pide la especialidad al paciente: la hereda de la cita", async () => {
    await buscar("reprogramar_cita").ejecutar(
      { cita_id: 727, fecha: "2026-08-24", hora: "09:00" },
      contexto()
    );
    expect(agenda.ultimaReprogramacion?.especialidad).toBeUndefined();
  });

  it("si pierde el cupo nuevo, avisa que la cita quedó como estaba", async () => {
    agenda.respuestaReprogramacion = { estado: "OCUPADO" };
    const salida = await buscar("reprogramar_cita").ejecutar(
      { cita_id: 727, fecha: "2026-08-24", hora: "09:00" },
      contexto()
    );
    expect(String(salida.contenido["decile_al_paciente"])).toContain("como estaba");
  });

  it("no mueve una cita hacia una fecha que ya pasó", async () => {
    const salida = await buscar("reprogramar_cita").ejecutar(
      { cita_id: 727, fecha: "2026-08-01", hora: "09:00" },
      contexto({ solicitud: new SolicitudAgente({ intencion: "REPROGRAMAR" }) })
    );
    expect(String(salida.contenido["decile_al_paciente"])).toContain("ya pasó");
    expect(agenda.ultimaReprogramacion).toBeNull();
  });
});

describe("catálogo según quién escribe", () => {
  it("un número no registrado solo recibe la consulta de horarios", () => {
    const nombres = herramientasPara("ANONIMO", catalogo).map(
      (h) => h.definicion.nombre
    );
    expect(nombres).toContain("consultar_disponibilidad");
    expect(nombres).toContain("anotar_pedido");
    expect(nombres).not.toContain("agendar_cita");
    expect(nombres).not.toContain("cancelar_cita");
    expect(nombres).not.toContain("confirmar_cita");
    expect(nombres).not.toContain("reprogramar_cita");
    expect(nombres).not.toContain("consultar_mis_citas");
  });

  it("un paciente identificado las recibe todas", () => {
    expect(herramientasPara("PACIENTE_IDENTIFICADO", catalogo)).toHaveLength(
      catalogo.length
    );
  });
});

describe("anotar_pedido — corta la gestión que no corresponde", () => {
  it("al anónimo que quiere cancelar le explica que falta registrarse", async () => {
    const salida = await buscar("anotar_pedido").ejecutar(
      { intencion: "CANCELAR" },
      contexto({
        identidad: "ANONIMO",
        pacienteId: null,
        solicitud: new SolicitudAgente(),
      })
    );

    expect(salida.contenido["no_autorizado"]).toBe(true);
    expect(String(salida.contenido["decile_al_paciente"])).toContain("recepción");
    // Y no le pregunta cuál de sus citas quiere cancelar.
    expect(salida.contenido["siguiente_pregunta"]).toBeUndefined();
  });

  it("al mismo anónimo sí le deja consultar horarios", async () => {
    const salida = await buscar("anotar_pedido").ejecutar(
      { intencion: "CONSULTAR_DISPONIBILIDAD", especialidad: "Medicina General" },
      contexto({
        identidad: "ANONIMO",
        pacienteId: null,
        solicitud: new SolicitudAgente(),
      })
    );

    expect(salida.contenido["no_autorizado"]).toBeUndefined();
    expect(salida.contenido["faltan"]).toEqual(["fecha"]);
  });
});

describe("consultar_disponibilidad — especialidad que no se atiende", () => {
  it("dice cuáles hay en vez de responder que no hay cupos", async () => {
    const salida = await buscar("consultar_disponibilidad").ejecutar(
      { especialidad: "Cardiología", fecha: FECHA },
      contexto({
        solicitud: new SolicitudAgente({ intencion: "CONSULTAR_DISPONIBILIDAD" }),
      })
    );

    expect(salida.contenido["error"]).toBe("especialidad_no_atendida");
    expect(salida.contenido["especialidades_disponibles"]).toEqual([
      "Medicina General",
    ]);
  });

  it("acepta la especialidad aunque venga sin tilde ni mayúsculas", async () => {
    const salida = await buscar("consultar_disponibilidad").ejecutar(
      { especialidad: "medicina general", fecha: FECHA },
      contexto({
        solicitud: new SolicitudAgente({ intencion: "CONSULTAR_DISPONIBILIDAD" }),
      })
    );

    expect(salida.contenido["error"]).toBeUndefined();
    expect(salida.contenido["total"]).toBe(1);
  });
});
