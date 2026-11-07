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
