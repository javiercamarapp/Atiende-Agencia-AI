/**
 * Tema claro/oscuro y bandera de diseno. Una sola implementacion en TS: la usan `ThemeSelector` y `ThemeBoot`.
 * El script externo `apps/web/public/theme-boot.js` (que corre ANTES del primer pintado, porque la CSP solo permite
 * `script-src 'self'`) replica estas mismas reglas en JS plano; `packages/ui/tests/tema-boot.spec.tsx` las compara.
 * Con la bandera apagada el script y `ThemeBoot` no hacen nada (produccion intacta); el tema global solo se aplica con
 * `ds3` encendida, salvo en rutas que lo piden explicitamente (`useTemaGlobal`, p. ej. el panel del repartidor).
 * Mecanismo: clase `dark` en <html>. Con ds3 encendida tambien `data-theme="dark"|"light"` (el mecanismo de Vexa): puente para
 * las piezas portadas de Vexa, que leen `[data-theme=dark]`; las de Atiende siguen leyendo `.dark`. Sin la bandera, nunca
 * `data-theme`. Por defecto, claro.
 *
 * Bandera de diseno, en orden: `?diseno=ds3|off` (vista previa manual, se recuerda en CLAVE_DISENO) > valor de la ORGANIZACION
 * (CLAVE_DISENO_ORG, lo escribe el shell de la vertical a partir de la sesion; migracion 0060) > interruptor del login
 * (pre-organizacion: <meta name="atiende-diseno-login" content="restaurantes,citas"> o "*", lo llena VITE_DISENO_LOGIN en el build).
 */
export const CLAVE_TEMA = "atiende-tema";
export const CLAVE_DISENO = "atiende-diseno";
export const CLAVE_DISENO_ORG = "atiende-diseno-org";
export const META_DISENO_LOGIN = "atiende-diseno-login";
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
  // El color de la barra del navegador y el puente data-theme solo siguen al tema con la bandera ds3 (con ella apagada se
  // conserva el de index.html y <html> no lleva data-theme).
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

/** Rutas previas a la organizacion (login, restablecer contrasena, registro) de una vertical: `/<vertical>/<pantalla>`. */
const RUTA_PRE_ORG = /^(login|restablecer-contrasena|registro)$/;

/** Interruptor del login: la lista del <meta> (verticales separadas por coma, o "*") incluye la vertical de esta ruta pre-org. */
export function rutaPreOrgConDiseno(ruta: string, lista: string | null | undefined): boolean {
  const partes = ruta.split("/");
  if (partes.length !== 3 || !RUTA_PRE_ORG.test(partes[2] ?? "")) return false;
  const verticales = (lista ?? "").split(",");
  return verticales.includes(partes[1] ?? "") || verticales.includes("*");
}

/**
 * Bandera de diseno: `?diseno=ds3` la guarda en localStorage; `?diseno=off` la borra (y apaga esta carga); sin parametro se lee la
 * manual y, si no hay, la de la organizacion; en una ruta pre-org cuenta ademas el interruptor del login.
 * Resultado: `html.dataset.diseno = "ds3"` o sin atributo. Devuelve si la bandera quedo encendida. Replica /theme-boot.js.
 */
export function aplicarBanderaDiseno(busqueda: string = window.location.search, ruta: string = window.location.pathname): boolean {
  let valor = new URLSearchParams(busqueda).get("diseno");
  try {
    if (valor === VALOR_DISENO) window.localStorage.setItem(CLAVE_DISENO, valor);
    else if (valor === "off") window.localStorage.removeItem(CLAVE_DISENO);
    else valor = window.localStorage.getItem(CLAVE_DISENO) || window.localStorage.getItem(CLAVE_DISENO_ORG);
  } catch {
    // Sin almacenamiento: solo vale el parametro de la URL de esta carga.
  }
  if (valor !== "off" && rutaPreOrgConDiseno(ruta, document.querySelector(`meta[name="${META_DISENO_LOGIN}"]`)?.getAttribute("content"))) valor = VALOR_DISENO;
  const encendida = valor === VALOR_DISENO;
  if (encendida) document.documentElement.dataset.diseno = VALOR_DISENO;
  return encendida;
}

/**
 * Sincroniza el diseno de la organizacion activa (sesion: `organizations[].diseno`, migracion 0060) con lo que se pinto.
 * `undefined` (sesion persistida antes del campo) no toca nada; `null` borra el valor de organizacion; `"ds3"` lo guarda.
 * Devuelve `true` si lo pintado ya no coincide con lo que resolveria /theme-boot.js en la proxima carga: las ramas JS de
 * DISENO_DS3 se leen una sola vez al cargar el modulo, asi que quien llama recarga la pagina (una vez) para aplicarlo.
 * Sin almacenamiento no se puede recordar el valor: devuelve `false` (sin recarga en bucle; se queda el diseno actual).
 */
export function sincronizarDisenoOrganizacion(diseno: string | null | undefined, porDefecto = ""): boolean {
  if (diseno === undefined) return false;
  let manual: string | null;
  let org: string | null;
  try {
    if (diseno === VALOR_DISENO) window.localStorage.setItem(CLAVE_DISENO_ORG, VALOR_DISENO);
    else window.localStorage.removeItem(CLAVE_DISENO_ORG);
    manual = window.localStorage.getItem(CLAVE_DISENO);
    org = window.localStorage.getItem(CLAVE_DISENO_ORG);
  } catch {
    return false;
  }
  if (org !== (diseno === VALOR_DISENO ? VALOR_DISENO : null)) return false;
  const debe = manual === VALOR_DISENO || org === VALOR_DISENO || porDefecto.trim() === VALOR_DISENO;
  const pintado = document.documentElement.dataset.diseno === VALOR_DISENO || porDefecto.trim() === VALOR_DISENO;
  return debe !== pintado;
}
