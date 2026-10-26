/**
 * Tema claro/oscuro y bandera de diseno. Una sola implementacion en TS: la usan `ThemeSelector` y `ThemeBoot`.
 * El script externo `apps/web/public/theme-boot.js` (que corre ANTES del primer pintado, porque la CSP solo permite
 * `script-src 'self'`) replica estas mismas reglas en JS plano; `packages/ui/tests/tema-boot.spec.tsx` las compara.
 * Con la bandera apagada el script y `ThemeBoot` no hacen nada (produccion intacta); el tema global solo se aplica con
 * `ds3` encendida, salvo en rutas que lo piden explicitamente (`useTemaGlobal`, p. ej. el panel del repartidor).
 * Mecanismo: clase `dark` en <html> (nunca `data-theme`). Por defecto, claro.
 */
export const CLAVE_TEMA = "atiende-tema";
export const CLAVE_DISENO = "atiende-diseno";
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

/** Aplica el tema: alterna `dark` en <html> y ajusta el color de la barra del navegador. Devuelve si quedo oscuro. */
export function aplicarTema(tema: Tema): boolean {
  const oscuro = tema === "oscuro" || (tema === "sistema" && sistemaEnOscuro());
  document.documentElement.classList.toggle("dark", oscuro);
  // El color de la barra del navegador solo sigue al tema con la bandera ds3 (con ella apagada se conserva el de index.html).
  if (document.documentElement.dataset.diseno === VALOR_DISENO) {
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
 * Bandera de diseno: `?diseno=ds3` la guarda en localStorage; `?diseno=off` la borra; sin parametro se lee de localStorage.
 * Resultado: `html.dataset.diseno = "ds3"` o sin atributo. Devuelve si la bandera quedo encendida.
 */
export function aplicarBanderaDiseno(busqueda: string = window.location.search): boolean {
  let valor = new URLSearchParams(busqueda).get("diseno");
  try {
    if (valor === VALOR_DISENO) window.localStorage.setItem(CLAVE_DISENO, valor);
    else if (valor === "off") window.localStorage.removeItem(CLAVE_DISENO);
    else valor = window.localStorage.getItem(CLAVE_DISENO);
  } catch {
    // Sin almacenamiento: solo vale el parametro de la URL de esta carga.
  }
  const encendida = valor === VALOR_DISENO;
  if (encendida) document.documentElement.dataset.diseno = VALOR_DISENO;
  return encendida;
}
