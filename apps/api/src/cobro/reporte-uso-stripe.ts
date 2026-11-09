// Reporte del excedente MEDIDO a Stripe (Billing Meters). Una vez al dia, dentro del cron existente
// /internal/plataforma/prueba-avisos (no agrega cron: 40 de 40), y una ultima vez al llegar `invoice.created` del ciclo
// (la factura borrador aun acepta uso). Se reporta solo la DIFERENCIA contra lo ya reportado (`core.cobro_uso_reportar`), con
// identificador idempotente: correr dos veces no cobra dos veces. El calculo es el mismo motor de la factura
// (`calcularFacturaPlanMedido`): excedente cobrable despues del uso justo.
// Orden: primero se anota la diferencia en la base y luego se llama a Stripe en la MISMA transaccion; si Stripe falla, la
// transaccion se revierte y el siguiente reporte la manda.
import { calcularFacturaPlanMedido } from "@atiende/billing";
import type { AppDeps } from "../deps.ts";
import { mesActualEn } from "../routes/cobro-planes.ts";
import { periodoDeFactura } from "./factura-webhook.ts";

export interface ResumenReporteUso {
  readonly disponible: boolean;
  readonly organizaciones: number;
  readonly eventos: number;
  readonly errores: number;
}

export async function reportarUsoOrganizacion(deps: AppDeps, organizationId: string, customerId: string, opts: { periodEndUnix?: number } = {}): Promise<number> {
  if (!deps.cobroPlanesRepo || !deps.cobroStripeRepo || !deps.stripePlanClient) return 0;
  const planes = deps.cobroPlanesRepo;
  const stripeRepo = deps.cobroStripeRepo;
  const cliente = deps.stripePlanClient;
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const t = await planes(db).tarifaDeOrganizacion(null, organizationId);
    if (!t.tarifa?.plan || t.tarifa.plan.modeloCobro !== "medido" || t.tarifa.vertical !== "restaurantes") return 0;
    const precios = await stripeRepo(db).preciosParaOrg(null, organizationId);
    const medidos = (precios.precios?.precios ?? []).filter((p) => p.meterEventName);
    if (medidos.length === 0) return 0;
    const periodo = opts.periodEndUnix ? periodoDeFactura(opts.periodEndUnix, t.tarifa.zonaHoraria) : mesActualEn(t.tarifa.zonaHoraria);
    const d = await planes(db).consumoDetalleRestaurantes(null, organizationId, periodo, 0);
    if (!d.detalle) return 0;
    const f = calcularFacturaPlanMedido(t.tarifa.plan, { sucursalesActivas: t.tarifa.sucursalesActivas, minutosVoz: d.detalle.totales.minutosVoz, conversacionesWa: d.detalle.totales.conversacionesWa });
    let eventos = 0;
    for (const [componente, metrica, unidades] of [["minuto_voz_excedente", "minuto_voz", f.voz.excedenteCobrado], ["conversacion_wa_excedente", "conversacion_wa", f.whatsapp.excedenteCobrado]] as const) {
      const precio = medidos.find((p) => p.componente === componente);
      if (!precio?.meterEventName) continue;
      const r = await stripeRepo(db).usoPorReportar(organizationId, periodo, metrica, unidades);
      if (r.availability === "not_migrated" || r.delta <= 0) continue;
      const ts = opts.periodEndUnix ? opts.periodEndUnix - 60 : Math.floor(Date.now() / 1000);
      await cliente.reportarUsoMedido({ eventName: precio.meterEventName, customerId, value: r.delta, timestampUnix: ts, identifier: `atiende-${organizationId}-${periodo}-${metrica}-${unidades}` });
      eventos += 1;
    }
    return eventos;
  });
}

export async function ejecutarReporteUsoStripe(deps: AppDeps): Promise<ResumenReporteUso> {
  if (!deps.cobroPlanesRepo || !deps.cobroStripeRepo || !deps.stripePlanClient) return { disponible: false, organizaciones: 0, eventos: 0, errores: 0 };
  const planes = deps.cobroPlanesRepo;
  const lista = await deps.engine.withAppSession({ userId: null }, (db) => planes(db).organizacionesMedidas(null));
  if (lista.availability === "not_migrated") return { disponible: false, organizaciones: 0, eventos: 0, errores: 0 };
  let eventos = 0;
  let errores = 0;
  for (const org of lista.organizaciones) {
    try {
      const billing = await deps.coreRepo.getOrganizationBillingForWebhook(org.organizationId);
      if (!billing?.stripeCustomerId || !billing.stripeSubscriptionId) continue;
      eventos += await reportarUsoOrganizacion(deps, org.organizationId, billing.stripeCustomerId);
    } catch (err) {
      errores += 1;
      console.error("reporte-uso-stripe: fallo una organizacion (se reintenta manana o al cerrar la factura):", err instanceof Error ? err.name : typeof err);
    }
  }
  return { disponible: true, organizaciones: lista.organizaciones.length, eventos, errores };
}
