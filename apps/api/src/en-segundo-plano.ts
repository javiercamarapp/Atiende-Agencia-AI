// `waitUntil` del contexto de peticion de Vercel SIN agregar la dependencia `@vercel/functions`: el runtime de Vercel publica el contexto de la peticion
// en `globalThis[Symbol.for("@vercel/request-context")]` y `@vercel/functions#waitUntil` hace exactamente esta lectura. Con el, una promesa sigue viva
// despues de responder (hasta `maxDuration` de la funcion); sin el (local, arnes de medicion, tests) no hay a quien entregarla y quien llama debe esperarla
// el mismo antes de responder.
const CONTEXTO_DE_PETICION = Symbol.for("@vercel/request-context");

type ContextoVercel = { readonly get?: () => { readonly waitUntil?: (p: Promise<unknown>) => void } | undefined };

/** Funcion para dejar trabajo corriendo tras la respuesta, o `null` si no corre dentro de una peticion de Vercel. Se lee POR PETICION (el contexto lo es). */
export function waitUntilDeVercel(): ((p: Promise<unknown>) => void) | null {
  const contexto = (globalThis as Record<symbol, ContextoVercel | undefined>)[CONTEXTO_DE_PETICION];
  const waitUntil = contexto?.get?.()?.waitUntil;
  return typeof waitUntil === "function" ? (p) => waitUntil(p) : null;
}

/** `WHATSAPP_TURNO_ASINCRONO` (1/true/on/si): turno asincrono del webhook de WhatsApp de restaurantes para TODAS las organizaciones (sin ella, solo las de
 * cerebro v2). Apagada por omision. Vive aqui (y no en production/deps.ts) porque tambien la lee el barredor de turnos huerfanos. */
export function turnoAsincronoDeEntorno(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.WHATSAPP_TURNO_ASINCRONO ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "si";
}

/** Ventana de silencio de la espera de rafagas en el turno ASINCRONO, por omision. Con el acuse a Meta en la fase A, la espera ya no protege el 200: solo
 * junta los mensajes seguidos del cliente. 2.5 s cubre el hueco tipico entre fragmentos de una rafaga (saludo, pedido, pin) sin sumarle 6 s a cada respuesta. */
export const SILENCIO_RAFAGA_ASINCRONA_MS = 2_500;

/** `WHATSAPP_RAFAGA_SILENCIO_MS` (500-10000): ventana de silencio de la espera deslizante del turno asincrono. Ausente, invalida o fuera de rango = 2500. */
export function silencioRafagaAsincronaMs(env: NodeJS.ProcessEnv = process.env): number {
  const crudo = (env.WHATSAPP_RAFAGA_SILENCIO_MS ?? "").trim();
  if (!/^\d+$/.test(crudo)) return SILENCIO_RAFAGA_ASINCRONA_MS;
  const n = Number(crudo);
  return n >= 500 && n <= 10_000 ? n : SILENCIO_RAFAGA_ASINCRONA_MS;
}
