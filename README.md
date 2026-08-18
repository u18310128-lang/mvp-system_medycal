# Sistema web automatizado para reducir el ausentismo de pacientes

Consultorio Perú Ruso — Lima, 2026
Tesis de Ingeniería de Sistemas e Informática

---

## Cómo levantarlo

```bash
npm run start
```

Luego abrí **http://localhost:3000**

Para desarrollo con recarga automática al guardar:

```bash
npm run dev
```

---

## Requisitos

| Componente | Versión | Estado |
|---|---|---|
| PostgreSQL | 18.4 | Instalado como servicio, puerto **5433** |
| Node.js | 26.6 | Instalado |
| Base de datos | `peru-ruso` | Creada y poblada |

Si la conexión falla, ajustá las variables de entorno (los valores por defecto
están en `src/infrastructure/db/pool.ts`):

```bash
PGHOST=localhost  PGPORT=5433  PGDATABASE=peru-ruso  PGUSER=postgres  PGPASSWORD=***
```

---

## Preparar la base desde cero

```bash
psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/schema.sql
psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/seed.sql
```

---

## Archivos de base de datos

| Archivo | Qué contiene |
|---|---|
| `db/schema.sql` | 15 tablas, 20 tipos enum. Verificado contra PostgreSQL 18.4 |
| `db/seed.sql` | Datos de demostración: 60 pacientes, 720 citas, 1026 recordatorios |
| `db/indicadores.sql` | Una consulta por cada ficha técnica del anexo + exportación para SPSS |
| `db/verificar_restricciones.sql` | 10 pruebas de las restricciones críticas |

Para reejecutar las pruebas de restricciones:

```bash
psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/verificar_restricciones.sql
```

---

## Pruebas del dominio

```bash
npm test
```

43 pruebas · 93,77 % de cobertura en `src/domain`

```bash
npm run test:cov
```

---

## Estructura

```
src/
  domain/            Reglas de negocio. Sin dependencias externas.
    Cita.ts            Máquina de estados de la cita
    PoliticaRecordatorios.ts   Qué recordatorio se envía y cuándo
    Reloj.ts           Puerto de tiempo (permite probar la lógica temporal)
  application/       Casos de uso y puertos
  infrastructure/
    db/                Conexión a PostgreSQL
    http/server.ts     API REST
  ui/                Interfaz de recepción (HTML + CSS + JS, sin build)
tests/               Pruebas unitarias del dominio
db/                  Esquema, datos e indicadores
docs/                Especificación técnica
```

---

## Vistas

**Agenda del día** — citas de la fecha con su estado, recordatorios enviados
y acciones de confirmar, cerrar asistencia o cancelar.

**Registrar cita** — busca el paciente, muestra solo los cupos realmente
libres del médico y programa la secuencia de recordatorios al guardar.
El tiempo de llenado del formulario se registra para la Ficha técnica N.° 1.

**Indicadores** — comparación pretest/postest de la tasa de ausentismo y el
resto de los indicadores de las fichas técnicas.

---

## Importante para la tesis

### Las ventanas del estudio son de demostración

`db/seed.sql` ubica ambas fases en el pasado para que el panel muestre una
comparación el día de la demo:

- PRETEST 05/01/2026 – 30/04/2026
- POSTEST 04/05/2026 – 11/08/2026

**Al iniciar el piloto real hay que reemplazarlas** por las del proyecto:

```sql
UPDATE fase_estudio SET desde='2026-01-01', hasta='2026-07-31' WHERE fase='PRETEST';
UPDATE fase_estudio SET desde='2026-11-09', hasta='2026-12-27' WHERE fase='POSTEST';
```

### Los datos son sintéticos

Las cifras que muestra el panel sirven para demostrar el sistema y validar
las consultas, **no para el capítulo de resultados**. Las cifras reales salen
de los registros del consultorio.

---

---

## n8n — automatización de los recordatorios

```bash
docker compose up -d      # levantar
docker compose logs -f    # ver la actividad
docker compose down       # detener (los flujos se conservan)
```

Editor en **http://localhost:5678**

### Cómo se reparte el trabajo

```
n8n (Docker :5678)                Aplicación (nativa :3000)
──────────────────                ─────────────────────────
Cron cada minuto ───────────────▶ POST /api/recordatorios/pendientes
                                       │ decide qué enviar y lo encola
                 ◀─────────────────────┘
Compone y envía
                 ───────────────▶ POST /api/recordatorios/:id/resultado
Webhook de Meta  ───────────────▶ POST /api/webhooks/whatsapp
```

n8n orquesta y envía. La aplicación decide **qué** corresponde enviar, valida
el consentimiento y registra los estados. La lógica de negocio no vive en los
nodos del flujo, que es lo que la mantiene verificable con pruebas.

