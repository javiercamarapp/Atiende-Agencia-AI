// Adaptador Postgres de la memoria del cliente (migracion 044). Todas las llamadas son a funciones `security definer`
// (ver la migracion) y corren dentro de un SAVEPOINT: la sesion es UNA transaccion por request, un error de Postgres sin
// SAVEPOINT la dejaria abortada (25P02) y el COMMIT seria un ROLLBACK silencioso.
//   - Lecturas/escrituras de SISTEMA (agente): contra una base sin la migracion devuelven `undefined` ("no disponible aun").
//   - Operaciones del STAFF: contra una base sin la migracion lanzan `ClienteMemoriaNoDisponibleError` (la ruta responde 503).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { ClienteMemoriaNoDisponibleError } from "../errors.ts";
import type { PersistedOrderItem } from "../types.ts";
import type {
  CustomerAddressChanges,
  CustomerAddressDetail,
  CustomerFicha,
  CustomerMemory,
  CustomerPolicy,
  CustomerPreference,
  CustomerProfilePatch,
  CustomerReliability,
  OrderClosureInput,
  PastOrder,
  PreferenceAction,
} from "./types.ts";
import { isPreferenceKind, POLITICA_POR_OMISION } from "./types.ts";

/** Funcion, tabla o columna inexistente: la base todavia no tiene la migracion 044. */
export function esBaseSinMigrar044(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

export function mapAddress(raw: Json): CustomerAddressDetail {
  return {
    id: String(raw.id),
    address: String(raw.address ?? ""),
    label: str(raw.label),
    isDefault: raw.is_default === true,
    accessNotes: str(raw.access_notes),
    mapsUrl: str(raw.maps_url),
    colonia: str(raw.colonia),
    branchSlug: str(raw.branch_slug),
    lastUsedAt: str(raw.last_used_at),
    timesUsed: num(raw.times_used),
  };
}

export function mapPreference(raw: Json): CustomerPreference | null {
  if (!isPreferenceKind(raw.kind)) return null;
  return {
    id: String(raw.id),
    kind: raw.kind,
    value: String(raw.value ?? ""),
    source: raw.source === "staff" ? "staff" : "pedido",
    timesSeen: num(raw.times_seen, 1),
    firstSeenAt: String(raw.first_seen_at ?? ""),
    lastSeenAt: String(raw.last_seen_at ?? ""),
    status: raw.status === "descartada" ? "descartada" : "activa",
  };
}

function mapPreferences(raw: unknown): CustomerPreference[] {
  return (Array.isArray(raw) ? (raw as Json[]) : []).map(mapPreference).filter((p): p is CustomerPreference => p !== null);
}

function mapReliability(raw: unknown): CustomerReliability {
  const r = (raw ?? {}) as Json;
  return { noRecogidos90d: num(r.no_recogidos_90d), pedidosFalsos: num(r.pedidos_falsos), umbral: num(r.umbral, 2), ventanaDias: num(r.ventana_dias, 90) };
}

function mapPastOrder(raw: Json): PastOrder {
  return {
    id: String(raw.id),
    orderNumber: typeof raw.order_number === "number" ? raw.order_number : raw.order_number != null ? Number(raw.order_number) : null,
    createdAt: String(raw.created_at ?? ""),
    status: String(raw.status ?? ""),
    total: num(raw.total),
    items: (Array.isArray(raw.items) ? raw.items : []) as PersistedOrderItem[],
    branch: str(raw.branch),
    propertyId: str(raw.property_id),
    paymentMethod: raw.payment_method === "efectivo" || raw.payment_method === "tarjeta" ? raw.payment_method : null,
    canal: raw.canal === "domicilio" || raw.canal === "recoger" ? raw.canal : null,
    propina: raw.propina == null ? null : num(raw.propina),
    source: String(raw.source ?? ""),
  };
}

async function callJson(db: TenantDbSession, sql: string, params: unknown[]): Promise<unknown> {
  const { rows } = await db.query<{ r: unknown }>(sql, params);
  return rows[0]?.r ?? null;
}

/** Lectura de sistema por telefono. `undefined` = base sin migrar (el agente cae al camino anterior). */
export async function getCustomerMemory(db: TenantDbSession, organizationId: string, phone: string): Promise<CustomerMemory | null | undefined> {
  return runWithSavepointFallback<CustomerMemory | null | undefined>({
    session: db,
    savepointName: "sp_cliente360_memoria",
    primary: async () => {
      const raw = (await callJson(db, `select restaurantes.cliente_memoria($1, $2) as r;`, [organizationId, phone])) as Json | null;
      if (!raw) return null;
      const c = raw.customer as Json;
      return {
        customer: { id: String(c.id), organizationId: String(c.organization_id), phone: String(c.phone), name: str(c.name), orderCount: num(c.order_count) },
        addresses: (Array.isArray(raw.addresses) ? (raw.addresses as Json[]) : []).map(mapAddress),
        orders: (Array.isArray(raw.orders) ? (raw.orders as Json[]) : []).map(mapPastOrder),
        preferences: mapPreferences(raw.preferences),
        reliability: mapReliability(raw.confiabilidad),
      };
    },
    isRecoverable: esBaseSinMigrar044,
    fallback: async () => undefined,
  });
}

/** Cierre del ciclo (sistema). `undefined` = base sin migrar. */
export async function registerOrderClosure(db: TenantDbSession, input: OrderClosureInput): Promise<{ readonly applied: boolean } | undefined> {
  return runWithSavepointFallback<{ readonly applied: boolean } | undefined>({
    session: db,
    savepointName: "sp_cliente360_cierre",
    primary: async () => {
      const domicilio = input.address
        ? {
            address: input.address.address,
            label: input.address.label ?? null,
            access_notes: input.address.accessNotes ?? null,
            maps_url: input.address.mapsUrl ?? null,
            colonia: input.address.colonia ?? null,
            property_id: input.address.propertyId ?? null,
          }
        : null;
      const raw = (await callJson(db, `select restaurantes.cliente_registrar_pedido($1, $2, $3::jsonb, $4::jsonb) as r;`, [
        input.organizationId,
        input.orderId,
        domicilio === null ? null : JSON.stringify(domicilio),
        JSON.stringify(input.observations.slice(0, 20)),
      ])) as Json | null;
      return { applied: raw?.aplicado === true };
    },
    isRecoverable: esBaseSinMigrar044,
    fallback: async () => undefined,
  });
}

async function staffCall<T>(db: TenantDbSession, name: string, primary: () => Promise<T>): Promise<T> {
  return runWithSavepointFallback<T>({
    session: db,
    savepointName: `sp_cliente360_${name}`,
    primary,
    isRecoverable: esBaseSinMigrar044,
    fallback: () => {
      throw new ClienteMemoriaNoDisponibleError();
    },
  });
}

export async function getCustomerFicha(db: TenantDbSession, organizationId: string, customerId: string): Promise<Omit<CustomerFicha, "tier"> | null> {
  return staffCall(db, "ficha", async () => {
    const raw = (await callJson(db, `select restaurantes.cliente_ficha($1, $2) as r;`, [organizationId, customerId])) as Json | null;
    if (!raw) return null;
    const c = raw.customer as Json;
    const wa = (raw.whatsapp ?? {}) as Json;
    return {
      customer: {
        id: String(c.id),
        organizationId,
        phone: String(c.phone),
        name: str(c.name),
        orderCount: num(c.order_count),
        lastOrderAt: str(c.last_order_at),
        createdAt: String(c.created_at ?? ""),
        fechaNacimientoDia: c.fecha_nacimiento_dia == null ? null : num(c.fecha_nacimiento_dia),
        fechaNacimientoMes: c.fecha_nacimiento_mes == null ? null : num(c.fecha_nacimiento_mes),
        staffNotes: str(c.staff_notes),
      },
      addresses: (Array.isArray(raw.addresses) ? (raw.addresses as Json[]) : []).map(mapAddress),
      preferences: mapPreferences(raw.preferences),
      reliability: mapReliability(raw.confiabilidad),
      orders: (Array.isArray(raw.orders) ? (raw.orders as Json[]) : []).map((o) => ({
        id: String(o.id),
        orderNumber: o.order_number == null ? null : num(o.order_number),
        createdAt: String(o.created_at ?? ""),
        status: String(o.status ?? ""),
        total: num(o.total),
        items: (Array.isArray(o.items) ? o.items : []) as PersistedOrderItem[],
        branch: str(o.branch),
        source: String(o.source ?? ""),
        paymentMethod: str(o.payment_method),
        pedidoFalso: o.pedido_falso === true,
      })),
      whatsapp: { conversaciones: num(wa.conversaciones), ultimaActividad: str(wa.ultima_actividad), mensajes: num(wa.mensajes) },
      llamadas: (Array.isArray(raw.llamadas) ? (raw.llamadas as Json[]) : []).map((l) => ({
        id: String(l.id),
        startedAt: String(l.started_at ?? ""),
        durationS: l.duration_s == null ? null : num(l.duration_s),
        resultado: str(l.resultado),
      })),
    };
  });
}

export async function updateCustomerProfile(db: TenantDbSession, organizationId: string, customerId: string, patch: CustomerProfilePatch): Promise<void> {
  const cambios: Json = {};
  if (patch.name !== undefined) cambios.name = patch.name;
  if (patch.staffNotes !== undefined) cambios.staff_notes = patch.staffNotes;
  if (patch.fechaNacimientoDia !== undefined || patch.fechaNacimientoMes !== undefined) {
    cambios.fecha_nacimiento_dia = patch.fechaNacimientoDia ?? null;
    cambios.fecha_nacimiento_mes = patch.fechaNacimientoMes ?? null;
  }
  await staffCall(db, "actualizar", async () => {
    await callJson(db, `select restaurantes.cliente_actualizar($1, $2, $3::jsonb) as r;`, [organizationId, customerId, JSON.stringify(cambios)]);
  });
}

export async function saveCustomerAddress(db: TenantDbSession, organizationId: string, customerId: string, addressId: string | null, changes: CustomerAddressChanges): Promise<string> {
  const cambios: Json = {};
  if (changes.address !== undefined) cambios.address = changes.address;
  if (changes.label !== undefined) cambios.label = changes.label;
  if (changes.accessNotes !== undefined) cambios.access_notes = changes.accessNotes;
  if (changes.mapsUrl !== undefined) cambios.maps_url = changes.mapsUrl;
  if (changes.colonia !== undefined) cambios.colonia = changes.colonia;
  if (changes.propertyId !== undefined) cambios.property_id = changes.propertyId;
  if (changes.isDefault !== undefined) cambios.is_default = changes.isDefault;
  return staffCall(db, "dir_guardar", async () => {
    const raw = (await callJson(db, `select restaurantes.cliente_direccion_guardar($1, $2, $3, $4::jsonb) as r;`, [organizationId, customerId, addressId, JSON.stringify(cambios)])) as Json | null;
    return String(raw?.id ?? "");
  });
}

export async function deleteCustomerAddress(db: TenantDbSession, organizationId: string, customerId: string, addressId: string): Promise<boolean> {
  return staffCall(db, "dir_borrar", async () => {
    const { rows } = await db.query<{ r: boolean }>(`select restaurantes.cliente_direccion_borrar($1, $2, $3) as r;`, [organizationId, customerId, addressId]);
    return rows[0]?.r === true;
  });
}

export async function applyCustomerPreferenceAction(
  db: TenantDbSession,
  organizationId: string,
  customerId: string,
  action: PreferenceAction,
  args: { readonly prefId?: string | null; readonly kind?: string | null; readonly value?: string | null },
): Promise<string> {
  return staffCall(db, "gusto", async () => {
    const raw = (await callJson(db, `select restaurantes.cliente_preferencia_accion($1, $2, $3, $4, $5, $6) as r;`, [
      organizationId,
      customerId,
      action,
      args.prefId ?? null,
      args.kind ?? null,
      args.value ?? null,
    ])) as Json | null;
    return String(raw?.id ?? "");
  });
}

export async function markOrderFake(db: TenantDbSession, organizationId: string, orderId: string, falso: boolean): Promise<boolean> {
  return staffCall(db, "falso", async () => {
    const { rows } = await db.query<{ r: boolean }>(`select restaurantes.cliente_marcar_pedido_falso($1, $2, $3) as r;`, [organizationId, orderId, falso]);
    return rows[0]?.r === true;
  });
}

export async function exportCustomerData(db: TenantDbSession, organizationId: string, customerId: string): Promise<Record<string, unknown> | null> {
  return staffCall(db, "exportar", async () => (await callJson(db, `select restaurantes.cliente_exportar_arco($1, $2) as r;`, [organizationId, customerId])) as Record<string, unknown> | null);
}

export async function deleteCustomerMemory(db: TenantDbSession, organizationId: string, customerId: string): Promise<{ readonly domiciliosBorrados: number; readonly gustosBorrados: number }> {
  return staffCall(db, "borrar", async () => {
    const raw = (await callJson(db, `select restaurantes.cliente_borrar_memoria($1, $2) as r;`, [organizationId, customerId])) as Json | null;
    return { domiciliosBorrados: num(raw?.domicilios_borrados), gustosBorrados: num(raw?.gustos_borrados) };
  });
}


/** Politica efectiva. Base sin migrar = valores por omision (la reincidencia no se evalua sin memoria de todos modos). */
export async function getCustomerPolicy(db: TenantDbSession, organizationId: string): Promise<CustomerPolicy> {
  return runWithSavepointFallback<CustomerPolicy>({
    session: db,
    savepointName: "sp_cliente360_politica",
    primary: async () => {
      const raw = (await callJson(db, `select restaurantes.cliente_politica_leer($1) as r;`, [organizationId])) as Json | null;
      return raw ? { umbralNoRecogidos: num(raw.umbral_no_recogidos, 2), ventanaDias: num(raw.ventana_dias, 90) } : POLITICA_POR_OMISION;
    },
    isRecoverable: esBaseSinMigrar044,
    fallback: async () => POLITICA_POR_OMISION,
  });
}

export async function saveCustomerPolicy(db: TenantDbSession, organizationId: string, policy: CustomerPolicy): Promise<CustomerPolicy> {
  return staffCall(db, "politica", async () => {
    const raw = (await callJson(db, `select restaurantes.cliente_politica_guardar($1, $2, $3) as r;`, [organizationId, policy.umbralNoRecogidos, policy.ventanaDias])) as Json | null;
    return { umbralNoRecogidos: num(raw?.umbral_no_recogidos, policy.umbralNoRecogidos), ventanaDias: num(raw?.ventana_dias, policy.ventanaDias) };
  });
}
