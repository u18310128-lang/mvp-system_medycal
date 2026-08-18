import { defineConfig, configDefaults } from "vitest/config";

/**
 * Configuración de las pruebas.
 *
 * Existe por un motivo puntual: la búsqueda de archivos de Vitest recorre
 * todo el proyecto, y `.claude/worktrees/` contiene copias completas del
 * repositorio. Sin excluirlas, cada copia aporta sus propias pruebas y el
 * total sale multiplicado —166 en vez de 123, por ejemplo—, con lo que el
 * número que se cita como evidencia deja de significar nada.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    coverage: {
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        "**/.claude/**",
        "evaluacion/**",
        "scripts/**",
      ],
    },
  },
});
