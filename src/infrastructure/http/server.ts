import express from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, consultar, consultarUna, enTransaccion } from "../db/pool.js";
import { Cita } from "../../domain/Cita.js";
import { RelojSistema } from "../../domain/Reloj.js";
import { PoliticaRecordatorios } from "../../domain/PoliticaRecordatorios.js";
import { accionesDe, alcanceAgenda } from "../../domain/Rol.js";
import {
  verificarPassword,
  esperarMinimo,
  hashearPassword,
  generarPasswordLegible,
} from "../auth/credenciales.js";
import {
  abrirSesion,
  cerrarSesion,
  cerrarSesionesDe,
  sesionesActivas,
  registrarIntento,
  intentosFallidosRecientes,
} from "../auth/sesiones.js";
import {
  COOKIE_SESION,
  cargarSesion,
  requiereSesion,
  requierePermiso,
  requiereClaveServicio,
  manejadorErrores,
  auditar,
  ipDe,
} from "./middleware.js";
import { publico, emitirEnlace } from "./publico.js";
import { agente } from "./agente.js";
import { registrarCita, HorarioOcupado } from "../citas/registrarCita.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const reloj = new RelojSistema();
const politica = new PoliticaRecordatorios();

app.use(express.json());
app.use(cookieParser());
app.use(cargarSesion);

const UI = join(__dirname, "../../ui");

/**
 * La interfaz no se entrega sin sesión.
 *
 * Antes el servidor mandaba index.html a cualquiera y era el JavaScript el
 * que redirigía al ver un 401. Los datos nunca se filtraban, pero la pantalla
 * completa alcanzaba a dibujarse, y sin JavaScript se quedaba ahí. La decisión
 * de si mostrar la aplicación es del servidor.
 */
function pantallaInicial(req: express.Request, res: express.Response): void {
  if (!req.usuario) {
    res.redirect(302, "/login.html");
    return;
  }
  res.sendFile(join(UI, "index.html"));
}

app.get("/", pantallaInicial);
app.get("/index.html", pantallaInicial);

/** Con sesión abierta, la pantalla de acceso no tiene sentido. */
app.get("/login.html", (req, res) => {
  if (req.usuario) {
    res.redirect(302, "/");
    return;
  }
  res.sendFile(join(UI, "login.html"));
});

// `index: false` evita que el estático vuelva a exponer index.html en "/".
app.use(express.static(UI, { index: false }));

const ZONA = "America/Lima";
/** Máximo de intentos fallidos antes de bloquear temporalmente el acceso. */
const MAX_INTENTOS = 5;
/** Base pública del sistema, la que ve el paciente en el enlace. */
const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000";

// Rutas del paciente: sin sesión, identificadas por el token del enlace.
app.use("/api/publico", publico);

// Canal conversacional: el agente actuando en nombre de un paciente.
// Se autentica con clave de servicio, igual que n8n; el alcance sobre las
// citas lo decide el dominio según el número desde el que escriben.
app.use("/api/agente", agente);

/** El enlace corto que viaja en el mensaje. */
app.get("/c/:token", (_req, res) => {
  res.sendFile(join(__dirname, "../../ui/cita.html"));
});

