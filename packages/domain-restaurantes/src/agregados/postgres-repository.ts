// Adaptador Postgres de los agregados (migracion 099). REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el codigo al instante y la
// 099 no se aplica sola. Toda llamada corre dentro de la transaccion UNICA del request/unidad (`withAppSession`): un error de Postgres la deja abortada
// (25P02), por eso cada operacion usa `runWithSavepointFallback` y degrada a «no disponible» ante 42P01 (tabla), 42703 (columna) y 42883 (funcion).
// Cualquier otro error se repropaga. Sin funciones SECURITY DEFINER: las policies de RLS (organizacion + alcance de sucursal) son la autoridad y esta capa
// agrega el mismo filtro de alcance como defensa en profundidad. Aceptar escribe la solicitud y el pedido en la MISMA transaccion (o ninguno).
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { OrderStatus, PersistedOrderItem } from "../types.ts";
import { fusionarRenglones } from "./fusion.ts";
import { AGREGADO_MAX_RENGLONES, ESTADOS_PEDIDO_AGREGABLES, pedidoAceptaAgregado } from "./tipos.ts";
import type {
  AgregadosRepository, AgregadoVista, DecisionAgregado, EstadoAgregado, EventoAgregado, EventoAgregadoEntrada, FiltroAgregados, LecturaAgregados, MotivoRechazoAgregado, NuevoAgregado,
  ResultadoCrearAgregado, ResultadoDecidirAgregado,
} from "./tipos.ts";

