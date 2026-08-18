/**
 * Regla de arquitectura verificable.
 *
 * Esta configuración es la evidencia empírica del RNF-12: no basta con
 * afirmar en la tesis que el dominio es independiente de la infraestructura,
 * hay que poder demostrarlo. `npm run arq:verificar` falla si alguien rompe
 * la regla, y su salida se adjunta como anexo del capítulo de resultados.
 */
module.exports = {
  forbidden: [
    {
      name: "dominio-sin-infraestructura",
      severity: "error",
      comment:
        "src/domain no puede depender de infraestructura. Es la regla que " +
        "sostiene la arquitectura hexagonal y hace comprobable el dominio.",
      from: { path: "^src/domain" },
      to: { path: "^src/(infrastructure|application)" },
    },
    {
      name: "dominio-sin-librerias-externas",
      severity: "error",
      comment:
        "src/domain no puede importar paquetes de node_modules. Si necesita " +
        "una capacidad externa, se declara como puerto y se implementa fuera.",
      from: { path: "^src/domain" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer"] },
    },
    {
      name: "aplicacion-sin-infraestructura",
      severity: "error",
      comment:
        "src/application depende de puertos, nunca de sus implementaciones. " +
        "Si esta regla falla, un caso de uso quedó atado a MySQL o a WhatsApp.",
      from: { path: "^src/application" },
      to: { path: "^src/infrastructure" },
    },
    {
      name: "sin-dependencias-circulares",
      severity: "error",
      comment: "Un ciclo entre módulos hace imposible razonar sobre el orden de carga.",
      from: {},
      to: { circular: true },
    },
    {
      name: "sin-huerfanos",
      severity: "warn",
      comment: "Módulo que nadie importa: probablemente código muerto.",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$"] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // src/ui se excluye porque el navegador lo carga con <script>, no por
    // import: quedaría marcado como huérfano sin serlo.
    exclude: { path: "(node_modules|coverage|tests|src/ui)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".ts"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
