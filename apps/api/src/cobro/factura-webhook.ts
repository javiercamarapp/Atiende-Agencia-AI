// Eventos de FACTURA de Stripe para la suscripcion por plan (llamados desde POST /billing/webhook ya verificado en firma, tenant
// y ledger):
//   invoice.payment_failed -> cobranza (aviso -> gracia -> pausa sugerida) + avisos al dueño y a superadmin. Nada se pausa solo.
//   invoice.paid           -> cobranza al corriente + CFDI de ingreso encolado (y timbrado si hay PAC; sin PAC queda pendiente).
//   invoice.created        -> reporte FINAL del excedente medido del periodo que cerro (la factura borrador aun acepta uso).
import { EmisorCfdiSinPac } from "@atiende/billing";
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { reportarUsoOrganizacion } from "./reporte-uso-stripe.ts";

/** Ids del catalogo, literales (la prueba del catalogo verifica que este archivo los emite). */
const EVENTO_PAGO_FALLIDO: Readonly<Record<string, string>> = {
  restaurantes: "restaurantes.cobro.pago_fallido",
  hoteles: "hoteles.cobro.pago_fallido",
  rentas: "rentas.cobro.pago_fallido",
  licitaciones: "licitaciones.cobro.pago_fallido",
  citas: "citas.cobro.pago_fallido",
  despachos: "despachos.cobro.pago_fallido",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Mes calendario (YYYY-MM-01) del periodo de uso que factura una factura de ciclo: el mes anterior a `period_end`. */
export function periodoDeFactura(periodEndUnix: number, zonaHoraria: string): string {
  const fin = new Date((periodEndUnix - 60) * 1000);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit" }).formatToParts(fin);
  return `${p.find((x) => x.type === "year")?.value}-${p.find((x) => x.type === "month")?.value}-01`;
}

export async function manejarEventoFactura(deps: AppDeps, organizationId: string, vertical: string, tipo: string, datos: Record<string, unknown>): Promise<void> {
  if (!deps.cobroStripeRepo) return;
  const repo = deps.cobroStripeRepo;
  const facturaId = typeof datos.id === "string" ? datos.id : null;

  if (tipo === "invoice.payment_failed") {
    await deps.engine.withAppSession({ userId: null }, async (db) => {
      const r = await repo(db).registrarCobranza(organizationId, "pago_fallido", facturaId, num(datos.attempt_count), num(datos.amount_due));
      if (r.availability === "not_migrated" || !r.nuevo) return;
      const clave = `${organizationId}:${facturaId ?? "factura"}:${r.nuevo}`;
      const evento = EVENTO_PAGO_FALLIDO[vertical];
      if (evento) await emitirNotificacion(db, { evento, organizationId, clave, parametros: {}, entidadTipo: "organizacion" });
      await emitirNotificacion(db, { evento: r.nuevo === "pausa_sugerida" ? "superadmin.cobro.pausa_sugerida" : "superadmin.cobro.pago_fallido", organizationId: null, clave, parametros: { estado: r.nuevo }, entidadTipo: "organizacion", entidadId: organizationId });
    });
    return;
  }

  if (tipo === "invoice.paid") {
    await deps.engine.withAppSession({ userId: null }, async (db) => {
      const rp = repo(db);
      await rp.registrarCobranza(organizationId, "pagada", facturaId, null, null);
      if (!facturaId) return;
      const total = num(datos.total) ?? 0;
      const iva = num(datos.tax) ?? Math.max(total - (num(datos.subtotal) ?? total), 0);
      const subtotal = Math.max(total - iva, 0);
      const encolada = await rp.encolarCfdi(organizationId, facturaId, subtotal, iva, null);
      if (encolada.availability === "available" && encolada.encolada) {
        const emisor = deps.emisorCfdiSuscripcion ?? new EmisorCfdiSinPac();
        const r = await emisor.emitir({ organizationId, stripeInvoiceId: facturaId, subtotalCentavos: subtotal, ivaCentavos: iva });
        if (r.estado !== "timbrado") console.warn(`billing/webhook: CFDI de ${facturaId} pendiente (${r.estado}).`);
      }
    });
    return;
  }

  if (tipo === "invoice.created" && datos.billing_reason === "subscription_cycle" && typeof datos.customer === "string") {
    const periodEnd = num(datos.period_end);
    if (periodEnd === null) return;
    await reportarUsoOrganizacion(deps, organizationId, datos.customer, { periodEndUnix: periodEnd });
  }
}
