// text-extraction.ts — Fase 11 (gap de paridad real): pipeline real de
// extracción de texto de PDF/texto plano -- port ~literal de
// `licitaciones/apps/api/src/lib/expediente/text-extraction.ts` (el motor
// original, con TODAS sus rondas de auditoría ya incorporadas, ver abajo).
//
// Hueco que esta pieza cierra: `contract-extraction.ts` (Fase 6) y el README
// de este vertical (`apps/api/src/routes/verticals/licitaciones/README.md`)
// documentaban explícitamente que este monorepo fusionado NO tenía, en
// NINGÚN vertical, un pipeline que convirtiera BYTES de un PDF (nativo o
// escaneado) en texto -- ni para bases de licitación
// (`technicalProposal.ts::POST .../requirements/extract`, que solo aceptaba
// `{pages:[{page,text}]}` ya extraído) ni para el contrato firmado
// (`contractDocuments.ts::POST .../contract/documents`, mismo contrato de
// entrada). Este módulo es esa pieza: dado el `Buffer` de un archivo subido,
// produce texto por página REAL (nunca una aproximación proporcional) listo
// para alimentar `RequirementMatrixBuilder`/`LlmRequirementExtractor`
// (bases) o `extractContractFields` (contrato firmado) -- ver
// `apps/api/src/routes/verticals/licitaciones/technicalProposal.ts` y
// `contractDocuments.ts` para dónde se conecta esta salida.
//
// Cobertura honesta de esta ronda (idéntica a la del origen):
//  - PDF con capa de texto: `pdfjs-dist` (build "legacy", el empaquetado
//    pensado para Node sin DOM), extracción PÁGINA POR PÁGINA REAL.
//  - Texto plano (`.txt`, `.md`, mime `text/plain` o sin mime reconocible
//    que decodifique como UTF-8 imprimible): se usa tal cual, como una única
//    "página" virtual (no hay noción de página real en texto plano).
//  - PDF SIN capa de texto (escaneado / solo imagen): NO se hace OCR real de
//    imagen en esta ronda -- ninguna librería/servicio de OCR está
//    disponible en este monorepo. El resultado es el estado EXPLÍCITO
//    `"requires_ocr"` -- nunca se deja `text`/`pages` vacío como si el
//    documento no tuviera contenido relevante (mismo principio "ausencia de
//    dato nunca se traduce en cumple/sin requisitos" que ya usa
//    `contract-extraction.ts`/`requirement-matrix.ts` en este monorepo).
//  - Cualquier otro formato (docx, imagen suelta, etc.): `"failed"` con
//    detalle explícito; tampoco se inventa texto.
//
// Motivo de elegir `pdfjs-dist` sobre `pdf-parse` (mismo motivo que el
// origen, R6-01/R6-02 de su auditoría): `pdf-parse@1.1.1` empaqueta una
// versión de `pdf.js` de 2017 (v1.10.100) que NO soporta el formato de
// referencia cruzada por STREAM (PDF 1.5+, el que genera `pdf-lib` y la
// mayoría de generadores reales -- exportar desde Word/LibreOffice, imprimir
// a PDF desde un navegador moderno, herramientas de firma electrónica).
// `pdfjs-dist` soporta ambos formatos de xref -- ver fixtures
// `tests/fixtures/pdf/xref-stream.pdf` (generado con `pdf-lib`) y
// `tests/fixtures/pdf/xref-classic.pdf` (tabla xref clásica, PDF 1.4) en
// `tests/text-extraction.spec.ts`.
//
// AE-04 (saneamiento anti-XSS): el texto extraído (sobre todo por la rama de
// "texto plano", que no analiza estructura alguna) podía contener
// HTML/`<script>` sin ningún indicio de ser PDF y persistirse/mostrarse tal
// cual -- vector de XSS almacenado para cualquier consumidor que renderizara
// ese texto sin escapar (p. ej. `description`/`sourceExcerpt` de la matriz
// de requisitos). Se sanea (`sanitizePlainText`) ANTES de devolver el
// resultado, página por página: se elimina el contenido de
// `<script>`/`<style>` por completo y se quita cualquier otra etiqueta HTML
// restante, dejando solo texto plano.
//
// AE-05 / R6-11 (anti "PDF bomb"): además de un límite de tamaño de subida
// que impone el caller HTTP (ver `technicalProposal.ts`/`contractDocuments.ts`,
// mismo criterio ~22MB que `storage.ts::MAX_BASE64_LENGTH`), se acota el
// número de páginas y el tamaño del texto extraído de un PDF -- un PDF con
// miles de páginas/objetos repetidos podría inflar el texto extraído en
// memoria mucho más allá del tamaño del archivo original. El límite de
// páginas se comprueba ANTES de extraer texto de ninguna página
// (`pdf.numPages` es O(1) frente al documento ya parseado, y
// `estimateFastPdfPageCount` es un atajo MÁS BARATO que invocar `pdfjs-dist`
// en absoluto para el caso fácil de detectar -- cuenta `/Type/Page` en el
// archivo, incluyendo dentro de streams comprimidos con Flate, sin construir
// el árbol `/Pages` completo). Los límites de caracteres/tiempo se
// comprueban PÁGINA A PÁGINA (nunca después de recorrer todo el documento),
// y el event loop se cede cada `YIELD_EVERY_N_PAGES` páginas para que un
// documento legítimo no monopolice el proceso de un tirón.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

