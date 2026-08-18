#!/bin/sh
# =====================================================================
#  Respaldo de la base de datos
#
#      ./scripts/respaldo.sh
#
#  Pensado para correr desde cron en el servidor:
#      0 3 * * * cd /opt/peruruso && ./scripts/respaldo.sh >> /var/log/respaldo.log 2>&1
#
#  Un sistema con historias clínicas sin respaldo probado no es un sistema
#  en producción: es un sistema que todavía no perdió los datos.
# =====================================================================
set -eu

DESTINO="${DESTINO_RESPALDO:-/var/respaldos/peruruso}"
DIAS_A_CONSERVAR=30

# shellcheck disable=SC1091
. ./.env

FECHA=$(date +%Y%m%d-%H%M)
ARCHIVO="$DESTINO/peruruso-$FECHA.sql.gz"

mkdir -p "$DESTINO"

docker compose -f docker-compose.produccion.yml exec -T db \
  pg_dump -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists \
  | gzip > "$ARCHIVO"

# Un pg_dump que falla a mitad deja un .gz válido pero incompleto. Se
# comprueba que el volcado termine con la marca de cierre de PostgreSQL.
if ! gunzip -c "$ARCHIVO" | tail -5 | grep -q "PostgreSQL database dump complete"; then
  echo "ERROR: el respaldo $ARCHIVO quedó incompleto. Se elimina."
  rm -f "$ARCHIVO"
  exit 1
fi

echo "ok $(date '+%F %T')  $ARCHIVO  $(du -h "$ARCHIVO" | cut -f1)"

# Los respaldos viejos se borran solo después de confirmar que el nuevo
# sirve: si se borraran antes, un fallo dejaría el servidor sin ninguno.
find "$DESTINO" -name "peruruso-*.sql.gz" -mtime "+$DIAS_A_CONSERVAR" -delete

echo "Respaldos conservados: $(find "$DESTINO" -name 'peruruso-*.sql.gz' | wc -l)"
