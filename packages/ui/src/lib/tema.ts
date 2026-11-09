/**
 * Tema claro/oscuro y diseno. Una sola implementacion en TS: la usan `ThemeSelector` y `ThemeBoot`.
 * El script externo `apps/web/public/theme-boot.js` (que corre ANTES del primer pintado, porque la CSP solo permite
 * `script-src 'self'`) replica estas mismas reglas en JS plano; `packages/ui/tests/tema-boot.spec.tsx` las compara.
 * El diseno nuevo (`ds3`) es el de todos: `html[data-diseno="ds3"]`, tema global y `data-theme="dark"|"light"` (puente para las
 * piezas que leen `[data-theme=dark]`; las demas leen `.dark`). Unico interruptor de emergencia: `VITE_DISENO_LEGADO=1` en el
 * build (sin atributo, sin `data-theme`, el tema solo donde se pide explicitamente con `useTemaGlobal`). Por defecto, claro.
 */
export const CLAVE_TEMA = "atiende-tema";
/** <meta> que el build inyecta solo con `VITE_DISENO_LEGADO=1` (interruptor de emergencia del diseno anterior). */
export const META_DISENO_LEGADO = "atiende-diseno-legado";
export const VALOR_DISENO = "ds3";
/** Valores de referencia del sistema de diseno para <meta name="theme-color">. */
export const COLOR_NAVEGADOR_CLARO = "#ffffff";
export const COLOR_NAVEGADOR_OSCURO = "#0e0e10";

export type Tema = "claro" | "sistema" | "oscuro";

export function leerTema(): Tema {
  let v: string | null = null;
  try {
    v = window.localStorage.getItem(CLAVE_TEMA);
  } catch {
    // Sin almacenamiento (modo privado, bloqueado): tema claro por defecto.
  }
  return v === "oscuro" || v === "sistema" ? v : "claro";
}

export function sistemaEnOscuro(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Pantallas de inicio de sesion (`/<vertical>/login`): siempre en claro, como el login de Rovaq AI (`color-scheme: light`). El
 * script `/theme-boot.js` aplica la misma regla antes del primer pintado, asi que el login nunca destella de oscuro a claro.
 */
export const RUTA_SIEMPRE_CLARA = /\/login\/?$/;

export function rutaSiempreClara(ruta: string = typeof window === "undefined" ? "" : window.location.pathname): boolean {
  return RUTA_SIEMPRE_CLARA.test(ruta);
}

/** Aplica el tema: alterna `dark` en <html> y ajusta el color de la barra del navegador. Devuelve si quedo oscuro. */
export function aplicarTema(tema: Tema): boolean {
  const oscuro = !rutaSiempreClara() && (tema === "oscuro" || (tema === "sistema" && sistemaEnOscuro()));
  document.documentElement.classList.toggle("dark", oscuro);
  // El color de la barra del navegador y el puente data-theme siguen al tema en el diseno nuevo (con el interruptor de
  // emergencia se conserva el de index.html y <html> no lleva data-theme).
  if (document.documentElement.dataset.diseno === VALOR_DISENO) {
    document.documentElement.dataset.theme = oscuro ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", oscuro ? COLOR_NAVEGADOR_OSCURO : COLOR_NAVEGADOR_CLARO);
  }
  return oscuro;
}

/** Reaplica el tema cuando el sistema cambia, solo si la persona eligio «sistema». Devuelve la funcion que lo desuscribe. */
export function suscribirTemaSistema(): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (leerTema() === "sistema") aplicarTema("sistema");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Diseno: el nuevo (`ds3`) siempre, salvo el interruptor de emergencia de build `VITE_DISENO_LEGADO=1`, que el build inyecta como
 * <meta name="atiende-diseno-legado"> antes de /theme-boot.js. Resultado: `html.dataset.diseno = "ds3"` o sin atributo (legado).
 * Devuelve si quedo el diseno nuevo. Replica /theme-boot.js.
 */
export function aplicarBanderaDiseno(): boolean {
  if (document.querySelector(`meta[name="${META_DISENO_LEGADO}"]`)) return false;
  document.documentElement.dataset.diseno = VALOR_DISENO;
  return true;
}
