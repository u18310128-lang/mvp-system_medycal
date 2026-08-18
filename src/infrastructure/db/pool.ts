import pg from "pg";

/**
 * Conexión a PostgreSQL.
 *
 * Host, puerto, base y usuario traen el valor de la instalación local de
 * desarrollo, porque no son secretos y ahorran configuración.
 *
 * La contraseña no: no tiene valor por omisión y el proceso se niega a
 * arrancar sin ella. Un valor por defecto acá termina siendo la contraseña
 * real de alguien, versionada y publicada, y el día que el servidor de
 * producción no reciba la variable se conectaría en silencio con la clave
 * de desarrollo en vez de fallar.
 */
const password = process.env["PGPASSWORD"];

if (!password) {
  throw new Error(
    "Falta PGPASSWORD. Copiá .env.ejemplo a .env y completá la contraseña de PostgreSQL."
  );
}

export const pool = new pg.Pool({
  host: process.env["PGHOST"] ?? "localhost",
  port: Number(process.env["PGPORT"] ?? 5433),
  database: process.env["PGDATABASE"] ?? "peru-ruso",
  user: process.env["PGUSER"] ?? "postgres",
  password,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/** Devuelve las filas de una consulta parametrizada. */
export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

/** Devuelve la primera fila, o null si no hay resultados. */
export async function consultarUna<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await consultar<T>(sql, params);
  return rows[0] ?? null;
}

/** Ejecuta una función dentro de una transacción. */
export async function enTransaccion<T>(
  fn: (cliente: pg.PoolClient) => Promise<T>
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (error) {
    await cliente.query("ROLLBACK");
    throw error;
  } finally {
    cliente.release();
  }
}
