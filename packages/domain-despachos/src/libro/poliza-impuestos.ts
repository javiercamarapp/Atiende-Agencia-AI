// D-P3-17 -- pólizas de un CFDI con retenciones de ISR/IVA o con IEPS, y póliza de cobro/pago de un complemento de pago (REP) con el traspaso del
// IVA no cobrado/no pagado a cobrado/pagado. Puro: sin I/O, sin SAT/PAC. Todo en centavos enteros; ninguna póliza sale descuadrada (se vuelve a
// comprobar al final y, si no cuadra, NO sale: devuelve el motivo).
//
// PENDIENTE DE VALIDAR CON EL FISCALISTA (los tres puntos de abajo son supuestos documentados, no decisiones fiscales de la plataforma):
//  1. Retenciones. Recibido: el contribuyente retiene y entera -> abono a «ISR retenido por pagar» / «IVA retenido por pagar» y el proveedor se
//     abona por lo que efectivamente se le debe (total). Emitido: al emisor le retienen -> cargo a «ISR/IVA retenido a favor» (se acredita después).
//  2. IEPS recibido: por omisión se SUMA AL COSTO O GASTO (el IEPS que se traslada a quien no lo traslada a su vez no es acreditable, LIEPS art. 4);
//     solo si el staff declara `tratamientoIeps: "acreditable"` se lleva a «IEPS acreditable». IEPS emitido: abono a «IEPS por pagar».
//  3. Traspaso de IVA del REP: cobro (emitido) -> cargo «IVA trasladado» (no cobrado, cuenta de la póliza del CFDI) y abono «IVA trasladado cobrado»;
//     pago (recibido) -> cargo «IVA acreditable pagado» y abono «IVA acreditable» (pendiente), por el IVA proporcional que ya calculó el servidor
//     (prorrateo BigInt de cfdi/rep.ts, guardado en pago_cfdi). El IVA retenido del pago no se traspasa (queda como advertencia).
import type { AccountMapping } from "../bookkeeping/types.ts";
import type { InvoiceRecord } from "../types.ts";
import {
  CUENTA_BANCOS,
  CUENTA_CLIENTES,
  CUENTA_IEPS_ACREDITABLE,
  CUENTA_IEPS_POR_PAGAR,
  CUENTA_INGRESOS_SERVICIOS,
  CUENTA_IVA_ACREDITABLE,
  CUENTA_IVA_ACREDITABLE_PAGADO,
  CUENTA_IVA_RETENIDO_A_FAVOR,
  CUENTA_IVA_RETENIDO_POR_PAGAR,
  CUENTA_IVA_TRASLADADO,
  CUENTA_IVA_TRASLADADO_COBRADO,
  CUENTA_ISR_RETENIDO_A_FAVOR,
  CUENTA_ISR_RETENIDO_POR_PAGAR,
  CUENTA_PROVEEDORES,
} from "./catalogo-base.ts";
import type { MovimientoPolizaInput, PagoRepContable, PolizaInput } from "./types.ts";

export type ResultadoPolizaImpuestos =
  | { readonly ok: true; readonly poliza: PolizaInput; readonly advertencias: readonly string[] }
  | { readonly ok: false; readonly motivo: string };

export interface OpcionesPolizaCfdi {
  /** Cuenta de cargo del gasto de un CFDI recibido (la elige el staff, p. ej. rentas para un arrendamiento). Sustituye la del mapeo por categoría. */
  readonly cuentaGasto?: string;
  /** IEPS de un CFDI recibido: `costo` (default, se suma al gasto) o `acreditable`. */
  readonly tratamientoIeps?: "costo" | "acreditable";
}

export interface MontosCfdi {
  readonly base: number;
  readonly iva: number;
  readonly ieps: number;
  readonly isrRetenido: number;
  readonly ivaRetenido: number;
  readonly total: number;
}

function cuadra(movs: readonly MovimientoPolizaInput[]): boolean {
  return movs.reduce((s, m) => s + m.debeCentavos, 0) === movs.reduce((s, m) => s + m.haberCentavos, 0);
}

const debe = (cuenta: string, concepto: string, centavos: number): MovimientoPolizaInput => ({ cuenta, concepto, debeCentavos: centavos, haberCentavos: 0 });
const haber = (cuenta: string, concepto: string, centavos: number): MovimientoPolizaInput => ({ cuenta, concepto, debeCentavos: 0, haberCentavos: centavos });

