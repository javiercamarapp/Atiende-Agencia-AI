// Fase 8 — SR-14 del repo origen: un `200 OK` con un cuerpo de
// bloqueo/captcha (página HTML de "Access Denied", "Verifying you are
// human", etc.) NUNCA debe interpretarse como "el CSV real, con 0 filas
// nuevas" — un fallo silencioso así es exactamente lo que REQ-148
// ("silencio nunca es 'cero oportunidades'") prohíbe. Puerto ADAPTADO
// (recortado a lo que este único conector necesita) de
// `licitaciones/packages/sources/src/http/response-classifier.ts`.
//
// Verificación real de esta fase (2026-09-14, ver
// `apps/worker/tests/fixtures/compras-mx-historico-access-denied.html`): un
// intento real (HEAD y GET, con y sin User-Agent de navegador) contra la URL
// del CSV histórico devolvió `403` con exactamente este tipo de cuerpo HTML
// (bloqueo de Akamai) — evidencia real de que esta función SÍ dispara en
// producción contra esta fuente, no un caso hipotético.
// Importa de `connector-errors.ts` directamente (NO de `connector-registry.ts`, que a su vez importa este
// conector) -- rompe un ciclo real, ver el comentario de cabecera de `connector-errors.ts` para el detalle.
import { CaptchaDetectedError, InterfaceChangedError } from "../connector-errors.ts";

const BLOCK_MARKERS = [
  "access denied",
  "captcha",
  "are you a human",
  "verifying you are human",
  "cloudflare",
  "akamai",
  "attention required",
  "unusual traffic",
  "robot check",
];

export interface AssertLegitimateCsvBodyOptions {
  readonly url: string;
}

function looksLikeHtml(trimmed: string): boolean {
  return trimmed.startsWith("<") || /<html[\s>]/i.test(trimmed.slice(0, 512));
}

function findBlockMarker(trimmed: string): string | undefined {
  const lower = trimmed.slice(0, 4096).toLowerCase();
  return BLOCK_MARKERS.find((needle) => lower.includes(needle));
}

/**
 * Valida que `sample` (el primer chunk decodificado, o el texto completo
 * para la variante en lote) tenga forma de CSV real y no de página de
 * bloqueo. Lanza `CaptchaDetectedError` (clasificado como
 * `state: "captcha_detected"` por `classifySourceFailure`, ver
 * `source-run.ts`) ante cualquier señal de bloqueo, e
 * `InterfaceChangedError` si el cuerpo es HTML pero sin ninguna señal de
 * bloqueo reconocida (el portal cambió de formato de una forma que este
 * conector no anticipó) — nunca deja pasar un cuerpo no-CSV como si fueran
 * "0 registros".
 */
export function assertLegitimateCsvBody(sample: string, options: AssertLegitimateCsvBodyOptions): void {
  const trimmed = sample.trimStart();
  if (!looksLikeHtml(trimmed)) return; // Forma de CSV (no empieza como HTML) -- no hay nada que bloquear aquí.

  const marker = findBlockMarker(trimmed);
  if (marker) {
    throw new CaptchaDetectedError(`Respuesta de bloqueo detectada en ${options.url} (marcador: "${marker}") -- no es el CSV real, se reporta como corrida fallida en vez de "0 registros".`);
  }
  throw new InterfaceChangedError(`Respuesta HTML inesperada en ${options.url} (se esperaba CSV) sin marcador de bloqueo reconocido -- posible cambio de formato del portal.`);
}

export interface AssertLegitimateJsonBodyOptions {
  readonly url: string;
}

/**
 * Fase 9 — variante JSON de `assertLegitimateCsvBody`, para conectores OCDS
 * (`nl-ocds-connector.ts`): un `200 OK` con un cuerpo HTML de bloqueo/captcha
 * donde se esperaba un JSON de OCDS (release/record package) tampoco debe
 * interpretarse como "0 releases" — mismo criterio SR-14, mismos marcadores
 * de bloqueo reconocidos, solo cambia la forma esperada del cuerpo legítimo
 * (JSON: empieza con `{`/`[` tras recortar espacios, nunca con `<`).
 */
export function assertLegitimateJsonBody(sample: string, options: AssertLegitimateJsonBodyOptions): void {
  const trimmed = sample.trimStart();
  if (!looksLikeHtml(trimmed)) return; // Forma de JSON (no empieza como HTML) -- el parser de JSON reportará su propio error si el resto del cuerpo está mal formado.

  const marker = findBlockMarker(trimmed);
  if (marker) {
    throw new CaptchaDetectedError(`Respuesta de bloqueo detectada en ${options.url} (marcador: "${marker}") -- no es el JSON OCDS real, se reporta como corrida fallida en vez de "0 releases".`);
  }
  throw new InterfaceChangedError(`Respuesta HTML inesperada en ${options.url} (se esperaba JSON OCDS) sin marcador de bloqueo reconocido -- posible cambio de formato de la API.`);
}
