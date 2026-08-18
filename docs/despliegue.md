# Puesta en producción

Consultorio Perú Ruso — Lima, 2026

Este documento va en orden. Cada bloque depende del anterior.

Hay dos clases de tarea: las de **gestión** (comprar, verificar, firmar),
que solo podés hacer vos, y las **técnicas**, que son comandos. Las de
gestión son las que tardan: la verificación de Meta puede llevar semanas y
no se acelera con nada. Empezá por esas, y mientras esperás, hacé el resto.

---

## Fase 0 — Trámites que tardan (empezá hoy)

Ninguno se programa. Todos bloquean la salida a producción.

### 0.1 Verificación de empresa ante Meta

Sin esto no hay WhatsApp, y sin WhatsApp no hay recordatorios, que es el
mecanismo con el que el sistema reduce el ausentismo.

1. Crear el negocio en [business.facebook.com](https://business.facebook.com)
2. Cargar los documentos: ficha RUC de SUNAT, dirección verificable y
   teléfono a nombre del consultorio
3. Esperar la aprobación
4. Crear la aplicación de WhatsApp Business y anotar el `PHONE_NUMBER_ID`
5. Enviar a aprobación las plantillas de mensaje (una por hito: T-48 h,
   T-24 h, T-3 h)

**Sobre las plantillas:** fuera de una ventana de 24 horas, Meta solo deja
enviar plantillas aprobadas de antemano. No se puede improvisar el texto de
un recordatorio. Diseñalas con las variables que ya usa el sistema: nombre,
fecha, hora, profesional.

### 0.2 Consentimiento informado (Ley N.° 29733)

El sistema ya exige consentimiento vigente antes de contactar a nadie: la
consulta de despacho lo verifica. Lo que falta es lo de afuera.

- Redactar el texto del consentimiento para contacto por WhatsApp
- Recogerlo firmado de cada paciente del piloto
- Cargarlo en la tabla `consentimiento`

Sin esto no podés contactar a un paciente real, aunque Meta ya te haya
aprobado todo.

### 0.3 Saldo en OpenAI

[platform.openai.com](https://platform.openai.com) → Billing. Sin saldo el
agente cae al modelo simulado, que acierta el 0 % de los mensajes
implícitos y de las correcciones.

### 0.4 Servidor y dominio

- VPS con Ubuntu 24.04, mínimo 2 vCPU y 4 GB de RAM
- Un dominio o subdominio, con un registro **A** apuntando a la IP del VPS

Verificá que el DNS ya resolvió antes de seguir: sin eso, Let's Encrypt no
puede emitir el certificado.

```bash
dig +short citas.tudominio.pe
```

---

## Fase 1 — Preparar el servidor

```bash
ssh root@TU_IP

adduser peruruso
usermod -aG sudo peruruso

apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 git
usermod -aG docker peruruso
```

Cortafuegos: solo web y SSH. **La base nunca se publica.**

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## Fase 2 — Traer el código y configurarlo

```bash
su - peruruso
sudo mkdir -p /opt/peruruso && sudo chown peruruso /opt/peruruso
git clone https://github.com/u18310128-lang/mvp-system_medycal.git /opt/peruruso
cd /opt/peruruso

cp .env.produccion.ejemplo .env
```

Generá los secretos y pegalos en `.env`:

```bash
echo "PGPASSWORD=$(openssl rand -base64 32)"
echo "N8N_PASSWORD=$(openssl rand -base64 24)"
echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Editá el resto a mano y cerrá el archivo:

```bash
nano .env
chmod 600 .env
```

Reemplazá tu dominio en la configuración de Nginx — aparece cuatro veces:

```bash
sed -i 's/citas.tudominio.pe/TU_DOMINIO_REAL/g' nginx/peruruso.conf
```

---

## Fase 3 — Certificado HTTPS

El certificado tiene que existir **antes** de levantar Nginx, porque su
configuración lo referencia y sin él no arranca.

```bash
docker run --rm -p 80:80 \
  -v peruruso_certbot-certs:/etc/letsencrypt \
  -v peruruso_certbot-raiz:/var/www/certbot \
  certbot/certbot certonly --standalone \
  -d TU_DOMINIO_REAL --agree-tos -m TU_CORREO --non-interactive
```

La renovación después es automática: el servicio `certbot` del compose la
revisa cada 12 horas.

---

## Fase 4 — Levantar el sistema

```bash
docker compose -f docker-compose.produccion.yml up -d --build
docker compose -f docker-compose.produccion.yml ps
```

El esquema de la base se crea solo la primera vez, desde los archivos de
`db/`. **No cargues `db/seed.sql`**: son los 60 pacientes sintéticos de la
demostración y no tienen nada que hacer en producción.

Comprobá que responde:

```bash
curl -s https://TU_DOMINIO_REAL/api/salud
```

Tiene que devolver `{"ok":true,...}`.

---

## Fase 5 — Credenciales reales

```bash
docker compose -f docker-compose.produccion.yml exec app \
  npx tsx scripts/crear-credenciales.ts
```

Las contraseñas se muestran **una sola vez**. Anotalas antes de cerrar la
terminal: en la base queda solo el resumen Argon2id, que no se puede
revertir.

Copiá la clave de servicio que imprime a `CLAVE_SERVICIO` en `.env` y
reiniciá la aplicación:

```bash
nano .env
docker compose -f docker-compose.produccion.yml up -d app
```

Entregá cada contraseña en persona. Que cada quien la cambie después.

---

## Fase 6 — Cargar los datos del consultorio

Esto es carga manual, desde la propia interfaz. En orden:

1. **Usuarios** — una cuenta por persona, con su rol real
2. **Horarios** — la semana de atención de cada profesional
3. **Pacientes** — con su consentimiento ya firmado

Las ventanas del estudio traen fechas de demostración. Reemplazalas por las
del piloto real:

```sql
UPDATE fase_estudio SET desde='2026-01-01', hasta='2026-07-31' WHERE fase='PRETEST';
UPDATE fase_estudio SET desde='2026-11-09', hasta='2026-12-27' WHERE fase='POSTEST';
```

---

## Fase 7 — Conectar WhatsApp de verdad

Recién acá, con las plantillas ya aprobadas.

1. Entrar a `https://TU_DOMINIO_REAL/n8n/` con `N8N_USUARIO` y `N8N_PASSWORD`
2. Importar el flujo de `n8n/workflows/despacho-recordatorios.json`
3. Cargar las credenciales de Meta como credencial de n8n, **no** en el nodo
4. Reemplazar el nodo *«Enviar por WhatsApp (simulado)»* por una llamada
   HTTP a la Cloud API. Es el único nodo que cambia; el resto del flujo
   queda igual
5. Configurar el webhook de Meta apuntando a
   `https://TU_DOMINIO_REAL/api/agente/mensaje`

**Probá con tu propio número antes que con un paciente.**

---

## Fase 8 — Respaldos

Un sistema con historias clínicas sin respaldo probado no está en
producción: está esperando el día que pierda los datos.

```bash
chmod +x scripts/respaldo.sh
crontab -e
```

```cron
0 3 * * * cd /opt/peruruso && ./scripts/respaldo.sh >> /var/log/peruruso-respaldo.log 2>&1
```

El script verifica que el volcado esté completo antes de borrar los
anteriores, y conserva 30 días.

**Probá la restauración.** Un respaldo que nunca se restauró es una
suposición, no un respaldo:

```bash
gunzip -c /var/respaldos/peruruso/peruruso-FECHA.sql.gz \
  | docker compose -f docker-compose.produccion.yml exec -T db \
    psql -U USUARIO -d peru_ruso_prueba
```

---

## Lista de verificación antes de atender al primer paciente

- [ ] `https://TU_DOMINIO/api/salud` responde `ok`
- [ ] El candado del navegador aparece y no hay aviso de certificado
- [ ] `http://` redirige a `https://`
- [ ] Las contraseñas por omisión fueron reemplazadas y entregadas
- [ ] El seed de demostración **no** está cargado
- [ ] Las ventanas de `fase_estudio` son las del piloto real
- [ ] Los horarios de cada profesional están cargados
- [ ] Un recordatorio de prueba llegó a tu propio WhatsApp
- [ ] El respaldo corrió y se restauró en una base de prueba
- [ ] Cada paciente del piloto tiene consentimiento firmado y cargado

---

## Operación diaria

```bash
# Ver qué está pasando
docker compose -f docker-compose.produccion.yml logs -f app

# Desplegar un cambio
git pull && docker compose -f docker-compose.produccion.yml up -d --build app

# Reiniciar todo
docker compose -f docker-compose.produccion.yml restart
```

---

## Si algo falla

| Síntoma | Dónde mirar |
|---|---|
| El sitio no carga | `docker compose ... ps` — ver si Nginx está arriba |
| Error de certificado | `docker compose ... logs certbot` |
| `/api/salud` da 503 | La base no responde: `docker compose ... logs db` |
| El agente se disculpa siempre | Saldo de OpenAI, o `CLAVE_SERVICIO` mal cargada |
| No llegan recordatorios | `logs n8n`, y revisar que las plantillas sigan aprobadas |