/**
 * Emitido, tipo I, con retenciones y/o IEPS (honorarios o arrendamiento de una persona física a una persona moral que retiene):
 * cargo Clientes (total a cobrar), ISR/IVA retenido a favor; abono Ingresos (base), IVA trasladado e IEPS por pagar.
 */
export function polizaEmitidoConImpuestos(f: InvoiceRecord, m: MontosCfdi, concepto: string): ResultadoPolizaImpuestos {
  const movs: MovimientoPolizaInput[] = [debe(CUENTA_CLIENTES, concepto, m.total)];
  if (m.isrRetenido > 0) movs.push(debe(CUENTA_ISR_RETENIDO_A_FAVOR, "ISR retenido", m.isrRetenido));
  if (m.ivaRetenido > 0) movs.push(debe(CUENTA_IVA_RETENIDO_A_FAVOR, "IVA retenido", m.ivaRetenido));
  movs.push(haber(CUENTA_INGRESOS_SERVICIOS, concepto, m.base));
  if (m.iva > 0) movs.push(haber(CUENTA_IVA_TRASLADADO, "IVA trasladado", m.iva));
  if (m.ieps > 0) movs.push(haber(CUENTA_IEPS_POR_PAGAR, "IEPS trasladado", m.ieps));
  if (!cuadra(movs)) return { ok: false, motivo: "La póliza del CFDI con retenciones o IEPS no cuadra (revisa los montos del comprobante)." };
  return { ok: true, poliza: { tipo: "ingreso", fecha: f.fecha, concepto, movimientos: movs }, advertencias: [] };
}

/**
 * Recibido, tipo I, con retenciones y/o IEPS: cargo gasto (base, más IEPS si va al costo), IVA acreditable (y IEPS acreditable si así se declara);
 * abono a la cuenta de pasivo/banco del mapeo por el total, más ISR/IVA retenido por pagar.
 */
export function polizaRecibidoConImpuestos(f: InvoiceRecord, m: MontosCfdi, concepto: string, mapeo: AccountMapping, opciones: OpcionesPolizaCfdi): ResultadoPolizaImpuestos {
  const tratamiento = opciones.tratamientoIeps ?? "costo";
  const cuentaGasto = opciones.cuentaGasto ?? mapeo.cargo;
  const movs: MovimientoPolizaInput[] = [debe(cuentaGasto, concepto, m.base + (tratamiento === "costo" ? m.ieps : 0))];
  if (m.iva > 0) movs.push(debe(mapeo.ivaCargo ?? CUENTA_IVA_ACREDITABLE, "IVA acreditable", m.iva));
  if (m.ieps > 0 && tratamiento === "acreditable") movs.push(debe(CUENTA_IEPS_ACREDITABLE, "IEPS acreditable", m.ieps));
  movs.push(haber(mapeo.abono, concepto, m.total));
  if (m.isrRetenido > 0) movs.push(haber(CUENTA_ISR_RETENIDO_POR_PAGAR, "ISR retenido", m.isrRetenido));
  if (m.ivaRetenido > 0) movs.push(haber(CUENTA_IVA_RETENIDO_POR_PAGAR, "IVA retenido", m.ivaRetenido));
  if (!cuadra(movs)) return { ok: false, motivo: "La póliza del CFDI con retenciones o IEPS no cuadra (revisa los montos del comprobante)." };
  const advertencias: string[] = [];
  if (m.ieps > 0) advertencias.push(tratamiento === "costo" ? "El IEPS se llevó al costo o gasto; si el contribuyente lo traslada a su vez, indícalo como acreditable (validar con el fiscalista)." : "El IEPS se llevó a IEPS acreditable (validar con el fiscalista).");
  return { ok: true, poliza: { tipo: "egreso", fecha: f.fecha, concepto, movimientos: movs }, advertencias };
}

// ---------------------------------------------------------------------------
// Póliza de cobro / pago de un complemento de pago (REP).
// ---------------------------------------------------------------------------

export interface OpcionesPolizaRep {
  /** Cuenta de bancos (o caja) donde entró o de donde salió el dinero. Default 1020000. */
  readonly cuentaBancos?: string;
}

