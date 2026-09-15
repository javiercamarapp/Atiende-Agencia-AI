// Cliente real de F&B con guardia de alergias (REQ-AB-004, P0/GOB) — consume
// apps/api/src/routes/verticals/hoteles/pedidosFnb.ts. Hallazgo de auditoría
// (severidad ALTA, "Pedidos F&B con guardia de alergias: backend real sin
// pantalla"): las 5 rutas (listar/crear/leer uno/confirmar cocina/asegurar
// seguridad) ya estaban montadas y probadas del lado del servidor, pero
// apps/web nunca tuvo ni cliente ni página — el rol `fnb` no tenía ninguna
// superficie en el panel. Mismo patrón exacto que housekeeping-client.ts
// (fetchImpl inyectado, fetchJson/sendJson de admin-client.ts que ya manejan
// refresh-on-401).
import { fetchJson, sendJson } from "./admin-client.ts";

export interface FnbOrderItem {
  readonly nombre: string;
  readonly notas?: string;
}

/** Espejo de `AllergyDeclaredVia` (domain-hoteles/src/fnbAllergyGuard.ts) — de
 * dónde se detectó la alergia declarada, `null` cuando no se declaró. Solo
 * para mostrar contexto al staff; la guarda de seguridad real vive siempre
 * del lado del servidor (`puedeAsegurarSeguridad`/`mensajeSeguridad` abajo se
 * calculan en vivo ahí, nunca aquí). */
export type FnbAllergyDeclaredVia = "estructurado" | "texto_libre" | "texto_libre_no_reconocido";

export const FNB_ALLERGY_VIA_LABELS: Record<FnbAllergyDeclaredVia, string> = {
  estructurado: "Campo declarado por el huésped",
  texto_libre: "Detectada en una nota de texto libre",
  texto_libre_no_reconocido: "Nota de texto libre sin reconocer (tratada como alergia por seguridad)",
};

export interface FnbPedido {
  readonly id: string;
  readonly roomId: string | null;
  readonly items: readonly FnbOrderItem[];
  readonly notas: string | null;
  readonly alergiaDeclarada: boolean;
  readonly alergiaDetectadaVia: FnbAllergyDeclaredVia | null;
  readonly cocineroConfirmoEn: string | null;
  readonly cocineroConfirmoPor: string | null;
  // SIEMPRE calculados en vivo por el servidor desde fnbAllergyGuard.ts — nunca
  // texto libre editable. Ver comentario de cabecera de `serializePedido` en
  // pedidosFnb.ts.
  readonly puedeAsegurarSeguridad: boolean;
  readonly mensajeSeguridad: string;
  readonly seguridadAseguradaEn: string | null;
  readonly creadoEn: string;
}

export interface CrearPedidoFnbInput {
  readonly roomId?: string;
  readonly items: readonly FnbOrderItem[];
  readonly notas?: string;
  readonly alergiaDeclarada?: boolean;
}

export async function fetchPedidosFnb(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly FnbPedido[]> {
  return fetchJson<readonly FnbPedido[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pedidos-fnb`, token);
}

export async function fetchPedidoFnb(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string): Promise<FnbPedido> {
  return fetchJson<FnbPedido>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pedidos-fnb/${orderId}`, token);
}

export async function crearPedidoFnb(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CrearPedidoFnbInput): Promise<FnbPedido> {
  return sendJson<FnbPedido>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pedidos-fnb`, token, "POST", input);
}

/** Rol `fnb` (cocina)/gm/owner confirmando que revisó el platillo a mano —
 * ÚNICA forma de que `cocineroConfirmoPor` deje de ser null (ver
 * assertCanAssureDishIsSafe en fnbAllergyGuard.ts). El servidor rechaza con
 * 409 confirmar un pedido que no declaró alergia. */
export async function confirmarCocinaFnb(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, nota?: string): Promise<FnbPedido> {
  return sendJson<FnbPedido>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pedidos-fnb/${orderId}/confirmar-cocina`, token, "POST", nota ? { nota } : {});
}

/** Único endpoint que le "asegura" al huésped que el platillo es seguro. Si el
 * pedido tiene alergia declarada sin confirmación de cocina, el servidor
 * responde 409 (`AllergySafetyAssuranceBlockedError`) y NUNCA marca
 * `seguridadAseguradaEn` — este cliente deja pasar ese error tal cual para
 * que la página lo muestre (nunca debe inventar que sí se aseguró). */
export async function asegurarSeguridadFnb(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string): Promise<FnbPedido> {
  return sendJson<FnbPedido>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/pedidos-fnb/${orderId}/asegurar-seguridad`, token, "POST", {});
}
