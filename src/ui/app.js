/* =====================================================================
   Consultorio Perú Ruso — interfaz de recepción
   ===================================================================== */

const $ = (sel) => document.querySelector(sel);

/* Aplicación instalable. El registro no bloquea nada: si falla, el sistema
   sigue funcionando como una página común. */
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("No se pudo registrar el service worker:", error.message);
    });
  });
}

/** Usuario de la sesión actual. Se completa al iniciar. */
let sesion = null;

const api = async (url, opciones) => {
  const r = await fetch(url, opciones);
  // Sesión vencida o inexistente: de vuelta a la pantalla de acceso.
  if (r.status === 401) {
    location.href = "/login.html";
    throw new Error("Sesión finalizada.");
  }
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo.error ?? `Error ${r.status}`);
  return cuerpo;
};

/** ¿El rol de la sesión tiene permitida esta acción? */
const puede = (accion) => sesion?.acciones?.includes(accion) ?? false;

const hoyISO = () => {
  const ahora = new Date();
  const lima = new Date(ahora.getTime() - 5 * 3600_000);
  return lima.toISOString().slice(0, 10);
};

/* ---------------------------------------------------------- navegación */

/** Encabezado de cada vista. La pestaña dice adónde vas; esto, qué vas a ver. */
const ENCABEZADOS = {
  consulta: [
    "Mi consulta",
    "Tus pacientes del día, en orden de atención.",
  ],
  agenda: [
    "Agenda del día",
    "Citas de la fecha con su estado y sus recordatorios.",
  ],
  registrar: [
    "Registrar cita",
    "Buscá al paciente, elegí un cupo libre y el sistema programa los recordatorios.",
  ],
  indicadores: [
    "Indicadores",
    "Comparación pretest / postest de las fichas técnicas del estudio.",
  ],
  horarios: [
    "Horarios de atención",
    "La semana de trabajo y las ausencias. De acá salen los cupos que ofrece el sistema.",
  ],
  usuarios: [
    "Usuarios del sistema",
    "Cuentas, roles y sesiones abiertas.",
  ],
  conversaciones: [
    "Conversaciones",
    "Los hilos del agente y lo que decidió en cada turno.",
  ],
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("activo"));
    document.querySelectorAll(".vista").forEach((v) => v.classList.remove("activa"));
    tab.classList.add("activo");
    $(`#vista-${tab.dataset.vista}`).classList.add("activa");

    const [titulo, bajada] = ENCABEZADOS[tab.dataset.vista] ?? [];
    if (titulo) {
      $("#titulo-vista").textContent = titulo;
      $("#bajada-vista").textContent = bajada;
    }

    if (tab.dataset.vista === "indicadores") cargarIndicadores();
    if (tab.dataset.vista === "registrar") iniciarCronometro();
    if (tab.dataset.vista === "consulta") cargarConsulta();
    if (tab.dataset.vista === "horarios") cargarHorarios();
    if (tab.dataset.vista === "usuarios") cargarUsuarios();
    if (tab.dataset.vista === "conversaciones") cargarConversaciones();
  });
});

/* ------------------------------------------------------------- tema */

$("#btn-tema").addEventListener("click", () => {
  const raiz = document.documentElement;
  const oscuroAhora =
    raiz.dataset.tema === "oscuro" ||
    (!raiz.dataset.tema && matchMedia("(prefers-color-scheme: dark)").matches);
  const nuevo = oscuroAhora ? "claro" : "oscuro";
  raiz.dataset.tema = nuevo;
  localStorage.setItem("tema", nuevo);
});

/* ============================================================ AGENDA */

const COLUMNAS = 8;

/** Última agenda cargada. El filtro y la exportación trabajan sobre esto. */
let citasDelDia = [];

/** Las cuatro respuestas posibles del paciente, con su etiqueta y su color. */
const RESPUESTAS = [
  { clave: "CONFIRMAR", etiqueta: "Sí", color: "var(--ok)" },
  { clave: "REPROGRAMAR", etiqueta: "Reagenda", color: "var(--info)" },
  { clave: "CANCELAR", etiqueta: "No", color: "var(--alert)" },
  { clave: "BAJA", etiqueta: "Baja", color: "var(--warn)" },
];

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre",
];

/** «lunes 23 de marzo», a partir de un ISO, sin depender de la zona del navegador. */
function rotularFecha(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  const fecha = new Date(Date.UTC(a, m - 1, d));
  return `${DIAS[fecha.getUTCDay()]} ${d} de ${MESES[m - 1]}`;
}

function correrDias(iso, dias) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

