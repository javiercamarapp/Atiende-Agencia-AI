import type { ModuloEs } from "../tipos.ts";

/** Urgencia de aprobacion en el tablero de Pedidos (restaurantes). La traduccion vive en `en/aprobaciones.ts`. */
export const aprobaciones = {
  "aprobaciones.aviso.titulo": { one: "{count} pedido espera tu aprobación", other: "{count} pedidos esperan tu aprobación" },
  "aprobaciones.aviso.urgentes": { one: "{count} urgente · el más antiguo espera hace {minutos} min", other: "{count} urgentes · el más antiguo espera hace {minutos} min" },
  "aprobaciones.aviso.espera": "El más antiguo espera hace {minutos} min",
  "aprobaciones.aviso.esperaMenosDeUno": "Acaba de llegar",
  "aprobaciones.aviso.revisar": "Revisar ahora",
  "aprobaciones.urgente": "Urgente",
  "aprobaciones.pestanaPendientes": { one: "{count} por aprobar", other: "{count} por aprobar" },
} as const satisfies ModuloEs;
