#!/usr/bin/env node
/**
 * SERVIDOR LOCAL DE NOTAS — corre en la PC, escucha en :3001
 * Recibe notas de la PWA cuando el celular está en el WiFi de casa,
 * las clasifica con Gemini (si hay API key) y las guarda como .md en
 * ~/MiWorkspace → rclone las sube a Drive.
 *
 * Sin API key configurada: guarda todo en _Bandeja sin clasificar (sigue funcionando).
 *
 * Arrancar:  node servidor.js
 * Con clave: GEMINI_API_KEY=AIza... node servidor.js
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PUERTO = 3001;
const WORKSPACE = path.join(os.homedir(), "MiWorkspace");
const CURSOS_DIR = path.join(WORKSPACE, "Cursos", "UTP - Ciclo Agosto 2026");
const BANDEJA = path.join(WORKSPACE, "_Bandeja");
const MODELO = "gemini-3.6-flash";

function apiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    (() => {
      try {
        return fs.readFileSync(
          path.join(os.homedir(), ".config", "notas-bolsillo", "gemini.key"),
          "utf8"
        ).trim();
      } catch {
        return null;
      }
    })()
  );
}

function listarCursos() {
  try {
    return fs.readdirSync(CURSOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
}

function hoyLima() {
  // Lima = UTC-5 fijo
  const ahora = new Date(Date.now() - 5 * 3600e3);
  return ahora.toISOString().slice(0, 10);
}

function armarMarkdown(clasif, datos) {
  const fecha = new Date(Date.now() - 5 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  return [
    "# " + (clasif.titulo || datos.titulo || "Nota sin título"),
    "",
    "- **Fecha de captura:** " + fecha,
    "- **Curso:** " + clasif.curso,
    "- **Etiquetas:** " + (clasif.etiquetas.join(", ") || "—"),
    "- **Origen:** Notas de bolsillo (celular)",
    "",
    "## Contenido",
    "",
    datos.texto,
    "",
  ].join("\n");
}

function guardar(curso, nombreArchivo, contenido) {
  let dir;
  if (!curso || curso === "DESCONOCIDO") {
    dir = BANDEJA;
  } else {
    dir = path.join(CURSOS_DIR, curso, "Notas");
  }
  fs.mkdirSync(dir, { recursive: true });
  let nombre = nombreArchivo;
  if (fs.existsSync(path.join(dir, nombre))) {
    nombre = nombre.replace(/\.md$/, "") + "-" + Date.now().toString().slice(-4) + ".md";
  }
  fs.writeFileSync(path.join(dir, nombre), contenido);
  return path.relative(WORKSPACE, path.join(dir, nombre));
}

async function clasificar(titulo, texto, cursos) {
  const key = apiKey();
  if (!key) return { curso: "DESCONOCIDO", archivo: `nota-${hoyLima()}.md`, titulo: titulo || "", etiquetas: [], confianza: 0 };

  const prompt =
    "Eres un clasificador de notas de un estudiante. CURSOS DISPONIBLES:\n" +
    cursos.map((c) => "- " + c).join("\n") +
    "\n\nNOTA DEL ESTUDIANTE:\nTítulo: " + (titulo || "(sin título)") +
    "\nContenido: " + texto.slice(0, 3000) +
    '\n\nTAREA: Devuelve SOLO un JSON válido (sin markdown) con esta forma exacta:\n' +
    '{"curso":"<uno de la lista EXACTO o DESCONOCIDO>","archivo":"YYYY-MM-DD-slug-corto.md","titulo":"<título breve>","etiquetas":["tag1","tag2"],"confianza":0.0}\n' +
    'Reglas: clasifica por SIGNIFICADO aunque el título sea ambiguo ("conexiones ipv4" → Redes). Si no encaja, DESCONOCIDO. Slug corto en minúsculas. Usa la fecha de HOY (' + hoyLima() + ').';

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );
  const data = await resp.json();
  const textoResp = data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, "").trim();
  let out;
  try { out = JSON.parse(textoResp); }
  catch { out = null; }
  if (!out || !out.archivo) {
    out = { curso: "DESCONOCIDO", archivo: `nota-${hoyLima()}.md`, titulo: titulo || "", etiquetas: [], confianza: 0 };
  }
  if (!Array.isArray(out.etiquetas)) out.etiquetas = [];
  if (typeof out.confianza !== "number") out.confianza = 0;
  if (out.confianza < 0.45) out.curso = "DESCONOCIDO";
  return out;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "GET" && (url.pathname === "/ping" || url.pathname === "/")) {
    return json(200, { ok: true, msg: "backend local vivo", gemini: Boolean(apiKey()) });
  }
  if (req.method === "GET" && url.pathname === "/cursos") {
    return json(200, { ok: true, cursos: listarCursos() });
  }
  if (req.method === "POST" && (url.pathname === "/nota" || url.pathname === "/")) {
    let cuerpo = "";
    req.on("data", (ch) => (cuerpo += ch));
    req.on("end", async () => {
      try {
        const datos = JSON.parse(cuerpo || "{}");
        const texto = (datos.texto || "").trim();
        if (!texto) return json(400, { ok: false, error: "La nota está vacía" });
        const cursos = listarCursos();
        const clasif = await clasificar((datos.titulo || "").trim(), texto, cursos);
        const rutaRel = guardar(clasif.curso, clasif.archivo, armarMarkdown(clasif, datos));
        console.log(`[nota] ${rutaRel}`);
        json(200, {
          ok: true,
          curso: clasif.curso === "DESCONOCIDO" ? "_Bandeja" : clasif.curso,
          archivo: clasif.archivo,
          etiquetas: clasif.etiquetas,
          confianza: clasif.confianza,
          ruta: rutaRel,
        });
      } catch (e) {
        console.error("[error]", e);
        json(500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }
  json(404, { ok: false, error: "Ruta desconocida" });
});

server.listen(PUERTO, "0.0.0.0", () =>
  console.log(`Backend local escuchando en http://0.0.0.0:${PUERTO} | Gemini: ${apiKey() ? "ON" : "OFF (todo va a _Bandeja)"}`)
);
