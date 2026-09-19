/**
 * NOTAS DE BOLSILLO — Backend (Google Apps Script)
 * =================================================
 * Recibe notas desde la PWA, las clasifica con Gemini y las guarda como .md
 * en la carpeta correcta de MiWorkspace en Drive.
 *
 * SETUP:
 * 1. script.google.com → Nuevo proyecto → pegar este código.
 * 2. Configuración del proyecto → mostrar "appsscript.json" y verificar
 *    que los scopes incluyan spreadsheets/documents/webapp (se piden solos al desplegar).
 * 3. Configuración del proyecto → Propiedades del script → agregar:
 *    GEMINI_API_KEY = <tu clave de https://aistudio.google.com/apikey>
 * 4. Implementar → Nueva implementación → App web:
 *    - Ejecutar como: Yo
 *    - Acceso: Cualquier persona
 * 5. Copiar la URL /exec y ponerla en los Ajustes de la PWA.
 */

const RAIZ = 'MiWorkspace';
const CARPETA_CURSOS = RAIZ + '/Cursos/UTP - Ciclo Agosto 2026';
const CARPETA_BANDEJA = RAIZ + '/_Bandeja';
const MODELO = 'gemini-3.6-flash';

/** Punto de entrada GET: devuelve la lista de cursos para el selector de la app. */
function doGet(e) {
  const accion = (e && e.parameter && e.parameter.accion) || 'cursos';
  if (accion === 'ping') {
    return json({ ok: true, msg: 'backend vivo' });
  }
  return json({ ok: true, cursos: listarCursos() });
}

/** Punto de entrada POST: recibe {titulo, texto, fecha} y guarda la nota clasificada. */
function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);
    const titulo = (datos.titulo || '').trim();
    const texto = (datos.texto || '').trim();
    if (!texto) return json({ ok: false, error: 'La nota está vacía' });

    const cursos = listarCursos();
    const clasif = clasificarConGemini(titulo, texto, cursos);

    let destino;
    if (clasif.curso === 'DESCONOCIDO') {
      destino = guardarEnCarpeta(CARPETA_BANDEJA, clasif.archivo, armarMarkdown(clasif, datos));
    } else {
      destino = guardarEnCarpeta(CARPETA_CURSOS + '/' + clasif.curso, clasif.archivo, armarMarkdown(clasif, datos));
    }

    return json({
      ok: true,
      curso: clasif.curso,
      archivo: clasif.archivo,
      etiquetas: clasif.etiquetas,
      confianza: clasif.confianza,
      ruta: destino,
    });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---------- helpers ---------- */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function listarCursos() {
  const it = DriveApp.getFoldersByName(RAIZ).next();
  const cursos = it.getFoldersByName('Cursos').next()
    .getFoldersByName('UTP - Ciclo Agosto 2026').next();
  const lista = [];
  const f = cursos.getFolders();
  while (f.hasNext()) lista.push(f.next().getName());
  return lista.sort();
}

function guardarEnCarpeta(ruta, nombreArchivo, contenido) {
  const partes = ruta.split('/');
  let carpeta = DriveApp.getRootFolder();
  for (const p of partes) {
    const it = carpeta.getFoldersByName(p);
    carpeta = it.hasNext() ? it.next() : carpeta.createFolder(p);
  }
  // si ya existe el archivo con ese nombre, agrega sufijo horario
  const existe = carpeta.getFilesByName(nombreArchivo);
  let nombreFinal = nombreArchivo;
  if (existe.hasNext()) {
    nombreFinal = nombreArchivo.replace(/\.md$/, '') + '-' + Utilities.formatDate(new Date(), 'America/Lima', 'HHmm') + '.md';
  }
  carpeta.createFile(nombreFinal, contenido, MimeType.PLAIN_TEXT);
  return ruta + '/' + nombreFinal;
}

function armarMarkdown(clasif, datos) {
  const hoy = new Date();
  const fecha = Utilities.formatDate(hoy, 'America/Lima', 'yyyy-MM-dd HH:mm');
  return [
    '# ' + (clasif.titulo || datos.titulo || 'Nota sin título'),
    '',
    '- **Fecha de captura:** ' + fecha,
    '- **Curso:** ' + clasif.curso,
    '- **Etiquetas:** ' + (clasif.etiquetas.join(', ') || '—'),
    '- **Origen:** Notas de bolsillo (celular)',
    '',
    '## Contenido',
    '',
    datos.texto,
    '',
  ].join('\n');
}

function clasificarConGemini(titulo, texto, cursos) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Falta GEMINI_API_KEY en propiedades del script');

  const prompt =
    'Eres un clasificador de notas de un estudiante. CURSOS DISPONIBLES:\n' +
    cursos.map((c) => '- ' + c).join('\n') +
    '\n\nNOTA DEL ESTUDIANTE:\nTítulo: ' + (titulo || '(sin título)') +
    '\nContenido: ' + texto.slice(0, 3000) +
    '\n\nTAREA: Devuelve SOLO un JSON válido (sin markdown, sin explicaciones) con esta forma exacta:\n' +
    '{"curso":"<uno de la lista EXACTO o DESCONOCIDO>","archivo":"YYYY-MM-DD-slug-corto.md","titulo":"<título breve y claro>","etiquetas":["tag1","tag2"],"confianza":0.0}' +
    '\nReglas: elige el curso por SIGNIFICADO del contenido aunque el título sea ambiguo (ej. "conexiones ipv4" → curso de Redes). ' +
    'Si no encaja razonablemente con ningún curso usa "DESCONOCIDO". El slug debe ser corto (máx 5 palabras, minúsculas, guiones). ' +
    '"confianza" es 0.0 a 1.0. Usa la fecha de HOY para YYYY-MM-DD.';

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  });

  const resp = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + MODELO + ':generateContent?key=' + key,
    { method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true }
  );
  const data = JSON.parse(resp.getContentText());
  const textoResp = data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();

  let out;
  try {
    out = JSON.parse(textoResp);
  } catch (_) {
    out = { curso: 'DESCONOCIDO', archivo: 'nota-' + Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd-HHmm') + '.md', titulo: titulo || 'Nota', etiquetas: [], confianza: 0 };
  }
  if (!out.archivo || !/\.md$/.test(out.archivo)) out.archivo = 'nota.md';
  if (!Array.isArray(out.etiquetas)) out.etiquetas = [];
  if (typeof out.confianza !== 'number') out.confianza = 0;
  if (out.confianza < 0.45) out.curso = 'DESCONOCIDO';
  return out;
}