/**
 * Póliza de cobro (CFDI emitido, tipo `ingreso`) o de pago (CFDI recibido, tipo `egreso`) de UNA parcialidad de un REP, con el traspaso del IVA
 * por el monto del flujo:
 *  - Cobro: cargo Bancos, abono Clientes (importe pagado); cargo IVA trasladado (no cobrado), abono IVA trasladado cobrado (IVA proporcional).
 *  - Pago: cargo Proveedores, abono Bancos (importe pagado); cargo IVA acreditable pagado, abono IVA acreditable (IVA proporcional).
 * Cuadra siempre por construcción (dos pares iguales) y se vuelve a comprobar. Solo pesos y solo un CFDI PPD vigente cuyo sentido coincide con el flujo.
 */
export function construirPolizaDesdeRep(p: PagoRepContable, opciones: OpcionesPolizaRep = {}): ResultadoPolizaImpuestos {
  const noAplica = (motivo: string): ResultadoPolizaImpuestos => ({ ok: false, motivo });
  const bancos = opciones.cuentaBancos ?? CUENTA_BANCOS;
  if (p.estadoSatCfdi === "cancelado" || p.estadoSatCfdi === "no_encontrado") return noAplica("El CFDI pagado está cancelado o no existe ante el SAT: no se contabiliza su pago.");
  if (p.metodoPagoCfdi !== "PPD") return noAplica("Solo el pago de un CFDI con método PPD se contabiliza con su complemento de pago.");
  if ((p.monedaCfdi ?? "MXN") !== "MXN") return noAplica("CFDI en moneda extranjera: la póliza requiere el tipo de cambio y se registra a mano.");
  const sentido = p.flujo === "trasladado" ? "emitido" : "recibido";
  if (p.direccionCfdi !== sentido) return noAplica("El flujo del pago no corresponde al sentido (emitido/recibido) del CFDI: revisa la ficha del cliente.");
  if (!Number.isSafeInteger(p.importePagadoCentavos) || p.importePagadoCentavos <= 0) return noAplica("El importe pagado debe ser mayor a cero.");
  if (!Number.isSafeInteger(p.ivaCentavos) || p.ivaCentavos < 0 || p.ivaCentavos > p.importePagadoCentavos) return noAplica("El IVA del pago es inválido: no puede ser negativo ni exceder lo pagado.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fechaPago)) return noAplica("La fecha del pago es inválida.");
  const corto = (u: string): string => u.slice(0, 8);
  const parcialidad = p.numParcialidad ? ` parcialidad ${p.numParcialidad}` : "";
  const concepto = `${p.flujo === "trasladado" ? "Cobro" : "Pago"} REP ${corto(p.folioFiscalRep)}${parcialidad} de CFDI ${corto(p.folioFiscalCfdi)}`;
  const movs: MovimientoPolizaInput[] = [];
  if (p.flujo === "trasladado") {
    movs.push(debe(bancos, concepto, p.importePagadoCentavos), haber(CUENTA_CLIENTES, concepto, p.importePagadoCentavos));
    if (p.ivaCentavos > 0) movs.push(debe(CUENTA_IVA_TRASLADADO, "IVA trasladado no cobrado", p.ivaCentavos), haber(CUENTA_IVA_TRASLADADO_COBRADO, "IVA trasladado cobrado", p.ivaCentavos));
  } else {
    movs.push(debe(CUENTA_PROVEEDORES, concepto, p.importePagadoCentavos), haber(bancos, concepto, p.importePagadoCentavos));
    if (p.ivaCentavos > 0) movs.push(debe(CUENTA_IVA_ACREDITABLE_PAGADO, "IVA acreditable pagado", p.ivaCentavos), haber(CUENTA_IVA_ACREDITABLE, "IVA acreditable pendiente de pago", p.ivaCentavos));
  }
  if (!cuadra(movs)) return noAplica("La póliza del pago no cuadra.");
  const advertencias: string[] = [];
  if (p.ivaRetenidoCentavos > 0) advertencias.push("El pago trae IVA retenido: su traspaso no se genera (validar con el fiscalista).");
  return { ok: true, poliza: { tipo: p.flujo === "trasladado" ? "ingreso" : "egreso", fecha: p.fechaPago, concepto, movimientos: movs }, advertencias };
}
