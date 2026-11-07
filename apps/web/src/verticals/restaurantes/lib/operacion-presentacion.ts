// Presentacion pura de la cola del encargado: pestanas, accion principal por pedido, etiquetas de origen y orden. Sin DOM ni red.
import type { AccionDisponible, EstadoPanel, TarjetaPedido } from "@atiende/domain-restaurantes/operacion";
import { semaforoPedido } from "./semaforo.ts";
import type { Semaforo } from "@atiende/domain-restaurantes/operacion";
import { etiquetasTraducidas } from "@atiende/ui";
import { restaurantesOperacion } from "@atiende/ui/i18n/restaurantes/operacion";

export type PestanaCola = "nuevos" | "preparacion" | "listos" | "camino";

const ETIQUETA_PESTANA = etiquetasTraducidas<PestanaCola>(["nuevos", "preparacion", "listos", "camino"], (p) => `restaurantes.operacion.cola.${p}` as const, restaurantesOperacion);

/** `etiqueta` se traduce en cada lectura al idioma activo (i18n); en espanol, los textos de siempre. */
export const PESTANAS_COLA: readonly { readonly valor: PestanaCola; readonly etiqueta: string }[] = (["nuevos", "preparacion", "listos", "camino"] as const).map((valor) => ({
  valor,
  get etiqueta() {
    return ETIQUETA_PESTANA[valor];
  },
}));

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

export const ETIQUETA_ACCION: Readonly<Record<string, string>> = etiquetasTraducidas(
  ["aceptar", "listo", "entregar", "salio"] as const,
  (a) => `restaurantes.operacion.tarjeta.accion.${a}` as const,
  restaurantesOperacion,
);

const CANAL_DE_ORIGEN: Readonly<Record<string, "whatsapp" | "voz" | "llamada" | "mostrador" | "web" | "admin">> = {
  whatsapp: "whatsapp",
  whatsapp_manual: "whatsapp",
  voice: "voz",
  voz: "voz",
  llamada: "llamada",
  mostrador: "mostrador",
  web: "web",
  admin: "admin",
};
const ETIQUETA_ORIGEN = etiquetasTraducidas(["whatsapp", "voz", "llamada", "mostrador", "web", "admin"] as const, (c) => `restaurantes.operacion.canal.${c}` as const, restaurantesOperacion);

export function etiquetaOrigen(origen: string): string {
  const canal = CANAL_DE_ORIGEN[origen];
  return canal ? ETIQUETA_ORIGEN[canal] : origen;
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