interface FilaVista {
  id: string;
  organization_id: string;
  property_id: string;
  order_id: string;
  status: EstadoAgregado;
  channel: "whatsapp" | "voice";
  items_added: PersistedOrderItem[];
  total_before: string | number;
  total_added: string | number;
  total_after: string | number;
  customer_note: string | null;
  version: number;
  requested_at: string | Date;
  first_seen_at: string | Date | null;
  decided_at: string | Date | null;
  decided_by: string | null;
  decided_by_name: string | null;
  reject_reason: MotivoRechazoAgregado | null;
  reject_note: string | null;
  escalation_level: 0 | 1 | 2;
  escalated_at: string | Date | null;
  order_number: string | number | null;
  order_status: OrderStatus;
  order_items: PersistedOrderItem[];
  order_total: string | number;
  order_created_at: string | Date;
  customer_name: string;
  customer_phone: string;
  sucursal: string | null;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOpc = (v: string | Date | null): string | null => (v === null ? null : iso(v));
const redondear = (n: number): number => Math.round(n * 100) / 100;

/** Une la solicitud con el pedido (nombre y telefono se leen del pedido; la solicitud no los copia). */
const SELECT_VISTA = `
  select a.id, a.organization_id, a.property_id, a.order_id, a.status, a.channel, a.items_added, a.total_before, a.total_added, a.total_after, a.customer_note,
         a.version, a.requested_at, a.first_seen_at, a.decided_at, a.decided_by, a.reject_reason, a.reject_note, a.escalation_level, a.escalated_at,
         (select su.full_name from core.staff_user su where su.id = a.decided_by) as decided_by_name,
         o.order_number, o.status as order_status, o.items as order_items, o.total as order_total, o.created_at as order_created_at,
         o.customer_name, o.customer_phone, o.branch as sucursal
  from restaurantes.order_amendments a
  join restaurantes.orders o on o.id = a.order_id and o.organization_id = a.organization_id`;

function aVista(r: FilaVista): AgregadoVista {
  return {
    id: r.id,
    organizationId: r.organization_id,
    propertyId: r.property_id,
    sucursal: r.sucursal,
    orderId: r.order_id,
    orderNumber: r.order_number === null ? null : Number(r.order_number),
    orderStatus: r.order_status,
    orderItems: r.order_items ?? [],
    orderTotal: Number(r.order_total),
    orderCreatedAt: iso(r.order_created_at),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    estado: r.status,
    channel: r.channel,
    itemsAdded: r.items_added ?? [],
    totalBefore: Number(r.total_before),
    totalAdded: Number(r.total_added),
    totalAfter: Number(r.total_after),
    customerNote: r.customer_note,
    version: r.version,
    requestedAt: iso(r.requested_at),
    firstSeenAt: isoOpc(r.first_seen_at),
    decidedAt: isoOpc(r.decided_at),
    decidedBy: r.decided_by,
    decidedByName: r.decided_by_name,
    rejectReason: r.reject_reason,
    rejectNote: r.reject_note,
    escalationLevel: r.escalation_level,
    escalatedAt: isoOpc(r.escalated_at),
  };
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresAgregadosRepository: las tablas de agregados todavia no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/099_agregados_pedido_por_validar.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

export class PostgresAgregadosRepository implements AgregadosRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async degradable<T>(nombre: string, noDisponible: T, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      savepointName: `sp_agregados_${nombre}`,
      primary: fn,
      isRecoverable: isMigrationPendingError,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return noDisponible;
      },
    });
  }

  private async leerUna(organizationId: string, id: string, propertyIds: readonly string[] | null): Promise<AgregadoVista | null> {
    const { rows } = await this.db.query<FilaVista>(`${SELECT_VISTA} where a.id = $1 and a.organization_id = $2 and ($3::uuid[] is null or a.property_id = any($3::uuid[]));`, [id, organizationId, propertyIds]);
    return rows[0] ? aVista(rows[0]) : null;
  }

  /** Relee una solicitud como SISTEMA (el sistema no ve `orders` por RLS): por la funcion solo-sistema, que devuelve la solicitud con los datos del pedido. */
  private async leerComoSistema(id: string): Promise<AgregadoVista> {
    const { rows } = await this.db.query<{ v: FilaVista | null }>("select restaurantes.agregado_leer_sistema($1) as v;", [id]);
    if (!rows[0]?.v) throw new Error("agregados: la solicitud no se pudo releer");
    return aVista(rows[0].v);
  }

  async crear(input: NuevoAgregado): Promise<ResultadoCrearAgregado> {
    if (input.items.length === 0 || input.items.length > AGREGADO_MAX_RENGLONES) throw new Error("renglones fuera de rango");
    return this.degradable<ResultadoCrearAgregado>("crear", { estado: "no_disponible" }, async () => {
      const sumar = redondear(input.items.reduce((s, i) => s + i.price * i.quantity, 0));
      const nota = input.customerNote ? input.customerNote.slice(0, 300) : null;
      // El sistema no ve `orders`: la validacion del pedido, el bloqueo y el alta ocurren en la funcion solo-sistema (migracion 099).
      const { rows } = await this.db.query<{ r: { estado: string; agregado?: FilaVista; orderStatus?: OrderStatus } }>(
        "select restaurantes.agregado_crear_sistema($1, $2, $3, $4, $5::jsonb, $6, $7, $8) as r;",
        [input.organizationId, input.propertyId, input.orderId, input.channel, JSON.stringify(input.items), sumar, nota, input.sourceEventId ?? null],
      );
      const r = rows[0]!.r;
      if (r.estado === "pedido_no_encontrado") return { estado: "pedido_no_encontrado" };
      if (r.estado === "pedido_no_agregable") return { estado: "pedido_no_agregable", orderStatus: r.orderStatus! };
      const vista = aVista(r.agregado!);
      if (r.estado === "repetido") return { estado: "repetido", agregado: vista };
      if (r.estado === "creado") {
        await this.registrarEvento({ amendmentId: vista.id, organizationId: input.organizationId, propertyId: input.propertyId, tipoEvento: "creado", actor: { tipo: "agente" }, detalle: { canal: input.channel, renglones: input.items.length, ...(input.sourceEventId ? { fuente: input.sourceEventId } : {}) } });
        return { estado: "creado", agregado: vista };
      }
      // Ya habia uno abierto: se FUSIONA (version + 1) y el cronometro (requested_at) NO se reinicia. El mismo evento no fusiona dos veces (huella en la bitacora).
      if (input.sourceEventId) {
        const visto = await this.db.query("select 1 from restaurantes.order_amendment_events where amendment_id = $1 and detail->>'fuente' = $2 limit 1;", [vista.id, input.sourceEventId]);
        if (visto.rows[0]) return { estado: "repetido", agregado: vista };
      }
      const items = fusionarRenglones(vista.itemsAdded, input.items);
      if (items.length > AGREGADO_MAX_RENGLONES) throw new Error("renglones fuera de rango");
      const totalAdded = redondear(vista.totalAdded + sumar);
      const notaFinal = [vista.customerNote, nota].filter(Boolean).join(" | ").slice(0, 300) || null;
      const upd = await this.db.query<{ id: string }>(
        `update restaurantes.order_amendments set items_added = $2::jsonb, total_added = $3, total_after = $4, customer_note = $5, version = version + 1
         where id = $1 and status = 'pendiente' returning id;`,
        [vista.id, JSON.stringify(items), totalAdded, redondear(vista.totalBefore + totalAdded), notaFinal],
      );
      // La unica ventana: la solicitud se resolvio entre la funcion y este UPDATE. Se reintenta como solicitud nueva (el pedido sigue siendo agregable o no).
      if (!upd.rows[0]) return this.crear({ ...input, sourceEventId: input.sourceEventId ?? null });
      await this.registrarEvento({ amendmentId: vista.id, organizationId: input.organizationId, propertyId: input.propertyId, tipoEvento: "fusionado", actor: { tipo: "agente" }, detalle: { renglonesNuevos: input.items.length, ...(input.sourceEventId ? { fuente: input.sourceEventId } : {}) } });
      return { estado: "fusionado", agregado: await this.leerComoSistema(vista.id) };
    });
  }

  async listar(organizationId: string, filtro: FiltroAgregados): Promise<LecturaAgregados<readonly AgregadoVista[]>> {
    return this.degradable<LecturaAgregados<readonly AgregadoVista[]>>("listar", { disponible: false, valor: [] }, async () => {
      const { rows } = await this.db.query<FilaVista>(
        `${SELECT_VISTA}
         where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
           and ($3::text[] is null or a.status = any($3::text[])) and ($4::timestamptz is null or a.requested_at >= $4::timestamptz)
         order by a.requested_at asc limit $5;`,
        [organizationId, filtro.propertyIds, filtro.estados ? [...filtro.estados] : null, filtro.desde ?? null, filtro.limite],
      );
      return { disponible: true, valor: rows.map(aVista) };
    });
  }

  async obtener(organizationId: string, id: string, propertyIds: readonly string[] | null): Promise<LecturaAgregados<AgregadoVista | null>> {
    return this.degradable<LecturaAgregados<AgregadoVista | null>>("obtener", { disponible: false, valor: null }, async () => ({ disponible: true, valor: await this.leerUna(organizationId, id, propertyIds) }));
  }

  async marcarVisto(organizationId: string, id: string, actorUserId: string, propertyIds: readonly string[] | null): Promise<void> {
    await this.degradable<void>("visto", undefined, async () => {
      const { rows } = await this.db.query<{ property_id: string }>(
        `update restaurantes.order_amendments set first_seen_at = now()
         where id = $1 and organization_id = $2 and status = 'pendiente' and first_seen_at is null and ($3::uuid[] is null or property_id = any($3::uuid[]))
         returning property_id;`,
        [id, organizationId, propertyIds],
      );
      if (rows[0]) await this.registrarEvento({ amendmentId: id, organizationId, propertyId: rows[0].property_id, tipoEvento: "visto", actor: { tipo: "usuario", userId: actorUserId } });
    });
  }

  async decidir(organizationId: string, id: string, decision: DecisionAgregado, actorUserId: string, propertyIds: readonly string[] | null): Promise<ResultadoDecidirAgregado> {
    return this.degradable<ResultadoDecidirAgregado>("decidir", { resultado: "no_disponible" }, async () => {
      const actual = await this.leerUna(organizationId, id, propertyIds);
      if (!actual) return { resultado: "no_encontrado" }; // inexistente, de otra organizacion o fuera de alcance: nunca se distingue
      if (actual.estado !== "pendiente") return { resultado: "ya_resuelto", agregado: actual };
      const actor = { tipo: "usuario", userId: actorUserId } as const;
      const releer = async (): Promise<AgregadoVista> => (await this.leerUna(organizationId, id, null))!;

      if (decision.tipo === "rechazar") {
        const { rows } = await this.db.query<{ id: string }>(
          `update restaurantes.order_amendments set status = 'rechazado', decided_at = now(), decided_by = $3, reject_reason = $4, reject_note = $5
           where id = $1 and organization_id = $2 and status = 'pendiente' returning id;`,
          [id, organizationId, actorUserId, decision.motivo, decision.nota ? decision.nota.slice(0, 300) : null],
        );
        if (!rows[0]) return { resultado: "ya_resuelto", agregado: await releer() };
        await this.registrarEvento({ amendmentId: id, organizationId, propertyId: actual.propertyId, tipoEvento: "rechazado", actor, detalle: { motivo: decision.motivo } });
        return { resultado: "aplicado", agregado: await releer() };
      }

      // Aceptar: el pedido se bloquea PRIMERO (mismo orden que la creacion) para decidir con su estado real.
      const pedido = await this.db.query<{ status: OrderStatus }>("select status from restaurantes.orders where id = $1 and organization_id = $2 for update;", [actual.orderId, organizationId]);
      if (!pedido.rows[0] || !pedidoAceptaAgregado(pedido.rows[0].status)) {
        const { rows } = await this.db.query<{ id: string }>(
          "update restaurantes.order_amendments set status = 'no_aplicable', decided_at = now(), decided_by = $3 where id = $1 and organization_id = $2 and status = 'pendiente' returning id;",
          [id, organizationId, actorUserId],
        );
        if (!rows[0]) return { resultado: "ya_resuelto", agregado: await releer() };
        await this.registrarEvento({ amendmentId: id, organizationId, propertyId: actual.propertyId, tipoEvento: "no_aplicable", actor, detalle: { estadoPedido: pedido.rows[0]?.status ?? null } });
        return { resultado: "no_aplicable", agregado: await releer() };
      }
      const { rows } = await this.db.query<{ id: string }>(
        "update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = $3 where id = $1 and organization_id = $2 and status = 'pendiente' returning id;",
        [id, organizationId, actorUserId],
      );
      if (!rows[0]) return { resultado: "ya_resuelto", agregado: await releer() };
      const aplicado = await this.db.query<{ id: string }>(
        `update restaurantes.orders set items = coalesce(items, '[]'::jsonb) || $3::jsonb, total = total + $4
         where id = $1 and organization_id = $2 and status = any($5::text[]) returning id;`,
        [actual.orderId, organizationId, JSON.stringify(actual.itemsAdded), actual.totalAdded, [...ESTADOS_PEDIDO_AGREGABLES]],
      );
      // El pedido esta bloqueado y su estado se verifico arriba: no aplicar es una inconsistencia; el error revierte TODA la transaccion (solicitud incluida).
      if (!aplicado.rows[0]) throw new Error("agregados: no se pudo aplicar el agregado al pedido (se revierte la aceptacion)");
      await this.registrarEvento({ amendmentId: id, organizationId, propertyId: actual.propertyId, tipoEvento: "aceptado", actor, detalle: { totalAgregado: actual.totalAdded, version: actual.version } });
      return { resultado: "aplicado", agregado: await releer() };
    });
  }

  async cancelarPorCliente(organizationId: string, orderId: string): Promise<LecturaAgregados<AgregadoVista | null>> {
    return this.degradable<LecturaAgregados<AgregadoVista | null>>("cancelar_cliente", { disponible: false, valor: null }, async () => {
      const { rows } = await this.db.query<{ id: string; property_id: string }>(
        "update restaurantes.order_amendments set status = 'cancelado_por_cliente', decided_at = now() where organization_id = $1 and order_id = $2 and status = 'pendiente' returning id, property_id;",
        [organizationId, orderId],
      );
      const fila = rows[0];
      if (!fila) return { disponible: true, valor: null };
      await this.registrarEvento({ amendmentId: fila.id, organizationId, propertyId: fila.property_id, tipoEvento: "cancelado_por_cliente", actor: { tipo: "agente" } });
      return { disponible: true, valor: await this.leerComoSistema(fila.id) };
    });
  }

  async pendientesAntesDe(antesDeIso: string, limite: number): Promise<LecturaAgregados<readonly AgregadoVista[]>> {
    return this.degradable<LecturaAgregados<readonly AgregadoVista[]>>("pendientes_antes", { disponible: false, valor: [] }, async () => {
      // El barrido corre como sistema (no ve `orders`): la funcion solo-sistema trae las pendientes con los datos del pedido.
      const { rows } = await this.db.query<{ v: FilaVista[] }>("select restaurantes.agregados_barrido_sistema($1::timestamptz, $2::integer) as v;", [antesDeIso, limite]);
      return { disponible: true, valor: (rows[0]?.v ?? []).map(aVista) };
    });
  }

  async escalarNivel1(organizationId: string, id: string, ahora: Date): Promise<boolean> {
    return this.degradable<boolean>("escalar", false, async () => {
      const { rows } = await this.db.query<{ property_id: string }>(
        "update restaurantes.order_amendments set escalation_level = 1, escalated_at = $3 where id = $1 and organization_id = $2 and status = 'pendiente' and escalation_level = 0 returning property_id;",
        [id, organizationId, ahora.toISOString()],
      );
      if (!rows[0]) return false;
      await this.registrarEvento({ amendmentId: id, organizationId, propertyId: rows[0].property_id, tipoEvento: "sin_respuesta_10min", actor: { tipo: "sistema" } });
      return true;
    });
  }

  async vencer(organizationId: string, id: string, ahora: Date): Promise<boolean> {
    return this.degradable<boolean>("vencer", false, async () => {
      const { rows } = await this.db.query<{ property_id: string }>(
        "update restaurantes.order_amendments set status = 'vencido', escalation_level = 2, escalated_at = $3, decided_at = $3 where id = $1 and organization_id = $2 and status = 'pendiente' returning property_id;",
        [id, organizationId, ahora.toISOString()],
      );
      if (!rows[0]) return false;
      await this.registrarEvento({ amendmentId: id, organizationId, propertyId: rows[0].property_id, tipoEvento: "vencido", actor: { tipo: "sistema" } });
      return true;
    });
  }

  async registrarEvento(e: EventoAgregadoEntrada): Promise<void> {
    await this.degradable<void>("evento", undefined, async () => {
      await this.db.query(
        `insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, actor_user_id, detail)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb);`,
        [e.amendmentId, e.organizationId, e.propertyId, e.tipoEvento, e.actor.tipo, e.actor.tipo === "usuario" ? e.actor.userId : null, JSON.stringify(e.detalle ?? {})],
      );
    });
  }

  async listarEventos(organizationId: string, id: string, propertyIds: readonly string[] | null) {
    type Salida = LecturaAgregados<readonly { readonly evento: EventoAgregado; readonly actor: string; readonly at: string; readonly detalle: Readonly<Record<string, unknown>> }[]>;
    return this.degradable<Salida>("eventos", { disponible: false, valor: [] }, async () => {
      const { rows } = await this.db.query<{ event_type: EventoAgregado; actor_kind: string; created_at: string | Date; detail: Record<string, unknown> }>(
        `select event_type, actor_kind, created_at, detail from restaurantes.order_amendment_events
         where amendment_id = $1 and organization_id = $2 and ($3::uuid[] is null or property_id = any($3::uuid[])) order by created_at asc, id asc;`,
        [id, organizationId, propertyIds],
      );
      return { disponible: true, valor: rows.map((r) => ({ evento: r.event_type, actor: r.actor_kind, at: iso(r.created_at), detalle: r.detail ?? {} })) };
    });
  }
}