### Garantías del despacho

| Riesgo | Cómo se evita |
|---|---|
| Dos ejecuciones toman el mismo recordatorio | `FOR UPDATE SKIP LOCKED` al reclamar |
| Un reintento genera un segundo mensaje | `UNIQUE` sobre `clave_idempotencia` |
| Se informa dos veces el mismo resultado | El `UPDATE` exige estado `ENCOLADO`; si no, responde 409 |
| Se contacta a quien revocó el consentimiento | La consulta exige consentimiento vigente (Ley N.° 29733) |

### Reimportar el flujo

```bash
docker exec peruruso-n8n n8n import:workflow --input=/workflows/despacho-recordatorios.json
docker exec peruruso-n8n n8n publish:workflow --id=despachoRecord01
docker compose restart n8n
```

### Envío simulado

El nodo *«Enviar por WhatsApp (simulado)»* registra el mensaje en lugar de
enviarlo, porque Meta todavía no aprueba las plantillas. Al aprobarse, se
reemplaza ese único nodo por una llamada HTTP a la Cloud API y el resto del
flujo queda igual.

---

## Agente conversacional de citas

Canal por el que el paciente gestiona su cita escribiendo o mandando un
audio, en lugar de llamar por teléfono al consultorio.

```bash
psql -U postgres -h localhost -p 5433 -d peru-ruso -f db/migracion-agente.sql
npm run start          # en una terminal
npm run demo:agente    # en otra
```

`demo:agente` recorre seis escenarios y muestra, turno por turno, qué
intención se detectó, qué herramienta se pidió y cuánto demoró cada tramo.

### Cómo se reparte el trabajo

```
Modelo de lenguaje                Dominio
──────────────────                ───────
Interpreta el mensaje    ───────▶ SolicitudAgente decide qué falta preguntar
Pide una herramienta     ───────▶ AlcanceAgente decide si está permitida
Redacta la respuesta     ◀─────── El sistema de citas devuelve datos reales
```

El modelo decide **qué herramienta pedir**; nunca decide **si tiene derecho
a ejecutarla** ni **qué horarios existen**. Las dos reglas que sostienen el
canal —un número no registrado no opera citas, y un paciente solo opera
sobre las suyas— viven en `src/domain/AlcanceAgente.ts` y se prueban sin
LLM ni base de datos.

### Configuración

| Variable | Para qué | Por omisión |
|---|---|---|
| `CLAVE_SERVICIO` | Autentica al proceso que llama a `/api/agente/*` | — |
| `OPENAI_API_KEY` | Sin ella corre el modelo simulado | — |
| `AGENTE_MODELO` | Modelo a usar; comparar modelos no exige recompilar | `gpt-4o-mini` |
| `AGENTE_API_URL` | Base de la API de citas que consulta el agente | `http://localhost:3000` |
| `AGENTE_AGENDA` | `http` (por la API) o `directo` (en proceso) | `http` |

El agente consulta la agenda **por HTTP** aunque esté en el mismo proceso.
Es la frontera que permite sustituir el sistema de citas sin tocar el
agente; `AGENTE_AGENDA=directo` sirve para medir cuánto cuesta esa frontera.

### Rutas

| Ruta | Qué hace |
|---|---|
| `GET /api/agente/especialidades` | Lo que el consultorio atiende |
| `GET /api/agente/disponibilidad` | Cupos libres por especialidad, fecha y franja |
| `GET /api/agente/citas` | Próximas citas del paciente |
| `POST /api/agente/citas` | Registra la cita que el paciente eligió |
| `POST /api/agente/citas/:id/confirmar` | El paciente confirma que asistirá |
| `POST /api/agente/citas/:id/cancelar` | Cancela y libera el cupo |
| `POST /api/agente/citas/:id/reprogramar` | Mueve la cita a otro horario |
| `POST /api/agente/mensaje` | Atiende un mensaje del paciente |
| `GET /api/agente/traza/:id` | Traza de una conversación, para el análisis |

### La cita tiene que ser propia

El identificador de cita lo propone el modelo a partir del texto del
paciente, así que no alcanza con comprobarlo del lado de la herramienta:
se verifica contra la base, dentro de la misma transacción que hace el
cambio. Una cita ajena y una inexistente devuelven **el mismo** mensaje —
si difirieran, probar identificadores permitiría averiguar qué citas tiene
otra persona.

Por eso `consultar_mis_citas` no es un lujo: nadie dice «cancelá la cita
727», dicen «la del viernes». Listar es lo que le permite al agente saber
de cuál habla sin adivinar.

