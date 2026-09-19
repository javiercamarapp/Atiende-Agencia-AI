// Suscripción SaaS PROPIA de Atiende a sus organizaciones clientes (auditoría de
// 22 rubros, hallazgo P1 #6, primera mitad: "checkout+webhook de Stripe para la
// suscripción SaaS propia de Atiende — implementado y probado, solo falta la
// ruta"). `@atiende/billing` (tenant-verification.ts, ledger.ts, per-seat.ts,
// rails/stripe-rail.ts) ya tenía las reglas de negocio probadas end-to-end
// (`packages/billing/tests/webhook-integration.spec.ts`) pero NINGÚN puerto
// HTTP real las exponía — este archivo es esa ruta.
//
// Vive en `apps/api/src/routes/` (no dentro de `routes/verticals/<x>/`) por el
// mismo motivo que `superadmin.ts`/`notifications.ts`: es infraestructura de
// PLATAFORMA, cruzada a las 6 verticales, nunca de un solo vertical.
//
// Distinto de `routes/verticals/hoteles/cfdi.ts` (timbrado fiscal) y del riel de
// cobro al HUÉSPED de `hoteles-payments-port.ts` -- esto es la suscripción que
// Atiende le cobra a la ORGANIZACIÓN cliente por usar la plataforma.
//
// Patrón "sin credenciales reales -> 503 honesto" idéntico al ya usado en
// `routes/verticals/hoteles/cfdi.ts` (PAC sin CSD configurado): nunca se simula
// una URL de checkout ni se procesa un webhook sin poder verificar su firma.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import {
  aplicarConLedger,
  crearCheckoutPerSeat,
  verificarFirmaWebhookStripe,
  verificarTenantDelWebhook,
  type CustomerLookup,
  type EventoWebhook,
  type LedgerStore,
  type TenantLookup,
} from "@atiende/billing";
import { OrganizationBillingAccessDeniedError, OrganizationNotFoundError, type OrganizationBillingRow, type RecordBillingWebhookEventInput } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, readTextCapped, requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hallazgo de revisores (ronda r5): POST /billing/webhook (Stripe) no tenía
// NINGÚN rate-limit -- a diferencia del resto de webhooks entrantes de este
// monorepo (CFDI del PAC, WhatsApp de Meta), que lo evalúan DESPUÉS de
// verificar la firma, aquí se evalúa ANTES: una ráfaga no autenticada contra
// este endpoint no debe gastar CPU verificando firmas HMAC ni leyendo el
// cuerpo completo del request antes de que el límite la corte. Categoría
// 'conversation:inbound-webhook' (ver packages/core-ratelimit/src/
// endpoint-policy.ts): fail-OPEN si Upstash no está configurado o el intento
// falla a media petición -- documentado a propósito, mismo criterio que el
// resto de webhooks de proveedor externo ya catalogados ahí: tirar un webhook
// LEGÍTIMO de Stripe (que reintenta un número limitado de veces con backoff)
// es peor que dejarlo pasar degradado al backend en memoria de ESTA instancia
// (nunca sin ningún tope). 120 req/60s por IP -- mismo límite que el resto de
// webhooks entrantes ya catalogados (WhatsApp de Meta, PAC de CFDI), holgado
// para las ráfagas reales de Stripe (varios eventos casi simultáneos tras una
// sola acción del cliente: checkout.session.completed + subscription.created
// + invoice.* suelen llegar juntos). Ante negativa, 429 con Retry-After
// (`Errors.tooManyRequests`) -- nunca 200 silencioso ni 5xx: Stripe reintenta
// solo ante 429/5xx, nunca ante 2xx.
const STRIPE_WEBHOOK_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

/** `organizationId`/`tenantIdDelPayload` puede venir de metadata que el propio
 *  caller del checkout escribió (ver `tenant-verification.ts`) -- nunca se
 *  asume que es un UUID válido antes de pasarlo a `core.record_billing_
 *  webhook_event` (`p_organization_id uuid`): un valor no-UUID haría fallar
 *  el cast en Postgres. `null` cuando no lo es -- la bitácora simplemente
 *  queda sin organización resuelta para esa fila, nunca lanza. */
function organizationIdCandidate(value: string | null): string | null {
  return value !== null && UUID_RE.test(value) ? value : null;
}