export type TextExtractionStatus = "extracted" | "requires_ocr" | "failed";

export interface ExtractedPageText {
  /** Número de página REAL (1-based) tal como lo reporta el propio PDF; para texto plano siempre es 1 (página virtual única). */
  readonly page: number;
  readonly text: string;
}

/** Cuál de los límites anti "PDF bomb" (AE-05) provocó un `status: 'failed'`. `undefined` para cualquier otro `'failed'` (formato corrupto, cifrado, etc.). */
export type PdfBombLimit = "paginas" | "caracteres" | "tiempo";

export interface TextExtractionResult {
  readonly status: TextExtractionStatus;
  /** Texto completo concatenado (todas las páginas unidas con `PAGE_BREAK`), para persistencia/búsqueda de texto completo. */
  readonly text: string | null;
  /** Texto por página REAL -- consumidores que necesiten citar una página concreta (matriz de requisitos, campos del contrato) deben usar esto, nunca una aproximación proporcional. */
  readonly pages: readonly ExtractedPageText[] | null;
  readonly pageCount: number | null;
  readonly detail?: string;
  /** Ver `PdfBombLimit`. Presente y con estado explícito ("rechazado_por_limite" en `detail`) solo cuando `status === 'failed'` por AE-05/R6-11. */
  readonly limitExceeded?: PdfBombLimit;
}

/**
 * Separador entre páginas dentro de `text` (form feed, `\f`) -- convención
 * estándar de "salto de página" en texto plano, invisible al leer pero
 * recuperable de forma determinista con `splitPersistedTextIntoPages` para
 * reconstruir el arreglo de páginas después de leer texto persistido (donde
 * solo se guardó el string concatenado, no el arreglo estructurado).
 */
export const PAGE_BREAK = "\f";

/**
 * Reconstruye páginas reales a partir de texto persistido, usando el
 * separador `PAGE_BREAK`. Si el texto persistido no contiene el separador
 * (documento de texto plano, o dato de antes de este cambio sin el
 * separador), se devuelve como una única página -- nunca se inventa un
 * número de página que el dato no sustenta.
 */
export function splitPersistedTextIntoPages(text: string): ExtractedPageText[] {
  const parts = text.split(PAGE_BREAK);
  return parts.map((t, i) => ({ page: i + 1, text: t }));
}

/** AE-05: límites anti "PDF bomb" -- un PDF real de licitación (bases + anexos) nunca debería acercarse a estos límites; existen para acotar el costo de procesar un archivo adversarial, no para restringir el uso normal. */
const MAX_PDF_PAGES = 500;
const MAX_EXTRACTED_TEXT_LENGTH = 5_000_000; // ~5MB de texto extraído.
/** R6-11: presupuesto de tiempo de pared para el bucle página-a-página de un solo PDF, comprobado ENTRE páginas (no interrumpe una página a medio parsear -- el margen real es este valor más el costo de la página más lenta en curso). */
const MAX_EXTRACTION_MS = 8_000;
/** R6-11: cada cuántas páginas se cede el event loop (`setImmediate`) durante la extracción. */
const YIELD_EVERY_N_PAGES = 20;