async function cargarAgenda() {
  const fecha = $("#fecha").value || hoyISO();
  $("#dia-rotulo").textContent = rotularFecha(fecha);

  const cuerpo = $("#cuerpo-agenda");
  cuerpo.innerHTML = `<tr><td colspan="${COLUMNAS}" class="spinner">Cargando…</td></tr>`;
  $("#pie-tabla").hidden = true;

  try {
    citasDelDia = await api(`/api/agenda?fecha=${fecha}`);
    pintarTablero(citasDelDia);

    if (!citasDelDia.length) {
      cuerpo.innerHTML = "";
      $("#resumen-agenda").innerHTML = "";
      $("#agenda-vacia").hidden = false;
      return;
    }

    $("#agenda-vacia").hidden = true;
    const cuenta = (e) => citasDelDia.filter((c) => c.estado === e).length;
    $("#resumen-agenda").innerHTML = `
      <span><b>${citasDelDia.length}</b> citas</span>
      <span><b>${cuenta("CONFIRMADA")}</b> confirmadas</span>
      <span><b>${cuenta("PROGRAMADA")}</b> sin confirmar</span>`;

    aplicarFiltro();
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="${COLUMNAS}" class="spinner">${error.message}</td></tr>`;
  }
}

/**
 * Banner de respuestas.
 *
 * El denominador son las citas que efectivamente recibieron un recordatorio:
 * una cita que nunca se contactó no puede figurar como «sin responder», y
 * mezclarlas hundiría la tasa sin que nadie haya dejado de contestar.
 */
function pintarTablero(citas) {
  const contactadas = citas.filter((c) => Number(c.recordatorios_enviados) > 0).length;
  const respondidas = citas.filter((c) => c.respuesta).length;
  const base = Math.max(contactadas, respondidas);

  const pc = (n) => (base ? (n * 100) / base : 0);
  const format = (n) => n.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  $("#tablero-detalle").textContent = base
    ? `Respondidas ${respondidas} de ${base} contactadas`
    : "Todavía no se envió ningún recordatorio";
  $("#tablero-porcentaje").textContent = base ? `${format(pc(respondidas))} %` : "—";

  $("#tablero-desglose").innerHTML = RESPUESTAS.map((r) => {
    const n = citas.filter((c) => c.respuesta === r.clave).length;
    return `<div class="desglose-fila">
      <span class="resp r-${r.clave}">${r.etiqueta}</span>
      <span class="pista"><span class="relleno" style="width:${pc(n)}%;background:${r.color}"></span></span>
      <span class="n">${n}</span>
      <span class="pc">${format(pc(n))} %</span>
    </div>`;
  }).join("");
}

/* ------------------------------------------------------------- filtro */

function aplicarFiltro() {
  const termino = $("#filtro-tabla").value.trim().toLowerCase();
  const visibles = termino
    ? citasDelDia.filter((c) =>
        [c.paciente, c.num_doc, c.medico, c.estado, c.hora]
          .join(" ")
          .toLowerCase()
          .includes(termino)
      )
    : citasDelDia;

  const cuerpo = $("#cuerpo-agenda");
  cuerpo.innerHTML = visibles.length
    ? visibles.map(filaAgenda).join("")
    : `<tr><td colspan="${COLUMNAS}" class="spinner">Ninguna cita coincide con «${escapar(termino)}».</td></tr>`;

  cuerpo.querySelectorAll("[data-accion]").forEach((btn) => {
    btn.addEventListener("click", () => accionCita(btn.dataset.accion, btn.dataset.id));
  });

  $("#pie-tabla").hidden = false;
  $("#pie-conteo").innerHTML =
    visibles.length === citasDelDia.length
      ? `Mostrando <b>${citasDelDia.length}</b> citas`
      : `Mostrando <b>${visibles.length}</b> de <b>${citasDelDia.length}</b> citas`;
  $("#pie-nota").textContent = termino ? `Filtro activo: «${termino}»` : "";
}

function escapar(texto) {
  return String(texto).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}

function filaAgenda(c) {
  const riesgo = c.riesgo === "ALTO" ? `<span class="riesgo-ALTO">RIESGO ALTO</span>` : "";
  const pend = Number(c.recordatorios_pendientes);
  const env = Number(c.recordatorios_enviados);

  const info = RESPUESTAS.find((r) => r.clave === c.respuesta);
  const respuesta = info
    ? `<span class="resp r-${info.clave}">${info.etiqueta}</span>`
    : `<span class="resp r-sin">Sin respuesta</span>`;

  return `<tr>
    <td class="hora">${c.hora}</td>
    <td>${respuesta}</td>
    <td>${escapar(c.paciente)}${riesgo}</td>
    <td class="doc">${escapar(c.num_doc)}</td>
    <td>${escapar(c.medico)}</td>
    <td><span class="estado e-${c.estado}">${c.estado}</span></td>
    <td class="rec">${env} enviados${pend ? ` · <span class="pend">${pend} pendientes</span>` : ""}</td>
    <td class="der"><div class="acciones">${botonesCita(c)}</div></td>
  </tr>`;
}

/**
 * Botones de una cita, según lo que el rol tenga permitido.
 *
 * Cada botón declara la acción del dominio que ejecuta. Antes se dibujaban
 * los cuatro para todos: un médico veía «Confirmar» y «Cancelar», los
 * apretaba y el servidor le devolvía 403. Mostrar lo que no se puede hacer
 * no es un detalle estético, es prometer algo que no se cumple.
 */
function botonesCita(c) {
  const abierta = c.estado === "PROGRAMADA" || c.estado === "CONFIRMADA";
  if (!abierta) return `<span class="rec">—</span>`;

  const posibles = [
    {
      accion: "confirmar", permiso: "CONFIRMAR_CITA", texto: "Confirmar",
      clase: "mini", cuando: c.estado === "PROGRAMADA",
    },
    { accion: "atendida", permiso: "CERRAR_ASISTENCIA", texto: "Atendió", clase: "mini", cuando: true },
    { accion: "ausente", permiso: "CERRAR_ASISTENCIA", texto: "No asistió", clase: "mini peligro", cuando: true },
    { accion: "cancelar", permiso: "CANCELAR_CITA", texto: "Cancelar", clase: "mini peligro", cuando: true },
  ];

  const botones = posibles
    .filter((b) => b.cuando && puede(b.permiso))
    .map((b) => `<button class="${b.clase}" data-accion="${b.accion}" data-id="${c.id}">${b.texto}</button>`)
    .join("");

  return botones || `<span class="rec">—</span>`;
}

/* --------------------------------------------------- barra de la agenda */

$("#filtro-tabla").addEventListener("input", () => {
  if (citasDelDia.length) aplicarFiltro();
});

$("#dia-anterior").addEventListener("click", () => {
  $("#fecha").value = correrDias($("#fecha").value || hoyISO(), -1);
  cargarAgenda();
});

$("#dia-siguiente").addEventListener("click", () => {
  $("#fecha").value = correrDias($("#fecha").value || hoyISO(), 1);
  cargarAgenda();
});

/**
 * Exportación de la agenda a CSV.
 *
 * Sale del listado ya cargado, así que respeta el alcance del rol: si un
 * médico solo recibe su propia agenda, eso es lo único que puede exportar.
 */
$("#btn-exportar").addEventListener("click", () => {
  if (!citasDelDia.length) return;

  const cabeceras = [
    "hora", "respuesta", "paciente", "documento", "medico",
    "estado", "recordatorios_enviados", "recordatorios_pendientes",
  ];
  const celda = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const filas = citasDelDia.map((c) =>
    [
      c.hora,
      c.respuesta ?? "SIN RESPUESTA",
      c.paciente,
      c.num_doc,
      c.medico,
      c.estado,
      c.recordatorios_enviados,
      c.recordatorios_pendientes,
    ].map(celda).join(";")
  );

  // El BOM hace que Excel en Windows lea las tildes correctamente.
  const csv = "﻿" + [cabeceras.join(";"), ...filas].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `agenda-${$("#fecha").value || hoyISO()}.csv`;
  enlace.click();
  URL.revokeObjectURL(url);
});

async function accionCita(accion, id) {
  try {
    if (accion === "confirmar") {
      await api(`/api/citas/${id}/confirmar`, { method: "POST" });
    } else if (accion === "cancelar") {
      const motivo = prompt("Motivo de la cancelación:", "Solicitud del paciente");
      if (motivo === null) return;
      const r = await api(`/api/citas/${id}/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo }),
      });
      if (r.cupo_reasignable) {
        alert(
          `Cancelada con ${r.antelacion_horas} h de antelación.\n` +
          `El cupo puede reasignarse a la lista de espera.`
        );
      }
    } else {
      await api(`/api/citas/${id}/cerrar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asistio: accion === "atendida" }),
      });
    }
    // Recargar la vista desde la que se operó, no siempre la agenda.
    if ($("#vista-consulta").classList.contains("activa")) cargarConsulta();
    else cargarAgenda();
  } catch (error) {
    alert(error.message);
  }
}

$("#fecha").addEventListener("change", cargarAgenda);
$("#btn-hoy").addEventListener("click", () => {
  $("#fecha").value = hoyISO();
  cargarAgenda();
});

/* ====================================================== MI CONSULTA */

/**
 * Vista propia del profesional.
 *
 * Usa la misma ruta que la agenda: el servidor ya la acota a sus pacientes
 * cuando el alcance del rol es PROPIA. Lo que cambia es la lectura — un
 * médico no necesita una grilla para administrar el día, necesita saber a
 * quién atiende ahora y quién viene después.
 */
async function cargarConsulta() {
  const fecha = $("#c-fecha").value || hoyISO();
  $("#c-dia-rotulo").textContent = rotularFecha(fecha);

  const linea = $("#linea-consulta");
  linea.innerHTML = `<li class="spinner">Cargando…</li>`;
  $("#consulta-vacia").hidden = true;

  try {
    const citas = await api(`/api/agenda?fecha=${fecha}`);

    if (!citas.length) {
      linea.innerHTML = "";
      $("#consulta-vacia").hidden = false;
      $("#proximo-paciente").innerHTML =
        `<span class="rot">Próximo paciente</span>
         <span class="hora-grande">Sin citas</span>
         <span class="meta">No tenés pacientes para esta fecha.</span>`;
      $("#consulta-cifras").innerHTML = "";
      return;
    }

    const pendientes = citas.filter(
      (c) => c.estado === "PROGRAMADA" || c.estado === "CONFIRMADA"
    );
    const proximo = pendientes[0] ?? null;

    pintarProximo(proximo, pendientes.length);
    pintarCifrasConsulta(citas, pendientes);

    linea.innerHTML = citas
      .map((c) => turnoConsulta(c, proximo && c.id === proximo.id))
      .join("");

    linea.querySelectorAll("[data-accion]").forEach((btn) => {
      btn.addEventListener("click", () => accionCita(btn.dataset.accion, btn.dataset.id));
    });
  } catch (error) {
    linea.innerHTML = `<li class="spinner">${escapar(error.message)}</li>`;
  }
}

function pintarProximo(c, cuantosQuedan) {
  const caja = $("#proximo-paciente");

  if (!c) {
    caja.className = "proximo sin-pendientes";
    caja.innerHTML =
      `<span class="rot">Próximo paciente</span>
       <span class="hora-grande">Día cerrado</span>
       <span class="meta">Todos los turnos de la fecha ya tienen resultado.</span>`;
    return;
  }

  const marcas = [
    `<span class="marca">${c.estado === "CONFIRMADA" ? "Confirmada" : "Sin confirmar"}</span>`,
    c.riesgo === "ALTO" ? `<span class="marca riesgo">Riesgo alto de ausencia</span>` : "",
    cuantosQuedan > 1 ? `<span class="marca">${cuantosQuedan - 1} después</span>` : "",
  ].join("");

  caja.className = "proximo";
  caja.innerHTML =
    `<span class="rot">Próximo paciente</span>
     <span class="hora-grande">${c.hora}</span>
     <span class="nombre">${escapar(c.paciente)}</span>
     <span class="meta">${escapar(c.num_doc)}</span>
     <div class="marcas">${marcas}</div>`;
}

function pintarCifrasConsulta(citas, pendientes) {
  const cuenta = (fn) => citas.filter(fn).length;
  const confirmadas = cuenta((c) => c.estado === "CONFIRMADA");
  const riesgo = pendientes.filter((c) => c.riesgo === "ALTO").length;
  const cerradas = citas.length - pendientes.length;

  $("#consulta-cifras").innerHTML = `
    <div class="cifra-caja">
      <span class="rot">Pacientes</span>
      <span class="n">${citas.length}</span>
      <span class="pie-n">${cerradas} ya cerrados</span>
    </div>
    <div class="cifra-caja">
      <span class="rot">Confirmadas</span>
      <span class="n ok">${confirmadas}</span>
      <span class="pie-n">de ${citas.length} citas</span>
    </div>
    <div class="cifra-caja">
      <span class="rot">Por atender</span>
      <span class="n">${pendientes.length}</span>
      <span class="pie-n">quedan en el día</span>
    </div>
    <div class="cifra-caja">
      <span class="rot">Riesgo alto</span>
      <span class="n ${riesgo ? "alerta" : ""}">${riesgo}</span>
      <span class="pie-n">pueden no presentarse</span>
    </div>`;
}

function turnoConsulta(c, esSiguiente) {
  const cerrado = c.estado !== "PROGRAMADA" && c.estado !== "CONFIRMADA";
  const info = RESPUESTAS.find((r) => r.clave === c.respuesta);
  const respuesta = info ? `<span class="resp r-${info.clave}">${info.etiqueta}</span>` : "";
  const riesgo = c.riesgo === "ALTO" ? `<span class="riesgo-ALTO">RIESGO ALTO</span>` : "";

  const clases = ["turno", cerrado ? "cerrado" : "", esSiguiente ? "siguiente" : ""]
    .filter(Boolean)
    .join(" ");

  return `<li class="${clases}">
    <span class="momento">${c.hora}</span>
    <div class="quien-paciente">
      <div class="nombre-paciente">${escapar(c.paciente)}${riesgo}</div>
      <div class="datos">
        <span class="doc">${escapar(c.num_doc)}</span>
        <span class="estado e-${c.estado}">${c.estado}</span>
        ${respuesta}
      </div>
    </div>
    <div class="acciones">${botonesCita(c)}</div>
  </li>`;
}

$("#c-fecha").addEventListener("change", cargarConsulta);
$("#c-btn-hoy").addEventListener("click", () => {
  $("#c-fecha").value = hoyISO();
  cargarConsulta();
});
$("#c-dia-anterior").addEventListener("click", () => {
  $("#c-fecha").value = correrDias($("#c-fecha").value || hoyISO(), -1);
  cargarConsulta();
});
$("#c-dia-siguiente").addEventListener("click", () => {
  $("#c-fecha").value = correrDias($("#c-fecha").value || hoyISO(), 1);
  cargarConsulta();
});

/* ========================================================= REGISTRAR */

let pacienteSel = null;
let cupoSel = null;
let t0Registro = null;
let cronoTimer = null;

function iniciarCronometro() {
  t0Registro = performance.now();
  clearInterval(cronoTimer);
  cronoTimer = setInterval(() => {
    const seg = Math.round((performance.now() - t0Registro) / 1000);
    $("#cronometro").textContent = `${seg} s`;
  }, 1000);
}

$("#buscar-paciente").addEventListener("input", async (e) => {
  const q = e.target.value.trim();
  const caja = $("#sugerencias");
  if (q.length < 2) { caja.hidden = true; return; }

  const lista = await api(`/api/pacientes?q=${encodeURIComponent(q)}`);
  if (!lista.length) { caja.hidden = true; return; }

  caja.innerHTML = lista
    .map((p) => `<div data-id="${p.id}" data-nombre="${p.nombre}">${p.nombre}<small>${p.num_doc}</small></div>`)
    .join("");
  caja.hidden = false;

  caja.querySelectorAll("div").forEach((item) => {
    item.addEventListener("click", () => {
      pacienteSel = { id: Number(item.dataset.id), nombre: item.dataset.nombre };
      $("#paciente-elegido").innerHTML =
        `<span>${pacienteSel.nombre}</span><button id="quitar">quitar</button>`;
      $("#paciente-elegido").hidden = false;
      $("#buscar-paciente").value = "";
      caja.hidden = true;
      $("#quitar").addEventListener("click", () => {
        pacienteSel = null;
        $("#paciente-elegido").hidden = true;
        validar();
      });
      validar();
    });
  });
});

async function cargarCupos() {
  const medicoId = $("#sel-medico").value;
  const fecha = $("#fecha-cita").value;
  const caja = $("#cupos");
  cupoSel = null;
  validar();

  if (!medicoId || !fecha) {
    caja.innerHTML = `<p class="hint">Elegí médico y fecha para ver los cupos libres.</p>`;
    return;
  }

  caja.innerHTML = `<p class="hint">Buscando cupos…</p>`;
  const cupos = await api(`/api/cupos?medico_id=${medicoId}&fecha=${fecha}`);

  if (!cupos.length) {
    caja.innerHTML = `<p class="hint">No hay cupos libres. El médico no atiende ese día o la agenda está completa.</p>`;
    return;
  }

  caja.innerHTML = cupos
    .map((c) => `<button class="cupo" data-inicio="${c.inicio}">${c.hora}</button>`)
    .join("");

  caja.querySelectorAll(".cupo").forEach((btn) => {
    btn.addEventListener("click", () => {
      caja.querySelectorAll(".cupo").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      cupoSel = btn.dataset.inicio;
      validar();
    });
  });
}

$("#sel-medico").addEventListener("change", cargarCupos);
$("#fecha-cita").addEventListener("change", cargarCupos);

function validar() {
  $("#btn-guardar").disabled = !(pacienteSel && cupoSel);
}

$("#btn-guardar").addEventListener("click", async () => {
  const msg = $("#msg-registro");
  msg.hidden = true;

  try {
    const r = await api("/api/citas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paciente_id: pacienteSel.id,
        medico_id: Number($("#sel-medico").value),
        inicio: cupoSel,
        registro_seg: Math.round((performance.now() - t0Registro) / 1000),
      }),
    });

    msg.className = "msg ok";
    msg.innerHTML =
      r.recordatorios > 0
        ? `Cita registrada (N.° ${r.id}). Se programaron <b>${r.recordatorios} recordatorios</b>.`
        : `Cita registrada (N.° ${r.id}). <b>No se programaron recordatorios</b>: faltan menos de
           3 horas para la cita, así que todos los hitos de la secuencia ya vencieron.`;
    msg.hidden = false;

    pacienteSel = null;
    cupoSel = null;
    $("#paciente-elegido").hidden = true;
    validar();
    cargarCupos();
    iniciarCronometro();
  } catch (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    msg.hidden = false;
  }
});

/* ======================================================= INDICADORES */

async function cargarIndicadores() {
  const d = await api("/api/indicadores");

  $("#ventanas").innerHTML = d.ventanas
    .map((v) => `<div class="ventana"><b>${v.fase}</b> &nbsp; ${v.desde} — ${v.hasta}</div>`)
    .join("");

  const pre = d.ausentismo.find((f) => f.fase === "PRETEST");
  const post = d.ausentismo.find((f) => f.fase === "POSTEST");
  const delta = pre && post ? (Number(pre.tasa_ausentismo) - Number(post.tasa_ausentismo)).toFixed(2) : null;

  $("#kpis").innerHTML = `
    ${kpi("Tasa de ausentismo · postest", `${post?.tasa_ausentismo ?? "—"} %`,
          delta ? `${delta} puntos menos que el pretest` : "", "N.° 10", "baja")}
    ${kpi("Reducción absoluta", delta ? `${delta} pp` : "—",
          pre ? `desde ${pre.tasa_ausentismo} % en el pretest` : "", "OG", "baja")}
    ${kpi("Recordatorios entregados", `${d.recordatorios?.pct_envio ?? "—"} %`,
          `${d.recordatorios?.enviados ?? 0} de ${d.recordatorios?.programados ?? 0}`, "N.° 4")}
    ${kpi("Citas confirmadas", `${d.confirmacion?.pct_confirmacion ?? "—"} %`,
          "sobre el total del postest", "N.° 5")}
    ${kpi("Cupos recuperados", `${d.cupos?.pct_recuperacion ?? "—"} %`,
          `${d.cupos?.recuperados ?? 0} de ${d.cupos?.liberados ?? 0} liberados`, "N.° 14")}
    ${kpi("Tiempo de consulta", `${d.consulta?.seg_promedio ?? "—"} s`,
          "promedio de las operaciones de lectura", "N.° 9")}
  `;

  const max = Math.max(...d.ausentismo.map((f) => Number(f.tasa_ausentismo)), 1);
  $("#grafico").innerHTML = d.ausentismo
    .slice()
    .sort((a, b) => (a.fase > b.fase ? 1 : -1))
    .map((f) => `
      <div class="barra-fila">
        <span class="et">${f.fase}</span>
        <div class="barra-pista">
          <div class="barra-val ${f.fase === "PRETEST" ? "pre" : "post"}"
               style="width:${(Number(f.tasa_ausentismo) / max) * 100}%"></div>
        </div>
        <span class="cifra">${f.tasa_ausentismo} %</span>
      </div>`)
    .join("");

  $("#cuerpo-fases").innerHTML = d.ausentismo
    .slice()
    .sort((a, b) => (a.fase > b.fase ? 1 : -1))
    .map((f) => `<tr>
      <td><b>${f.fase}</b></td>
      <td class="num">${f.programadas}</td>
      <td class="num">${f.atendidas}</td>
      <td class="num">${f.ausentes}</td>
      <td class="num">${f.canceladas}</td>
      <td class="num"><b>${f.tasa_ausentismo} %</b></td>
      <td class="num">${f.pct_asistencia} %</td>
      <td class="num">${f.min_registro}</td>
    </tr>`)
    .join("");
}

function kpi(rotulo, valor, detalle, ficha, clase = "") {
  return `<div class="kpi">
    <span class="rot">${rotulo}</span>
    <div class="val ${clase}">${valor}</div>
    <div class="det">${detalle}</div>
    <div class="ficha">FICHA TÉCNICA ${ficha}</div>
  </div>`;
}

/* ===================================================== CONVERSACIONES */

let hilos = [];
let hiloAbierto = null;

const ETIQUETA_INTENCION = {
  SALUDO: "Saludo",
  CONSULTAR_DISPONIBILIDAD: "Consultar disponibilidad",
  AGENDAR: "Agendar",
  REPROGRAMAR: "Reprogramar",
  CANCELAR: "Cancelar",
  CONFIRMAR: "Confirmar",
  CONSULTAR_MIS_CITAS: "Consultar sus citas",
  FUERA_DE_ALCANCE: "Fuera de alcance",
  DESPEDIDA: "Despedida",
};

async function cargarConversaciones() {
  const lista = $("#hilos");
  lista.innerHTML = `<li class="spinner">Cargando…</li>`;

  try {
    hilos = await api("/api/conversaciones");
    pintarHilos();
    if (hilos.length && !hiloAbierto) abrirHilo(hilos[0].id);
  } catch (error) {
    lista.innerHTML = `<li class="spinner">${escapar(error.message)}</li>`;
  }
}

function pintarHilos() {
  const termino = $("#filtro-hilos").value.trim().toLowerCase();
  const visibles = termino
    ? hilos.filter((h) =>
        [h.paciente, h.celular, h.num_doc].join(" ").toLowerCase().includes(termino)
      )
    : hilos;

  const lista = $("#hilos");
  if (!visibles.length) {
    lista.innerHTML = `<li class="spinner">Sin conversaciones.</li>`;
    return;
  }

  lista.innerHTML = visibles
    .map((h) => {
      // Un número que no está en el padrón puede conversar, pero el sistema
      // no sabe de quién es: mostrarlo como paciente sería inventar.
      const quien = h.paciente
        ? escapar(h.paciente)
        : `<span class="anonimo">Número no registrado</span>`;
      const intencion = h.intencion
        ? `<span class="resp r-CONFIRMAR">${ETIQUETA_INTENCION[h.intencion] ?? h.intencion}</span>`
        : "";
      const audios = h.audios > 0 ? `<span class="marca-audio">${h.audios} audio</span>` : "";

      return `<li class="hilo${h.id === hiloAbierto ? " elegido" : ""}" data-hilo="${h.id}">
        <div class="titulo">
          <span class="quien-hilo">${quien}</span>
          <span class="cuando">${h.actividad}</span>
        </div>
        <div class="adelanto">${escapar(h.ultimo_texto ?? "")}</div>
        <div class="marcas-hilo">${intencion}${audios}</div>
      </li>`;
    })
    .join("");

  lista.querySelectorAll("[data-hilo]").forEach((li) => {
    li.addEventListener("click", () => abrirHilo(Number(li.dataset.hilo)));
  });
}

async function abrirHilo(id) {
  hiloAbierto = id;
  pintarHilos();
  $("#hilo-mensajes").innerHTML = `<p class="hint">Cargando…</p>`;

  try {
    const { conversacion, mensajes, traza, citas } = await api(`/api/conversaciones/${id}`);

    $("#chat-encabezado").innerHTML = `
      <h2>${conversacion.paciente ? escapar(conversacion.paciente) : "Número no registrado"}</h2>
      <p>${escapar(conversacion.celular)} · ${mensajes.length} mensajes · desde ${conversacion.iniciada}</p>`;

    $("#hilo-mensajes").innerHTML = mensajes.length
      ? mensajes.map(burbuja).join("")
      : `<p class="hint">El hilo no tiene mensajes.</p>`;

    pintarFichaHilo(conversacion);
    pintarTraza(traza, mensajes);

    $("#chat-citas").innerHTML = citas.length
      ? citas.map(citaMini).join("")
      : `<p class="hint">Sin citas registradas.</p>`;
  } catch (error) {
    $("#hilo-mensajes").innerHTML = `<p class="hint">${escapar(error.message)}</p>`;
  }
}

function burbuja(m) {
  const audio =
    m.entrada === "AUDIO"
      ? `<span class="marca-audio">audio${
          m.transcripcion_ms ? ` · ${m.transcripcion_ms} ms` : ""
        }</span>`
      : "";
  return `<div class="burbuja ${m.rol}">
    ${escapar(m.texto)}
    <div class="pie-burbuja">${audio}<span>${m.hora}</span></div>
  </div>`;
}

function pintarFichaHilo(c) {
  const filas = [
    ["Teléfono", escapar(c.celular)],
    ["Paciente", c.paciente ? escapar(c.paciente) : `<span class="anonimo">No registrado</span>`],
    ["Documento", c.num_doc ? `${c.tipo_doc} ${escapar(c.num_doc)}` : "—"],
    [
      "Riesgo",
      c.riesgo === "ALTO" ? `<span class="riesgo-ALTO">ALTO</span>` : (c.riesgo ?? "—"),
    ],
    ["Estado", `<span class="estado e-${c.estado === "ACTIVA" ? "CONFIRMADA" : "CANCELADA"}">${c.estado}</span>`],
    ["Iniciada", c.iniciada],
    ["Última actividad", c.actividad],
  ];

  // El contexto es lo que el hilo recordaba: sin esto no se puede explicar
  // por qué el agente no volvió a preguntar la especialidad.
  const contexto = c.contexto && Object.keys(c.contexto).length
    ? Object.entries(c.contexto).map(([k, v]) => `${k}: ${v}`).join(" · ")
    : "vacío";
  filas.push(["Contexto", escapar(contexto)]);

  $("#chat-datos").innerHTML = filas
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");
}

function pintarTraza(traza, mensajes) {
  if (!traza.length) {
    $("#chat-traza").innerHTML = `<p class="hint">Este hilo no tiene traza registrada.</p>`;
    return;
  }

  const textoDe = new Map(mensajes.map((m) => [m.id, m.texto]));

  $("#chat-traza").innerHTML = traza
    .map((t) => {
      const disparador = textoDe.get(t.mensaje_id);
      const herramienta = t.herramienta
        ? `<code>${escapar(t.herramienta)}</code>`
        : "<i>sin herramienta</i>";
      const latencias = [
        t.latencia_llm_ms != null ? `modelo ${t.latencia_llm_ms} ms` : "",
        t.latencia_tool_ms != null ? `consulta ${t.latencia_tool_ms} ms` : "",
        t.latencia_total_ms != null ? `total ${t.latencia_total_ms} ms` : "",
        t.modelo ? escapar(t.modelo) : "",
      ]
        .filter(Boolean)
        .map((x) => `<span>${x}</span>`)
        .join("");

      return `<div class="turno-traza${t.exito ? "" : " fallo"}">
        <div class="intencion">${ETIQUETA_INTENCION[t.intencion] ?? t.intencion ?? "—"}</div>
        ${disparador ? `<div class="herramienta">«${escapar(disparador.slice(0, 70))}»</div>` : ""}
        <div class="herramienta">${herramienta}</div>
        <div class="latencias">${latencias}</div>
        ${t.exito ? "" : `<div class="fallo-detalle">${escapar(t.error_detalle ?? "Falló")}</div>`}
      </div>`;
    })
    .join("");
}

function citaMini(c) {
  return `<div class="cita-mini">
    <span class="cuando-cita">${c.fecha} ${c.hora}</span>
    <span class="detalle-cita">${escapar(c.especialidad)}</span>
    <span class="estado e-${c.estado}">${c.estado}</span>
    ${c.origen === "AGENTE" ? `<span class="origen-AGENTE">agente</span>` : ""}
  </div>`;
}

$("#filtro-hilos").addEventListener("input", pintarHilos);

/* ========================================================== HORARIOS */

const NOMBRE_DIA = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

/** Médico cuyos horarios se están editando. Nulo cuando el rol es propio. */
let medicoEnEdicion = null;

async function cargarHorarios() {
  // Dirección elige el profesional; un médico solo se administra a sí mismo.
  if (sesion.alcance === "COMPLETA" && !$("#h-medico").options.length) {
    const medicos = await api("/api/medicos");
    $("#h-medico").innerHTML = medicos
      .map((m) => `<option value="${m.id}">${escapar(m.nombre)}</option>`)
      .join("");
    $("#selector-medico").hidden = false;
    medicoEnEdicion = medicos[0]?.id ?? null;
  }

  const consulta = medicoEnEdicion ? `?medico_id=${medicoEnEdicion}` : "";

  try {
    const { medico, bloques, excepciones } = await api(`/api/horarios${consulta}`);

    $("#h-subtitulo").textContent = medico
      ? `${medico.nombre} · ${medico.especialidad}. Los cupos que ofrece el sistema salen de estos bloques.`
      : "Los cupos que ofrece el sistema salen de estos bloques.";

    $("#h-semana").innerHTML = [1, 2, 3, 4, 5, 6, 7]
      .map((dia) => {
        const delDia = bloques.filter((b) => Number(b.dia_semana) === dia);
        const contenido = delDia.length
          ? delDia.map(chipBloque).join("")
          : `<span class="sin-bloques">No atiende</span>`;
        return `<div class="dia-fila${delDia.length ? "" : " vacio-dia"}">
          <span class="nombre-dia">${NOMBRE_DIA[dia]}</span>
          <div class="bloques">${contenido}</div>
        </div>`;
      })
      .join("");

    $("#h-semana").querySelectorAll("[data-bloque]").forEach((btn) => {
      btn.addEventListener("click", () => quitarBloque(btn.dataset.bloque));
    });

    $("#h-ausencias").innerHTML = excepciones.length
      ? excepciones.map(filaAusencia).join("")
      : `<li class="sin-bloques">No hay ausencias registradas.</li>`;

    $("#h-ausencias").querySelectorAll("[data-ausencia]").forEach((btn) => {
      btn.addEventListener("click", () => quitarAusencia(btn.dataset.ausencia));
    });
  } catch (error) {
    $("#h-semana").innerHTML = `<p class="sin-bloques">${escapar(error.message)}</p>`;
  }
}

function chipBloque(b) {
  return `<span class="bloque">
    ${b.hora_inicio}–${b.hora_fin}
    <span class="cada">cada ${b.duracion_min}′</span>
    <button class="quitar" data-bloque="${b.id}" title="Quitar bloque" aria-label="Quitar bloque">×</button>
  </span>`;
}

function filaAusencia(e) {
  const tramo = e.todo_el_dia
    ? `<span class="tramo">Todo el día</span>`
    : `<span class="tramo">${e.hora_inicio}–${e.hora_fin}</span>`;
  return `<li class="ausencia">
    <span class="cuando">${rotularFecha(e.fecha)}</span>
    ${tramo}
    <span class="motivo">${escapar(e.motivo)}</span>
    <button class="mini peligro" data-ausencia="${e.id}">Quitar</button>
  </li>`;
}

async function quitarBloque(id) {
  if (!confirm("¿Quitar este bloque de atención?")) return;
  try {
    const r = await api(`/api/horarios/${id}`, { method: "DELETE" });
    if (r.citas_afectadas > 0) {
      alert(
        `Bloque quitado.\n\nHay ${r.citas_afectadas} cita(s) ya reservada(s) en ese ` +
        `tramo que siguen en pie. Revisalas y reprogramalas: quitar el bloque ` +
        `deja de ofrecer cupos nuevos, no cancela los que ya tomó un paciente.`
      );
    }
    cargarHorarios();
  } catch (error) {
    alert(error.message);
  }
}

async function quitarAusencia(id) {
  try {
    await api(`/api/excepciones/${id}`, { method: "DELETE" });
    cargarHorarios();
  } catch (error) {
    alert(error.message);
  }
}

$("#h-medico").addEventListener("change", (e) => {
  medicoEnEdicion = e.target.value;
  cargarHorarios();
});

$("#a-todo-el-dia").addEventListener("change", (e) => {
  $("#a-tramo").hidden = e.target.checked;
});

$("#form-bloque").addEventListener("submit", async (e) => {
  e.preventDefault();
  await enviarFormulario("#h-msg", "Bloque agregado.", () =>
    api("/api/horarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        medico_id: medicoEnEdicion,
        dia_semana: Number($("#h-dia").value),
        hora_inicio: $("#h-desde").value,
        hora_fin: $("#h-hasta").value,
        duracion_min: Number($("#h-duracion").value),
      }),
    })
  );
  cargarHorarios();
});

$("#form-ausencia").addEventListener("submit", async (e) => {
  e.preventDefault();
  const todoElDia = $("#a-todo-el-dia").checked;

  const r = await enviarFormulario("#a-msg", "Ausencia registrada.", () =>
    api("/api/excepciones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        medico_id: medicoEnEdicion,
        fecha: $("#a-fecha").value,
        todo_el_dia: todoElDia,
        hora_inicio: todoElDia ? null : $("#a-desde").value,
        hora_fin: todoElDia ? null : $("#a-hasta").value,
        motivo: $("#a-motivo").value,
      }),
    })
  );

  if (r?.citas_afectadas > 0) {
    alert(
      `Ausencia registrada.\n\nHay ${r.citas_afectadas} cita(s) agendada(s) ese día. ` +
      `El sistema no las cancela solo: avisá a esos pacientes y reprogramalas.`
    );
  }
  $("#a-motivo").value = "";
  cargarHorarios();
});

/** Envía un formulario y deja el resultado en su cartel. Devuelve la respuesta. */
async function enviarFormulario(selectorMsg, textoOk, envio) {
  const msg = $(selectorMsg);
  try {
    const r = await envio();
    msg.className = "msg ok";
    msg.textContent = textoOk;
    msg.hidden = false;
    return r;
  } catch (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    msg.hidden = false;
    return null;
  }
}

/* ========================================================== USUARIOS */

const ETIQUETA_ROL_LARGA = {
  RECEPCIONISTA: "Recepción",
  MEDICO: "Médico",
  ADMINISTRADOR: "Dirección",
};

async function cargarUsuarios() {
  const cuerpo = $("#cuerpo-usuarios");
  cuerpo.innerHTML = `<tr><td colspan="7" class="spinner">Cargando…</td></tr>`;

  try {
    const usuarios = await api("/api/usuarios");
    cuerpo.innerHTML = usuarios.map(filaUsuario).join("");

    cuerpo.querySelectorAll("[data-usuario]").forEach((btn) => {
      btn.addEventListener("click", () =>
        accionUsuario(btn.dataset.accionUsuario, btn.dataset.usuario, btn.dataset.valor)
      );
    });
    cuerpo.querySelectorAll("select[data-rol-de]").forEach((sel) => {
      sel.addEventListener("change", () =>
        accionUsuario("rol", sel.dataset.rolDe, sel.value)
      );
    });
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="7" class="spinner">${escapar(error.message)}</td></tr>`;
  }
}