/** Best-effort por diseño (ver el comentario de cabecera de `packages/db/
 *  migrations/0018_billing_webhook_registro.sql` y de `CoreRepository.
 *  recordBillingWebhookEvent`): `deps.coreRepo.recordBillingWebhookEvent` YA
 *  nunca lanza (atrapa todo internamente, incluida la migración sin aplicar
 *  todavía -- SQLSTATE 42883) -- este `try/catch` es una segunda red, no la
 *  primera. La escritura de la bitácora JAMÁS debe cambiar la respuesta real
 *  del webhook: un proveedor de pagos reintenta según el código HTTP que
 *  `POST /billing/webhook` responda, y esa respuesta tiene que seguir
 *  reflejando SOLO el resultado real de procesar el evento. */
async function registrarWebhook(deps: AppDeps, input: RecordBillingWebhookEventInput): Promise<void> {
  try {
    await deps.coreRepo.recordBillingWebhookEvent(input);
  } catch (err) {
    console.error("POST /billing/webhook: registrarWebhook (best-effort) falló:", err);
  }
}

/** Extrae `id`/`type` de un payload que NI SIQUIERA tiene la forma mínima que
 *  `normalizeStripeEvent` exige (devolvió `null`) -- solo para que la bitácora
 *  de un evento "no reconocido" no quede totalmente vacía cuando esos 2
 *  campos SÍ vinieron como texto plano, aunque el resto de la forma no sirva.
 *  Nunca lanza, nunca expone nada del resto del payload. */
function looseStringField(payload: unknown, field: "id" | "type"): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

const MAX_CHECKOUT_BODY_BYTES = 2 * 1024;
// Stripe puede mandar payloads grandes en eventos con muchos line items/mucha
// metadata -- 256KB es el mismo límite que ya usa `restaurantesWhatsAppRoutes`
// para el webhook de Meta (otro proveedor externo, mismo criterio de "límite
// generoso pero explícito", nunca sin límite).
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

interface CheckoutBody {
  readonly organizationId?: unknown;
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

// Eventos que este handler de verdad interpreta -- cualquier otro tipo se
// contesta con ack 200 sin tocar el ledger/persistir nada (Stripe solo necesita
// un 2xx para dejar de reintentar; procesar un tipo que no conocemos no es un
// error, es simplemente ruido que no nos interesa).
const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * Normaliza el JSON crudo de un evento de Stripe a `EventoWebhook` -- `null` si
 * la forma no es la que un evento real de Stripe tiene (nunca lanza: una forma
 * inesperada se trata como "no procesable", ack 200, no un 500).
 */
function normalizeStripeEvent(raw: unknown): EventoWebhook | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.type !== "string" || typeof obj.created !== "number") return null;

  const data = obj.data;
  if (typeof data !== "object" || data === null) return null;
  const dataObject = (data as Record<string, unknown>).object;
  if (typeof dataObject !== "object" || dataObject === null) return null;
  const record = dataObject as Record<string, unknown>;

  const customerId = record.customer;
  if (typeof customerId !== "string") return null;

  const metadata = record.metadata;
  const tenantIdDelPayload =
    metadata && typeof metadata === "object" && typeof (metadata as Record<string, unknown>).tenant_id === "string"
      ? ((metadata as Record<string, unknown>).tenant_id as string)
      : null;

  return { id: obj.id, tipo: obj.type, creadoUnix: obj.created, tenantIdDelPayload, proveedorCustomerId: customerId, datos: record };
}

/** Estados reales de una `Subscription` de Stripe -> el enum interno de
 *  `core.organization_billing.status` (ver la migración). Un status
 *  desconocido/futuro de Stripe se trata como `pago_pendiente` (nunca `activa`
 *  a ciegas -- fail-closed: mejor mostrarle al owner "revisa tu pago" que
 *  dejarlo creyendo que su suscripción sigue activa cuando Stripe reporta algo
 *  que este código todavía no entiende). */
function mapStripeSubscriptionStatus(status: unknown): OrganizationBillingRow["status"] {
  switch (status) {
    case "active":
    case "trialing":
      return "activa";
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "cancelada";
    default:
      return "pago_pendiente";
  }
}

interface DerivedBillingState {
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string | null;
  readonly priceId: string | null;
  readonly seats: number;
  readonly status: OrganizationBillingRow["status"];
  readonly currentPeriodEnd: string | null;
}

/** `customer.subscription.{created,updated,deleted}` traen la forma completa
 *  de una `Subscription` -- items/quantity/price/status/current_period_end
 *  SIEMPRE presentes (incluso en `.deleted`: el objeto en `data.object` es la
 *  subscription tal como quedó, con `status: "canceled"`), así que un solo
 *  extractor cubre los 3 tipos. */
