import type { Request, Response, NextFunction, RequestHandler } from "express";
import { puede, type Accion } from "../../domain/Rol.js";
import {
  usuarioDeSesion,
  claveServicioValida,
  type UsuarioSesion,
} from "../auth/sesiones.js";
import { pool } from "../db/pool.js";

/** Nombre de la cookie de sesión. */
export const COOKIE_SESION = "peruruso_sesion";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioSesion;
    }
  }
}

/** Dirección del cliente, para la bitácora. */
function ipDe(req: Request): string | null {
  const dir = req.ip ?? req.socket.remoteAddress ?? null;
  if (!dir) return null;
  // Express reporta IPv4 mapeadas como ::ffff:127.0.0.1
  return dir.startsWith("::ffff:") ? dir.slice(7) : dir;
}

/**
 * Carga el usuario de la sesión si la cookie es válida.
 * No bloquea: las rutas públicas siguen funcionando sin sesión.
 */
export const cargarSesion: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[COOKIE_SESION] as string | undefined;
  usuarioDeSesion(token)
    .then((usuario) => {
      if (usuario) req.usuario = usuario;
      next();
    })
    .catch(next);
};

/** Exige una sesión iniciada. */
export const requiereSesion: RequestHandler = (req, res, next) => {
  if (!req.usuario) {
    res.status(401).json({ error: "Necesitás iniciar sesión." });
    return;
  }
  next();
};

/**
 * Exige que el rol del usuario tenga permitida la acción.
 * La decisión la toma el dominio; acá solo se traduce a HTTP.
 */
export function requierePermiso(accion: Accion): RequestHandler {
  return (req, res, next) => {
    if (!req.usuario) {
      res.status(401).json({ error: "Necesitás iniciar sesión." });
      return;
    }
    if (!puede(req.usuario.rol, accion)) {
      res.status(403).json({
        error: "Tu rol no tiene permiso para esta operación.",
      });
      return;
    }
    next();
  };
}

/**
 * Autentica a un sistema externo mediante clave de servicio.
 * n8n no es una persona: no tiene sesión de navegador ni contraseña.
 */
export const requiereClaveServicio: RequestHandler = (req, res, next) => {
  const clave =
    (req.header("x-api-key") ?? "").trim() ||
    (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  claveServicioValida(clave)
    .then((valida) => {
      if (!valida) {
        res.status(401).json({ error: "Clave de servicio inválida." });
        return;
      }
      next();
    })
    .catch(next);
};

/**
 * Registra en la bitácora un acceso a datos personales (RF-28).
 *
 * Nunca interrumpe la petición: si la auditoría falla, se pierde el
 * registro pero no la atención del paciente. El fallo queda en consola.
 */
export function auditar(
  req: Request,
  entidad: string,
  accion: "LECTURA" | "CREACION" | "MODIFICACION" | "ELIMINACION" | "EXPORTACION",
  entidadId?: number | null,
  datos?: { antes?: unknown; despues?: unknown }
): void {
  pool
    .query(
      `INSERT INTO auditoria (usuario_id, entidad, entidad_id, accion, datos_antes, datos_despues, ip)
       VALUES ($1, $2, $3, $4::accion_auditoria, $5, $6, $7::inet)`,
      [
        req.usuario?.id ?? null,
        entidad,
        entidadId ?? null,
        accion,
        datos?.antes ? JSON.stringify(datos.antes) : null,
        datos?.despues ? JSON.stringify(datos.despues) : null,
        ipDe(req),
      ]
    )
    .catch((e) => console.error("auditoría:", e.message));
}

export { ipDe };

/** Traduce los errores de permiso del dominio a respuestas HTTP. */
export function manejadorErrores(
  error: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error.name === "PermisoDenegado") {
    res.status(403).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Error interno del servidor." });
}