function filaUsuario(u) {
  const propio = u.id === sesion.id;

  // La propia cuenta no se puede desactivar ni cambiar de rol: quien lo
  // hiciera se dejaría afuera del sistema sin nadie que pueda reponerlo.
  const selectorRol = propio
    ? `${ETIQUETA_ROL_LARGA[u.rol]} <span class="rec">(vos)</span>`
    : `<select data-rol-de="${u.id}">${Object.entries(ETIQUETA_ROL_LARGA)
        .map(([v, t]) => `<option value="${v}"${v === u.rol ? " selected" : ""}>${t}</option>`)
        .join("")}</select>`;

  const acciones = [
    `<button class="mini" data-accion-usuario="clave" data-usuario="${u.id}">Restablecer clave</button>`,
    propio
      ? ""
      : `<button class="mini ${u.activo ? "peligro" : ""}" data-accion-usuario="activo"
                 data-usuario="${u.id}" data-valor="${u.activo ? "false" : "true"}">
           ${u.activo ? "Desactivar" : "Reactivar"}
         </button>`,
  ].join("");

  return `<tr class="${u.activo ? "" : "inactivo"}">
    <td><span class="nombre-usuario">${escapar(u.nombres)}</span>
        ${u.medico_id ? `<span class="rec"> · ficha médica</span>` : ""}</td>
    <td class="doc">${escapar(u.email)}</td>
    <td>${selectorRol}</td>
    <td><span class="estado ${u.activo ? "e-CONFIRMADA" : "e-CANCELADA"}">${u.activo ? "ACTIVA" : "INACTIVA"}</span></td>
    <td class="num">${u.sesiones}</td>
    <td class="doc">${u.ultimo_acceso ?? "—"}</td>
    <td class="der"><div class="acciones">${acciones}</div></td>
  </tr>`;
}

