// Enlace del perfil historico con la busqueda de cliente del agente. Aditivo: si el repositorio no ofrece la lectura, la base no esta migrada
// o el cliente no tiene historial importado, el resultado es EXACTAMENTE el de antes (mismo objeto).
import { normalizePhone } from "../phone.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { CustomerLookupResult } from "../types.ts";
import { construirPerfil360, perfilParaAgente, type EntradaPerfil } from "./perfil.ts";

type Conocido = Extract<CustomerLookupResult, { isNew: false }>;
const KINDS_REALES = new Set(["tortilla", "salsa", "omision", "pago", "canal"]);

export async function adjuntarPerfilHistorico(repo: RestaurantesRepository, organizationId: string, phone: string, base: Conocido, now: Date): Promise<Conocido> {
  if (typeof repo.getPerfilHistorico !== "function") return base;
  let entrada: EntradaPerfil | null | undefined;
  try {
    entrada = await repo.getPerfilHistorico(organizationId, normalizePhone(phone));
  } catch {
    return base; // el perfil historico es un extra: nunca tumba la busqueda del cliente
  }
  if (!entrada) return base;
  const gustosReales = (base.gustos ?? [])
    .filter((g) => KINDS_REALES.has(g.kind))
    .map((g) => ({ kind: g.kind as "tortilla" | "salsa" | "omision" | "pago" | "canal", valor: g.value, veces: g.veces, ultimaVez: g.ultimaVez }));
  const perfil = construirPerfil360({ ...entrada, gustosReales, pedidosReales: base.orderCount, ultimoPedidoReal: base.pedidosAnteriores?.[0]?.fecha ?? null }, now);
  if (!perfil.tieneHistorialImportado) return base;
  return { ...base, perfilHistorico: perfilParaAgente(perfil) };
}
