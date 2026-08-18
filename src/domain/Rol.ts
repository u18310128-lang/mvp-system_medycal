/**
 * Roles y permisos del sistema.
 *
 * La matriz de permisos es una regla de negocio, no un detalle técnico:
 * define quién puede hacer qué dentro del consultorio. Por eso vive en el
 * dominio y se prueba sin base de datos ni servidor HTTP.
 */

export type Rol = "RECEPCIONISTA" | "MEDICO" | "ADMINISTRADOR";

/**
 * Acciones que el sistema puede autorizar o denegar.
 * Se nombran por lo que la persona hace, no por la ruta técnica.
 */
export type Accion =
  | "VER_AGENDA"
  | "REGISTRAR_CITA"
  | "CONFIRMAR_CITA"
  | "CANCELAR_CITA"
  | "CERRAR_ASISTENCIA"
  | "BUSCAR_PACIENTE"
  | "REGISTRAR_PACIENTE"
  | "VER_INDICADORES"
  | "EXPORTAR_DATOS"
  | "GESTIONAR_USUARIOS"
  | "GESTIONAR_HORARIOS"
  | "VER_CONVERSACIONES";

const PERMISOS: Readonly<Record<Rol, readonly Accion[]>> = {
  RECEPCIONISTA: [
    "VER_AGENDA",
    "REGISTRAR_CITA",
    "CONFIRMAR_CITA",
    "CANCELAR_CITA",
    "CERRAR_ASISTENCIA",
    "BUSCAR_PACIENTE",
    "REGISTRAR_PACIENTE",
    "VER_CONVERSACIONES",
  ],
  MEDICO: [
    "VER_AGENDA",
    "CERRAR_ASISTENCIA",
    "BUSCAR_PACIENTE",
    "GESTIONAR_HORARIOS",
  ],
  ADMINISTRADOR: [
    "VER_AGENDA",
    "REGISTRAR_CITA",
    "CONFIRMAR_CITA",
    "CANCELAR_CITA",
    "CERRAR_ASISTENCIA",
    "BUSCAR_PACIENTE",
    "REGISTRAR_PACIENTE",
    "VER_INDICADORES",
    "EXPORTAR_DATOS",
    "GESTIONAR_USUARIOS",
    "GESTIONAR_HORARIOS",
    // El médico queda afuera a propósito: el hilo del agente incluye
    // conversaciones de pacientes que no son suyos.
    "VER_CONVERSACIONES",
  ],
};

/** ¿El rol tiene permitida esta acción? */
export function puede(rol: Rol, accion: Accion): boolean {
  return PERMISOS[rol].includes(accion);
}

/** Todas las acciones permitidas para un rol. Útil para la interfaz. */
export function accionesDe(rol: Rol): readonly Accion[] {
  return PERMISOS[rol];
}

/**
 * El médico solo ve su propia agenda; recepción y dirección ven la de todos.
 *
 * Es una regla de confidencialidad, no una comodidad de interfaz: la agenda
 * de un profesional revela qué pacientes atiende, y eso es información que
 * no corresponde compartir entre médicos.
 */
export function alcanceAgenda(rol: Rol): "PROPIA" | "COMPLETA" {
  return rol === "MEDICO" ? "PROPIA" : "COMPLETA";
}

export class PermisoDenegado extends Error {
  constructor(
    readonly rol: Rol,
    readonly accion: Accion
  ) {
    super(`El rol ${rol} no tiene permiso para ${accion}.`);
    this.name = "PermisoDenegado";
  }
}

/** Lanza si el rol no puede ejecutar la acción. */
export function exigir(rol: Rol, accion: Accion): void {
  if (!puede(rol, accion)) throw new PermisoDenegado(rol, accion);
}
