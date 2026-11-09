// ═══════════════════════════════════════════════════════════════════════════
// STRIPE POR PLAN — reglas de negocio (sin SDK ni HTTP: eso vive en apps/api).
//
// - Los precios salen de la LISTA PERMITIDA del plan (core.plan_stripe_precio),
//   nunca de un `priceId` que mande el navegador.
// - Suscripción = cuota fija (cantidad 1) y/o precio por sucursal (cantidad =
//   sucursales activas) + precios MEDIDOS de excedente (minutos y conversaciones,
//   sin cantidad: Stripe suma los eventos del meter) + alta como pago único en la
//   primera factura.
// - El periodo se ancla al día 1 del mes siguiente en la zona del negocio, para
//   que el periodo de Stripe sea el mismo mes calendario que mide la plataforma.
// - CFDI: interfaz `EmisorCfdiSuscripcion`. Sin PAC configurado, la
//   implementación por omisión NO timbra nada y lo dice.
// ═══════════════════════════════════════════════════════════════════════════

export type ComponenteStripe = 'cuota_fija' | 'sucursal' | 'alta' | 'minuto_voz_excedente' | 'conversacion_wa_excedente';

export interface PrecioPlanStripe {
  componente: ComponenteStripe;
  priceId: string;
  meterEventName: string | null;
}

export interface LineItemSuscripcion {
  price: string;
  /** Ausente en precios medidos (Stripe no acepta cantidad en esos). */
  quantity?: number;
  /** Pago único (alta): solo entra en la primera factura. */
  unico?: boolean;
}

export class PreciosStripeIncompletos extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreciosStripeIncompletos';
  }
}

/** Arma los renglones de la suscripción a partir de la lista permitida del plan. */
export function armarLineItemsSuscripcion(precios: readonly PrecioPlanStripe[], sucursalesActivas: number, opts: { incluirAlta: boolean }): LineItemSuscripcion[] {
  const de = (c: ComponenteStripe) => precios.find((p) => p.componente === c);
  const items: LineItemSuscripcion[] = [];
  const fija = de('cuota_fija');
  const sucursal = de('sucursal');
  if (!fija && !sucursal) throw new PreciosStripeIncompletos('El plan no tiene precio de Stripe para la cuota fija ni para la sucursal: configúralo en Planes antes de cobrar.');
  if (fija) items.push({ price: fija.priceId, quantity: 1 });
  if (sucursal) {
    if (!Number.isInteger(sucursalesActivas) || sucursalesActivas < 1) throw new PreciosStripeIncompletos('La organización no tiene sucursales activas: no hay a cuántas cobrar.');
    items.push({ price: sucursal.priceId, quantity: sucursalesActivas });
  }
  for (const c of ['minuto_voz_excedente', 'conversacion_wa_excedente'] as const) {
    const p = de(c);
    if (p) items.push({ price: p.priceId });
  }
  const alta = de('alta');
  if (opts.incluirAlta && alta) items.push({ price: alta.priceId, quantity: sucursal ? sucursalesActivas : 1, unico: true });
  return items;
}

/** Detalle de un precio de Stripe (lo que devuelve GET /v1/prices/:id, normalizado). */
export interface PrecioStripeDetalle {
  id: string;
  activo: boolean;
  moneda: string;
  /** null = precio medido o por niveles sin monto unitario fijo. */
  montoUnitarioCentavos: number | null;
  tipo: 'recurring' | 'one_time';
  usoMedido: boolean;
  meterId: string | null;
}

/** Valida que un precio de Stripe sirva para el componente; devuelve el motivo si no. */
export function motivoPrecioInvalido(componente: ComponenteStripe, p: PrecioStripeDetalle): string | null {
  if (!p.activo) return `El precio ${p.id} está archivado en Stripe.`;
  if (p.moneda.toLowerCase() !== 'mxn') return `El precio ${p.id} cobra en ${p.moneda.toUpperCase()}, no en MXN.`;
  if (componente === 'alta') return p.tipo === 'one_time' ? null : `El precio ${p.id} de la cuota de alta debe ser de pago único.`;
  if (p.tipo !== 'recurring') return `El precio ${p.id} debe ser recurrente (mensual).`;
  const medido = componente === 'minuto_voz_excedente' || componente === 'conversacion_wa_excedente';
  if (medido && (!p.usoMedido || !p.meterId)) return `El precio ${p.id} debe ser medido y estar ligado a un meter de Stripe.`;
  if (!medido && p.usoMedido) return `El precio ${p.id} es medido; la cuota fija y la sucursal deben ser precios fijos.`;
  if (!medido && !(p.montoUnitarioCentavos !== null && p.montoUnitarioCentavos > 0)) return `El precio ${p.id} cobra $0: un plan gratis se asigna a mano.`;
  return null;
}

/** Inicio (Unix) del día 1 del mes siguiente en la zona del negocio: ancla del periodo de la suscripción. */
export function anclaPrimerDiaMesSiguiente(zonaHoraria: string, ahora = new Date()): number {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: zonaHoraria, year: 'numeric', month: '2-digit' }).formatToParts(ahora);
  const y = Number(partes.find((p) => p.type === 'year')?.value);
  const m = Number(partes.find((p) => p.type === 'month')?.value);
  const sy = m === 12 ? y + 1 : y;
  const sm = m === 12 ? 1 : m + 1;
  // Medianoche local = medianoche UTC menos el desfase de la zona en ese instante.
  const utc = Date.UTC(sy, sm - 1, 1, 0, 0, 0);
  const desfaseMin = desfaseMinutos(zonaHoraria, new Date(utc));
  return Math.floor((utc - desfaseMin * 60_000) / 1000);
}

function desfaseMinutos(zonaHoraria: string, instante: Date): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zonaHoraria, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(instante);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return Math.round((local - instante.getTime()) / 60_000);
}

// ---- CFDI de la suscripción ----------------------------------------------

export interface SolicitudCfdiSuscripcion {
  organizationId: string;
  stripeInvoiceId: string;
  subtotalCentavos: number;
  ivaCentavos: number;
}

export type ResultadoCfdiSuscripcion = { estado: 'timbrado'; uuidFiscal: string } | { estado: 'sin_pac'; motivo: string } | { estado: 'error'; motivo: string };

/** Punto de enganche del PAC (Finkok, SW Sapien...). La app conecta uno real cuando haya CSD y credenciales. */
export interface EmisorCfdiSuscripcion {
  emitir(solicitud: SolicitudCfdiSuscripcion): Promise<ResultadoCfdiSuscripcion>;
}

/** Implementación por omisión: no timbra (no hay CSD ni PAC configurados). La solicitud queda en cola como `pendiente_pac`. */
export class EmisorCfdiSinPac implements EmisorCfdiSuscripcion {
  async emitir(): Promise<ResultadoCfdiSuscripcion> {
    return { estado: 'sin_pac', motivo: 'No hay PAC ni CSD configurados: el CFDI queda pendiente y no se timbra nada.' };
  }
}
