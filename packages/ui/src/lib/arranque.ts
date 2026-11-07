/**
 * Gobierno de la UNICA capa de carga a pantalla completa (ds3): `#arranque` de index.html, el logo de Atiende que respira sobre un
 * solo color. El estado vive en `html[data-arranque]`:
 *   - sin atributo  -> capa visible (arranque: lo que se ve desde el primer pintado, sin JS);
 *   - "activo"      -> capa visible durante una navegacion interna lenta;
 *   - "suelto"      -> capa oculta (se desvanece en 170 ms por CSS).
 * Casos (mismas reglas que el sistema de referencia):
 *   1. Carga/recarga: se suelta cuando, de forma CONTINUA durante `ARRANQUE_ESTABLE_MS`, el documento termino de llegar y no hay carga
 *      pendiente (cargador de pantalla, o cualquier `aria-busy` dentro de <main> en el arranque, o #root vacio).
 *   2. Navegacion interna: si un cargador de pantalla sigue montado pasados `ARRANQUE_RETARDO_MS`, la capa vuelve; una vez visible dura al
 *      menos `ARRANQUE_MINIMO_MS` (nunca destella). En /login no se activa en navegacion.
 *   3. Seguro: a los `ARRANQUE_TOPE_MS` se suelta pase lo que pase (la hoja tiene ademas un tope CSS por si React nunca monta).
 * La condicion se lee del DOM (no de un registro de React) para cubrir chunks y Suspense que aun no montan.
 */
export const ARRANQUE_ESTABLE_MS = 600;
export const ARRANQUE_NAVEGACION_MS = 150;
export const ARRANQUE_RETARDO_MS = 250;
export const ARRANQUE_MINIMO_MS = 400;
export const ARRANQUE_TOPE_MS = 45_000;
export const ARRANQUE_FUNDIDO_MS = 170;

/** Cargador de pagina completa (CargandoLogo `pantalla`, fallbacks de ruta). */
export const SELECTOR_CARGA_PAGINA = '[data-carga-tamano="pantalla"], [data-atiende-carga-ruta]';
/** En el arranque tambien cuenta cualquier carga dentro del contenido principal. */
export const SELECTOR_CARGA_INICIAL = `${SELECTOR_CARGA_PAGINA}, main [aria-busy="true"]`;
const SIN_CAPA_EN_NAVEGACION = /(^|\/)login(\/|$)/;

export type EstadoArranque = "activo" | "suelto";

export interface EntornoArranque {
  readonly raiz: HTMLElement;
  readonly documento: Document;
  readonly ruta: () => string;
}

/** ¿Hay una carga que justifique la capa? `inicial` incluye las cargas de <main> y un #root todavia vacio. */
export function hayCargaPendiente(documento: Document, inicial: boolean): boolean {
  if (documento.readyState === "loading") return true;
  if (documento.querySelector(inicial ? SELECTOR_CARGA_INICIAL : SELECTOR_CARGA_PAGINA) !== null) return true;
  if (inicial) {
    const root = documento.getElementById("root");
    if (root && root.childElementCount === 0) return true;
  }
  return false;
}

/**
 * Arranca el gobierno de la capa. Devuelve la funcion de limpieza. Usa `setTimeout`/`Date.now` globales (pruebas con timers falsos).
 */
export function gobernarArranque({ raiz, documento, ruta }: EntornoArranque): () => void {
  let inicial = !raiz.dataset.arranque;
  let activa = inicial;
  let desde = Date.now();
  let vivo = true;
  let programado = false;
  let tope: ReturnType<typeof setTimeout> | undefined;
  let espera: ReturnType<typeof setTimeout> | undefined;
  let aparicion: ReturnType<typeof setTimeout> | undefined;

  const fijar = (estado: EstadoArranque) => {
    if (raiz.dataset.arranque !== estado) raiz.dataset.arranque = estado;
  };
  const soltar = () => {
    clearTimeout(tope);
    activa = false;
    inicial = false;
    fijar("suelto");
  };
  const armarTope = () => {
    clearTimeout(tope);
    tope = setTimeout(() => {
      if (vivo && activa) soltar();
    }, ARRANQUE_TOPE_MS);
  };

  const evaluar = () => {
    if (!vivo) return;
    if (activa) {
      clearTimeout(aparicion);
      clearTimeout(espera);
      if (hayCargaPendiente(documento, inicial)) return;
      const ventana = inicial ? ARRANQUE_ESTABLE_MS : Math.max(ARRANQUE_NAVEGACION_MS, ARRANQUE_MINIMO_MS - (Date.now() - desde));
      espera = setTimeout(() => {
        if (vivo && !hayCargaPendiente(documento, inicial)) soltar();
      }, ventana);
      return;
    }
    clearTimeout(aparicion);
    if (SIN_CAPA_EN_NAVEGACION.test(ruta()) || !hayCargaPendiente(documento, false)) return;
    aparicion = setTimeout(() => {
      if (!vivo || activa || !hayCargaPendiente(documento, false)) return;
      activa = true;
      inicial = false;
      desde = Date.now();
      fijar("activo");
      armarTope();
    }, ARRANQUE_RETARDO_MS);
  };

  // Las mutaciones llegan en rafagas (montaje, chunks): se evalua una vez por rafaga.
  const alCambiar = () => {
    if (programado) return;
    programado = true;
    queueMicrotask(() => {
      programado = false;
      evaluar();
    });
  };
  const Observador = documento.defaultView?.MutationObserver ?? (typeof MutationObserver === "undefined" ? undefined : MutationObserver);
  const observador = Observador ? new Observador(alCambiar) : undefined;
  observador?.observe(documento.body ?? raiz, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "data-carga-tamano"] });
  documento.addEventListener("readystatechange", alCambiar);
  if (activa) armarTope();
  evaluar();

  return () => {
    vivo = false;
    clearTimeout(tope);
    clearTimeout(espera);
    clearTimeout(aparicion);
    observador?.disconnect();
    documento.removeEventListener("readystatechange", alCambiar);
  };
}
