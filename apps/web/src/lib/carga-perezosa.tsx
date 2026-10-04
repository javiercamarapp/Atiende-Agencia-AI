// R-37: carga perezosa de pantallas con recuperación real ante un chunk que no baja.
//
// Por qué existe: cada pantalla es un chunk con hash. Si entra un despliegue mientras el cliente tiene la app abierta,
// el chunk viejo ya no existe (Vercel responde index.html por la reescritura `/(.*)`) y el import dinámico falla; con
// una red móvil inestable pasa igual. React.lazy guarda el rechazo en caché, así que reintentar el render no lo arregla.
// Estrategia real en el build de Vite: el helper de precarga emite `vite:preloadError` en el PRIMER fallo de un import
// dinámico; el manejador de main.tsx recarga la página (una vez por ventana de 30 s, marca en sessionStorage) para traer
// el index.html nuevo. El reintento corto de importarConRecuperacion solo corre dentro de esa ventana (o sin helper de
// Vite, p. ej. en tests). Pasada la ventana, un chunk que falla de forma persistente (sin conexión) puede provocar una
// recarga por navegación: no hay bucle. Si ni así carga, el ErrorBoundary de la raíz pinta un error con "Recargar".
// Limitación conocida: ErrorBoundaryRaiz no reinicia su estado al navegar; el botón recarga la página.
// Nada del storefront debe precargar chunks con import() especulativo: el mismo evento recargaría con un formulario abierto.
import { Component, lazy } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { EstadoError } from "@atiende/ui";

const CLAVE_RECARGA = "atiende:recarga-por-chunk";
/** Ventana en la que NO se vuelve a recargar automáticamente (evita bucles si el chunk sigue sin existir). */
export const VENTANA_RECARGA_MS = 30_000;
const ESPERA_REINTENTO_MS = 400;

/** Marca de tiempo de la última recarga automática, o null. Tolera sessionStorage bloqueado. */
function leerMarca(): number | null {
  try {
    const v = window.sessionStorage.getItem(CLAVE_RECARGA);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/**
 * Recarga la página una sola vez por ventana. Devuelve true si disparó la recarga, false si ya se había hecho hace
 * poco (o sessionStorage no permite recordarlo, caso en el que NO recarga: sin memoria no hay garantía anti-bucle).
 */
export function recargarUnaVez(ahora: number = Date.now(), recargar: () => void = () => window.location.reload()): boolean {
  const previa = leerMarca();
  if (previa !== null && Number.isFinite(previa) && ahora - previa < VENTANA_RECARGA_MS) return false;
  try {
    window.sessionStorage.setItem(CLAVE_RECARGA, String(ahora));
  } catch {
    return false;
  }
  recargar();
  return true;
}

/** Importa con un reintento corto; si vuelve a fallar intenta la recarga protegida y, si no procede, relanza el error. */
export async function importarConRecuperacion<T>(cargar: () => Promise<T>, opciones?: { esperaMs?: number; recargar?: () => void }): Promise<T> {
  try {
    return await cargar();
  } catch {
    await new Promise<void>((r) => setTimeout(r, opciones?.esperaMs ?? ESPERA_REINTENTO_MS));
    try {
      return await cargar();
    } catch (err) {
      if (recargarUnaVez(Date.now(), opciones?.recargar)) {
        // La página se está recargando: no resolver ni rechazar, para no pintar un error un instante antes del reload.
        return new Promise<T>(() => {});
      }
      throw err;
    }
  }
}

/** Como React.lazy sobre un export con nombre, con recuperación ante fallo de chunk. Conserva el tipo del componente. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cargaPerezosa<M extends Record<string, any>, K extends keyof M & string>(cargar: () => Promise<M>, nombre: K) {
  return lazy(async () => ({ default: (await importarConRecuperacion(cargar))[nombre] as M[K] }));
}

/** Vite emite `vite:preloadError` cuando falla la precarga de un chunk (p. ej. tras un despliegue): recarga protegida. */
export function instalarManejadorPreloadError(destino: Window = window): () => void {
  const manejador = (evento: Event) => {
    if (recargarUnaVez()) evento.preventDefault();
  };
  destino.addEventListener("vite:preloadError", manejador);
  return () => destino.removeEventListener("vite:preloadError", manejador);
}

/** Último límite de error de la app: cubre storefront público, logins, 404 y shells, que no tienen RutaBoundary. */
export class ErrorBoundaryRaiz extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[app] error no controlado al pintar la app", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // React.lazy cachea el rechazo: reintentar el render no sirve; la recuperación real es recargar la página.
    return (
      <div data-atiende-error-raiz>
        <EstadoError
          titulo="No pudimos cargar esta pantalla"
          mensaje="Puede que haya una versión nueva de la aplicación o que falle la conexión. Recarga la página para continuar."
          onReintentar={() => window.location.reload()}
        />
      </div>
    );
  }
}
