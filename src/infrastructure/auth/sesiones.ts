import { consultar, consultarUna, pool } from "../db/pool.js";
import { generarToken, resumir } from "./credenciales.js";
import type { Rol } from "../../domain/Rol.js";

export interface UsuarioSesion {
  readonly id: number;
  readonly email: string;
  readonly nombres: string;
  readonly rol: Rol;
  /** Identificador del médico, cuando el usuario es un profesional. */
  readonly medicoId: number | null;
}

/** Duración de la sesión: una jornada de trabajo con margen. */
const HORAS_VIGENCIA = 12;

/** Crea una sesión y devuelve el token que viajará en la cookie. */
export async function abrirSesion(
  usuarioId: number,
  ip: string | null,
  userAgent: string | null
): Promise<string> {
  const { token, resumen } = generarToken();

  await pool.query(
    `INSERT INTO sesion (usuario_id, token_hash, expira_en, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4::inet, $5)`,
    [usuarioId, resumen, String(HORAS_VIGENCIA), ip, userAgent?.slice(0, 300) ?? null]
  );

  return token;
}

/**
 * Resuelve el usuario a partir del token de la cookie.
 * Devuelve null si la sesión no existe, venció o fue cerrada.
 */
export async function usuarioDeSesion(
  token: string | undefined
): Promise<UsuarioSesion | null> {
  if (!token) return null;

  const fila = await consultarUna(
    `UPDATE sesion s
     SET ultima_actividad = now()
     FROM usuario u
     WHERE s.token_hash = $1
       AND s.usuario_id = u.id
       AND s.cerrada_en IS NULL
       AND s.expira_en > now()
       AND u.activo
     RETURNING u.id, u.email, u.nombres, u.rol,
               (SELECT m.id FROM medico m WHERE m.usuario_id = u.id) AS medico_id`,
    [resumir(token)]
  );

  if (!fila) return null;

  return {
    id: Number(fila["id"]),
    email: fila["email"],
    nombres: fila["nombres"],
    rol: fila["rol"] as Rol,
    medicoId: fila["medico_id"] === null ? null : Number(fila["medico_id"]),
  };
}

/** Cierra la sesión indicada. */
export async function cerrarSesion(token: string | undefined): Promise<void> {
  if (!token) return;
  await pool.query(
    `UPDATE sesion SET cerrada_en = now()
     WHERE token_hash = $1 AND cerrada_en IS NULL`,
    [resumir(token)]
  );
}

/** Cierra todas las sesiones de un usuario. Se usa al desactivar una cuenta. */
export async function cerrarSesionesDe(usuarioId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE sesion SET cerrada_en = now()
     WHERE usuario_id = $1 AND cerrada_en IS NULL`,
    [usuarioId]
  );
  return rowCount ?? 0;
}

/**
 * Intentos fallidos recientes para un correo.
 * Se usa para frenar el ensayo sistemático de contraseñas.
 */
export async function intentosFallidosRecientes(
  email: string,
  minutos = 15
): Promise<number> {
  const fila = await consultarUna(
    `SELECT count(*)::int AS total
     FROM intento_acceso
     WHERE email = $1
       AND NOT exitoso
       AND ocurrido_en > now() - ($2 || ' minutes')::interval`,
    [email, String(minutos)]
  );
  return Number(fila?.["total"] ?? 0);
}

export async function registrarIntento(
  email: string,
  exitoso: boolean,
  ip: string | null
): Promise<void> {
  await pool
    .query(
      `INSERT INTO intento_acceso (email, exitoso, ip) VALUES ($1, $2, $3::inet)`,
      [email, exitoso, ip]
    )
    .catch(() => undefined);
}

/** Valida la clave de servicio que usa n8n. */
export async function claveServicioValida(clave: string | undefined): Promise<boolean> {
  if (!clave) return false;

  const { rowCount } = await pool.query(
    `UPDATE clave_servicio SET ultimo_uso_en = now()
     WHERE clave_hash = $1 AND activa`,
    [resumir(clave)]
  );

  return (rowCount ?? 0) > 0;
}

/** Sesiones abiertas de un usuario, para el panel de administración. */
export function sesionesActivas(usuarioId: number) {
  return consultar(
    `SELECT id, to_char(creada_en AT TIME ZONE 'America/Lima','DD/MM/YYYY HH24:MI') AS creada,
            to_char(ultima_actividad AT TIME ZONE 'America/Lima','DD/MM/YYYY HH24:MI') AS actividad,
            host(ip) AS ip
     FROM sesion
     WHERE usuario_id = $1 AND cerrada_en IS NULL AND expira_en > now()
     ORDER BY ultima_actividad DESC`,
    [usuarioId]
  );
}
