// Tablas `estado -> tono` de restaurantes para <StatusBadge> de @atiende/ui (PR-5 del
// plan de diseno-ux, F-09): reemplazan las comparaciones sueltas `status === "problema"
// ? "destructive" : "secondary"` de Pedidos/Historial/Repartidor/Conversaciones y las
// clases de color crudas del tier de cliente. Un estado que la tabla aun no conoce cae
// a "neutral" (via `statusTone`) en vez de pintarse mal.
import type { StatusTone } from "@atiende/ui";

/** Estado de un pedido (`orders.status`). */
export const ORDER_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  pending: "warning",
  preparando: "info",
  en_camino: "info",
  listo_para_recoger: "info",
  entregado: "success",
  completado: "success",
  cancelado: "neutral",
  problema: "danger",
  no_recogido: "danger",
  programado: "info",
  por_aprobar: "warning",
};

/** Estado de una conversacion tomada por una persona (handoff). */
export const HANDOFF_ESTADO_TONES: Readonly<Record<string, StatusTone>> = {
  pendiente: "danger",
  tomada: "info",
  agente: "success",
  devuelta: "neutral",
  cerrada: "neutral",
};

/** Etiqueta y glifo de cada nivel de cliente (el glifo es decorativo: el texto es la señal accesible). */
export const CUSTOMER_TIER_META: Readonly<Record<"BLACK" | "PLATINUM" | "GOLD" | "BLUE", { readonly label: string; readonly glyph: string }>> = {
  BLACK: { label: "Black", glyph: "♛" },
  PLATINUM: { label: "Platinum", glyph: "◆" },
  GOLD: { label: "Gold", glyph: "★" },
  BLUE: { label: "Blue", glyph: "●" },
};

/** Nivel de cliente. BLACK usa ademas `TIER_BLACK_CLASE` (fondo de tinta) porque ningun tono semantico lo representa. */
export const CUSTOMER_TIER_TONES: Readonly<Record<string, StatusTone>> = {
  BLACK: "neutral",
  PLATINUM: "neutral",
  GOLD: "warning",
  BLUE: "info",
};

/** Clase de token (no paleta cruda) que invierte el badge del tier BLACK: fondo de tinta, texto de fondo. */
export const TIER_BLACK_CLASE = "border-transparent bg-foreground text-background";

/** Clase extra del badge de un nivel de cliente (solo BLACK la necesita). */
export function tierBadgeClase(tier: string): string | undefined {
  return tier === "BLACK" ? TIER_BLACK_CLASE : undefined;
}
