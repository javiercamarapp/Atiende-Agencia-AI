// Memoria del cliente: carga (con respaldo honesto contra la base sin migrar), cierre del ciclo tras un pedido y regla de
// reincidencia. La base la conoce el repositorio; aqui vive la logica de negocio.
import type { RestaurantesRepository } from "../repository.ts";
import type { CreateOrderInput, Order } from "../types.ts";
import { extraerDomicilio, extraerObservaciones } from "./gustos.ts";
import type { CustomerMemory, CustomerReliability } from "./types.ts";

/** Memoria del cliente por telefono (10 digitos). `null` = cliente nuevo; `undefined` = la base todavia no la ofrece. */
export async function cargarMemoria(repo: RestaurantesRepository, organizationId: string, phone: string): Promise<CustomerMemory | null | undefined> {
  return repo.getCustomerMemory(organizationId, phone);
}

/** Cierre automatico del ciclo: tras crear el pedido se actualizan domicilio y gustos. Idempotente por pedido y
 * best-effort: nunca revierte un pedido ya creado (SAVEPOINT por si Postgres falla dentro de la transaccion compartida). */
export async function cerrarCicloDelCliente(
  repo: RestaurantesRepository,
  order: Order,
  input: Pick<CreateOrderInput, "requestedComplements" | "omitDefaultComplements" | "doubleSalsas" | "notes" | "paymentMethod" | "canal" | "propina" | "customerAddress" | "colonia"> & {
    readonly addressLabel?: string;
    readonly accessNotes?: string;
    readonly mapsUrl?: string;
  },
): Promise<void> {
  if (!order.customerId) return;
  try {
    await repo.runWithRowSavepoint(() =>
      repo.registerOrderClosure({
        organizationId: order.organizationId,
        orderId: order.id,
        address: extraerDomicilio(input, order.propertyId),
        observations: extraerObservaciones({ items: order.items, input, branchName: order.branch }),
      }),
    );
  } catch (err) {
    // Sin PII: solo la clase del error y el id del pedido.
    console.error("cliente-360: no se pudo cerrar el ciclo del cliente", { orderId: order.id, code: (err as { code?: string } | null)?.code ?? "desconocido" });
  }
}

export interface DecisionReincidencia {
  readonly requiereConfirmacion: boolean;
  readonly noRecogidos: number;
  readonly pedidosFalsos: number;
  readonly umbral: number;
}

/** Con `umbral` o mas "no recogido" + pedidos falsos dentro de la ventana, el siguiente pedido lo confirma la sucursal.
 * Umbral 0 = politica apagada. */
export function evaluarReincidencia(reliability: CustomerReliability | undefined): DecisionReincidencia {
  if (!reliability) return { requiereConfirmacion: false, noRecogidos: 0, pedidosFalsos: 0, umbral: 0 };
  const total = reliability.noRecogidos90d + reliability.pedidosFalsos;
  return {
    requiereConfirmacion: reliability.umbral > 0 && total >= reliability.umbral,
    noRecogidos: reliability.noRecogidos90d,
    pedidosFalsos: reliability.pedidosFalsos,
    umbral: reliability.umbral,
  };
}
