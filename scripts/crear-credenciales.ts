/**
 * Genera las contraseñas iniciales de los usuarios y la clave de servicio
 * que usa n8n.
 *
 *   npx tsx scripts/crear-credenciales.ts
 *
 * Las contraseñas se muestran UNA sola vez por consola: en la base solo
 * queda su resumen Argon2id, que no se puede revertir. Anotalas antes de
 * cerrar la terminal.
 */
import { randomBytes } from "node:crypto";
import { pool } from "../src/infrastructure/db/pool.js";
import {
  hashearPassword,
  resumir,
  generarPasswordLegible,
} from "../src/infrastructure/auth/credenciales.js";

async function main(): Promise<void> {
  const { rows: usuarios } = await pool.query<{
    id: string; email: string; nombres: string; rol: string;
  }>(`SELECT id, email, nombres, rol FROM usuario WHERE activo ORDER BY id`);

  if (!usuarios.length) {
    console.log("No hay usuarios en la base. Ejecutá primero db/seed.sql");
    return;
  }

  console.log("\n  CREDENCIALES DE ACCESO — anotalas ahora, no se vuelven a mostrar\n");
  console.log("  " + "-".repeat(74));
  console.log(
    "  " + "CORREO".padEnd(30) + "CONTRASEÑA".padEnd(18) + "ROL".padEnd(16) + "NOMBRE"
  );
  console.log("  " + "-".repeat(74));

  for (const u of usuarios) {
    const password = generarPasswordLegible();
    const resumenPass = await hashearPassword(password);

    await pool.query(`UPDATE usuario SET hash_password = $2 WHERE id = $1`, [
      u.id,
      resumenPass,
    ]);

    console.log(
      "  " + u.email.padEnd(30) + password.padEnd(18) + u.rol.padEnd(16) + u.nombres
    );
  }
  console.log("  " + "-".repeat(74));

  // ---- clave de servicio para n8n ----
  const claveN8n = randomBytes(24).toString("base64url");

  await pool.query(
    `INSERT INTO clave_servicio (nombre, clave_hash)
     VALUES ('n8n-despacho', $1)
     ON CONFLICT (nombre) DO UPDATE
       SET clave_hash = EXCLUDED.clave_hash, activa = TRUE`,
    [resumir(claveN8n)]
  );

  console.log("\n  CLAVE DE SERVICIO PARA n8n\n");
  console.log("  " + claveN8n);
  console.log("\n  Se envía en la cabecera:  x-api-key: <clave>");
  console.log("  Solo habilita el despacho de recordatorios, nada más.\n");

  // Las sesiones abiertas quedan invalidadas al cambiar las contraseñas.
  const { rowCount } = await pool.query(
    `UPDATE sesion SET cerrada_en = now() WHERE cerrada_en IS NULL`
  );
  if (rowCount) console.log(`  Se cerraron ${rowCount} sesiones activas.\n`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
