import { hash, verify, Algorithm } from "@node-rs/argon2";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Manejo de contraseñas y tokens.
 *
 * Argon2id es el algoritmo recomendado hoy para contraseñas: resiste tanto
 * los ataques con GPU como los que usan hardware dedicado, porque exige
 * memoria además de tiempo de cómputo (RNF-06).
 */

const OPCIONES_ARGON = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB — mínimo sugerido por OWASP
  timeCost: 2,
  parallelism: 1,
};

/** Calcula el resumen de una contraseña para almacenarlo. */
export function hashearPassword(password: string): Promise<string> {
  return hash(password, OPCIONES_ARGON);
}

const SILABAS = [
  "ka", "re", "mi", "to", "sa", "lu", "pe", "no", "ti", "ma",
  "ve", "ro", "chi", "fa", "gu", "nel", "bri", "cor", "dan", "tur",
];

/**
 * Contraseña inicial legible pero no adivinable: cuatro sílabas y tres
 * dígitos, sorteados con el generador criptográfico.
 *
 * Se dicta por teléfono sin deletrear y se escribe sin errores, que es lo
 * que hace que la persona no termine anotándola en un papel pegado al
 * monitor. Es de un solo uso: quien la recibe debería cambiarla.
 */
export function generarPasswordLegible(): string {
  const bytes = randomBytes(5);
  const partes = Array.from(
    { length: 4 },
    (_, i) => SILABAS[bytes[i]! % SILABAS.length]!
  );
  return partes.join("") + String(100 + (bytes[4]! % 900));
}

/**
 * Verifica una contraseña contra su resumen almacenado.
 * Nunca lanza: un resumen corrupto o vacío devuelve false.
 */
export async function verificarPassword(
  resumen: string,
  password: string
): Promise<boolean> {
  try {
    return await verify(resumen, password, OPCIONES_ARGON);
  } catch {
    return false;
  }
}

/**
 * Genera un token de sesión aleatorio de 256 bits.
 *
 * Se devuelve el valor en claro, que viaja en la cookie, y su resumen, que
 * es lo único que se guarda. Así una filtración de la base no permite
 * suplantar sesiones activas (RNF-07).
 */
export function generarToken(): { token: string; resumen: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, resumen: resumir(token) };
}

/** SHA-256 en hexadecimal. Usado para tokens de sesión y claves de servicio. */
export function resumir(valor: string): string {
  return createHash("sha256").update(valor).digest("hex");
}

/**
 * Compara dos cadenas en tiempo constante.
 *
 * Una comparación normal corta en el primer carácter distinto, y ese
 * detalle de tiempo permite deducir el valor correcto carácter por
 * carácter. Se usa para las claves de servicio.
 */
export function comparaSegura(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Retardo mínimo para las respuestas de acceso fallido.
 *
 * Sin esto, un intento con correo inexistente responde más rápido que uno
 * con correo válido y contraseña incorrecta, lo que permite averiguar qué
 * cuentas existen.
 */
export function esperarMinimo(desdeMs: number, minimoMs = 400): Promise<void> {
  const restante = minimoMs - (performance.now() - desdeMs);
  return restante > 0
    ? new Promise((r) => setTimeout(r, restante))
    : Promise.resolve();
}
