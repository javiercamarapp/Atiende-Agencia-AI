// ═══════════════════════════════════════════════════════════════════════════
// COTIZADOR — costo y margen bruto proyectados de un plan negociado.
//
// Costo = minutos × costo por minuto + conversaciones × costo por conversación
//       + sucursales × fijo por sucursal + fijo por organización.
// Los costos unitarios entran como DATOS (core.cobro_costo_unitario, editables
// por el superadmin); aquí no vive ninguno. Margen = (subtotal sin IVA − costo)
// / subtotal: antes de comisiones de cobro. `comisionTarjeta` da además el
// margen si el cliente paga con tarjeta.
//
// Regla del dueño: toda oferta debe dejar ≥ 55 % en su PEOR punto, que es un
// cliente usando exactamente el 100 % de la bolsa incluida (antes de que el
// excedente empiece a pagar). `margenPeorPunto` calcula justo eso.
// ═══════════════════════════════════════════════════════════════════════════

import { bandasDe, bolsaPorSucursalVigente, calcularFacturaPlanMedido, repartirEnBandas, type FacturaPlanMedido, type TarifaPlanMedido } from './plan-medido.ts';

export interface CostosUnitarios {
  /** MXN por minuto de voz, todo incluido. */
  minutoVozMxn: number;
  /** MXN por conversación de WhatsApp. */
  conversacionWaMxn: number;
  /** MXN fijos por sucursal activa al mes (parte de infraestructura). */
  fijoMensualSucursalMxn: number;
  /** MXN al mes por el número de voz de cada sucursal; solo si el plan incluye voz. */
  numeroVozMensualSucursalMxn?: number;
  /** MXN fijos por organización al mes. */
  fijoMensualOrganizacionMxn: number;
}

/** Comisión de tarjeta (Stripe MX, referencia pública): porcentaje + fijo, con IVA sobre la comisión. Dato, no constante de negocio. */
export interface ComisionTarjeta {
  porcentaje: number;
  fijoMxn: number;
  ivaSobreComisionPct: number;
}

export interface UsoEsperado {
  sucursales: number;
  minutosVoz: number;
  conversacionesWa: number;
}

export interface ResultadoCotizacion {
  factura: FacturaPlanMedido;
  costoMxn: number;
  utilidadMxn: number;
  /** null si el subtotal es 0. */
  margenPct: number | null;
  /** Margen si paga con tarjeta (null si no se dio comisión). */
  margenConTarjetaPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Costo de `unidades` de una métrica: por bandas (costo de cada banda) si el plan las trae; si no, el costo unitario plano. */
function costoMetrica(tarifa: TarifaPlanMedido | null, metrica: 'minuto_voz' | 'conversacion_wa', unidades: number, plano: number): number {
  const bandas = tarifa ? bandasDe(tarifa, metrica) : [];
  if (bandas.length === 0) return unidades * plano;
  return repartirEnBandas(bandas, 0, unidades).reduce((s, { banda, unidades: u }) => s + u * banda.costoUnitarioMxn, 0);
}

/** ¿El plan incluye voz? (minutos incluidos, precio de minuto o bandas de minutos). Sin voz no hay número de Twilio. */
export function tieneVoz(t: TarifaPlanMedido): boolean {
  return t.minutosVozIncluidos > 0 || t.minutosVozIncluidosPorSucursal > 0 || t.precioMinutoVozExcedenteCentavos !== null
    || (t.tramosSucursal ?? []).some((tr) => (tr.minutosVozIncluidosPorSucursal ?? 0) > 0) || bandasDe(t, 'minuto_voz').length > 0;
}

export function costoProyectadoMxn(c: CostosUnitarios, uso: UsoEsperado, tarifa: TarifaPlanMedido | null = null): number {
  return r2(
    costoMetrica(tarifa, 'minuto_voz', uso.minutosVoz, c.minutoVozMxn) +
      costoMetrica(tarifa, 'conversacion_wa', uso.conversacionesWa, c.conversacionWaMxn) +
      uso.sucursales * (c.fijoMensualSucursalMxn + (tarifa === null || tieneVoz(tarifa) ? (c.numeroVozMensualSucursalMxn ?? 0) : 0)) +
      c.fijoMensualOrganizacionMxn,
  );
}

export function comisionTarjetaMxn(montoConIvaMxn: number, com: ComisionTarjeta): number {
  return r2((montoConIvaMxn * com.porcentaje + com.fijoMxn) * (1 + com.ivaSobreComisionPct));
}

export function cotizar(tarifa: TarifaPlanMedido, uso: UsoEsperado, costos: CostosUnitarios, comision?: ComisionTarjeta): ResultadoCotizacion {
  const factura = calcularFacturaPlanMedido(tarifa, { sucursalesActivas: uso.sucursales, minutosVoz: uso.minutosVoz, conversacionesWa: uso.conversacionesWa });
  const ingreso = factura.subtotalCentavos / 100;
  const costo = costoProyectadoMxn(costos, uso, tarifa);
  const utilidad = r2(ingreso - costo);
  const margenPct = ingreso > 0 ? r2((utilidad / ingreso) * 100) : null;
  const margenConTarjetaPct = comision && ingreso > 0 ? r2(((utilidad - comisionTarjetaMxn(factura.totalCentavos / 100, comision)) / ingreso) * 100) : null;
  return { factura, costoMxn: costo, utilidadMxn: utilidad, margenPct, margenConTarjetaPct };
}

/** Peor punto: la cuenta usa EXACTAMENTE su bolsa incluida de minutos y conversaciones (sin excedente). */
export function margenPeorPunto(tarifa: TarifaPlanMedido, sucursales: number, costos: CostosUnitarios, comision?: ComisionTarjeta): ResultadoCotizacion {
  const bolsa = bolsaPorSucursalVigente(tarifa, sucursales);
  const cubiertas = Math.max(sucursales, tarifa.sucursalesIncluidas);
  return cotizar(
    tarifa,
    {
      sucursales,
      minutosVoz: tarifa.minutosVozIncluidos + bolsa.minutosVoz * cubiertas,
      conversacionesWa: tarifa.conversacionesWaIncluidas + bolsa.conversacionesWa * cubiertas,
    },
    costos,
    comision,
  );
}

/** Margen del minuto (o conversación) excedente: (precio − costo) / precio. null si no se cobra excedente. */
export function margenExcedentePct(precioCentavos: number | null, costoMxn: number): number | null {
  if (precioCentavos === null || precioCentavos <= 0) return null;
  const precio = precioCentavos / 100;
  return r2(((precio - costoMxn) / precio) * 100);
}
