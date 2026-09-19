// Back office de plataforma — FACTURACIÓN de la suscripción SaaS propia de
// Atiende (lo que Atiende le cobra a cada organización cliente,
// `core.organization_billing`, ver `apps/api/src/routes/billing.ts` para el
// checkout/webhook real, y `packages/db/migrations/0013_superadmin_
// facturacion.sql` para las funciones de lectura agregada que este archivo
// consume). Archivo NUEVO a propósito -- mismo criterio que
// `superadmin-integraciones.ts`/`superadmin-llm-usage.ts`: cada concern de
// plataforma en su propio archivo, montado por separado en `app.ts`.
//
// Autorización real: las 3 funciones SQL que `deps.coreRepo` consume
// (`core.list_organization_billing_for_superadmin`/etc.) YA verifican
// `auth.uid() = p_caller_id` + `core.is_platform_superadmin(p_caller_id)` por
// dentro -- el middleware de aquí (`requireSuperadmin`, MISMO patrón que
// `superadmin.ts`/`superadmin-llm-usage.ts`) es defensa en profundidad (403
// explícito en vez de arreglos vacíos silenciosos), nunca la única autoridad
// real. El endpoint de checkout reutiliza `crearCheckoutDeOrganizacion`
// (`./billing.ts`) sin duplicar su lógica -- la autoridad real de ESE endpoint
// vive en `core.get_organization_billing_for_checkout`, que ya acepta un
// superadmin de plataforma además de owner/admin de la organización.
//
// MRR -- SOLO datos reales, nunca un precio inventado: `core.organization_
// billing.seats` es la cantidad real que Stripe reportó en el último evento de
// webhook aplicado (asientos CONTRATADOS); el precio por asiento sale de
// `@atiende/billing::SEAT_HOTELES`/`SEAT_RESTAURANTES`/`SEAT_CITAS_RESERVACIONES`
// (las MISMAS constantes que ya usa el motor de reglas real, `per-seat.ts`) --
// nunca un número escrito a mano para esta pantalla. Solo 3 de los 6 verticales
// tienen una constante `SEAT_*` declarada hoy (`rentas`/`licitaciones`/
// `despachos` no) -- para esos, el precio NO es conocible sin llamar a Stripe
// (el `price_id` guardado es un id opaco, su monto real vive solo en la cuenta
// de Stripe), así que el MRR de esa organización queda `null` ("no disponible
// sin precio configurado"), nunca `0` (que confundiría "no se sabe" con
// "no paga") ni un número inventado.
//
// Reconciliación de asientos -- SOLO LECTURA en este archivo (nunca escribe
// nada en Stripe): compara `seats` (contratado) contra
// `calcularPerSeat(config, staffCount).seatsFacturables` (lo que DEBERÍA
// facturarse según el staff real, mismo motor que produce el número real de
// Stripe cuando alguien sí corre el checkout) cuando el vertical tiene precio
// conocido; sin precio conocido, compara directo contra el headcount real
// (`staffCount`) y lo marca `precioConocido: false` para que el frontend no lo
// confunda con una comparación real contra el modelo per-seat.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { calcularPerSeat, SEAT_CITAS_RESERVACIONES, SEAT_HOTELES, SEAT_RESTAURANTES } from "@atiende/billing";
import type { SeatVerticalConfig } from "@atiende/billing";
import type { BillingWebhookLogFilters, BillingWebhookLogResult, SuperadminOrganizationBillingRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { crearCheckoutDeOrganizacion } from "./billing.ts";
import type { AppDeps } from "../deps.ts";

/** Vertical (`core.organization.vertical`) -> config per-seat conocida --
 *  SOLO las 3 que `packages/billing/src/per-seat.ts` ya declara (ver el
 *  comentario de cabecera de ese archivo: son las que ejercen sus propios
 *  tests). `rentas`/`licitaciones`/`despachos` deliberadamente ausentes --
 *  nunca se inventa un precio para ellos aquí. */
const SEAT_CONFIG_POR_VERTICAL: Readonly<Record<string, SeatVerticalConfig>> = {
  hoteles: SEAT_HOTELES,
  restaurantes: SEAT_RESTAURANTES,
  citas: SEAT_CITAS_RESERVACIONES,
};

const ESTADOS_VALIDOS = new Set(["sin_suscripcion", "activa", "pago_pendiente", "cancelada"]);
const DEFAULT_WEBHOOK_LIMIT = 20;
const MAX_WEBHOOK_LIMIT = 200;

// `core.billing_webhook_log.result` (`0018_billing_webhook_registro.sql`) --
// distinto de `ESTADOS_VALIDOS` de arriba (esos son `organization_billing.
// status`, esto es el resultado de UN intento de webhook).
const RESULTADOS_BITACORA_VALIDOS: ReadonlySet<BillingWebhookLogResult> = new Set(["procesado", "ignorado", "rechazado", "error"]);
const DEFAULT_BITACORA_LIMIT = 50;
const MAX_BITACORA_LIMIT = 200;

function parseFechaQuery(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (Number.isNaN(Date.parse(raw))) throw Errors.validation(`${field} debe ser una fecha ISO 8601 válida.`);
  return raw;
}

function unixToIso(unix: number | null): string | null {
  return unix === null ? null : new Date(unix * 1000).toISOString();
}

interface OrganizacionFacturacion {
  readonly organizationId: string;
  readonly vertical: string;
  readonly name: string;
  readonly slug: string;
  readonly orgStatus: string;
  readonly createdAt: string;
  readonly billingStatus: string;
  readonly seats: number;
  readonly staffCount: number;
  readonly priceId: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly ultimoEventoAplicadoAt: string | null;
  readonly precioConocido: boolean;
  readonly seatLabel: string | null;
  readonly precioPorSeatMxn: number | null;
  /** `null` cuando el vertical no tiene precio conocido -- nunca se calcula
   *  "lo que debería pagar" con un precio inventado. */
  readonly seatsFacturablesSegunReal: number | null;
  /** `seats` (contratado) menos la referencia real (`seatsFacturablesSegunReal`
   *  cuando el precio es conocido, `staffCount` si no) -- positivo = se está
   *  cobrando DE MÁS respecto al staff real; negativo = de menos. */
  readonly descuadreAsientos: number;
  /** `null` sin precio conocido, o cuando `billingStatus !== "activa"`
   *  (una organización sin suscripción activa no aporta MRR, sin importar
   *  cuántos seats haya tenido contratados alguna vez). */
  readonly mrrMxn: number | null;
}

function calcularFilaFacturacion(row: SuperadminOrganizationBillingRow): OrganizacionFacturacion {
  const config = SEAT_CONFIG_POR_VERTICAL[row.vertical];
  const precioConocido = config !== undefined;
  const seatsFacturablesSegunReal = config ? calcularPerSeat(config, row.staffCount).seatsFacturables : null;
  const referenciaReal = precioConocido ? (seatsFacturablesSegunReal ?? 0) : row.staffCount;
  const mrrMxn = precioConocido && row.billingStatus === "activa" ? Math.round((row.seats * config.precioPorSeatMxn + Number.EPSILON) * 100) / 100 : null;

  return {
    organizationId: row.organizationId,
    vertical: row.vertical,
    name: row.name,
    slug: row.slug,
    orgStatus: row.orgStatus,
    createdAt: row.createdAt,
    billingStatus: row.billingStatus,
    seats: row.seats,
    staffCount: row.staffCount,
    priceId: row.priceId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    currentPeriodEnd: row.currentPeriodEnd,
    ultimoEventoAplicadoAt: unixToIso(row.lastAppliedEventUnix),
    precioConocido,
    seatLabel: config?.seatLabel ?? null,
    precioPorSeatMxn: config?.precioPorSeatMxn ?? null,
    seatsFacturablesSegunReal,
    descuadreAsientos: row.seats - referenciaReal,
    mrrMxn,
  };
}

interface CheckoutBody {
  readonly priceId?: unknown;
  readonly seats?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw Errors.validation(`${field}: se esperaba un entero >= 1.`);
  }
  return value;
}

