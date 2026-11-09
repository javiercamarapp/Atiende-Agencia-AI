// Recuperacion manual cuando una pantalla (chunk perezoso) no carga ni con el reintento ni con la recarga automatica de
// `carga-perezosa.tsx`. Caso real del repo suelto: un despliegue anterior respondio index.html para la URL de un chunk y algunos
// navegadores guardaron esa respuesta; recargar no basta, hay que vaciar la cache HTTP de la app (CacheStorage) y quitar un
// service worker viejo. NO toca localStorage ni cookies: la sesion, el idioma y el tema se conservan.
// Vive en el barril de arranque: debe quedarse pequeno y sin dependencias.

/** Mensajes con los que los navegadores rechazan un import dinamico (Chrome, Firefox, Safari) o el nombre de webpack/Vite. */
const PATRONES_ERROR_CARGA = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /loading (css )?chunk [\w-]+ failed/i,
];

/** true si el error es de un chunk que no bajo (y no un error de la propia pantalla). */
export function esErrorDeCarga(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return PATRONES_ERROR_CARGA.some((p) => p.test(error.message));
}

export interface EntornoRecuperacion {
  readonly caches?: Pick<CacheStorage, "keys" | "delete">;
  readonly serviceWorker?: Pick<ServiceWorkerContainer, "getRegistrations">;
  readonly sessionStorage?: Pick<Storage, "removeItem">;
  readonly recargar: () => void;
}

/** Marca anti-bucle de `carga-perezosa.tsx`: se quita para que, tras limpiar, la recarga automatica vuelva a estar disponible. */
const CLAVE_RECARGA = "atiende:recarga-por-chunk";

function entornoNavegador(): EntornoRecuperacion {
  const w = typeof window === "undefined" ? undefined : window;
  let sesion: Storage | undefined;
  try {
    sesion = w?.sessionStorage;
  } catch {
    sesion = undefined;
  }
  return {
    caches: w && "caches" in w ? w.caches : undefined,
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    sessionStorage: sesion,
    recargar: () => w?.location.reload(),
  };
}

/**
 * Vacia CacheStorage, da de baja los service workers y recarga. Cada paso es tolerante (API ausente, permiso denegado, modo
 * privado): un fallo en uno no impide los demas ni la recarga, que siempre ocurre al final.
 */
export async function limpiarCacheYRecargar(entorno: EntornoRecuperacion = entornoNavegador()): Promise<void> {
  try {
    if (entorno.caches) {
      const claves = await entorno.caches.keys();
      await Promise.all(claves.map((c) => entorno.caches!.delete(c)));
    }
  } catch {
    // Sin permiso o sin CacheStorage: se sigue con lo demas.
  }
  try {
    if (entorno.serviceWorker) {
      const registros = await entorno.serviceWorker.getRegistrations();
      await Promise.all(registros.map((r) => r.unregister()));
    }
  } catch {
    // Igual que arriba.
  }
  try {
    entorno.sessionStorage?.removeItem(CLAVE_RECARGA);
  } catch {
    // sessionStorage bloqueado.
  }
  entorno.recargar();
}
