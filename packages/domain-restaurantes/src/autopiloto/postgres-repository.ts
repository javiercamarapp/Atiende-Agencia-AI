// Adaptador Postgres del autopiloto (migracion 050). REGLA DURA de compatibilidad con la base SIN migrar: mergear despliega el codigo al
// instante y la 050 no se aplica sola. Toda llamada corre dentro de la transaccion UNICA del request/unidad (`withAppSession`): un error de
// Postgres la deja abortada (25P02), por eso cada operacion usa `runWithSavepointFallback` y degrada a "no disponible" ante 42883 (funcion),
// 42P01 (tabla) y 42703 (columna). 42501 (sin acceso) y 22023 (regla de negocio) se traducen a errores tipados; cualquier otro error se repropaga.
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { CanalPedido, OrderStatus } from "../types.ts";
import { AutopilotoAccesoError, AutopilotoValidacionError, AUTOPILOTO_CONFIG_POR_OMISION } from "./tipos.ts";
import type {
  AgotadoRepuesto, AutopilotoConfig, AutopilotoOrgConfig, AutopilotoRepository, CandidatoEstado, ComandaParaAvance, EventoEstadoPedido, FiltroSolicitudes, HandoffDevuelto, Lectura,
  MuestrasTiempo, OpcionesResolver, ResultadoCancelarCliente, ResultadoCrearSolicitud, ResultadoResolver, ResultadoRetener, SolicitudDecision, SolicitudPorEscalar,
  SolicitudTipo, SolicitudVista,
} from "./tipos.ts";

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresAutopilotoRepository: las tablas/funciones del autopiloto todavia no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/050_autopiloto_aprobaciones_y_estados.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

