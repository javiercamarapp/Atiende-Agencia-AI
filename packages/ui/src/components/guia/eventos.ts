// Eventos de la «Guía» (ds3). Modulo LIGERO a proposito: lo importan el barril de @atiende/ui y las paginas, mientras el componente
// de la guia (GuiaRecorrido, @atiende/ui/guia) se carga diferido y solo con la bandera ds3.
import type { ModoTour } from "./motor.ts";

/** Lo emite el boton «Guía» de la cabecera (`GUIA_ABRIR_EVENTO` de VerticalShell, mismo valor): abre o cierra el menu de la guia. */
export const GUIA_ABRIR_EVENTO_RECORRIDO = "atiende:guia:abrir";
/** Empieza el recorrido directamente (p. ej. desde «Primeros pasos»), sin pasar por el menu. `detail.modo`: «corto» o «completo». */
export const GUIA_RECORRIDO_EVENTO = "atiende:guia:recorrido";
/** Envia ya el ultimo cambio pendiente del progreso (al cerrar sesion, antes de borrar el almacen local). */
export const GUIA_VACIAR_EVENTO = "atiende:guia:vaciar";

const quienTieneElFoco = (): HTMLElement | null => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);

export function iniciarRecorridoGuia(modo: ModoTour = "corto"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GUIA_RECORRIDO_EVENTO, { detail: { modo, desde: quienTieneElFoco() } }));
}

/** Abre el menu de la guia (entrada movil «Guía» de la hoja «Más»). `desde` = el control al que vuelve el foco al cerrar. */
export function abrirMenuGuia(desde?: HTMLElement | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GUIA_ABRIR_EVENTO_RECORRIDO, { detail: { desde: desde ?? quienTieneElFoco() } }));
}

export function vaciarGuardadoGuia(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GUIA_VACIAR_EVENTO));
}