async function accionUsuario(accion, id, valor) {
  try {
    if (accion === "clave") {
      if (!confirm("Se generará una contraseña nueva y se cerrarán las sesiones de esa cuenta. ¿Seguir?")) {
        cargarUsuarios();
        return;
      }
      const r = await api(`/api/usuarios/${id}/clave`, { method: "POST" });
      mostrarClave("Contraseña restablecida", r.email, r.password);
    } else if (accion === "activo") {
      await api(`/api/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activo: valor === "true" }),
      });
    } else if (accion === "rol") {
      await api(`/api/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rol: valor }),
      });
    }
    cargarUsuarios();
  } catch (error) {
    alert(error.message);
    cargarUsuarios();
  }
}

/**
 * Muestra una contraseña recién emitida.
 *
 * Es la única vez que se puede leer: en la base queda solo el resumen
 * Argon2id. Por eso ocupa un cartel entero y no un mensaje que se pierda.
 */
function mostrarClave(titulo, email, password) {
  const caja = $("#clave-emitida");
  caja.innerHTML = `
    <h3>${titulo}</h3>
    <p>Anotala y entregala en persona. No se vuelve a mostrar: en la base solo queda su resumen.</p>
    <div class="credencial">
      <span>${escapar(email)}</span>
      <b>${escapar(password)}</b>
    </div>`;
  caja.hidden = false;
  caja.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#btn-nuevo-usuario").addEventListener("click", () => {
  $("#panel-nuevo-usuario").hidden = !$("#panel-nuevo-usuario").hidden;
});

