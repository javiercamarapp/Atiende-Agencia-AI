import type { Traduccion } from "../../tipos.ts";
import type { aprobaciones } from "../aprobaciones.ts";

export const aprobacionesEn: Traduccion<typeof aprobaciones> = {
  "aprobaciones.aviso.titulo": { one: "{count} order is waiting for your approval", other: "{count} orders are waiting for your approval" },
  "aprobaciones.aviso.urgentes": { one: "{count} urgent · the oldest has waited {minutos} min", other: "{count} urgent · the oldest has waited {minutos} min" },
  "aprobaciones.aviso.espera": "The oldest has waited {minutos} min",
  "aprobaciones.aviso.esperaMenosDeUno": "Just arrived",
  "aprobaciones.aviso.revisar": "Review now",
  "aprobaciones.urgente": "Urgent",
  "aprobaciones.pestanaPendientes": { one: "{count} awaiting approval", other: "{count} awaiting approval" },
};
