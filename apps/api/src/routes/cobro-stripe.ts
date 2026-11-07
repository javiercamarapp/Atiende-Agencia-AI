// Stripe ligado al plan (0083):
//   PUT  /superadmin/planes/:id/stripe-precios/:componente   (step-up) lista permitida; el precio se valida contra Stripe
//   POST /billing/checkout-plan                              owner/admin o superadmin: Checkout con los precios del plan, IVA y
//                                                            periodo anclado al dia 1 (autoservicio con tarjeta)
//   POST /superadmin/cobro/organizaciones/:id/suscripcion-spei (step-up) suscripcion por FACTURA pagadera por SPEI (Enterprise)
//   GET  /billing/cobranza                                   estado de cobranza (miembro o superadmin)
//   GET  /superadmin/cobro/cfdi-pendientes                   CFDI de suscripcion en cola (sin PAC no se timbran)
// OXXO: Stripe no lo admite en suscripciones ni facturas (y su tope es 10,000 MXN por pago): no se ofrece.
// Sin STRIPE_SECRET_KEY o sin STRIPE_IVA_TAX_RATE_ID: 503 con el motivo, nunca una URL inventada.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { anclaPrimerDiaMesSiguiente, armarLineItemsSuscripcion, motivoPrecioInvalido, PreciosStripeIncompletos, type ComponenteStripe } from "@atiende/billing";
import { COMPONENTES_STRIPE, OrganizationBillingAccessDeniedError, OrganizationNotFoundError } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "El cobro por plan con Stripe todavía no está disponible en este despliegue (falta la migración 0083_cobro_stripe_cobranza_cfdi).";
const SIN_STRIPE = "Stripe no está configurado en este entorno (falta STRIPE_SECRET_KEY).";
const SIN_IVA = "Falta STRIPE_IVA_TAX_RATE_ID (la tasa de IVA 16 % de Stripe): sin ella no se cobra, para no emitir facturas sin IVA.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u;
const PRICE_RE = /^price_[A-Za-z0-9]{8,64}$/u;
const METER_RE = /^[a-z][a-z0-9_]{2,99}$/u;
const MUTACION = { max: 20, windowMs: 5 * 60_000 } as const;