/** Envuelve un manejador async para que los errores lleguen a Express 5. */
function ruta(
  fn: (req: express.Request, res: express.Response) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Registra la duración de una consulta de lectura.
 * Alimenta la Ficha técnica N.° 9 — Tiempo de consulta de información.
 */
async function medir(
  operacion: string,
  inicioMs: number,
  usuarioId: number | null = 1
): Promise<void> {
  const duracion = Math.round(performance.now() - inicioMs);
  await pool
    .query(
      `INSERT INTO medicion_consulta (usuario_id, operacion, duracion_ms, fase)
       VALUES ($1, $2::operacion_medida, $3, 'POSTEST')`,
      [usuarioId, operacion, duracion]
    )
    .catch(() => undefined); // la instrumentación nunca debe tumbar la petición
}

// =====================================================================
// ACCESO AL SISTEMA
// =====================================================================

app.post(
  "/api/auth/login",
  ruta(async (req, res) => {
    const t0 = performance.now();
    const email = String((req.body as { email?: string }).email ?? "").trim().toLowerCase();
    const password = String((req.body as { password?: string }).password ?? "");
    const ip = ipDe(req);

    if (!email || !password) {
      await esperarMinimo(t0);
      res.status(400).json({ error: "Ingresá tu correo y tu contraseña." });
      return;
    }

    // Freno al ensayo sistemático de contraseñas.
    if ((await intentosFallidosRecientes(email)) >= MAX_INTENTOS) {
      await esperarMinimo(t0);
      res.status(429).json({
        error: "Demasiados intentos fallidos. Esperá 15 minutos antes de reintentar.",
      });
      return;
    }

    const fila = await consultarUna(
      `SELECT id, email, nombres, rol, hash_password
       FROM usuario WHERE lower(email) = $1 AND activo`,
      [email]
    );

    // Se verifica siempre, exista o no el usuario: el retardo mínimo evita
    // que el tiempo de respuesta revele qué correos están registrados.
    const valida = fila
      ? await verificarPassword(fila["hash_password"], password)
      : false;

    if (!valida) {
      await registrarIntento(email, false, ip);
      await esperarMinimo(t0);
      res.status(401).json({ error: "Correo o contraseña incorrectos." });
      return;
    }

    const usuarioId = Number(fila!["id"]);
    const token = await abrirSesion(usuarioId, ip, req.header("user-agent") ?? null);
    await registrarIntento(email, true, ip);

    res.cookie(COOKIE_SESION, token, {
      httpOnly: true,   // inaccesible desde JavaScript: mitiga el robo por XSS
      sameSite: "lax",  // no viaja en peticiones de otros sitios
      secure: process.env["NODE_ENV"] === "production",
      maxAge: 12 * 3600 * 1000,
      path: "/",
    });

    req.usuario = {
      id: usuarioId,
      email: fila!["email"],
      nombres: fila!["nombres"],
      rol: fila!["rol"],
      medicoId: null,
    };
    auditar(req, "usuario", "LECTURA", usuarioId, { despues: { evento: "inicio de sesión" } });

    res.json({
      id: usuarioId,
      nombres: fila!["nombres"],
      rol: fila!["rol"],
      acciones: accionesDe(fila!["rol"]),
      alcance: alcanceAgenda(fila!["rol"]),
    });
  })
);

app.post(
  "/api/auth/logout",
  ruta(async (req, res) => {
    await cerrarSesion(req.cookies?.[COOKIE_SESION]);
    res.clearCookie(COOKIE_SESION, { path: "/" });
    res.json({ ok: true });
  })
);

/** Quién soy. La interfaz la usa para decidir qué mostrar. */
app.get("/api/auth/yo", (req, res) => {
  if (!req.usuario) {
    res.status(401).json({ error: "Sin sesión activa." });
    return;
  }
  res.json({
    id: req.usuario.id,
    nombres: req.usuario.nombres,
    email: req.usuario.email,
    rol: req.usuario.rol,
    medicoId: req.usuario.medicoId,
    acciones: accionesDe(req.usuario.rol),
    // La interfaz decide su vista principal con esto, no adivinando por el rol.
    alcance: alcanceAgenda(req.usuario.rol),
  });
});

// =====================================================================
// AGENDA DEL DÍA
// =====================================================================

app.get(
  "/api/agenda",
  requierePermiso("VER_AGENDA"),
  ruta(async (req, res) => {
    const t0 = performance.now();
    // Si no se indica fecha, "hoy" se resuelve en el motor con la zona de
    // Lima. Calcularlo en Node con toISOString() daría la fecha UTC, que
    // después de las 19:00 hora local ya corresponde al día siguiente.
    const fecha = String(req.query["fecha"] ?? "").trim() || null;

    // El dominio decide el alcance; acá solo se traduce a un filtro SQL.
    const soloMedico =
      alcanceAgenda(req.usuario!.rol) === "PROPIA" ? req.usuario!.medicoId : null;

    const filas = await consultar(
      `SELECT
         c.id,
         to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')      AS hora,
         to_char(c.fin    AT TIME ZONE $2, 'HH24:MI')      AS hora_fin,
         c.estado,
         c.tipo,
         c.origen,
         p.id            AS paciente_id,
         p.nombres || ' ' || p.apellidos AS paciente,
         p.num_doc,
         p.celular,
         p.riesgo,
         m.id            AS medico_id,
         'Dr(a). ' || m.nombres || ' ' || m.apellidos AS medico,
         (SELECT count(*) FROM recordatorio r
           WHERE r.cita_id = c.id
             AND r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))          AS recordatorios_enviados,
         (SELECT count(*) FROM recordatorio r
           WHERE r.cita_id = c.id AND r.estado = 'PROGRAMADO')         AS recordatorios_pendientes,
         (SELECT rp.accion FROM respuesta_paciente rp
           WHERE rp.cita_id = c.id AND rp.respondido_en IS NOT NULL
           ORDER BY rp.respondido_en DESC LIMIT 1)                     AS respuesta
       FROM cita c
       JOIN paciente p ON p.id = c.paciente_id
       JOIN medico   m ON m.id = c.medico_id
       WHERE (c.inicio AT TIME ZONE $2)::date
             = COALESCE($1::date, (now() AT TIME ZONE $2)::date)
         -- El médico solo ve su propia agenda: la de un colega revela qué
         -- pacientes atiende, y eso no se comparte entre profesionales.
         AND ($3::bigint IS NULL OR c.medico_id = $3::bigint)
       ORDER BY c.inicio, m.id`,
      [fecha, ZONA, soloMedico]
    );

    auditar(req, "cita", "LECTURA", null, { despues: { fecha, filas: filas.length } });
    await medir("VER_AGENDA_DIA", t0, req.usuario?.id ?? null);
    res.json(filas);
  })
);

// =====================================================================
// CUPOS LIBRES DE UN MÉDICO EN UNA FECHA
// =====================================================================

app.get(
  "/api/cupos",
  requierePermiso("VER_AGENDA"),
  ruta(async (req, res) => {
    const medicoId = Number(req.query["medico_id"]);
    const fecha = String(req.query["fecha"] ?? "");

    if (!medicoId || !fecha) {
      res.status(400).json({ error: "Faltan medico_id y fecha." });
      return;
    }

    const filas = await consultar(
      `WITH rejilla AS (
         SELECT gs AS inicio
         FROM horario_atencion h
         CROSS JOIN LATERAL generate_series(
           (($2::date + h.hora_inicio) AT TIME ZONE $3),
           (($2::date + h.hora_fin)    AT TIME ZONE $3) - (h.duracion_min * INTERVAL '1 minute'),
           (h.duracion_min * INTERVAL '1 minute')
         ) AS gs
         WHERE h.medico_id = $1
           AND h.activo
           AND h.dia_semana = extract(isodow FROM $2::date)
       )
       SELECT to_char(r.inicio AT TIME ZONE $3, 'HH24:MI') AS hora,
              r.inicio
       FROM rejilla r
       WHERE NOT EXISTS (
               SELECT 1 FROM cita c
               WHERE c.medico_id = $1
                 AND c.estado NOT IN ('CANCELADA','REPROGRAMADA')
                 AND c.inicio = r.inicio)
         AND NOT EXISTS (
               SELECT 1 FROM excepcion_agenda e
               WHERE e.medico_id = $1 AND e.fecha = $2::date AND e.todo_el_dia)
       ORDER BY r.inicio`,
      [medicoId, fecha, ZONA]
    );

    res.json(filas);
  })
);

// =====================================================================
// REGISTRAR UNA CITA
// =====================================================================

app.post(
  "/api/citas",
  requierePermiso("REGISTRAR_CITA"),
  ruta(async (req, res) => {
    const { paciente_id, medico_id, inicio, tipo, registro_seg } = req.body as {
      paciente_id?: number;
      medico_id?: number;
      inicio?: string;
      tipo?: string;
      registro_seg?: number;
    };

    if (!paciente_id || !medico_id || !inicio) {
      res.status(400).json({ error: "Faltan paciente, médico u horario." });
      return;
    }

    try {
      // El registro es el mismo que usa el canal conversacional. Lo único
      // que cambia es el origen y que acá sí hay una persona que la creó.
      const creada = await registrarCita(
        {
          pacienteId: paciente_id,
          medicoId: medico_id,
          inicio,
          origen: "RECEPCION",
          tipo: (tipo ?? null) as "PRIMERA_VEZ" | "CONTINUADOR" | null,
          registroSeg: registro_seg ?? null,
          creadoPor: req.usuario?.id ?? 1,
        },
        reloj,
        politica
      );

      res.status(201).json({ id: creada.id, recordatorios: creada.recordatorios });
    } catch (error) {
      if (error instanceof HorarioOcupado) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

// =====================================================================
// CONFIRMAR / CANCELAR / CERRAR EL DÍA
// =====================================================================

/** Reconstruye la entidad de dominio a partir de la fila persistida. */
async function cargarCita(id: number): Promise<Cita | null> {
  const fila = await consultarUna(
    `SELECT id, paciente_id, medico_id, inicio, fin, estado, cita_origen_id
     FROM cita WHERE id = $1`,
    [id]
  );
  if (!fila) return null;

  return new Cita({
    id: Number(fila["id"]),
    pacienteId: Number(fila["paciente_id"]),
    medicoId: Number(fila["medico_id"]),
    inicio: new Date(fila["inicio"]),
    fin: new Date(fila["fin"]),
    estado: fila["estado"],
    citaOrigenId: fila["cita_origen_id"],
  });
}

app.post(
  "/api/citas/:id/confirmar",
  requierePermiso("CONFIRMAR_CITA"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const cita = await cargarCita(id);
    if (!cita) {
      res.status(404).json({ error: "Cita no encontrada." });
      return;
    }

    try {
      cita.confirmar(reloj); // el dominio valida la transición
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    await enTransaccion(async (cliente) => {
      await cliente.query(`UPDATE cita SET estado = 'CONFIRMADA' WHERE id = $1`, [id]);

      // Al confirmar se suspenden los recordatorios que ya no tienen sentido,
      // pero se conserva el del mismo día (T-3h).
      await cliente.query(
        `UPDATE recordatorio SET estado = 'SUSPENDIDO'
         WHERE cita_id = $1 AND estado = 'PROGRAMADO'
           AND hito = ANY($2::hito_recordatorio[])`,
        [id, politica.hitosASuspenderTrasConfirmar()]
      );

      // El identificador va casteado en sus dos usos. Sin el cast, el motor
      // deduce bigint por la columna y text por la concatenación, y rechaza
      // la consulta entera con «tipos de dato inconsistentes» (42P08).
      await cliente.query(
        `INSERT INTO respuesta_paciente (cita_id, token_hash, accion, expira_en, respondido_en)
         VALUES ($1::bigint,
                 encode(digest('manual-' || $1::bigint::text || '-' || clock_timestamp()::text,
                               'sha256'), 'hex'),
                 'CONFIRMAR', now(), now())`,
        [id]
      );
    });

    res.json({ id, estado: "CONFIRMADA" });
  })
);

app.post(
  "/api/citas/:id/cancelar",
  requierePermiso("CANCELAR_CITA"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const motivo = String((req.body as { motivo?: string }).motivo ?? "Sin motivo");

    const cita = await cargarCita(id);
    if (!cita) {
      res.status(404).json({ error: "Cita no encontrada." });
      return;
    }

    try {
      cita.cancelar(reloj, motivo, "PACIENTE");
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    await enTransaccion(async (cliente) => {
      await cliente.query(
        `UPDATE cita
         SET estado = 'CANCELADA', cancelada_en = now(),
             motivo_cancelacion = $2, origen_cancelacion = 'PACIENTE',
             antelacion_horas = $3
         WHERE id = $1`,
        [id, motivo, cita.antelacionHoras]
      );

      // Cancelar suspende la secuencia completa.
      await cliente.query(
        `UPDATE recordatorio SET estado = 'SUSPENDIDO'
         WHERE cita_id = $1 AND estado = 'PROGRAMADO'`,
        [id]
      );
    });

    res.json({
      id,
      estado: "CANCELADA",
      antelacion_horas: cita.antelacionHoras,
      cupo_reasignable: cita.cupoEsReasignable(),
    });
  })
);

app.post(
  "/api/citas/:id/cerrar",
  requierePermiso("CERRAR_ASISTENCIA"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const asistio = Boolean((req.body as { asistio?: boolean }).asistio);

    const cita = await cargarCita(id);
    if (!cita) {
      res.status(404).json({ error: "Cita no encontrada." });
      return;
    }

    try {
      if (asistio) cita.marcarAtendida(reloj);
      else cita.marcarAusente(reloj);
    } catch (error) {
      res.status(422).json({ error: (error as Error).message });
      return;
    }

    await pool.query(
      `UPDATE cita SET estado = $2::estado_cita, cerrada_en = now(), cerrada_por = 1
       WHERE id = $1`,
      [id, cita.estado]
    );

    res.json({ id, estado: cita.estado });
  })
);

// =====================================================================
// BÚSQUEDA DE PACIENTES Y MÉDICOS
// =====================================================================

app.get(
  "/api/pacientes",
  requierePermiso("BUSCAR_PACIENTE"),
  ruta(async (req, res) => {
    const t0 = performance.now();
    const q = String(req.query["q"] ?? "").trim();

    const filas = await consultar(
      `SELECT id, num_doc, nombres || ' ' || apellidos AS nombre, celular, riesgo
       FROM paciente
       WHERE activo
         AND ($1 = '' OR num_doc ILIKE $1 || '%'
                      OR (nombres || ' ' || apellidos) ILIKE '%' || $1 || '%')
       ORDER BY apellidos, nombres
       LIMIT 20`,
      [q]
    );

    await medir("BUSCAR_PACIENTE", t0);
    res.json(filas);
  })
);

app.get(
  "/api/medicos",
  requiereSesion,
  ruta(async (_req, res) => {
    res.json(
      await consultar(
        `SELECT id, 'Dr(a). ' || nombres || ' ' || apellidos AS nombre, especialidad
         FROM medico WHERE activo ORDER BY apellidos`
      )
    );
  })
);

// =====================================================================
// PANEL DE INDICADORES  — Fichas técnicas de la investigación
// =====================================================================

app.get(
  "/api/indicadores",
  requierePermiso("VER_INDICADORES"),
  ruta(async (_req, res) => {
    const t0 = performance.now();

    const ausentismo = await consultar(
      `SELECT f.fase,
              count(*)                                                     AS programadas,
              count(*) FILTER (WHERE c.estado = 'ATENDIDA')                AS atendidas,
              count(*) FILTER (WHERE c.estado = 'AUSENTE')                 AS ausentes,
              count(*) FILTER (WHERE c.estado = 'CANCELADA')               AS canceladas,
              count(*) FILTER (WHERE c.estado = 'REPROGRAMADA')            AS reprogramadas,
              round(100.0 * count(*) FILTER (WHERE c.estado = 'AUSENTE')
                    / nullif(count(*), 0), 2)                              AS tasa_ausentismo,
              round(100.0 * count(*) FILTER (WHERE c.estado = 'ATENDIDA')
                    / nullif(count(*), 0), 2)                              AS pct_asistencia,
              round(avg(c.registro_seg) / 60.0, 2)                         AS min_registro
       FROM cita c
       JOIN fase_estudio f
         ON (c.inicio AT TIME ZONE $1)::date BETWEEN f.desde AND f.hasta
       GROUP BY f.fase
       ORDER BY f.fase DESC`,
      [ZONA]
    );

    const recordatorios = await consultarUna(
      `SELECT count(*)                                                            AS programados,
              count(*) FILTER (WHERE r.estado IN ('ENVIADO','ENTREGADO','LEIDO')) AS enviados,
              count(*) FILTER (WHERE r.estado IN ('ENTREGADO','LEIDO'))           AS entregados,
              count(*) FILTER (WHERE r.estado = 'FALLIDO')                        AS fallidos,
              round(100.0 * count(*) FILTER (WHERE r.estado IN ('ENVIADO','ENTREGADO','LEIDO'))
                    / nullif(count(*), 0), 2)                                     AS pct_envio
       FROM recordatorio r
       JOIN cita c ON c.id = r.cita_id
       JOIN fase_estudio f
         ON (c.inicio AT TIME ZONE $1)::date BETWEEN f.desde AND f.hasta
       WHERE f.fase = 'POSTEST' AND r.estado <> 'SUSPENDIDO'`,
      [ZONA]
    );

    const cupos = await consultarUna(
      `SELECT count(DISTINCT o.cita_liberada_id)                                      AS liberados,
              count(DISTINCT o.cita_liberada_id) FILTER (WHERE o.estado = 'ACEPTADA') AS recuperados,
              round(100.0 * count(DISTINCT o.cita_liberada_id) FILTER (WHERE o.estado = 'ACEPTADA')
                    / nullif(count(DISTINCT o.cita_liberada_id), 0), 2)               AS pct_recuperacion
       FROM oferta_cupo o`
    );

    const confirmacion = await consultarUna(
      `SELECT round(100.0 * count(*) FILTER (
                WHERE EXISTS (SELECT 1 FROM respuesta_paciente rp
                              WHERE rp.cita_id = c.id AND rp.accion = 'CONFIRMAR'))
              / nullif(count(*), 0), 2) AS pct_confirmacion
       FROM cita c
       JOIN fase_estudio f
         ON (c.inicio AT TIME ZONE $1)::date BETWEEN f.desde AND f.hasta
       WHERE f.fase = 'POSTEST'`,
      [ZONA]
    );

    const consulta = await consultarUna(
      `SELECT round(avg(duracion_ms) / 1000.0, 2) AS seg_promedio
       FROM medicion_consulta WHERE fase = 'POSTEST'`
    );

    const ventanas = await consultar(
      `SELECT fase, to_char(desde,'DD/MM/YYYY') AS desde,
              to_char(hasta,'DD/MM/YYYY') AS hasta
       FROM fase_estudio ORDER BY fase DESC`
    );

    await medir("GENERAR_REPORTE", t0);

    res.json({ ausentismo, recordatorios, cupos, confirmacion, consulta, ventanas });
  })
);

// =====================================================================
// DESPACHO DE RECORDATORIOS  — consumido por n8n
//
// n8n orquesta (cron y envío); la aplicación decide qué corresponde
// enviar y registra el resultado. La lógica de negocio no vive en los
// nodos del workflow.
// =====================================================================

/**
 * Entrega los recordatorios vencidos y los marca como ENCOLADO.
 *
 * El reclamo es atómico: `FOR UPDATE SKIP LOCKED` impide que dos
 * ejecuciones simultáneas del cron tomen el mismo recordatorio. Junto con
 * la restricción UNIQUE sobre clave_idempotencia, es lo que sostiene el
 * RNF-04 (un mismo recordatorio nunca se envía dos veces).
 */
app.post(
  "/api/recordatorios/pendientes",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const limite = Math.min(Number(req.body?.limite ?? 50), 200);

    const pendientes = await enTransaccion(async (cliente) => {
      const { rows: tomados } = await cliente.query<{ id: string }>(
        `SELECT r.id
         FROM recordatorio r
         JOIN cita c     ON c.id = r.cita_id
         JOIN paciente p ON p.id = c.paciente_id
         WHERE r.estado = 'PROGRAMADO'
           AND r.programado_para <= now()
           AND c.estado IN ('PROGRAMADA', 'CONFIRMADA')
           -- Ley N.° 29733: sin consentimiento vigente de contacto no se envía.
           AND EXISTS (
                 SELECT 1 FROM consentimiento k
                 WHERE k.paciente_id = p.id
                   AND k.finalidad = 'CONTACTO_RECORDATORIOS'
                   AND k.revocado_en IS NULL)
         ORDER BY r.programado_para
         LIMIT $1
         FOR UPDATE OF r SKIP LOCKED`,
        [limite]
      );

      if (!tomados.length) return [];
      const ids = tomados.map((f) => Number(f.id));

      await cliente.query(
        `UPDATE recordatorio
         SET estado = 'ENCOLADO', encolado_en = now(), intentos = intentos + 1
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );

      const { rows } = await cliente.query(
        `SELECT
           r.id,
           r.hito,
           r.canal,
           r.plantilla,
           r.clave_idempotencia,
           p.celular,
           p.nombres                                        AS paciente_nombres,
           to_char(c.inicio AT TIME ZONE $2, 'DD/MM/YYYY')  AS fecha,
           to_char(c.inicio AT TIME ZONE $2, 'HH24:MI')     AS hora,
           'Dr(a). ' || m.nombres || ' ' || m.apellidos     AS medico,
           c.id                                             AS cita_id
         FROM recordatorio r
         JOIN cita c     ON c.id = r.cita_id
         JOIN paciente p ON p.id = c.paciente_id
         JOIN medico m   ON m.id = c.medico_id
         WHERE r.id = ANY($1::bigint[])
         ORDER BY r.programado_para`,
        [ids, ZONA]
      );

      return rows;
    });

    // Cada recordatorio viaja con el enlace único del paciente, que es lo
    // que le permite responder sin iniciar sesión (RF-16).
    const conEnlace = await Promise.all(
      pendientes.map(async (r) => {
        const token = await emitirEnlace(Number(r["cita_id"]));
        return { ...r, enlace: token ? `${BASE_URL}/c/${token}` : null };
      })
    );

    res.json(conEnlace);
  })
);

/**
 * n8n informa el resultado del envío.
 * El mensaje nunca contiene datos clínicos, solo fecha, hora y profesional.
 */
app.post(
  "/api/recordatorios/:id/resultado",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const { exito, proveedor_msg_id, error } = req.body as {
      exito?: boolean;
      proveedor_msg_id?: string;
      error?: string;
    };

    const { rowCount } = await pool.query(
      `UPDATE recordatorio
       SET estado           = CASE WHEN $2 THEN 'ENVIADO'::estado_recordatorio
                                   ELSE 'FALLIDO'::estado_recordatorio END,
           enviado_en       = CASE WHEN $2 THEN now() ELSE enviado_en END,
           proveedor_msg_id = COALESCE($3, proveedor_msg_id),
           error_detalle    = $4
       WHERE id = $1 AND estado = 'ENCOLADO'`,
      [id, Boolean(exito), proveedor_msg_id ?? null, error ?? null]
    );

    if (!rowCount) {
      res.status(409).json({ error: "El recordatorio no estaba encolado." });
      return;
    }

    res.json({ id, estado: exito ? "ENVIADO" : "FALLIDO" });
  })
);

/**
 * Webhook de estados de entrega de WhatsApp, reenviado por n8n.
 * Alimenta la Ficha técnica N.° 4 (porcentaje de entrega).
 */
app.post(
  "/api/webhooks/whatsapp",
  requiereClaveServicio,
  ruta(async (req, res) => {
    const { proveedor_msg_id, estado } = req.body as {
      proveedor_msg_id?: string;
      estado?: string;
    };

    if (!proveedor_msg_id || !estado) {
      res.status(400).json({ error: "Faltan proveedor_msg_id y estado." });
      return;
    }

    const mapa: Record<string, string> = {
      sent: "ENVIADO",
      delivered: "ENTREGADO",
      read: "LEIDO",
      failed: "FALLIDO",
    };
    const nuevo = mapa[estado.toLowerCase()];

    if (!nuevo) {
      res.status(422).json({ error: `Estado desconocido: ${estado}` });
      return;
    }

    await pool.query(
      `UPDATE recordatorio
       SET estado       = $2::estado_recordatorio,
           entregado_en = CASE WHEN $2 IN ('ENTREGADO','LEIDO')
                               THEN COALESCE(entregado_en, now()) ELSE entregado_en END,
           leido_en     = CASE WHEN $2 = 'LEIDO'
                               THEN COALESCE(leido_en, now()) ELSE leido_en END
       WHERE proveedor_msg_id = $1`,
      [proveedor_msg_id, nuevo]
    );

    res.json({ ok: true });
  })
);

/** Estado de la cola, para monitoreo desde n8n o el panel. */
app.get(
  "/api/recordatorios/estado",
  requierePermiso("VER_INDICADORES"),
  ruta(async (_req, res) => {
    res.json(
      await consultar(
        `SELECT estado, count(*)::int AS total,
                count(*) FILTER (WHERE programado_para <= now())::int AS vencidos
         FROM recordatorio
         GROUP BY estado
         ORDER BY estado`
      )
    );
  })
);

// =====================================================================
// HORARIOS DE ATENCIÓN
// =====================================================================

/**
 * Resuelve sobre qué médico se está operando.
 *
 * Un profesional solo administra su propia agenda; dirección administra la
 * de cualquiera. Es la misma regla que acota la agenda del día, aplicada a
 * la configuración: si un médico pudiera editar los horarios de un colega,
 * podría abrirle o cerrarle cupos sin que el otro se entere.
 */
function medicoOperable(req: express.Request, pedido: unknown): number | null {
  const propio = alcanceAgenda(req.usuario!.rol) === "PROPIA";
  if (propio) return req.usuario!.medicoId;
  const id = Number(pedido);
  return Number.isFinite(id) && id > 0 ? id : null;
}

app.get(
  "/api/horarios",
  requierePermiso("GESTIONAR_HORARIOS"),
  ruta(async (req, res) => {
    const medicoId = medicoOperable(req, req.query["medico_id"]);
    if (!medicoId) {
      res.status(400).json({ error: "Indicá de qué médico querés los horarios." });
      return;
    }

    const [bloques, excepciones, medico] = await Promise.all([
      consultar(
        `SELECT id, dia_semana, to_char(hora_inicio,'HH24:MI') AS hora_inicio,
                to_char(hora_fin,'HH24:MI') AS hora_fin, duracion_min
         FROM horario_atencion
         WHERE medico_id = $1 AND activo
         ORDER BY dia_semana, hora_inicio`,
        [medicoId]
      ),
      consultar(
        `SELECT id, to_char(fecha,'YYYY-MM-DD') AS fecha, todo_el_dia,
                to_char(hora_inicio,'HH24:MI') AS hora_inicio,
                to_char(hora_fin,'HH24:MI') AS hora_fin, motivo
         FROM excepcion_agenda
         WHERE medico_id = $1 AND fecha >= (now() AT TIME ZONE $2)::date
         ORDER BY fecha`,
        [medicoId, ZONA]
      ),
      consultarUna(
        `SELECT id, nombres || ' ' || apellidos AS nombre, especialidad
         FROM medico WHERE id = $1`,
        [medicoId]
      ),
    ]);

    res.json({ medico, bloques, excepciones });
  })
);

app.post(
  "/api/horarios",
  requierePermiso("GESTIONAR_HORARIOS"),
  ruta(async (req, res) => {
    const cuerpo = req.body as Record<string, unknown>;
    const medicoId = medicoOperable(req, cuerpo["medico_id"]);
    const dia = Number(cuerpo["dia_semana"]);
    const inicio = String(cuerpo["hora_inicio"] ?? "");
    const fin = String(cuerpo["hora_fin"] ?? "");
    const duracion = Number(cuerpo["duracion_min"] ?? 20);

    if (!medicoId) {
      res.status(400).json({ error: "No se pudo determinar el médico." });
      return;
    }
    if (!Number.isInteger(dia) || dia < 1 || dia > 7) {
      res.status(400).json({ error: "El día debe ir de 1 (lunes) a 7 (domingo)." });
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(inicio) || !/^\d{2}:\d{2}$/.test(fin) || fin <= inicio) {
      res.status(400).json({ error: "El horario debe ser HH:MM y terminar después de empezar." });
      return;
    }
    if (!Number.isInteger(duracion) || duracion < 5 || duracion > 120) {
      res.status(400).json({ error: "La duración debe estar entre 5 y 120 minutos." });
      return;
    }

    // Dos bloques superpuestos ofrecerían el mismo cupo dos veces.
    const choque = await consultarUna(
      `SELECT to_char(hora_inicio,'HH24:MI') AS desde, to_char(hora_fin,'HH24:MI') AS hasta
       FROM horario_atencion
       WHERE medico_id = $1 AND dia_semana = $2 AND activo
         AND hora_inicio < $4::time AND hora_fin > $3::time
       LIMIT 1`,
      [medicoId, dia, inicio, fin]
    );
    if (choque) {
      res.status(409).json({
        error: `Se superpone con el bloque de ${choque["desde"]} a ${choque["hasta"]}.`,
      });
      return;
    }

    const fila = await consultarUna(
      `INSERT INTO horario_atencion (medico_id, dia_semana, hora_inicio, hora_fin, duracion_min)
       VALUES ($1, $2, $3::time, $4::time, $5)
       RETURNING id`,
      [medicoId, dia, inicio, fin, duracion]
    );

    auditar(req, "horario_atencion", "CREACION", Number(fila!["id"]), {
      despues: { medicoId, dia, inicio, fin, duracion },
    });
    res.status(201).json({ id: Number(fila!["id"]) });
  })
);

app.delete(
  "/api/horarios/:id",
  requierePermiso("GESTIONAR_HORARIOS"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const bloque = await consultarUna(
      `SELECT medico_id, dia_semana,
              to_char(hora_inicio,'HH24:MI') AS desde, to_char(hora_fin,'HH24:MI') AS hasta
       FROM horario_atencion WHERE id = $1 AND activo`,
      [id]
    );
    if (!bloque) {
      res.status(404).json({ error: "El bloque no existe." });
      return;
    }

    const propio = alcanceAgenda(req.usuario!.rol) === "PROPIA";
    if (propio && Number(bloque["medico_id"]) !== req.usuario!.medicoId) {
      res.status(403).json({ error: "Ese bloque es de otro profesional." });
      return;
    }

    // Quitar el bloque no cancela las citas ya tomadas dentro de él: hay
    // pacientes con esa hora reservada. Se avisa para que se reprogramen.
    const pendientes = await consultarUna(
      `SELECT count(*)::int AS total
       FROM cita c
       WHERE c.medico_id = $1
         AND c.estado IN ('PROGRAMADA','CONFIRMADA')
         AND c.inicio > now()
         AND extract(isodow FROM (c.inicio AT TIME ZONE $2)) = $3
         AND (c.inicio AT TIME ZONE $2)::time >= $4::time
         AND (c.inicio AT TIME ZONE $2)::time <  $5::time`,
      [bloque["medico_id"], ZONA, bloque["dia_semana"], bloque["desde"], bloque["hasta"]]
    );

    await pool.query(`UPDATE horario_atencion SET activo = FALSE WHERE id = $1`, [id]);
    auditar(req, "horario_atencion", "MODIFICACION", id, { antes: bloque });

    res.json({ id, citas_afectadas: Number(pendientes?.["total"] ?? 0) });
  })
);

app.post(
  "/api/excepciones",
  requierePermiso("GESTIONAR_HORARIOS"),
  ruta(async (req, res) => {
    const cuerpo = req.body as Record<string, unknown>;
    const medicoId = medicoOperable(req, cuerpo["medico_id"]);
    const fecha = String(cuerpo["fecha"] ?? "");
    const todoElDia = cuerpo["todo_el_dia"] !== false;
    const motivo = String(cuerpo["motivo"] ?? "").trim();
    const inicio = todoElDia ? null : String(cuerpo["hora_inicio"] ?? "");
    const fin = todoElDia ? null : String(cuerpo["hora_fin"] ?? "");

    if (!medicoId) {
      res.status(400).json({ error: "No se pudo determinar el médico." });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      res.status(400).json({ error: "La fecha debe ser AAAA-MM-DD." });
      return;
    }
    if (!motivo) {
      res.status(400).json({ error: "Indicá el motivo de la ausencia." });
      return;
    }
    if (!todoElDia && (!/^\d{2}:\d{2}$/.test(inicio!) || !/^\d{2}:\d{2}$/.test(fin!) || fin! <= inicio!)) {
      res.status(400).json({ error: "El tramo debe ser HH:MM y terminar después de empezar." });
      return;
    }

    const afectadas = await consultarUna(
      `SELECT count(*)::int AS total
       FROM cita c
       WHERE c.medico_id = $1
         AND c.estado IN ('PROGRAMADA','CONFIRMADA')
         AND (c.inicio AT TIME ZONE $2)::date = $3::date
         AND ($4::boolean
              OR ((c.inicio AT TIME ZONE $2)::time >= $5::time
              AND (c.inicio AT TIME ZONE $2)::time <  $6::time))`,
      [medicoId, ZONA, fecha, todoElDia, inicio, fin]
    );

    try {
      const fila = await consultarUna(
        `INSERT INTO excepcion_agenda (medico_id, fecha, todo_el_dia, hora_inicio, hora_fin, motivo)
         VALUES ($1, $2::date, $3, $4::time, $5::time, $6)
         RETURNING id`,
        [medicoId, fecha, todoElDia, inicio, fin, motivo]
      );
      auditar(req, "excepcion_agenda", "CREACION", Number(fila!["id"]), {
        despues: { medicoId, fecha, todoElDia, motivo },
      });
      res.status(201).json({
        id: Number(fila!["id"]),
        citas_afectadas: Number(afectadas?.["total"] ?? 0),
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "Ya hay una ausencia registrada para esa fecha." });
        return;
      }
      throw error;
    }
  })
);

app.delete(
  "/api/excepciones/:id",
  requierePermiso("GESTIONAR_HORARIOS"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const fila = await consultarUna(
      `SELECT medico_id FROM excepcion_agenda WHERE id = $1`,
      [id]
    );
    if (!fila) {
      res.status(404).json({ error: "La ausencia no existe." });
      return;
    }

    const propio = alcanceAgenda(req.usuario!.rol) === "PROPIA";
    if (propio && Number(fila["medico_id"]) !== req.usuario!.medicoId) {
      res.status(403).json({ error: "Esa ausencia es de otro profesional." });
      return;
    }

    await pool.query(`DELETE FROM excepcion_agenda WHERE id = $1`, [id]);
    auditar(req, "excepcion_agenda", "ELIMINACION", id, { antes: fila });
    res.json({ id });
  })
);

// =====================================================================
// USUARIOS DEL SISTEMA
// =====================================================================

const ROLES_VALIDOS = ["RECEPCIONISTA", "MEDICO", "ADMINISTRADOR"] as const;

app.get(
  "/api/usuarios",
  requierePermiso("GESTIONAR_USUARIOS"),
  ruta(async (req, res) => {
    const filas = await consultar(
      `SELECT u.id, u.email, u.nombres, u.rol, u.activo,
              to_char(u.creado_en AT TIME ZONE $1,'DD/MM/YYYY') AS creado,
              m.id AS medico_id,
              (SELECT count(*)::int FROM sesion s
                WHERE s.usuario_id = u.id AND s.cerrada_en IS NULL
                  AND s.expira_en > now())                       AS sesiones,
              (SELECT to_char(max(s.ultima_actividad) AT TIME ZONE $1,'DD/MM/YYYY HH24:MI')
                 FROM sesion s WHERE s.usuario_id = u.id)        AS ultimo_acceso
       FROM usuario u
       LEFT JOIN medico m ON m.usuario_id = u.id
       ORDER BY u.activo DESC, u.rol, u.nombres`,
      [ZONA]
    );
    auditar(req, "usuario", "LECTURA");
    res.json(filas);
  })
);

app.post(
  "/api/usuarios",
  requierePermiso("GESTIONAR_USUARIOS"),
  ruta(async (req, res) => {
    const cuerpo = req.body as Record<string, unknown>;
    const email = String(cuerpo["email"] ?? "").trim().toLowerCase();
    const nombres = String(cuerpo["nombres"] ?? "").trim();
    const rol = String(cuerpo["rol"] ?? "");

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "El correo no tiene un formato válido." });
      return;
    }
    if (nombres.length < 3) {
      res.status(400).json({ error: "Indicá el nombre de la persona." });
      return;
    }
    if (!ROLES_VALIDOS.includes(rol as (typeof ROLES_VALIDOS)[number])) {
      res.status(400).json({ error: `El rol debe ser uno de: ${ROLES_VALIDOS.join(", ")}.` });
      return;
    }

    // Se genera acá y se muestra una sola vez: en la base solo queda el
    // resumen Argon2id, que no se puede revertir.
    const password = generarPasswordLegible();

    try {
      const fila = await consultarUna(
        `INSERT INTO usuario (email, hash_password, nombres, rol)
         VALUES ($1, $2, $3, $4::rol_usuario)
         RETURNING id`,
        [email, await hashearPassword(password), nombres, rol]
      );
      auditar(req, "usuario", "CREACION", Number(fila!["id"]), {
        despues: { email, nombres, rol },
      });
      res.status(201).json({ id: Number(fila!["id"]), email, nombres, rol, password });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "Ya existe una cuenta con ese correo." });
        return;
      }
      throw error;
    }
  })
);

app.patch(
  "/api/usuarios/:id",
  requierePermiso("GESTIONAR_USUARIOS"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const cuerpo = req.body as Record<string, unknown>;

    const antes = await consultarUna(
      `SELECT id, email, nombres, rol, activo FROM usuario WHERE id = $1`,
      [id]
    );
    if (!antes) {
      res.status(404).json({ error: "La cuenta no existe." });
      return;
    }

    const propio = id === req.usuario!.id;
    const quiereDesactivar = cuerpo["activo"] === false;
    const quiereCambiarRol =
      typeof cuerpo["rol"] === "string" && cuerpo["rol"] !== antes["rol"];

    // Sin esto, la última persona con acceso de dirección puede dejarse
    // afuera del sistema y no queda nadie que pueda volver a habilitarla.
    if (propio && (quiereDesactivar || quiereCambiarRol)) {
      res.status(409).json({
        error: "No podés desactivar ni cambiar el rol de tu propia cuenta.",
      });
      return;
    }

    if (quiereCambiarRol && !ROLES_VALIDOS.includes(cuerpo["rol"] as (typeof ROLES_VALIDOS)[number])) {
      res.status(400).json({ error: `El rol debe ser uno de: ${ROLES_VALIDOS.join(", ")}.` });
      return;
    }

    const nombres =
      typeof cuerpo["nombres"] === "string" && cuerpo["nombres"].trim()
        ? cuerpo["nombres"].trim()
        : antes["nombres"];
    const rol = quiereCambiarRol ? String(cuerpo["rol"]) : antes["rol"];
    const activo =
      typeof cuerpo["activo"] === "boolean" ? cuerpo["activo"] : antes["activo"];

    await pool.query(
      `UPDATE usuario SET nombres = $2, rol = $3::rol_usuario, activo = $4 WHERE id = $1`,
      [id, nombres, rol, activo]
    );

    // Una cuenta desactivada o con otro rol no puede seguir operando con la
    // sesión que abrió antes del cambio.
    let cerradas = 0;
    if (!activo || quiereCambiarRol) cerradas = await cerrarSesionesDe(id);

    auditar(req, "usuario", "MODIFICACION", id, {
      antes,
      despues: { nombres, rol, activo },
    });
    res.json({ id, nombres, rol, activo, sesiones_cerradas: cerradas });
  })
);

app.post(
  "/api/usuarios/:id/clave",
  requierePermiso("GESTIONAR_USUARIOS"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);
    const usuario = await consultarUna(
      `SELECT id, email, nombres FROM usuario WHERE id = $1`,
      [id]
    );
    if (!usuario) {
      res.status(404).json({ error: "La cuenta no existe." });
      return;
    }

    const password = generarPasswordLegible();
    await pool.query(`UPDATE usuario SET hash_password = $2 WHERE id = $1`, [
      id,
      await hashearPassword(password),
    ]);
    const cerradas = await cerrarSesionesDe(id);

    auditar(req, "usuario", "MODIFICACION", id, {
      despues: { evento: "restablecimiento de contraseña" },
    });
    res.json({
      id,
      email: usuario["email"],
      password,
      sesiones_cerradas: cerradas,
    });
  })
);

app.get(
  "/api/usuarios/:id/sesiones",
  requierePermiso("GESTIONAR_USUARIOS"),
  ruta(async (req, res) => {
    res.json(await sesionesActivas(Number(req.params["id"])));
  })
);

// =====================================================================
// CONVERSACIONES DEL AGENTE
// =====================================================================

app.get(
  "/api/conversaciones",
  requierePermiso("VER_CONVERSACIONES"),
  ruta(async (req, res) => {
    const filas = await consultar(
      `SELECT c.id, c.celular, c.estado,
              to_char(c.ultima_actividad_en AT TIME ZONE $1,'DD/MM/YYYY HH24:MI') AS actividad,
              p.id AS paciente_id,
              p.nombres || ' ' || p.apellidos AS paciente,
              p.num_doc,
              (SELECT count(*)::int FROM mensaje_conversacion m
                WHERE m.conversacion_id = c.id)                       AS mensajes,
              (SELECT count(*)::int FROM mensaje_conversacion m
                WHERE m.conversacion_id = c.id AND m.entrada = 'AUDIO') AS audios,
              (SELECT m.texto FROM mensaje_conversacion m
                WHERE m.conversacion_id = c.id
                ORDER BY m.ocurrido_en DESC LIMIT 1)                  AS ultimo_texto,
              (SELECT t.intencion FROM traza_agente t
                WHERE t.conversacion_id = c.id AND t.intencion IS NOT NULL
                ORDER BY t.ocurrido_en DESC LIMIT 1)                  AS intencion
       FROM conversacion c
       LEFT JOIN paciente p ON p.id = c.paciente_id
       ORDER BY c.ultima_actividad_en DESC`,
      [ZONA]
    );
    auditar(req, "conversacion", "LECTURA");
    res.json(filas);
  })
);

app.get(
  "/api/conversaciones/:id",
  requierePermiso("VER_CONVERSACIONES"),
  ruta(async (req, res) => {
    const id = Number(req.params["id"]);

    const conversacion = await consultarUna(
      `SELECT c.id, c.celular, c.estado, c.contexto,
              to_char(c.iniciada_en AT TIME ZONE $2,'DD/MM/YYYY HH24:MI') AS iniciada,
              to_char(c.ultima_actividad_en AT TIME ZONE $2,'DD/MM/YYYY HH24:MI') AS actividad,
              p.id AS paciente_id,
              p.nombres || ' ' || p.apellidos AS paciente,
              p.num_doc, p.tipo_doc, p.riesgo
       FROM conversacion c
       LEFT JOIN paciente p ON p.id = c.paciente_id
       WHERE c.id = $1`,
      [id, ZONA]
    );

    if (!conversacion) {
      res.status(404).json({ error: "La conversación no existe." });
      return;
    }

    const [mensajes, traza, citas] = await Promise.all([
      consultar(
        `SELECT id, rol, entrada, texto, transcripcion_ms,
                to_char(ocurrido_en AT TIME ZONE $2,'HH24:MI') AS hora
         FROM mensaje_conversacion
         WHERE conversacion_id = $1
         ORDER BY ocurrido_en, id`,
        [id, ZONA]
      ),
      consultar(
        `SELECT mensaje_id, intencion, herramienta, argumentos, exito, error_detalle,
                latencia_llm_ms, latencia_tool_ms, latencia_total_ms, modelo
         FROM traza_agente
         WHERE conversacion_id = $1
         ORDER BY ocurrido_en, id`,
        [id]
      ),
      conversacion["paciente_id"]
        ? consultar(
            `SELECT c.id, c.estado, c.origen,
                    to_char(c.inicio AT TIME ZONE $2,'DD/MM/YYYY') AS fecha,
                    to_char(c.inicio AT TIME ZONE $2,'HH24:MI')    AS hora,
                    m.especialidad,
                    'Dr(a). ' || m.nombres || ' ' || m.apellidos AS medico
             FROM cita c JOIN medico m ON m.id = c.medico_id
             WHERE c.paciente_id = $1
             ORDER BY c.inicio DESC
             LIMIT 5`,
            [conversacion["paciente_id"], ZONA]
          )
        : Promise.resolve([]),
    ]);

    // Solo se audita cuando el hilo pertenece a un paciente identificado:
    // es ahí donde se está accediendo a datos personales (RF-28).
    if (conversacion["paciente_id"]) {
      auditar(req, "conversacion", "LECTURA", id);
    }

    res.json({ conversacion, mensajes, traza, citas });
  })
);

// =====================================================================
// SALUD DEL SERVICIO
// =====================================================================

/**
 * Sonda para el balanceador y el monitoreo.
 *
 * Va sin sesión porque quien la consulta es una máquina, y por eso mismo
 * no revela nada: si la base está caída responde 503 sin decir por qué.
 * Un detalle del motor acá es un dato gratis para quien sondea el servidor.
 */
app.get("/api/salud", (_req, res) => {
  pool
    .query("SELECT 1")
    .then(() => res.json({ ok: true, hora: new Date().toISOString() }))
    .catch(() => res.status(503).json({ ok: false }));
});

// =====================================================================

app.use(manejadorErrores);

const PUERTO = Number(process.env["PORT"] ?? 3000);

app.listen(PUERTO, () => {
  console.log(`\n  Consultorio Perú Ruso — sistema de citas`);
  console.log(`  http://localhost:${PUERTO}\n`);
});
