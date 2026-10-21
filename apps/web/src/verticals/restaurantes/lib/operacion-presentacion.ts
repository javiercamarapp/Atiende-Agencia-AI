// Presentacion pura de la cola del encargado: pestanas, accion principal por pedido, etiquetas de origen y orden. Sin DOM ni red.
import type { AccionDisponible, EstadoPanel, TarjetaPedido } from "@atiende/domain-restaurantes/operacion";
import { semaforoPedido } from "./semaforo.ts";
import type { Semaforo } from "@atiende/domain-restaurantes/operacion";

export type PestanaCola = "nuevos" | "preparacion" | "listos" | "camino";

export const PESTANAS_COLA: readonly { readonly valor: PestanaCola; readonly etiqueta: string }[] = [
  { valor: "nuevos", etiqueta: "Nuevos" },
  { valor: "preparacion", etiqueta: "En preparación" },
  { valor: "listos", etiqueta: "Listos" },
  { valor: "camino", etiqueta: "En camino" },
];

/** Pestana de un pedido. En domicilio, «listo» es `preparando` con `listoAt` (no hay estado propio); recoger usa `listo_para_recoger`. Otros estados no se pintan en la cola. */
export function pestanaDe(p: Pick<TarjetaPedido, "estado" | "listoAt">): PestanaCola | null {
  switch (p.estado as EstadoPanel) {
    case "pending":
      return "nuevos";
    case "preparando":
      return p.listoAt ? "listos" : "preparacion";
    case "listo_para_recoger":
      return "listos";
    case "en_camino":
      return "camino";
    default:
      return null;
  }
}

export function conteosPorPestana(pedidos: readonly TarjetaPedido[]): Readonly<Record<PestanaCola, number>> {
  const c: Record<PestanaCola, number> = { nuevos: 0, preparacion: 0, listos: 0, camino: 0 };
  for (const p of pedidos) {
    const t = pestanaDe(p);
    if (t) c[t] += 1;
  }
  return c;
}

/** Accion grande de la tarjeta: la primera que el SERVIDOR declara disponible, en el orden del flujo (Aceptar -> Listo -> Entregar/Salio). */
export type AccionPrincipal = Extract<AccionDisponible, "aceptar" | "listo" | "entregar" | "salio">;
const ORDEN_ACCION: readonly AccionPrincipal[] = ["aceptar", "listo", "entregar", "salio"];
export function accionPrincipal(p: Pick<TarjetaPedido, "accionesDisponibles" | "estado" | "canal">): AccionPrincipal | null {
  for (const a of ORDEN_ACCION) {
    if (!p.accionesDisponibles.includes(a)) continue;
    // «Entregar» del encargado solo existe en mostrador (recoger); un domicilio en camino lo entrega el chofer.
    if (a === "entregar" && p.canal !== "recoger") continue;
    return a;
  }
  return null;
}

export const ETIQUETA_ACCION: Readonly<Record<string, string>> = { aceptar: "Aceptar", listo: "Listo", entregar: "Entregado", salio: "Salió" };

export function etiquetaOrigen(origen: string): string {
  const mapa: Record<string, string> = { whatsapp: "WhatsApp", whatsapp_manual: "WhatsApp", voice: "Voz", voz: "Voz", llamada: "Llamada", mostrador: "Mostrador", web: "Web", admin: "Captura" };
  return mapa[origen] ?? origen;
}

/** Minutos del pedido ahora: los que dijo el servidor al actualizar mas lo que ha pasado en ESTE telefono desde esa consulta (no mezcla relojes). */
export function minutosVivos(p: Pick<TarjetaPedido, "minutos">, consultadoEnMs: number, ahoraMs: number): number {
  return p.minutos + Math.max(0, Math.floor((ahoraMs - consultadoEnMs) / 60_000));
}

const PESO: Readonly<Record<Semaforo, number>> = { rojo: 0, amarillo: 1, verde: 2 };

/** Rojos primero y, a igual color, el mas antiguo primero (el que ya lleva mas tiempo esperando). */
export function ordenarCola(pedidos: readonly TarjetaPedido[], consultadoEnMs: number, ahoraMs: number): readonly TarjetaPedido[] {
  const clave = (p: TarjetaPedido) => PESO[semaforoPedido(p.estado, p.canal, minutosVivos(p, consultadoEnMs, ahoraMs))];
  return [...pedidos].sort((a, b) => clave(a) - clave(b) || Date.parse(a.creadoEn) - Date.parse(b.creadoEn) || a.numero - b.numero);
}
