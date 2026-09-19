/* ============ Notas UTP — lógica de la app ============ */
"use strict";

const $ = (sel) => document.querySelector(sel);
const CLAVE_URL = "notas_url_backend";
const CLAVE_HISTORIAL = "notas_historial";

let historial = JSON.parse(localStorage.getItem(CLAVE_HISTORIAL) || "[]");
let borrador = { titulo: "", texto: "" };
let notaEditandoIdx = -1;
let menuAbierto = false;

/* ---------- navegación ---------- */
function irA(id) {
  document.querySelectorAll(".vista").forEach((v) => v.classList.remove("activa"));
  $(id).classList.add("activa");
  cerrarMenu();
}

/* ---------- utilidades ---------- */
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("oculto");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("oculto"), ms);
}
function guardarHistorial() {
  localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(historial));
}
function fechaCorta(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/'/g, "'");
}

/* ---------- menú contextual (long press) ---------- */
function abrirMenu(e, idx) {
  e.preventDefault();
  e.stopPropagation();
  cerrarMenu();

  const menu = document.createElement("div");
  menu.className = "card-menu";
  menu.id = "card-menu";
  menu.innerHTML = `
    <button class="menu-item danger" data-accion="eliminar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
      Eliminar
    </button>
  `;
  document.body.appendChild(menu);

  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 160)}px`;
  menu.style.top = `${rect.bottom + 8}px`;

  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.id = "menu-overlay";
  document.body.appendChild(overlay);

  menuAbierto = true;

  overlay.addEventListener("click", cerrarMenu);
  menu.querySelector("[data-accion=eliminar]").addEventListener("click", () => {
    eliminarNota(idx);
    cerrarMenu();
  });
}

function cerrarMenu() {
  const menu = $("#card-menu");
  const overlay = $("#menu-overlay");
  if (menu) menu.remove();
  if (overlay) overlay.remove();
  menuAbierto = false;
}

function eliminarNota(idx) {
  if (confirm("¿Eliminar esta nota? Se borra solo del historial local.")) {
    historial.splice(idx, 1);
    guardarHistorial();
    renderLista();
    toast("Nota eliminada");
  }
}

/* ---------- render lista ---------- */
function renderLista() {
  const cont = $("#lista-notas");
  cont.innerHTML = "";
  $("#lista-vacia").style.display = historial.length ? "none" : "block";

  [...historial].reverse().forEach((n, revIdx) => {
    const realIdx = historial.length - 1 - revIdx;
    const card = document.createElement("article");
    card.className = "nota-card";
    card.dataset.idx = realIdx;

    const estadoTxt = { enviada: "✓ enviada", cola: "⏳ en cola", error: "⚠️ error" }[n.estado] || "";
    card.innerHTML = `
      <h3>${escapeHtml(n.titulo || "(sin título)")}</h3>
      <p>${escapeHtml(n.texto)}</p>
      <div class="nota-meta">
        <span>${fechaCorta(n.ts)}</span>
        ${n.curso ? `<span>${escapeHtml(n.curso)}</span>` : ""}
        <span class="estado ${n.estado}">${estadoTxt}</span>
      </div>
    `;

    // Click simple → editar
    card.addEventListener("click", () => abrirEditor(realIdx));

    // Long press → menú
    let pressTimer;
    card.addEventListener("pointerdown", (e) => {
      pressTimer = setTimeout(() => abrirMenu(e, realIdx), 500);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((evt) =>
      card.addEventListener(evt, () => clearTimeout(pressTimer))
    );

    cont.appendChild(card);
  });
  actualizarBanner();
}

/* ---------- editor ---------- */
function abrirEditor(idx) {
  notaEditandoIdx = idx;
  const n = historial[idx];
  borrador = { titulo: n.titulo || "", texto: n.texto || "" };
  $("#inp-titulo").value = n.titulo || "";
  $("#inp-texto").value = n.texto || "";
  $("#resultado-envio").classList.add("oculto");
  irA("#vista-editor");
  $("#inp-titulo").focus();
}

async function enviarNota(nota) {
  const url = localStorage.getItem(CLAVE_URL);
  if (!url) throw new Error("Configura la URL del backend en Ajustes");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ titulo: nota.titulo, texto: nota.texto }),
    redirect: "follow",
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || "Error del backend");
  return data;
}

async function procesarCola() {
  if (!navigator.onLine) return;
  const pendientes = historial.filter((n) => n.estado === "cola" || n.estado === "error");
  for (const n of pendientes) {
    try {
      const r = await enviarNota(n);
      n.estado = "enviada";
      n.curso = r.curso === "DESCONOCIDO" ? "_Bandeja" : r.curso;
      n.archivo = r.archivo;
      n.confianza = r.confianza;
      toast(`Guardada en: ${n.curso}`);
    } catch (e) {
      n.estado = navigator.onLine ? "error" : "cola";
      n.error = String(e.message || e);
      break;
    }
  }
  guardarHistorial();
  renderLista();
}

async function enviarDesdeEditor() {
  if (window.enviando) return;
  window.enviando = true;

  const btn = $("#btn-enviar");
  btn.disabled = true;
  btn.classList.add("sending");
  btn.style.opacity = "0.5";

  const titulo = $("#inp-titulo").value.trim();
  const texto = $("#inp-texto").value.trim();
  if (!texto) { toast("La nota está vacía"); resetBtn(); return; }

  const nota = { ts: Date.now(), titulo, texto, estado: "cola", curso: null };
  const esNueva = notaEditandoIdx === -1;
  if (esNueva) {
    historial.push(nota);
  } else {
    historial[notaEditandoIdx] = { ...historial[notaEditandoIdx], titulo, texto };
  }
  guardarHistorial();

  try {
    const r = await enviarNota(nota);
    if (esNueva) {
      historial[historial.length - 1] = { ...nota, estado: "enviada", curso: r.curso === "DESCONOCIDO" ? "_Bandeja" : r.curso, archivo: r.archivo, confianza: r.confianza };
    } else {
      historial[notaEditandoIdx] = { ...historial[notaEditandoIdx], estado: "enviada", curso: r.curso === "DESCONOCIDO" ? "_Bandeja" : r.curso, archivo: r.archivo, confianza: r.confianza };
    }
    guardarHistorial();

    btn.classList.remove("sending");
    btn.classList.add("success");
    btn.textContent = "✓";

    await new Promise(r => setTimeout(r, 400)); // espera animación

    btn.classList.remove("success");
    btn.textContent = "✓";
    btn.style.opacity = "1";
    btn.disabled = false;
    window.enviando = false;
    notaEditandoIdx = -1;
    irA("#vista-lista");
    renderLista();
    toast(`✓ Guardada en ${r.curso === "DESCONOCIDO" ? "_Bandeja" : r.curso}`);
  } catch (e) {
    if (esNueva) historial.pop(); else {
      historial[notaEditandoIdx].estado = navigator.onLine ? "error" : "cola";
      historial[notaEditandoIdx].error = String(e.message || e);
    }
    guardarHistorial();
    resetBtn();
    toast(`⚠️ ${e.message || e}`);
    renderLista();
  }
}

function resetBtn() {
  const btn = $("#btn-enviar");
  btn.disabled = false;
  btn.classList.remove("sending");
  btn.style.opacity = "1";
  window.enviando = false;
}

/* ---------- ajustes ---------- */
async function probarConexion() {
  const url = $("#inp-url").value.trim();
  const estado = $("#estado-conexion");
  if (!url) { estado.textContent = "Pega primero la URL."; return; }
  localStorage.setItem(CLAVE_URL, url);
  estado.textContent = "Probando…";
  try {
    const resp = await fetch(url + "?accion=ping");
    const data = await resp.json();
    estado.textContent = data.ok ? "✓ Conexión correcta" : "Respuesta inesperada";
  } catch (e) {
    estado.textContent = "✗ Sin conexión: revisa la URL y el despliegue";
  }
}

/* ---------- eventos ---------- */
$("#fab-nueva").addEventListener("click", () => {
  notaEditandoIdx = -1;
  borrador = { titulo: "", texto: "" };
  $("#inp-titulo").value = "";
  $("#inp-texto").value = "";
  $("#resultado-envio").classList.add("oculto");
  irA("#vista-editor");
  $("#inp-titulo").focus();
});
$("#btn-volver").addEventListener("click", () => { notaEditandoIdx = -1; irA("#vista-lista"); renderLista(); });
$("#btn-enviar").addEventListener("click", enviarDesdeEditor);
$("#btn-ajustes").addEventListener("click", () => {
  $("#inp-url").value = localStorage.getItem(CLAVE_URL) || "";
  irA("#vista-ajustes");
});
$("#btn-volver-ajustes").addEventListener("click", () => irA("#vista-lista"));
$("#btn-probar").addEventListener("click", probarConexion);
$("#btn-borrar-historial").addEventListener("click", () => {
  if (confirm("¿Borrar el historial local? Las notas ya enviadas siguen en tu Drive.")) {
    historial = [];
    localStorage.removeItem(CLAVE_HISTORIAL);
    renderLista();
    toast("Historial borrado");
  }
});
$("#btn-reintentar").addEventListener("click", procesarCola);
window.addEventListener("online", () => { toast("Conexión recuperada — enviando…"); procesarCola(); });
document.addEventListener("click", (e) => { if (menuAbierto && !e.target.closest(".card-menu")) cerrarMenu(); });

/* ---------- arranque + service worker ---------- */
renderLista();
if (historial.some((n) => n.estado === "cola" || n.estado === "error")) {
  procesarCola();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}