`/api/cupos` sigue siendo la consulta de recepción, que busca por médico.
El agente necesita la otra: el paciente sabe nombrar la especialidad, no
al profesional.

### Un solo registro de citas para los dos canales

`POST /api/citas` (recepción) y `POST /api/agente/citas` comparten
`src/infrastructure/citas/registrarCita.ts`. Si cada uno armara su propio
INSERT, tarde o temprano uno programaría los recordatorios y el otro no.
Lo único que cambia entre ambos es el origen y quién queda como autor —el
agente deja `creado_por` en nulo, porque no la registró una persona.

```bash
npm run verificar:registro
```

Dieciocho comprobaciones: que ambos caminos coincidan, que el solape se
siga rechazando y que ningún paciente pueda tocar la cita de otro.
Conviene correrlo después de tocar el registro de citas: es lo que impide
que un cambio pensado para el agente altere en silencio los datos que
recepción viene produciendo para la investigación.

### Al agendar, el cupo se vuelve a validar

Entre que el agente ofrece los horarios y el paciente contesta pueden
pasar minutos, y en ese intervalo recepción pudo tomar el mismo cupo. Por
eso `agendar` vuelve a buscar la disponibilidad real antes de registrar, y
si aun así pierde la carrera, la restricción `ex_cita_sin_solape` la
rechaza y el agente ofrece otro horario en lugar de fallar.

Si a la hora elegida hay dos profesionales libres y el paciente no dijo
cuál, el agente pregunta: elegir por él sería decidir algo que no delegó.

### Reprogramar no es cancelar y volver a agendar

Las dos operaciones van en **una sola transacción**. Si se hicieran por
separado y fallara la segunda, el paciente quedaría sin la cita vieja y
sin la nueva; y como liberar el cupo anterior es a veces lo que permite
tomar el nuevo, tampoco pueden ir en el orden inverso.

La cita anterior queda `REPROGRAMADA` y la nueva apunta a ella con
`cita_origen_id`. Esa cadena es la Ficha técnica N.° 13, y es lo que
distingue a quien movió su turno de quien simplemente no se presentó. Sin
ella, ambos casos se contarían igual.

### Sin clave de OpenAI también funciona

`LlmSimulado` reconoce intenciones por palabras clave. Cumple dos papeles:
permite desarrollar y probar el canal entero sin credenciales ni red, y es
la **condición de control** del experimento — comparar su desempeño con el
del modelo real sobre los mismos mensajes es lo que permite sostener con
evidencia qué aporta el agente.

### Evaluación del canal

```bash
npm run evaluar
```

Corre un banco de 31 mensajes etiquetados contra cada modelo disponible y
compara exactitud de intención, selección de herramienta, respeto de los
límites, latencia y consumo. No toca la base: la agenda, el padrón y el
hilo están sustituidos por dobles, así que se puede correr las veces que
haga falta. El detalle queda en `evaluacion/resultados.json` para el anexo.

El banco está en [`evaluacion/casos.ts`](evaluacion/casos.ts), agrupado por
tipo de dificultad, y cada caso dice por qué está ahí. Varias frases usan
giros del castellano peruano —«separar una cita», «¿hay campo?»— porque son
los que va a recibir el consultorio; un banco en español neutro mediría
otra cosa.

**El promedio global esconde lo importante.** El modelo simulado acierta el
100 % de los casos directos y el 0 % de los implícitos y de las
correcciones. Por eso el informe desglosa por dificultad: es la diferencia
entre «acierta la mitad» y «acierta todo lo fácil y nada de lo que un
paciente escribe de verdad».

### Qué queda registrado

`traza_agente` guarda por turno la intención detectada, la herramienta
usada, si tuvo éxito y las latencias del modelo y de la consulta por
separado. De ahí salen los indicadores de exactitud de intención, de
selección de herramienta y de tiempo de respuesta del canal.

Las citas que agende el agente llevan `origen = 'AGENTE'`, lo que permite
comparar la tasa de ausentismo entre el canal conversacional y el
tradicional en vez de mezclarlas.

---

## Pendiente

- Página de confirmación del paciente por enlace único
- Lista de espera y reasignación automática de cupos
- Extraer los casos de uso de `server.ts` a `src/application/`
- Autenticación y control de acceso por rol
- Verificación de empresa ante Meta y aprobación de plantillas de WhatsApp

### Del agente conversacional

- Transcripción de las notas de voz: hoy el audio entra ya transcrito
- Webhook de la Cloud API apuntando a `POST /api/agente/mensaje`
- Conjunto de mensajes de prueba para comparar modelo real contra simulado
- Lista de espera: al cancelarse una cita el cupo se libera, pero todavía
  no se le ofrece a nadie
