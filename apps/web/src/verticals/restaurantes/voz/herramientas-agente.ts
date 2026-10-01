// Herramientas (server tools) que el agente de voz de restaurantes puede llamar.
// Son las que YA existen en la API: buscar_sucursal_cercana / buscar_producto /
// cotizar_pedido en routes/verticals/restaurantes/voice-tools.ts, y buscar_cliente /
// crear_pedido en routes/verticals/restaurantes/public.ts (ver el comentario de
// cabecera de voice-tools.ts). El contador de ejecuciones NUNCA se fija aquí: sale
// de las conversaciones reales (ver contarEjecuciones).
import type { ConversacionVoz } from "../lib/voz-client.ts";

export interface HerramientaAgente {
  readonly nombre: string;
  readonly titulo: string;
  readonly descripcion: string;
}

export const HERRAMIENTAS_AGENTE: readonly HerramientaAgente[] = [
  { nombre: "buscar_sucursal_cercana", titulo: "Buscar sucursal cercana", descripcion: "Encuentra la sucursal más cercana a la zona o referencia que da el cliente." },
  { nombre: "buscar_producto", titulo: "Buscar producto", descripcion: "Consulta el menú real: productos, precios y disponibilidad." },
  { nombre: "cotizar_pedido", titulo: "Cotizar pedido", descripcion: "Calcula el total de un pedido antes de confirmarlo." },
  { nombre: "buscar_cliente", titulo: "Buscar cliente", descripcion: "Reconoce a un cliente recurrente por su teléfono." },
  { nombre: "crear_pedido", titulo: "Crear pedido", descripcion: "Registra el pedido confirmado por el cliente." },
];

export type EjecucionesPorHerramienta =
  | { readonly disponible: false; readonly motivo: string }
  | { readonly disponible: true; readonly llamadas: number; readonly cuentas: Readonly<Record<string, number>> };

/**
 * Cuenta ejecuciones REALES a partir de las conversaciones que el servicio devolvió.
 * Si el servicio no reporta herramientas por conversación, no hay dato: se dice
 * `disponible: false` con el motivo, en vez de mostrar "0 ejecuciones".
 */
export function contarEjecuciones(conversaciones: readonly ConversacionVoz[] | null): EjecucionesPorHerramienta {
  if (conversaciones === null) return { disponible: false, motivo: "El historial de conversaciones todavía no está disponible." };
  const conDato = conversaciones.filter((c) => c.herramientas !== undefined);
  if (conDato.length === 0) {
    return {
      disponible: false,
      motivo: conversaciones.length === 0 ? "Todavía no hay conversaciones registradas." : "El historial no reporta qué herramientas usó cada llamada.",
    };
  }
  const cuentas: Record<string, number> = {};
  for (const c of conDato) for (const h of c.herramientas ?? []) cuentas[h] = (cuentas[h] ?? 0) + 1;
  return { disponible: true, llamadas: conDato.length, cuentas };
}