/** Traduce los errores de regla de la base a errores tipados que la ruta HTTP convierte en 403/422. */
function traducir(err: unknown): never {
  const c = codigo(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (c === "42501") throw new AutopilotoAccesoError(msg);
  if (c === "22023") throw new AutopilotoValidacionError(msg);
  throw err;
}

const num = (v: unknown): number => Number(v);
const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

export class PostgresAutopilotoRepository implements AutopilotoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async lectura<T>(nombre: string, vacio: T, fn: () => Promise<T>): Promise<Lectura<T>> {
    return runWithSavepointFallback<Lectura<T>>({
      session: this.db,
      savepointName: `sp_autopiloto_${nombre}`,
      primary: async () => ({ disponible: true, valor: await fn() }),
      isRecoverable: isMigrationPendingError,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: vacio };
      },
    });
  }

  async leerConfig(organizationId: string, propertyId: string): Promise<Lectura<AutopilotoConfig>> {
    return this.lectura("config_leer", AUTOPILOTO_CONFIG_POR_OMISION, async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select * from restaurantes.autopiloto_config_leer($1::uuid, $2::uuid);", [organizationId, propertyId]).catch(traducir);
      const r = rows[0];
      if (!r) return AUTOPILOTO_CONFIG_POR_OMISION;
      return {
        cancelacionAuto: r.cancelacion_auto === true,
        aceptacionAuto: r.aceptacion_auto === true,
        aprobacionMinutos: num(r.aprobacion_minutos),
        handoffRegresoMinutos: num(r.handoff_regreso_minutos),
        noRecogidoMinutos: num(r.no_recogido_minutos),
        completadoHoras: num(r.completado_horas),
        compensacionTopePct: num(r.compensacion_tope_pct),
        saturacionUmbral1: r.saturacion_umbral_1 === null ? null : num(r.saturacion_umbral_1),
        saturacionUmbral2: r.saturacion_umbral_2 === null ? null : num(r.saturacion_umbral_2),
        saturacionExtraMinutos: num(r.saturacion_extra_minutos),
        configurada: r.configurada === true,
      };
    });
  }

  async guardarConfig(organizationId: string, propertyId: string, c: Omit<AutopilotoConfig, "configurada">): Promise<{ readonly disponible: boolean }> {
    const r = await this.lectura("config_guardar", false, async () => {
      await this.db
        .query(
          "select restaurantes.autopiloto_config_guardar($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);",
          [organizationId, propertyId, c.cancelacionAuto, c.aceptacionAuto, c.aprobacionMinutos, c.handoffRegresoMinutos, c.noRecogidoMinutos, c.completadoHoras, c.compensacionTopePct, c.saturacionUmbral1, c.saturacionUmbral2, c.saturacionExtraMinutos],
        )
        .catch(traducir);
      return true;
    });
    return { disponible: r.disponible };
  }

  async leerConfigOrg(organizationId: string): Promise<Lectura<AutopilotoOrgConfig>> {
    return this.lectura<AutopilotoOrgConfig>("config_org_leer", { cancelacionAgente: false }, async () => {
      const { rows } = await this.db.query<{ v: boolean | null }>("select restaurantes.autopiloto_org_config_leer($1::uuid) as v;", [organizationId]).catch(traducir);
      return { cancelacionAgente: rows[0]?.v === true };
    });
  }

  async guardarConfigOrg(organizationId: string, config: AutopilotoOrgConfig): Promise<{ readonly disponible: boolean }> {
    const r = await this.lectura("config_org_guardar", false, async () => {
      await this.db.query("select restaurantes.autopiloto_org_config_guardar($1::uuid, $2);", [organizationId, config.cancelacionAgente]).catch(traducir);
      return true;
    });
    return { disponible: r.disponible };
  }

  async retenerPedidoGrande(organizationId: string, orderId: string, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoRetener> {
    const r = await this.lectura<ResultadoRetener>("retener", { estado: "no_disponible", solicitudId: null, propertyId: null }, async () => {
      const { rows } = await this.db
        .query<{ id: string; creada: boolean; property_id: string }>("select id, creada, property_id from restaurantes.solicitud_pedido_grande_retener($1::uuid, $2::uuid, $3::jsonb);", [organizationId, orderId, JSON.stringify(detalle)])
        .catch(traducir);
      const f = rows[0];
      if (!f) return { estado: "no_disponible", solicitudId: null, propertyId: null };
      return { estado: f.creada ? "creada" : "existente", solicitudId: f.id, propertyId: f.property_id };
    });
    return r.valor;
  }

  async crearSolicitud(organizationId: string, propertyId: string, tipo: Exclude<SolicitudTipo, "pedido_grande">, orderId: string | null, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoCrearSolicitud> {
    const r = await this.lectura<ResultadoCrearSolicitud>("crear", { estado: "no_disponible", solicitudId: null }, async () => {
      const { rows } = await this.db
        .query<{ id: string; creada: boolean }>("select id, creada from restaurantes.solicitud_crear($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb);", [organizationId, propertyId, tipo, orderId, JSON.stringify(detalle)])
        .catch(traducir);
      const f = rows[0];
      if (!f) return { estado: "no_disponible", solicitudId: null };
      return { estado: f.creada ? "creada" : "existente", solicitudId: f.id };
    });
    return r.valor;
  }

  async listarSolicitudes(organizationId: string, filtro: FiltroSolicitudes): Promise<Lectura<readonly SolicitudVista[]>> {
    return this.lectura<readonly SolicitudVista[]>("listar", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>(
        `select s.id, s.organization_id, s.property_id, s.tipo, s.estado, s.order_id, s.detalle, s.decision, s.motivo_resolucion, s.codigo_descuento,
                s.solicitada_at, s.escalada_at, s.resuelta_at,
                o.order_number, o.total, o.status as order_status, o.customer_name, o.canal, o.items
           from restaurantes.solicitud_aprobacion s
           left join restaurantes.orders o on o.id = s.order_id and o.organization_id = s.organization_id
          where s.organization_id = $1 and s.estado = $2 and ($3::uuid[] is null or s.property_id = any ($3::uuid[]))
          order by s.solicitada_at ${filtro.estado === "pendiente" ? "asc" : "desc"}
          limit $4;`,
        [organizationId, filtro.estado, filtro.propertyIds === null ? null : [...filtro.propertyIds], Math.min(Math.max(filtro.limite, 1), 200)],
      );
      return rows.map((r): SolicitudVista => {
        const items = Array.isArray(r.items) ? (r.items as { name?: unknown; quantity?: unknown }[]) : [];
        return {
          id: String(r.id),
          organizationId: String(r.organization_id),
          propertyId: String(r.property_id),
          tipo: r.tipo as SolicitudTipo,
          estado: r.estado as "pendiente" | "resuelta",
          orderId: r.order_id === null ? null : String(r.order_id),
          detalle: (typeof r.detalle === "string" ? JSON.parse(r.detalle) : r.detalle) as Record<string, unknown>,
          decision: (r.decision as SolicitudDecision | null) ?? null,
          motivoResolucion: (r.motivo_resolucion as string | null) ?? null,
          codigoDescuento: (r.codigo_descuento as string | null) ?? null,
          solicitadaAt: iso(r.solicitada_at as string | Date),
          escaladaAt: r.escalada_at === null ? null : iso(r.escalada_at as string | Date),
          resueltaAt: r.resuelta_at === null ? null : iso(r.resuelta_at as string | Date),
          pedido:
            r.order_id === null || r.total === null
              ? null
              : {
                  numero: r.order_number === null ? null : num(r.order_number),
                  total: num(r.total),
                  status: r.order_status as OrderStatus,
                  clienteNombre: String(r.customer_name ?? ""),
                  canal: (r.canal as CanalPedido | null) ?? null,
                  renglones: items.map((it, indice) => ({ indice, nombre: String(it.name ?? ""), cantidad: num(it.quantity ?? 1) })),
                },
        };
      });
    });
  }

  async resolverSolicitud(organizationId: string, solicitudId: string, decision: SolicitudDecision, opciones: OpcionesResolver): Promise<ResultadoResolver | null> {
    const r = await this.lectura<ResultadoResolver | null>("resolver", null, async () => {
      const { rows } = await this.db
        .query<Record<string, unknown>>("select * from restaurantes.solicitud_resolver($1::uuid, $2::uuid, $3, $4, $5, $6::int[]);", [
          organizationId, solicitudId, decision, opciones.motivo ?? null, opciones.valor ?? null, opciones.indices ? [...opciones.indices] : null,
        ])
        .catch(traducir);
      const f = rows[0];
      if (!f) return null;
      return {
        aplicado: f.aplicado === true,
        tipo: f.tipo as SolicitudTipo,
        decision: (f.decision as SolicitudDecision | null) ?? null,
        orderId: f.order_id === null ? null : String(f.order_id),
        propertyId: String(f.property_id),
        estadoPedido: (f.estado_pedido as OrderStatus | null) ?? null,
        codigoDescuento: (f.codigo_descuento as string | null) ?? null,
        reposicionOrderId: f.reposicion_order_id === null ? null : String(f.reposicion_order_id),
      };
    });
    return r.valor;
  }

  async solicitudesPorEscalar(ahora: Date, limite: number): Promise<Lectura<readonly SolicitudPorEscalar[]>> {
    return this.lectura<readonly SolicitudPorEscalar[]>("escalar", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select id, organization_id, property_id, tipo, order_id, minutos from restaurantes.solicitudes_por_escalar($1::timestamptz, $2);", [ahora.toISOString(), limite]);
      return rows.map((r) => ({ id: String(r.id), organizationId: String(r.organization_id), propertyId: String(r.property_id), tipo: r.tipo as SolicitudTipo, orderId: r.order_id === null ? null : String(r.order_id), minutos: num(r.minutos) }));
    });
  }

  async candidatosEstados(ahora: Date, limite: number): Promise<Lectura<readonly CandidatoEstado[]>> {
    return this.lectura<readonly CandidatoEstado[]>("candidatos", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select order_id, organization_id, property_id, from_status, to_status, motivo from restaurantes.autopiloto_candidatos_estados($1::timestamptz, $2);", [ahora.toISOString(), limite]);
      return rows.map((r) => ({ orderId: String(r.order_id), organizationId: String(r.organization_id), propertyId: String(r.property_id), desde: r.from_status as OrderStatus, hacia: r.to_status as OrderStatus, motivo: String(r.motivo) }));
    });
  }

  async aplicarTransicion(organizationId: string, orderId: string, desde: OrderStatus, hacia: OrderStatus, actor: "agente" | "pos" | "sistema", motivo: string): Promise<boolean> {
    const r = await this.lectura("aplicar", false, async () => {
      const { rows } = await this.db
        .query<{ ok: boolean }>("select restaurantes.autopiloto_aplicar_transicion($1::uuid, $2::uuid, $3, $4, $5, $6) as ok;", [organizationId, orderId, desde, hacia, actor, motivo])
        .catch(traducir);
      return rows[0]?.ok === true;
    });
    return r.valor;
  }

  async comandasParaAvance(limite: number): Promise<Lectura<readonly ComandaParaAvance[]>> {
    return this.lectura<readonly ComandaParaAvance[]>("comandas", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select order_id, organization_id, property_id, folio, status, canal from restaurantes.autopiloto_comandas_para_avance($1);", [limite]);
      return rows.map((r) => ({ orderId: String(r.order_id), organizationId: String(r.organization_id), propertyId: String(r.property_id), folio: String(r.folio), status: r.status as OrderStatus, canal: (r.canal as CanalPedido | null) ?? null }));
    });
  }

  async devolverHandoffsVencidos(ahora: Date, limite: number): Promise<Lectura<readonly HandoffDevuelto[]>> {
    return this.lectura<readonly HandoffDevuelto[]>("handoffs", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select handoff_id, organization_id, property_id, conversation_id, minutos, avisado from restaurantes.handoffs_devolver_vencidos($1::timestamptz, $2);", [ahora.toISOString(), limite]);
      return rows.map((r) => ({ handoffId: String(r.handoff_id), organizationId: String(r.organization_id), propertyId: String(r.property_id), conversationId: String(r.conversation_id), minutos: num(r.minutos), avisado: r.avisado === true }));
    });
  }

  async cancelarPorCliente(organizationId: string, orderId: string, motivo: string): Promise<ResultadoCancelarCliente> {
    const r = await this.lectura<ResultadoCancelarCliente>("cancelar_cliente", null, async () => {
      const { rows } = await this.db.query<{ aplicado: boolean; estado: string }>("select aplicado, estado from restaurantes.pedido_cancelar_cliente($1::uuid, $2::uuid, $3);", [organizationId, orderId, motivo]).catch(traducir);
      const f = rows[0];
      return f ? { aplicado: f.aplicado === true, estado: f.estado } : null;
    });
    return r.valor;
  }

  async marcarAgotado(organizationId: string, propertyId: string, productId: string, hasta: string): Promise<{ readonly disponible: boolean; readonly aplicado: boolean }> {
    const r = await this.lectura("agotado_marcar", false, async () => {
      const { rows } = await this.db.query<{ ok: boolean }>("select restaurantes.agotado_marcar($1::uuid, $2::uuid, $3::uuid, $4::date) as ok;", [organizationId, propertyId, productId, hasta]).catch(traducir);
      return rows[0]?.ok === true;
    });
    return { disponible: r.disponible, aplicado: r.valor };
  }

  async reponerAgotados(ahora: Date): Promise<Lectura<readonly AgotadoRepuesto[]>> {
    return this.lectura<readonly AgotadoRepuesto[]>("agotados_reponer", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>("select property_id, product_id, organization_id, to_char(agotado_hasta, 'YYYY-MM-DD') as agotado_hasta from restaurantes.agotados_reponer($1::timestamptz);", [ahora.toISOString()]);
      return rows.map((r) => ({ organizationId: String(r.organization_id), propertyId: String(r.property_id), productId: String(r.product_id), agotadoHasta: String(r.agotado_hasta) }));
    });
  }

  async muestrasTiempo(organizationId: string, propertyId: string, canal: CanalPedido, ahora: Date): Promise<Lectura<MuestrasTiempo>> {
    return this.lectura<MuestrasTiempo>("muestras", { muestras: [], abiertos: 0 }, async () => {
      const { rows } = await this.db
        .query<{ r: unknown }>("select restaurantes.tiempo_entrega_muestras($1::uuid, $2::uuid, $3, $4::timestamptz, 30) as r;", [organizationId, propertyId, canal, ahora.toISOString()])
        .catch(traducir);
      const raw = rows[0]?.r;
      const j = (typeof raw === "string" ? JSON.parse(raw) : raw) as { muestras?: unknown[]; abiertos?: unknown } | null;
      return { muestras: (j?.muestras ?? []).map(Number).filter(Number.isFinite), abiertos: num(j?.abiertos ?? 0) };
    });
  }

  async historialEstados(organizationId: string, orderId: string): Promise<Lectura<readonly EventoEstadoPedido[]>> {
    return this.lectura<readonly EventoEstadoPedido[]>("historial", [], async () => {
      const { rows } = await this.db.query<Record<string, unknown>>(
        "select from_status, to_status, actor, motivo, at from restaurantes.order_status_events where organization_id = $1 and order_id = $2 order by at asc, id asc limit 200;",
        [organizationId, orderId],
      );
      return rows.map((r) => ({ desde: (r.from_status as OrderStatus | null) ?? null, hacia: r.to_status as OrderStatus, actor: String(r.actor), motivo: (r.motivo as string | null) ?? null, at: iso(r.at as string | Date) }));
    });
  }
}
