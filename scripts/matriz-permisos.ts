import {
  puede,
  accionesDe,
  alcanceAgenda,
  type Rol,
  type Accion,
} from "../src/domain/Rol.js";

const ROLES: Rol[] = ["RECEPCIONISTA", "MEDICO", "ADMINISTRADOR"];

// Las acciones se deducen del propio dominio. Escritas a mano, la tabla
// queda muda justo cuando más importa: al agregar un permiso nuevo.
const ACCIONES: Accion[] = [...new Set(ROLES.flatMap((r) => accionesDe(r)))];

const ancho = Math.max(...ACCIONES.map((a) => a.length));
console.log("\n  " + "ACCIÓN".padEnd(ancho) + "  RECEPCIÓN  MÉDICO  DIRECCIÓN");
console.log("  " + "-".repeat(ancho + 30));
for (const accion of ACCIONES) {
  const celdas = ROLES.map((r) => (puede(r, accion) ? "sí" : "—"));
  console.log(
    "  " + accion.padEnd(ancho) +
    "  " + celdas[0]!.padEnd(11) + celdas[1]!.padEnd(8) + celdas[2]
  );
}
console.log("  " + "-".repeat(ancho + 30));
console.log("  " + "ALCANCE DE AGENDA".padEnd(ancho) + "  " +
  ROLES.map((r) => alcanceAgenda(r)).map((a, i) => a.padEnd(i === 0 ? 11 : 8)).join(""));
console.log("");