$("#btn-cancelar-usuario").addEventListener("click", () => {
  $("#panel-nuevo-usuario").hidden = true;
  $("#u-msg").hidden = true;
});

$("#form-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#u-msg");
  try {
    const r = await api("/api/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombres: $("#u-nombres").value,
        email: $("#u-email").value,
        rol: $("#u-rol").value,
      }),
    });
    msg.hidden = true;
    $("#form-usuario").reset();
    $("#panel-nuevo-usuario").hidden = true;
    mostrarClave("Cuenta creada", r.email, r.password);
    cargarUsuarios();
  } catch (error) {
    msg.className = "msg error";
    msg.textContent = error.message;
    msg.hidden = false;
  }
});

/* ============================================================= inicio */

(async function iniciar() {
  // Sin sesión válida no se muestra nada.
  try {
    sesion = await api("/api/auth/yo");
  } catch {
    return; // api() ya redirigió a la pantalla de acceso
  }

  pintarSesion();
  aplicarPermisos();

  $("#fecha").value = hoyISO();
  $("#c-fecha").value = hoyISO();
  $("#fecha-cita").value = hoyISO();
  $("#a-fecha").value = hoyISO();

  if (puede("REGISTRAR_CITA")) {
    const medicos = await api("/api/medicos");
    $("#sel-medico").innerHTML =
      `<option value="">— Seleccionar —</option>` +
      medicos.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join("");
  }

  abrirVistaInicial();
})();