/** R6-11 (perf): cotas de seguridad del atajo `estimateFastPdfPageCount`. */
const FAST_PRECHECK_MAX_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;
const FAST_PRECHECK_MAX_STREAMS = 20_000;
const FAST_PRECHECK_MAX_MS = 500;

/** `/Type/Page` (con o sin espacio antes de la segunda barra), pero NUNCA `/Type/Pages` (el nodo intermedio del árbol, no una página real). */
const PAGE_TYPE_MARKER_RE = /\/Type\s*\/Page(?!s)/g;

function countPageMarkers(text: string): number {
  const matches = text.match(PAGE_TYPE_MARKER_RE);
  return matches ? matches.length : 0;
}

/**
 * R6-11 (perf): conteo APROXIMADO y barato de páginas reales de un PDF, sin
 * invocar `pdfjs-dist` -- ver el comentario de cabecera de este módulo.
 * Cuenta ocurrencias de `/Type/Page` tanto en el texto plano del archivo
 * como dentro de cada stream que logre descomprimirse con Flate -- `pdf-lib`
 * y la mayoría de generadores PDF 1.5+ empaquetan los objetos de página
 * dentro de "object streams" (`/Type/ObjStm`) comprimidos.
 *
 * Es SOLO un atajo best-effort: si no encuentra suficientes coincidencias
 * (otro filtro de compresión, cifrado, estructura atípica), simplemente
 * cuenta menos de lo real (nunca más) y la llamada de arriba cae al flujo
 * normal con `pdfjs`, que sigue comprobando `pdf.numPages` como única fuente
 * de verdad. Esta función nunca reemplaza ese chequeo -- solo evita pagar su
 * costo en el caso en que ya alcanza para rechazar.
 */
function estimateFastPdfPageCount(buffer: Buffer): number {
  const startedAt = Date.now();
  const text = buffer.toString("latin1");
  let count = countPageMarkers(text);
  let searchFrom = 0;
  let streamsScanned = 0;
  while (streamsScanned < FAST_PRECHECK_MAX_STREAMS) {
    const streamKeywordIdx = text.indexOf("stream", searchFrom);
    if (streamKeywordIdx === -1) break;
    let dataStart = streamKeywordIdx + "stream".length;
    if (text[dataStart] === "\r") dataStart += 1;
    if (text[dataStart] === "\n") dataStart += 1;
    const dataEnd = text.indexOf("endstream", dataStart);
    if (dataEnd === -1) break;
    streamsScanned += 1;
    try {
      const inflated = zlib.inflateSync(buffer.subarray(dataStart, dataEnd), {
        maxOutputLength: FAST_PRECHECK_MAX_STREAM_OUTPUT_BYTES,
      });
      count += countPageMarkers(inflated.toString("latin1"));
    } catch {
      // Filtro distinto de Flate, stream corrupto/cifrado, o excede
      // `maxOutputLength`: se ignora -- es solo un atajo best-effort, el
      // chequeo autoritativo (`pdf.numPages`) sigue vigente más abajo.
    }
    searchFrom = dataEnd + "endstream".length;
    if (Date.now() - startedAt > FAST_PRECHECK_MAX_MS) break;
  }
  return count;
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Heurística simple de "texto plano": decodifica UTF-8 y verifica que la proporción de caracteres de control (fuera de espacios/saltos) sea baja. */
function looksLikePlainText(buffer: Buffer): string | null {
  const text = buffer.toString("utf8");
  if (text.length === 0) return null;
  let controlCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) controlCount += 1;
  }
  if (controlCount / text.length > 0.02) return null; // demasiados bytes no imprimibles: probablemente binario, no texto.
  return text;
}

/**
 * AE-04: elimina por completo el contenido de `<script>`/`<style>` (nunca
 * solo la etiqueta) y quita cualquier otra etiqueta HTML restante,
 * conservando el texto entre ellas. Nunca se decide aquí cómo escapar al
 * renderizar (responsabilidad del consumidor), pero se elimina la
 * posibilidad de que el propio contenido devuelto sea HTML ejecutable.
 */
