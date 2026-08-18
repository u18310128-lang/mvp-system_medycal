# =====================================================================
#  Consultorio Perú Ruso — imagen de la aplicación
#
#  Se usa la variante slim y no alpine porque @node-rs/argon2 trae binarios
#  nativos: con musl habría que compilarlos, y una imagen que a veces
#  compila y a veces no es peor que unos megabytes de más.
# =====================================================================

FROM node:26-slim

ENV NODE_ENV=production
ENV TZ=America/Lima

WORKDIR /app

# Las dependencias van en una capa aparte: mientras package-lock.json no
# cambie, un despliegue no vuelve a instalarlas.
COPY package.json package-lock.json ./

# `npm ci` respeta el lock exacto. Se conservan las dependencias de
# desarrollo porque el proyecto corre TypeScript con tsx, sin compilar.
RUN npm ci --ignore-scripts=false

COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY evaluacion ./evaluacion
COPY tsconfig.json ./

# El proceso no corre como root: si alguien logra ejecutar algo dentro del
# contenedor, no debería además ser administrador de él.
USER node

EXPOSE 3000

# La sonda la usa Docker para reiniciar el contenedor si deja de responder.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/infrastructure/http/server.ts"]
