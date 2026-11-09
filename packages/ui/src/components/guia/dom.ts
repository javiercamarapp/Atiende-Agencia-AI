// Utilidades de DOM del recorrido: encontrar el elemento real de un paso (esperando a que exista), abrir el grupo plegado del menu que lo
// esconde, sensores (movimiento reducido, pantalla estrecha, foco en un campo, formulario modificado). Solo CSSOM y atributos.
import { teclasPropias } from "./motor";

const visible = (el: Element): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0;

/** Primer elemento visible de los selectores (el orden manda). Un selector invalido se ignora. */
export function primerVisible(selectores: readonly string[]): HTMLElement | null {
  for (const s of selectores) {
    let lista: Element[] = [];
    try {
      lista = Array.from(document.querySelectorAll(s));
    } catch {
      continue;
    }
    const el = lista.find(visible);
    if (el) return el;
  }
  return null;
}

/**
 * Si el item del menu vive en un grupo plegado del acordeon del Sidebar (los grupos cerrados no pintan sus items), despliega ese grupo
 * con un clic real en su boton de titulo. Devuelve true si hizo clic. Si el item ya se ve, no hace nada.
 */
export function abrirGrupoDelMenu(selectores: readonly string[], grupo: string | undefined): boolean {
  if (primerVisible(selectores) || !grupo) return false;
  const titulo = grupo.trim().toLowerCase();
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('aside button[aria-expanded="false"]'))) {
    if (visible(b) && (b.textContent ?? "").trim().toLowerCase() === titulo) {
      b.click();
      return true;
    }
  }
  return false;
}

export const reducirMovimiento = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const pantallaEstrecha = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;

/** Espera a que aparezca el elemento (lo busca ya y en cada cambio del DOM) hasta `tope` ms; si no aparece, la tarjeta se centra. */
export function esperarObjetivo(selectores: readonly string[], alEncontrar: (el: HTMLElement) => void, alAgotar: () => void, tope = 4000): () => void {
  let fin = false;
  let observador: MutationObserver | null = null;
  // eslint-disable-next-line prefer-const -- se asigna despues de definir `terminar`, que lo lee
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let cuadro = 0;
  const terminar = () => {
    fin = true;
    observador?.disconnect();
    if (temporizador) clearTimeout(temporizador);
    if (cuadro) cancelAnimationFrame(cuadro);
  };
  const intentar = () => {
    cuadro = 0;
    if (fin) return;
    const el = primerVisible(selectores);
    if (el) {
      terminar();
      alEncontrar(el);
    }
  };
  if (selectores.length === 0) {
    const id = setTimeout(() => { if (!fin) { terminar(); alAgotar(); } }, 0);
    return () => { terminar(); clearTimeout(id); };
  }
  const ya = primerVisible(selectores);
  if (ya) {
    const id = setTimeout(() => { if (!fin) { terminar(); alEncontrar(ya); } }, 0);
    return () => { terminar(); clearTimeout(id); };
  }
  observador = new MutationObserver(() => { if (!cuadro) cuadro = requestAnimationFrame(intentar); });
  observador.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "data-state"] });
  temporizador = setTimeout(() => { if (!fin) { terminar(); alAgotar(); } }, tope);
  return terminar;
}

/** Nombre real del elemento (su etiqueta o su texto), recortado. */
export function nombreDe(el: HTMLElement): string {
  const crudo = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
  const limpio = crudo.replace(/\s+/g, " ").trim();
  return limpio.length > 40 ? `${limpio.slice(0, 39).trimEnd()}…` : limpio;
}

export const enCampo = (el: Element | null): boolean => el instanceof HTMLElement && teclasPropias(el);

/** ¿Hay un formulario con campos modificados? Un viaje automatico lo perderia. */
export function hayFormularioSucio(raiz: ParentNode = document): boolean {
  for (const f of Array.from(raiz.querySelectorAll("form"))) {
    for (const c of Array.from(f.elements)) {
      if (c instanceof HTMLInputElement) {
        if (["hidden", "submit", "button", "reset", "image", "file"].includes(c.type)) continue;
        if (c.type === "checkbox" || c.type === "radio" ? c.checked !== c.defaultChecked : c.value !== c.defaultValue) return true;
      } else if (c instanceof HTMLTextAreaElement) {
        if (c.value !== c.defaultValue) return true;
      } else if (c instanceof HTMLSelectElement) {
        if (Array.from(c.options).some((o) => o.selected !== o.defaultSelected)) return true;
      }
    }
  }
  return false;
}
