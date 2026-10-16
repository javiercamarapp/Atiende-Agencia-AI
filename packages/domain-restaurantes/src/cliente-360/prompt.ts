// Lineas de contexto del cliente para el prompt del agente (WhatsApp y voz): domicilios, gustos y pedidos anteriores.
// Nunca incluye calle ni numero: la direccion completa solo la devuelve la herramienta `buscar_cliente`.
import { sanitizeInlineText } from "../text-sanitize.ts";
import type { CustomerLookupResult } from "../types.ts";
import { describirGusto } from "./gustos.ts";

type Conocido = Extract<CustomerLookupResult, { isNew: false }>;

function nombreDeDomicilio(d: NonNullable<Conocido["domicilios"]>[number]): string {
  const etiqueta = d.label ? sanitizeInlineText(d.label, 60) : "";
  const colonia = d.colonia ? sanitizeInlineText(d.colonia, 80) : "";
  if (etiqueta && colonia) return `${etiqueta} (${colonia})`;
  return etiqueta || colonia || "sin etiqueta";
}

/**
 * Lineas adicionales (vacio si la base no ofrece la memoria completa). El agente PROPONE y confirma: nunca da por hecho un
 * dato guardado ni vuelve a pedir lo que ya existe.
 */
export function lineasCliente360(customer: Conocido): string[] {
  const lines: string[] = [];
  const domicilios = customer.domicilios ?? [];
  if (domicilios.length > 1) {
    lines.push(
      `Tiene ${domicilios.length} domicilios guardados (el de la última vez primero): ${domicilios.map((d, i) => `${i + 1}) ${nombreDeDomicilio(d)}`).join("; ")}. Ofrece primero el de la última vez por su etiqueta o colonia y deja que elija otro de la lista o dé uno nuevo; nunca leas calle ni número.`,
    );
  } else if (domicilios.length === 1) {
    lines.push(`Su domicilio guardado se llama «${nombreDeDomicilio(domicilios[0]!)}»: confírmalo ("¿se lo enviamos a ${nombreDeDomicilio(domicilios[0]!)}, como la vez pasada?") en vez de pedirlo de nuevo.`);
  }
  if (customer.name) lines.push("Ya tienes su nombre: salúdalo por él y NO se lo pidas otra vez; solo confírmalo si dudas.");
  const gustos = customer.gustos ?? [];
  if (gustos.length > 0) {
    lines.push(
      `Gustos conocidos (aprendidos de sus pedidos confirmados; PROPÓN, no los des por hechos, y acepta de inmediato si los cambia): ${gustos.map((g) => describirGusto(g)).join("; ")}. Ejemplo: "¿Como siempre, con ese gusto?".`,
    );
  }
  const anteriores = customer.pedidosAnteriores ?? [];
  if (anteriores.length > 0) {
    lines.push(
      `Tiene ${anteriores.length} ${anteriores.length === 1 ? "pedido anterior" : "pedidos anteriores"} registrados: si pide "lo mismo" o "lo de siempre", usa historial_pedidos y repetir_pedido (re-cotiza con los precios de HOY y te dice qué cambió; avísaselo antes de confirmar). Nunca uses el precio de la vez pasada.`,
    );
  }
  return lines;
}