function derivarEstadoDeSubscription(record: Record<string, unknown>): DerivedBillingState {
  const items = record.items && typeof record.items === "object" ? (record.items as Record<string, unknown>).data : undefined;
  const first = Array.isArray(items) && items.length > 0 && typeof items[0] === "object" && items[0] !== null ? (items[0] as Record<string, unknown>) : null;
  const price = first?.price && typeof first.price === "object" ? (first.price as Record<string, unknown>) : null;

  const priceId = typeof price?.id === "string" ? price.id : null;
  const seats = typeof first?.quantity === "number" && Number.isFinite(first.quantity) ? first.quantity : 0;
  const currentPeriodEnd = typeof record.current_period_end === "number" ? new Date(record.current_period_end * 1000).toISOString() : null;

  return {
    stripeCustomerId: record.customer as string,
    stripeSubscriptionId: typeof record.id === "string" ? record.id : null,
    priceId,
    seats,
    status: mapStripeSubscriptionStatus(record.status),
    currentPeriodEnd,
  };
}

/** `checkout.session.completed` NO trae items/price/status de la subscription
 *  (esos viven en la propia `Subscription`, que Stripe entrega en un evento
 *  `customer.subscription.created` aparte, casi siempre alrededor del mismo
 *  momento) -- este evento solo confirma que el pago se completó y liga
 *  customer<->subscription. `existing` (la fila YA guardada, si la hay) se
 *  preserva para seats/price/currentPeriodEnd -- nunca se pisan con `0`/`null`
 *  solo porque ESTE evento en particular no los trae. */
function derivarEstadoDeCheckoutCompleted(record: Record<string, unknown>, existing: OrganizationBillingRow | null): DerivedBillingState {
  return {
    stripeCustomerId: record.customer as string,
    stripeSubscriptionId: typeof record.subscription === "string" ? record.subscription : (existing?.stripeSubscriptionId ?? null),
    priceId: existing?.priceId ?? null,
    seats: existing?.seats ?? 0,
    status: "activa",
    currentPeriodEnd: existing?.currentPeriodEnd ?? null,
  };
}

/**
 * Núcleo real de `POST /billing/checkout` — extraído sin cambiar su
 * comportamiento (ver `apps/api/tests/billing.spec.ts`, que sigue verde sin
 * modificarse) para que `POST /superadmin/facturacion/organizaciones/:id/checkout`
 * (`routes/superadmin-facturacion.ts`) lo reutilice en vez de duplicar la
 * llamada a `crearCheckoutPerSeat`/el mismo 503 honesto sin credenciales/el
 * mismo mapeo de `OrganizationNotFoundError`/`OrganizationBillingAccessDeniedError`.
 * `callerId` decide la autoridad real DENTRO de `getOrganizationBillingForCheckout`
 * (owner/admin de la organización, o superadmin de plataforma) — el back office
 * de superadmin pasa el id del propio superadmin, que esa función ya acepta.
 */
export async function crearCheckoutDeOrganizacion(deps: AppDeps, callerId: string, organizationId: string, priceId: string, seats: number): Promise<{ url: string }> {
  if (!deps.saasBillingStripeClient) {
    throw Errors.serviceUnavailable(
      "El checkout de suscripción no está disponible en este entorno: no hay STRIPE_SECRET_KEY configurada. Esto es esperado sin credenciales reales de Stripe -- configúrala para habilitarlo.",
    );
  }

  let billing: OrganizationBillingRow;
  try {
    billing = await deps.coreRepo.getOrganizationBillingForCheckout(callerId, organizationId);
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) throw Errors.notFound(err.message);
    if (err instanceof OrganizationBillingAccessDeniedError) throw Errors.forbidden(err.message);
    throw err;
  }

  const appBaseUrl = deps.env.appBaseUrl;
  return crearCheckoutPerSeat(deps.saasBillingStripeClient, {
    tenantId: organizationId,
    vertical: billing.vertical,
    priceId,
    cantidadSeats: seats,
    customerId: billing.stripeCustomerId ?? undefined,
    successUrl: `${appBaseUrl}/billing/success?organization_id=${encodeURIComponent(organizationId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appBaseUrl}/billing/cancel?organization_id=${encodeURIComponent(organizationId)}`,
  });
}

