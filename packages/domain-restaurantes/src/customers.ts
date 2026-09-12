// Port literal de lookupCustomer/vipNote de
// restaurantes/supabase/functions/_shared/create-order-core.ts +
// customer-lookup/index.ts (agent_notes). Memoria real de cliente frecuente por
// teléfono: no solo el último pedido, sino frequent_items (productos más pedidos
// across TODO su historial real) y tier (percentil real, calc_customer_tier). Esta es
// la "memoria de cliente por teléfono" que el brief pide preservar explícitamente.
import { normalizePhone } from "./phone.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { CustomerLookupResult, CustomerTier, OrderHistoryItem, PersistedOrderItem } from "./types.ts";

/** Cuando el cliente es BLACK o PLATINUM el agente (voz o WhatsApp, o el staff
 * humano leyendo el resultado en el panel) debe tratarlo con calidez extra/prioridad
 * — texto listo para inyectar en un prompt o mostrar tal cual. */
export function vipNote(tier: CustomerTier | null): string | null {
  if (tier === "BLACK") {
    return "Es cliente BLACK — uno de los clientes de mayor consumo/frecuencia del restaurante (top 10%). Trátalo con calidez extra y dale prioridad.";
  }
  if (tier === "PLATINUM") {
    return "Es cliente PLATINUM — uno de los clientes más frecuentes/de mayor consumo del restaurante. Trátalo con calidez extra y dale prioridad.";
  }
  return null;
}

function countFrequentItems(orders: ReadonlyArray<{ items: readonly PersistedOrderItem[] }>): OrderHistoryItem[] {
  const conteo = new Map<string, { name: string; quantity: number }>();
  for (const order of orders) {
    for (const item of order.items) {
      const key = item.id ?? item.name;
      const actual = conteo.get(key);
      if (actual) actual.quantity += item.quantity;
      else conteo.set(key, { name: item.name, quantity: item.quantity });
    }
  }
  return [...conteo.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 3);
}

/**
 * Reconoce a un cliente por teléfono (normalizado) y arma su memoria real: nombre,
 * direcciones guardadas, último pedido, "lo de siempre" (frequent_items across todo
 * el historial elegible), tier por percentil, y agentNotes en texto plano listas para
 * inyectar en un prompt o mostrar al staff. Un cliente nunca visto -> { isNew: true }.
 */
export async function lookupCustomer(repo: RestaurantesRepository, organizationId: string, phone: string): Promise<CustomerLookupResult> {
  const customer = await repo.findCustomerByPhone(organizationId, normalizePhone(phone));
  if (!customer) return { isNew: true };

  const [addresses, history, tier] = await Promise.all([
    repo.listCustomerAddresses(customer.id),
    repo.listEligibleOrderHistory(customer.id),
    repo.calcCustomerTier(organizationId, customer.id),
  ]);

  const lastOrder = history[0] ?? null;
  const frequentItems = countFrequentItems(history);

  const agentNotes: string[] = [];
  const nota = vipNote(tier);
  if (nota) agentNotes.push(nota);
  if (frequentItems.length > 0) {
    const items = frequentItems.map((i) => i.name).join(", ");
    agentNotes.push(
      `Lo que más pide across todo su historial real (no solo su último pedido): ${items}. Puedes ofrecer "¿lo de siempre?" con confianza usando esto, incluso si su último pedido fue distinto.`,
    );
  }

  return {
    isNew: false,
    name: customer.name,
    orderCount: customer.orderCount,
    addresses,
    lastOrderItems: lastOrder ? lastOrder.items.map((i) => ({ name: i.name, quantity: i.quantity })) : null,
    frequentItems,
    tier,
    agentNotes,
  };
}

/**
 * Fase 5 back-office CORE — misma memoria real que `lookupCustomer` (nombre,
 * direcciones, "lo de siempre", tier, agentNotes), pero resuelta por id de cliente
 * en vez de teléfono: la ficha de administración del panel navega desde un listado
 * (`GET .../admin/customers`) que ya trae el id, nunca vuelve a pedirle el teléfono
 * al staff. `null` cuando el id no existe o pertenece a otra organización — nunca
 * se filtra el cliente de otro tenant devolviendo `{ isNew: true }` (eso implicaría
 * "no existe", cuando en realidad SÍ existe, solo que no es tuyo).
 */
export async function getCustomerDetailById(repo: RestaurantesRepository, organizationId: string, customerId: string): Promise<CustomerLookupResult | null> {
  const customer = await repo.findCustomerById(organizationId, customerId);
  if (!customer) return null;

  const [addresses, history, tier] = await Promise.all([
    repo.listCustomerAddresses(customer.id),
    repo.listEligibleOrderHistory(customer.id),
    repo.calcCustomerTier(organizationId, customer.id),
  ]);

  const lastOrder = history[0] ?? null;
  const frequentItems = countFrequentItems(history);

  const agentNotes: string[] = [];
  const nota = vipNote(tier);
  if (nota) agentNotes.push(nota);
  if (frequentItems.length > 0) {
    const items = frequentItems.map((i) => i.name).join(", ");
    agentNotes.push(
      `Lo que más pide across todo su historial real (no solo su último pedido): ${items}. Puedes ofrecer "¿lo de siempre?" con confianza usando esto, incluso si su último pedido fue distinto.`,
    );
  }

  return {
    isNew: false,
    name: customer.name,
    orderCount: customer.orderCount,
    addresses,
    lastOrderItems: lastOrder ? lastOrder.items.map((i) => ({ name: i.name, quantity: i.quantity })) : null,
    frequentItems,
    tier,
    agentNotes,
  };
}