function sanitizePlainText(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]+>/g, "");
}

// Resuelto una sola vez por proceso: ruta absoluta al directorio
// `standard_fonts/` que empaqueta `pdfjs-dist` -- evita la advertencia
// "Ensure that the `standardFontDataUrl` API parameter is provided" al medir
// glifos de las 14 fuentes estándar (Helvetica y similares) sin descargar
// nada.
let cachedStandardFontDataUrl: string | null = null;
function resolveStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("pdfjs-dist/package.json");
  const dir = path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  cachedStandardFontDataUrl = pathToFileURL(dir).href;
  return cachedStandardFontDataUrl;
}

type PdfExtractionResult = { ok: true; pages: ExtractedPageText[]; pageCount: number } | { ok: false; limit: PdfBombLimit; pageCount: number };

async function extractPdfPages(buffer: Buffer): Promise<PdfExtractionResult> {
  // Atajo barato ANTES de tocar `pdfjs-dist` en absoluto -- ver
  // `estimateFastPdfPageCount`. Si el conteo aproximado ya supera el
  // límite, se rechaza sin pagar el costo de que `pdfjs` construya el árbol
  // `/Pages` completo.
  const fastPageCount = estimateFastPdfPageCount(buffer);
  if (fastPageCount > MAX_PDF_PAGES) {
    return { ok: false, limit: "paginas", pageCount: fastPageCount };
  }

  // Import perezoso: `pdfjs-dist` es pesado y solo hace falta en la rama PDF.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: resolveStandardFontDataUrl(),
    // Solo se usa para extraer texto (nunca se renderiza a un lienzo): las
    // advertencias de métricas de fuente que no afectan el texto extraído
    // son ruido, no errores reales -- se silencian aquí sin ocultar fallos
    // genuinos de parseo (verbosity ERRORS sigue reportándolos).
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const pdf = await loadingTask.promise;
  try {
    // `pdf.numPages` sale de la tabla /Pages ya parseada por `getDocument` --
    // comprobarlo aquí es O(1) frente al documento y NO requiere invocar
    // `getPage`/`getTextContent` en NINGUNA página.
    if (pdf.numPages > MAX_PDF_PAGES) {
      return { ok: false, limit: "paginas", pageCount: pdf.numPages };
    }
    const pages: ExtractedPageText[] = [];
    let totalLength = 0;
    const deadline = Date.now() + MAX_EXTRACTION_MS;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item: unknown) => (typeof (item as { str?: unknown }).str === "string" ? (item as { str: string }).str : "")).join(" ");
      page.cleanup();
      pages.push({ page: pageNumber, text });
      totalLength += text.length;
      // Abortar EN CUANTO se cruza el límite de caracteres, sin esperar a
      // terminar de recorrer el resto de páginas.
      if (totalLength > MAX_EXTRACTED_TEXT_LENGTH) {
        return { ok: false, limit: "caracteres", pageCount: pdf.numPages };
      }
      if (Date.now() > deadline) {
        return { ok: false, limit: "tiempo", pageCount: pdf.numPages };
      }
      if (pageNumber % YIELD_EVERY_N_PAGES === 0) {
        // Ceder el event loop periódicamente: con el tope de `MAX_PDF_PAGES`
        // ya comprobado arriba, un `worker_thread` aparte no se justifica;
        // sin este punto de cesión, un documento con muchas páginas
        // legítimas seguiría bloqueando el proceso de un tirón.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { ok: true, pages, pageCount: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

/**
 * Convierte los bytes de un archivo subido (bases de licitación, propuestas,
 * contrato firmado, ...) en texto por página REAL. `opts.mimeType`/
 * `opts.filename` son solo PISTAS (el propio contenido, `looksLikePdf`, es
 * la fuente de verdad para decidir la rama PDF) -- ver
 * `technicalProposal.ts::resolveDocumentText`/`contractDocuments.ts` para
 * dónde se llama con los datos reales de la subida HTTP.
 */
export async function extractDocumentText(buffer: Buffer, opts: { mimeType?: string | null; filename?: string | null } = {}): Promise<TextExtractionResult> {
  const filename = (opts.filename ?? "").toLowerCase();
  const isPdfByHint = opts.mimeType === "application/pdf" || filename.endsWith(".pdf") || looksLikePdf(buffer);

  if (isPdfByHint) {
    try {
      const extraction = await extractPdfPages(buffer);
      // Los límites anti "PDF bomb" (AE-05) ya se comprobaron DENTRO de
      // `extractPdfPages` -- antes del bucle (páginas) y página a página
      // (caracteres/tiempo) -- así que si `ok` es `false` aquí nunca se hizo
      // el trabajo de extraer texto de más páginas de las estrictamente
      // necesarias para detectar el límite.
      if (!extraction.ok) {
        const detailByLimit: Record<PdfBombLimit, string> = {
          paginas: `PDF rechazado_por_limite: ${extraction.pageCount} páginas > límite de ${MAX_PDF_PAGES} de esta ronda -- comprobado ANTES de extraer texto de ninguna página, medida anti "PDF bomb" (AE-05/R6-11).`,
          caracteres: `PDF rechazado_por_limite: el texto extraído superó ${MAX_EXTRACTED_TEXT_LENGTH} caracteres antes de terminar de recorrer sus páginas -- extracción abortada temprano, medida anti "PDF bomb" (AE-05/R6-11).`,
          tiempo: `PDF rechazado_por_limite: la extracción superó el presupuesto de tiempo de esta ronda (${MAX_EXTRACTION_MS} ms) -- abortada temprano, medida anti "PDF bomb" (AE-05/R6-11).`,
        };
        return {
          status: "failed",
          text: null,
          pages: null,
          pageCount: extraction.pageCount,
          detail: detailByLimit[extraction.limit],
          limitExceeded: extraction.limit,
        };
      }
      const { pages: rawPages, pageCount } = extraction;
      const joined = rawPages
        .map((p) => p.text)
        .join("")
        .trim();
      if (joined.length === 0) {
        return {
          status: "requires_ocr",
          text: null,
          pages: null,
          pageCount,
          detail: "PDF sin capa de texto extraíble (probablemente escaneado). Requiere OCR, no soportado en esta ronda: no hay librería/servicio de OCR de imagen disponible en este monorepo -- nunca se inventa texto a partir de bytes sin capa de texto.",
        };
      }
      const sanitizedPages = rawPages.map((p) => ({ page: p.page, text: sanitizePlainText(p.text) }));
      return {
        status: "extracted",
        text: sanitizedPages.map((p) => p.text).join(PAGE_BREAK),
        pages: sanitizedPages,
        pageCount,
      };
    } catch (err) {
      return {
        status: "failed",
        text: null,
        pages: null,
        pageCount: null,
        detail: `No se pudo procesar el PDF: ${(err as Error).message}`,
      };
    }
  }

  const isTextByHint = opts.mimeType === "text/plain" || filename.endsWith(".txt") || filename.endsWith(".md");
  const plainText = looksLikePlainText(buffer);
  if (isTextByHint || plainText !== null) {
    const text = plainText ?? buffer.toString("utf8");
    if (text.trim().length === 0) {
      return { status: "failed", text: null, pages: null, pageCount: null, detail: "Archivo de texto vacío." };
    }
    // Sanitizar ANTES de devolver -- ver docstring del módulo. Si el
    // contenido era ÍNTEGRAMENTE HTML/script (nada de texto real fuera de
    // las etiquetas), el resultado queda vacío -- se marca "failed"
    // explícito, nunca "extracted" con texto vacío.
    const sanitized = sanitizePlainText(text);
    if (sanitized.trim().length === 0) {
      return { status: "failed", text: null, pages: null, pageCount: null, detail: "El contenido quedó vacío después de sanitizar HTML/script embebido (AE-04); no se devuelve como 'extracted' un texto vacío." };
    }
    // Texto plano: no hay noción de página real -- una única página virtual.
    return { status: "extracted", text: sanitized, pages: [{ page: 1, text: sanitized }], pageCount: null };
  }

  return {
    status: "failed",
    text: null,
    pages: null,
    pageCount: null,
    detail: `Formato no soportado en esta ronda (solo PDF con texto y texto plano). mimeType=${opts.mimeType ?? "desconocido"}`,
  };
}