export function billingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/billing/checkout", authMiddleware(deps.env));

  app.post("/billing/checkout", async (c) => {
    const raw = await readJsonCapped<CheckoutBody>(c.req.raw, MAX_CHECKOUT_BODY_BYTES);
    const organizationId = requireString(raw.organizationId, "organizationId");
    const priceId = requireString(raw.priceId, "priceId");
    const seats = requirePositiveInt(raw.seats, "seats");

    const { url } = await crearCheckoutDeOrganizacion(deps, c.get("userId"), organizationId, priceId, seats);

    return c.json({ url });
  });

  app.post("/billing/webhook", async (c) => {
    // Rate-limit evaluado ANTES de verificar la firma (ver comentario de
    // cabecera de este archivo) -- primera línea del handler, antes incluso de
    // comprobar si hay credenciales configuradas: ninguna otra rama de este
    // handler hace trabajo real (leer el body, HMAC, JSON.parse) todavía en
    // este punto. Solo por IP -- a diferencia de otros webhooks de este
    // monorepo (WhatsApp trae phone_number_id), Stripe no manda ningún
    // identificador de tenant en la URL/headers antes de verificar la firma.
    const rateAllowed = await rateLimit(`conversation:inbound-webhook:${requestActor(c.req.raw)}`, STRIPE_WEBHOOK_RATE_LIMIT.max, STRIPE_WEBHOOK_RATE_LIMIT.windowMs, {
      category: "conversation:inbound-webhook",
    });
    if (!rateAllowed) throw Errors.tooManyRequests("Demasiadas notificaciones de webhook de Stripe. Intenta de nuevo en unos minutos.");

    if (!deps.saasBillingWebhookSecret) {
      throw Errors.serviceUnavailable(
        "El webhook de suscripción no está disponible en este entorno: no hay STRIPE_WEBHOOK_SECRET configurado. Esto es esperado sin credenciales reales de Stripe -- configúralo para habilitarlo.",
      );
    }

    // Firma HMAC sobre los BYTES/TEXTO CRUDO del body -- nunca sobre un JSON ya
    // parseado/re-serializado (mismo detalle crítico que
    // `restaurantesWhatsAppRoutes`/`verifyMetaSignature` documentan para el
    // webhook de Meta). `readTextCapped` no consume el stream dos veces: el
    // parseo de JSON de abajo corre sobre este MISMO texto, nunca sobre
    // `c.req.json()`.
    const rawBody = await readTextCapped(c.req.raw, MAX_WEBHOOK_BODY_BYTES);

    if (!verificarFirmaWebhookStripe({ payload: rawBody, signatureHeader: c.req.header("stripe-signature") ?? null, secret: deps.saasBillingWebhookSecret })) {
      // Rechazo SIN payload/cabecera de firma guardados (ver el comentario de
      // cabecera de `0018_billing_webhook_registro.sql`) -- este es el ÚNICO
      // `reason` de rechazo alcanzable por cualquiera en internet sin conocer
      // el secreto del webhook, por eso el tope anti-inflado de la migración
      // se acota justo a `result = 'rechazado'`.
      await registrarWebhook(deps, { providerEventId: null, eventType: null, organizationId: null, result: "rechazado", reason: "firma_invalida" });
      throw Errors.unauthorized("Firma de webhook inválida.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      await registrarWebhook(deps, { providerEventId: null, eventType: null, organizationId: null, result: "rechazado", reason: "json_invalido" });
      throw Errors.validation("JSON inválido.");
    }

    const evento = normalizeStripeEvent(payload);
    if (!evento || !HANDLED_EVENT_TYPES.has(evento.tipo)) {
      // Forma inesperada, o un tipo de evento que este handler no interpreta
      // (Stripe manda decenas de tipos que no nos interesan) -- ack silencioso,
      // NUNCA un reintento: ninguno de los dos casos se va a resolver
      // reintentando.
      await registrarWebhook(deps, {
        providerEventId: evento?.id ?? looseStringField(payload, "id"),
        eventType: evento?.tipo ?? looseStringField(payload, "type"),
        organizationId: null,
        result: "ignorado",
        reason: "evento_no_reconocido",
      });
      return c.json({ ok: true, procesado: false });
    }

    const tenants: TenantLookup = {
      async getTenantPorId(id) {
        const row = await deps.coreRepo.getOrganizationBillingForWebhook(id);
        if (!row) return null;
        return { tenantId: row.organizationId, proveedorCustomerId: row.stripeCustomerId, ownerEmail: row.ownerEmail };
      },
    };
    // Sin `saasBillingCustomerLookup` configurado (STRIPE_SECRET_KEY ausente en
    // este entorno), el cruce de email del CASO 2 de `verificarTenantDelWebhook`
    // simplemente no tiene datos contra qué cruzar -- esa función YA trata
    // "sin datos suficientes" como "no bloquea" (ver su comentario de cabecera),
    // nunca como fallo de seguridad: el CASO 1 (customer YA registrado debe
    // coincidir) sigue protegiendo sin depender de esto.
    const customers: CustomerLookup = deps.saasBillingCustomerLookup ?? { async getEmailDelCustomer() { return null; } };

    const verificacion = await verificarTenantDelWebhook({
      tenantIdDelPayload: evento.tenantIdDelPayload,
      proveedorCustomerIdDelEvento: evento.proveedorCustomerId,
      tenants,
      customers,
    });
    if (!verificacion.ok) {
      // 409, NUNCA 200: a diferencia de un tipo de evento que no nos interesa,
      // esto SÍ es una señal real (metadata falseada/replay cross-tenant, ver
      // `tenant-verification.ts`) que un reintento de Stripe no va a resolver
      // por sí solo, pero que tampoco se quiere silenciar con un ack -- queda
      // visible en el log de webhooks fallidos de Stripe.
      //
      // `verificacion.motivo` (`@atiende/billing::MotivoRechazo`) es LITERALMENTE
      // el mismo vocabulario que `BillingWebhookLogReason` para estos 4 casos
      // (ver `packages/db/migrations/0018_billing_webhook_registro.sql`) --
      // nunca se traduce/reformula entre el motivo real y lo que queda guardado.
      // `organizationIdCandidate` resuelve a `null` para 'tenant_id_ausente'
      // (no hay id) y 'tenant_no_existe' (existe pero no es un id real -- la
      // propia función SQL de todos modos lo descartaría si no fuera válido),
      // y al id real para 'customer_no_coincide'/'email_no_coincide' (el
      // tenant SÍ existe, solo el customer/email no cruzó).
      await registrarWebhook(deps, {
        providerEventId: evento.id,
        eventType: evento.tipo,
        organizationId: organizationIdCandidate(evento.tenantIdDelPayload),
        result: "rechazado",
        reason: verificacion.motivo,
      });
      throw Errors.conflict(`Webhook rechazado (${verificacion.motivo}): ${verificacion.detalle}`);
    }

    const tenantId = evento.tenantIdDelPayload!; // ya no puede ser null: `verificarTenantDelWebhook` lo hubiera rechazado arriba.
    const organizationId = organizationIdCandidate(tenantId);

    const ledger: LedgerStore = {
      marcarVisto: (eventId) => deps.coreRepo.markBillingWebhookEventSeen(eventId),
      ordenAplicado: (entidadId) => deps.coreRepo.getBillingEntityOrder(entidadId),
      sellarOrden: (entidadId, creadoUnix) => deps.coreRepo.sealBillingEntityOrder(entidadId, creadoUnix),
    };

    let resultado: Awaited<ReturnType<typeof aplicarConLedger<OrganizationBillingRow>>>;
    try {
      resultado = await aplicarConLedger(ledger, {
        eventId: evento.id,
        // La ENTIDAD que el ledger ordena es el customer de Stripe (mismo criterio
        // que `webhook-integration.spec.ts`: "la 'entidad' para el orden es la
        // suscripción/customer") -- dos eventos del mismo customer se comparan
        // entre sí aunque uno sea `checkout.session.completed` y el otro
        // `customer.subscription.updated`.
        entidadId: evento.proveedorCustomerId,
        creadoUnix: evento.creadoUnix,
        aplicar: async () => {
          const estado =
            evento.tipo === "checkout.session.completed"
              ? derivarEstadoDeCheckoutCompleted(evento.datos, await deps.coreRepo.getOrganizationBillingForWebhook(tenantId))
              : derivarEstadoDeSubscription(evento.datos);
          return deps.coreRepo.upsertOrganizationBilling({ organizationId: tenantId, ...estado });
        },
      });
    } catch (err) {
      // El propio `aplicar()` de arriba puede lanzar (p.ej. un error real de
      // Postgres al hacer el upsert) -- se registra como 'error' y se
      // RELANZA tal cual (nunca se cambia el 500/comportamiento real que ya
      // producía este catch antes de que existiera esta bitácora).
      await registrarWebhook(deps, { providerEventId: evento.id, eventType: evento.tipo, organizationId, result: "error", reason: "error_interno" });
      throw err;
    }

    await registrarWebhook(deps, {
      providerEventId: evento.id,
      eventType: evento.tipo,
      organizationId,
      result: resultado.estado === "aplicado" ? "procesado" : "ignorado",
      reason: resultado.estado,
    });

    return c.json({ ok: true, procesado: true, estado: resultado.estado });
  });

  return app;
}