/**
 * Cada rol entra por donde trabaja.
 *
 * Quien solo ve su propia agenda arranca en «Mi consulta»; quien ve la del
 * consultorio entero, en el tablero de confirmaciones. La pestaña que no
 * corresponde no se muestra, porque duplicaría la misma información leída
 * de dos maneras.
 */
function abrirVistaInicial() {
  const propia = sesion.alcance === "PROPIA";

  document.querySelectorAll("[data-alcance]").forEach((el) => {
    el.hidden = el.dataset.alcance !== sesion.alcance;
  });

  const inicial = propia ? "consulta" : "agenda";
  document.querySelector(`.tab[data-vista="${inicial}"]`).click();
}

const ETIQUETA_ROL = {
  RECEPCIONISTA: "Recepción",
  MEDICO: "Médico",
  ADMINISTRADOR: "Dirección",
};

function pintarSesion() {
  $("#sesion-nombre").textContent = sesion.nombres;
  $("#sesion-nombre").title = sesion.nombres;
  $("#sesion-rol").textContent = ETIQUETA_ROL[sesion.rol] ?? sesion.rol;
  $("#sesion-inicial").textContent = iniciales(sesion.nombres);
  $("#barra-sesion").hidden = false;
}

/** Hasta dos iniciales, para el avatar. */
function iniciales(nombre) {
  return (nombre ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

/**
 * Oculta lo que el rol no puede usar.
 *
 * Es una comodidad de interfaz, no la medida de seguridad: el servidor
 * rechaza igual cualquier operación sin permiso, aunque alguien fuerce
 * la pestaña desde la consola del navegador.
 */
function aplicarPermisos() {
  document.querySelectorAll("[data-requiere]").forEach((el) => {
    el.hidden = !puede(el.dataset.requiere);
  });
}

$("#btn-salir").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/login.html";
});