export function superadminFacturacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/facturacion/*", authMiddleware(deps.env));
  app.use("/superadmin/facturacion/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  app.get("/superadmin/facturacion/organizaciones", async (c) => {
    const rows = await deps.coreRepo.listOrganizationBillingForSuperadmin(c.get("userId"));
    const estadoFiltro = c.req.query("estado");
    if (estadoFiltro !== undefined && !ESTADOS_VALIDOS.has(estadoFiltro)) throw Errors.validation("estado inválido.");
    const organizaciones = rows.map(calcularFilaFacturacion).filter((o) => estadoFiltro === undefined || o.billingStatus === estadoFiltro);
    return c.json({ organizaciones });
  });

  app.get("/superadmin/facturacion/resumen", async (c) => {
    const callerId = c.get("userId");
    const [rows, totalEventosWebhook, eventosRecientes] = await Promise.all([
      deps.coreRepo.listOrganizationBillingForSuperadmin(callerId),
      deps.coreRepo.countBillingWebhookEventsForSuperadmin(callerId),
      deps.coreRepo.listRecentBillingWebhookEventsForSuperadmin(callerId, 1),
    ]);
    const organizaciones = rows.map(calcularFilaFacturacion);

    const conteoPorEstado = { sin_suscripcion: 0, activa: 0, pago_pendiente: 0, cancelada: 0 } as Record<string, number>;
    let mrrMxn = 0;
    let organizacionesActivasConPrecioDesconocido = 0;
    for (const o of organizaciones) {
      conteoPorEstado[o.billingStatus] = (conteoPorEstado[o.billingStatus] ?? 0) + 1;
      if (o.billingStatus === "activa") {
        if (o.mrrMxn !== null) mrrMxn += o.mrrMxn;
        else organizacionesActivasConPrecioDesconocido += 1;
      }
    }
    mrrMxn = Math.round((mrrMxn + Number.EPSILON) * 100) / 100;

    const proximasRenovaciones = organizaciones
      .filter((o) => o.billingStatus === "activa" && o.currentPeriodEnd !== null)
      .sort((a, b) => (a.currentPeriodEnd as string).localeCompare(b.currentPeriodEnd as string))
      .slice(0, 5);

    return c.json({
      totalOrganizaciones: organizaciones.length,
      conteoPorEstado,
      morosos: conteoPorEstado.pago_pendiente ?? 0,
      // `null` cuando NINGUNA organización activa tiene precio conocido (nunca se
      // reporta "$0 MXN de MRR" -- sería indistinguible de "sí se sabe y es cero").
      mrrMxn: (conteoPorEstado.activa ?? 0) > 0 && organizacionesActivasConPrecioDesconocido === conteoPorEstado.activa ? null : mrrMxn,
      organizacionesActivasConPrecioDesconocido,
      proximasRenovaciones,
      webhooks: {
        totalProcesados: totalEventosWebhook,
        ultimoProcesadoAt: eventosRecientes[0]?.processedAt ?? null,
      },
    });
  });

  app.get("/superadmin/facturacion/webhooks-recientes", async (c) => {
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_WEBHOOK_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) throw Errors.validation("limit debe ser un entero >= 1.");
      limit = Math.min(parsed, MAX_WEBHOOK_LIMIT);
    }
    const [eventos, total] = await Promise.all([
      deps.coreRepo.listRecentBillingWebhookEventsForSuperadmin(c.get("userId"), limit),
      deps.coreRepo.countBillingWebhookEventsForSuperadmin(c.get("userId")),
    ]);
    return c.json({ eventos, total });
  });

  // Bitácora COMPLETA de `POST /billing/webhook` (`0018_billing_webhook_
  // registro.sql`) -- a diferencia de `webhooks-recientes` de arriba (feed
  // ligero, solo eventos ya aplicados con éxito, sin organización/motivo),
  // esta incluye TODO intento (procesado/ignorado/rechazado/error), filtrable
  // por resultado/tipo/organización/rango de fechas, paginado.
  // `disponible: false` (nunca un 500) cuando la migración todavía no se
  // aplicó en este ambiente -- ver el comentario de cabecera de
  // `PostgresCoreRepository.listBillingWebhookLogForSuperadmin`.
  app.get("/superadmin/facturacion/webhooks-bitacora", async (c) => {
    const rawResult = c.req.query("result");
    if (rawResult !== undefined && !RESULTADOS_BITACORA_VALIDOS.has(rawResult as BillingWebhookLogResult)) {
      throw Errors.validation("result inválido.");
    }
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_BITACORA_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) throw Errors.validation("limit debe ser un entero >= 1.");
      limit = Math.min(parsed, MAX_BITACORA_LIMIT);
    }
    const rawOffset = c.req.query("offset");
    let offset = 0;
    if (rawOffset !== undefined) {
      const parsed = Number(rawOffset);
      if (!Number.isInteger(parsed) || parsed < 0) throw Errors.validation("offset debe ser un entero >= 0.");
      offset = parsed;
    }

    const filters: BillingWebhookLogFilters = {
      result: rawResult as BillingWebhookLogResult | undefined,
      eventType: c.req.query("eventType"),
      organizationId: c.req.query("organizationId"),
      desde: parseFechaQuery(c.req.query("desde"), "desde"),
      hasta: parseFechaQuery(c.req.query("hasta"), "hasta"),
      limit,
      offset,
    };

    const pagina = await deps.coreRepo.listBillingWebhookLogForSuperadmin(c.get("userId"), filters);
    return c.json(pagina);
  });

  // Acción acotada: SOLO genera el enlace de checkout (reutiliza
  // `crearCheckoutDeOrganizacion`, sin duplicar la llamada a Stripe) -- nunca
  // cobra, reembolsa ni cancela nada desde aquí.
  app.post("/superadmin/facturacion/organizaciones/:id/checkout", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as CheckoutBody;
    const priceId = requireString(raw.priceId, "priceId");
    const seats = requirePositiveInt(raw.seats, "seats");
    const { url } = await crearCheckoutDeOrganizacion(deps, c.get("userId"), c.req.param("id"), priceId, seats);
    return c.json({ url });
  });

  return app;
}