export function cobroStripeRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string) {
    if (!(await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION.max, MUTACION.windowMs, { category: "admin" }))) throw Errors.tooManyRequests("Demasiadas solicitudes en poco tiempo.");
  }

  app.put("/superadmin/planes/:id/stripe-precios/:componente", async (c) => {
    if (!deps.cobroStripeRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroStripeRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-stripe");
    const planId = c.req.param("id");
    const componente = c.req.param("componente") as ComponenteStripe;
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("id de plan inválido.");
    if (!COMPONENTES_STRIPE.includes(componente)) throw Errors.validation(`componente debe ser uno de: ${COMPONENTES_STRIPE.join(", ")}.`);
    const raw = await readJsonCapped<{ priceId?: unknown; meterEventName?: unknown }>(c.req.raw, 1024);
    const priceId = raw.priceId === null ? null : typeof raw.priceId === "string" && PRICE_RE.test(raw.priceId) ? raw.priceId : undefined;
    if (priceId === undefined) throw Errors.validation("priceId debe ser un id de precio de Stripe (price_...) o null para quitarlo.");
    const medido = componente === "minuto_voz_excedente" || componente === "conversacion_wa_excedente";
    const meter = medido ? (typeof raw.meterEventName === "string" && METER_RE.test(raw.meterEventName) ? raw.meterEventName : null) : null;
    if (priceId !== null && medido && meter === null) throw Errors.validation("meterEventName es obligatorio en los precios medidos (nombre del evento del meter de Stripe).");
    if (priceId !== null) {
      if (!deps.stripePlanClient) throw Errors.serviceUnavailable(SIN_STRIPE);
      const detalle = await deps.stripePlanClient.leerPrecio(priceId).catch((err: unknown) => {
        console.error("stripe-precios: no se pudo leer el precio:", err instanceof Error ? err.message : String(err));
        throw Errors.validation(`Stripe no devolvió el precio ${priceId}: revisa que exista en esta cuenta.`);
      });
      const motivo = motivoPrecioInvalido(componente, detalle);
      if (motivo) throw Errors.validation(motivo);
    }
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setStripePrecio(callerId, planId, componente, priceId, meter));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  async function preparar(callerId: string, organizationId: string) {
    if (!deps.cobroStripeRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    if (!deps.stripePlanClient) throw Errors.serviceUnavailable(SIN_STRIPE);
    const taxRateId = deps.env.stripe.ivaTaxRateId ?? null;
    if (!taxRateId) throw Errors.serviceUnavailable(SIN_IVA);
    let billing;
    try {
      billing = await deps.coreRepo.getOrganizationBillingForCheckout(callerId, organizationId);
    } catch (err) {
      if (err instanceof OrganizationNotFoundError) throw Errors.notFound(err.message);
      if (err instanceof OrganizationBillingAccessDeniedError) throw Errors.forbidden(err.message);
      throw err;
    }
    const repo = deps.cobroStripeRepo;
    const precios = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).preciosParaOrg(callerId, organizationId));
    if (precios.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
    if (!precios.precios) throw Errors.forbidden("No perteneces a esta organización.");
    if (!precios.precios.planId) throw Errors.conflict("La organización no tiene plan asignado: asígnalo antes de cobrar.");
    const zona = deps.cobroPlanesRepo
      ? ((await deps.engine.withAppSession({ userId: callerId }, (db) => deps.cobroPlanesRepo!(db).tarifaDeOrganizacion(callerId, organizationId))).tarifa?.zonaHoraria ?? "America/Merida")
      : "America/Merida";
    let lineItems;
    try {
      lineItems = armarLineItemsSuscripcion(precios.precios.precios, precios.precios.sucursalesActivas, { incluirAlta: !billing.stripeSubscriptionId });
    } catch (err) {
      if (err instanceof PreciosStripeIncompletos) throw Errors.conflict(err.message);
      throw err;
    }
    return { billing, lineItems, taxRateId, anclaUnix: anclaPrimerDiaMesSiguiente(zona), metadata: { tenant_id: organizationId, vertical: billing.vertical, plan_id: precios.precios.planId } };
  }

  app.use("/billing/checkout-plan", authMiddleware(deps.env));
  app.post("/billing/checkout-plan", async (c) => {
    const callerId = c.get("userId");
    const raw = await readJsonCapped<{ organizationId?: unknown }>(c.req.raw, 1024).catch(() => ({}) as { organizationId?: unknown });
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId : c.get("organizationId");
    if (!organizationId || !UUID_RE.test(organizationId)) throw Errors.validation("organizationId: se esperaba un UUID.");
    const p = await preparar(callerId, organizationId);
    const regreso = `organization_id=${encodeURIComponent(organizationId)}&vertical=${encodeURIComponent(p.billing.vertical)}`;
    try {
      const { url } = await deps.stripePlanClient!.crearCheckoutPlan({
        customerId: p.billing.stripeCustomerId ?? undefined,
        lineItems: p.lineItems,
        metadata: p.metadata,
        taxRateId: p.taxRateId,
        anclaUnix: p.anclaUnix,
        successUrl: `${deps.env.appBaseUrl}/billing/success?${regreso}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${deps.env.appBaseUrl}/billing/cancel?${regreso}`,
      });
      return c.json({ url });
    } catch (err) {
      console.error("checkout-plan: Stripe no creo la sesion:", err instanceof Error ? err.message : String(err));
      throw Errors.serviceUnavailable("Stripe no pudo abrir el pago. Revisa los precios del plan en Stripe e intenta de nuevo.");
    }
  });

  app.post("/superadmin/cobro/organizaciones/:id/suscripcion-spei", async (c) => {
    const callerId = c.get("userId");
    await limitar(c, callerId, "suscripcion-spei");
    const organizationId = c.req.param("id");
    if (!UUID_RE.test(organizationId)) throw Errors.validation("id de organización inválido.");
    const raw = await readJsonCapped<{ diasParaPagar?: unknown }>(c.req.raw, 1024).catch(() => ({}) as { diasParaPagar?: unknown });
    const dias = raw.diasParaPagar === undefined ? 7 : raw.diasParaPagar;
    if (typeof dias !== "number" || !Number.isInteger(dias) || dias < 1 || dias > 30) throw Errors.validation("diasParaPagar debe ser un entero entre 1 y 30.");
    const p = await preparar(callerId, organizationId);
    if (p.billing.stripeSubscriptionId && p.billing.status === "activa") throw Errors.conflict("La organización ya tiene una suscripción activa en Stripe.");
    const datos = await deps.coreRepo.getOrganizationBillingForWebhook(organizationId);
    try {
      const customerId = p.billing.stripeCustomerId ?? (datos?.ownerEmail ? (await deps.stripePlanClient!.crearCustomer({ email: datos.ownerEmail, nombre: organizationId, metadata: p.metadata })).id : null);
      if (!customerId) throw Errors.conflict("La organización no tiene correo del dueño para crear el cliente en Stripe.");
      const { id } = await deps.stripePlanClient!.crearSuscripcionFactura({ customerId, lineItems: p.lineItems, metadata: p.metadata, taxRateId: p.taxRateId, anclaUnix: p.anclaUnix, diasParaPagar: dias });
      return c.json({ ok: true, suscripcionId: id, cobro: "factura por SPEI (CLABE virtual de Stripe)", siguiente: "El webhook de Stripe liga la suscripción a la organización al crearse." }, 201);
    } catch (err) {
      if (err instanceof Error && "status" in err) throw err;
      console.error("suscripcion-spei: Stripe fallo:", err instanceof Error ? err.message : String(err));
      throw Errors.serviceUnavailable("Stripe no pudo crear la suscripción por SPEI. Revisa que la transferencia bancaria esté habilitada en la cuenta de Stripe.");
    }
  });

  app.use("/billing/cobranza", authMiddleware(deps.env));
  app.get("/billing/cobranza", async (c) => {
    const callerId = c.get("userId");
    const q = c.req.query("organizationId");
    const organizationId = q ?? c.get("organizationId");
    if (!organizationId || !UUID_RE.test(organizationId)) throw Errors.validation("organizationId: se esperaba un UUID.");
    if (!deps.cobroStripeRepo) return c.json({ disponible: false });
    const repo = deps.cobroStripeRepo;
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).cobranzaDeOrganizacion(callerId, organizationId));
    if (r.availability === "not_migrated") return c.json({ disponible: false });
    if (!r.cobranza) throw Errors.forbidden("No perteneces a esta organización.");
    return c.json({ disponible: true, ...r.cobranza });
  });

  app.get("/superadmin/cobro/cfdi-pendientes", async (c) => {
    if (!deps.cobroStripeRepo) return c.json({ disponible: false, pendientes: [] });
    const repo = deps.cobroStripeRepo;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).cfdiPendientes(callerId));
    return c.json({ disponible: r.availability === "available", pac: deps.emisorCfdiSuscripcion ? "configurado" : "sin_pac", pendientes: r.pendientes });
  });

  return app;
}
