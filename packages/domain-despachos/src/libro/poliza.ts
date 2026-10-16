// D-24 -- validación de una póliza de entrada y armado de la póliza de un CFDI persistido. Puro: sin I/O, sin SAT/PAC.
// Todo en centavos enteros; el cuadre (debe = haber) se exige aquí Y en la función SQL de la migración 020.
import { DEFAULT_MAPPINGS, mappingKey } from "../bookkeeping/catalogo.ts";
import type { CategoriaContable, InvoiceRecord } from "../types.ts";
import { polizaEmitidoConImpuestos, polizaRecibidoConImpuestos } from "./poliza-impuestos.ts";
import type { OpcionesPolizaCfdi } from "./poliza-impuestos.ts";
import { CUENTA_CLIENTES, CUENTA_DEVOLUCIONES_VENTAS, CUENTA_INGRESOS_SERVICIOS, CUENTA_IVA_TRASLADADO } from "./catalogo-base.ts";
import { TIPOS_POLIZA } from "./types.ts";
import type { MovimientoPolizaInput, PolizaInput, TipoPoliza } from "./types.ts";

export const MAX_PARTIDAS_POLIZA = 200;
const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CUENTA_RE = /^\d{4,10}$/;

export interface ErrorCampoLibro {
  readonly campo: string;
  readonly mensaje: string;
}
export type ResultadoValidacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly errores: readonly ErrorCampoLibro[] };

/** YYYY-MM-DD con calendario real (rechaza 2026-02-30) y ejercicio 2014-2099, igual que el CHECK de la base. */
export function esFechaValida(valor: unknown): valor is string {
  if (typeof valor !== "string") return false;
  const m = FECHA_RE.exec(valor);
  if (!m) return false;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (anio < 2014 || anio > 2099 || mes < 1 || mes > 12) return false;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

function centavosEntero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/** Valida y normaliza el cuerpo de una póliza (`tipo`, `fecha`, `concepto`, `movimientos[{cuenta, concepto, debe, haber}]`).
 * `debe`/`haber` llegan en CENTAVOS enteros; un decimal, una cadena o un negativo se rechaza (nunca se redondea en silencio). */
export function validarPolizaEntrada(raw: Record<string, unknown>): ResultadoValidacion<PolizaInput> {
  const errores: ErrorCampoLibro[] = [];
  const tipo = raw.tipo;
  if (typeof tipo !== "string" || !(TIPOS_POLIZA as readonly string[]).includes(tipo)) errores.push({ campo: "tipo", mensaje: "Tipo de póliza: ingreso, egreso o diario." });
  if (!esFechaValida(raw.fecha)) errores.push({ campo: "fecha", mensaje: "Fecha de la póliza (AAAA-MM-DD, ejercicio 2014 a 2099)." });
  const concepto = typeof raw.concepto === "string" ? raw.concepto.trim() : "";
  if (concepto.length < 1 || concepto.length > 300) errores.push({ campo: "concepto", mensaje: "Concepto de 1 a 300 caracteres." });

  const movimientos: MovimientoPolizaInput[] = [];
  const lista = raw.movimientos;
  if (!Array.isArray(lista) || lista.length < 2 || lista.length > MAX_PARTIDAS_POLIZA) {
    errores.push({ campo: "movimientos", mensaje: `Una póliza lleva de 2 a ${MAX_PARTIDAS_POLIZA} partidas.` });
  } else {
    lista.forEach((item, i) => {
      const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const cuenta = typeof m.cuenta === "string" ? m.cuenta.trim() : "";
      const debe = centavosEntero(m.debe ?? 0);
      const haber = centavosEntero(m.haber ?? 0);
      const conceptoPartida = typeof m.concepto === "string" ? m.concepto.trim() : "";
      if (!CUENTA_RE.test(cuenta)) errores.push({ campo: `movimientos[${i}].cuenta`, mensaje: "Cuenta de 4 a 10 dígitos." });
      else if (debe === null || haber === null) errores.push({ campo: `movimientos[${i}]`, mensaje: "Debe y haber son centavos enteros no negativos." });
      else if ((debe > 0) === (haber > 0)) errores.push({ campo: `movimientos[${i}]`, mensaje: "Cada partida lleva debe o haber (uno solo, mayor que cero)." });
      else if (conceptoPartida.length > 300) errores.push({ campo: `movimientos[${i}].concepto`, mensaje: "Concepto de la partida de hasta 300 caracteres." });
      else movimientos.push({ cuenta, concepto: conceptoPartida, debeCentavos: debe, haberCentavos: haber });
    });
  }

  if (errores.length === 0) {
    const debe = movimientos.reduce((s, m) => s + m.debeCentavos, 0);
    const haber = movimientos.reduce((s, m) => s + m.haberCentavos, 0);
    if (!Number.isSafeInteger(debe) || !Number.isSafeInteger(haber)) errores.push({ campo: "movimientos", mensaje: "Los montos exceden el rango permitido." });
    else if (debe !== haber) errores.push({ campo: "movimientos", mensaje: `Póliza descuadrada: debe ${debe} y haber ${haber} centavos.` });
  }
  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, valor: { tipo: tipo as TipoPoliza, fecha: raw.fecha as string, concepto, movimientos } };
}

/** Categoría gruesa del CFDI (`invoice.categoria`) -> clave del mapeo de cuentas del clasificador de pólizas. Solo lo que NO es ambiguo se
 * automatiza: activos fijos, inversiones y nómina llevan cuentas específicas que decide el contador. */
const MAPEO_POR_CATEGORIA: Readonly<Record<CategoriaContable, string | null>> = {
  honorarios: "servicios_profesionales",
  gasto_operativo: "otros",
  activo_fijo: null,
  inversion: null,
  nomina: null,
  sin_clasificar: null,
};

export type ResultadoPolizaCfdi =
  | { readonly ok: true; readonly poliza: PolizaInput }
  | { readonly ok: false; readonly motivo: string };

/**
 * Póliza (devengada) de un CFDI persistido. Solo arma las que se pueden armar sin inventar: CFDI en pesos, con montos en centavos (D-22) y
 * total = base + IVA + IEPS - retenciones (D-P3-17: con retenciones de ISR/IVA o con IEPS la póliza lleva las cuentas de poliza-impuestos.ts).
 *  - Emitido, tipo I:  cargo Clientes (total); abono Ingresos por servicios (base) e IVA trasladado.
 *  - Emitido, tipo E:  nota de crédito: cargo Devoluciones sobre ventas (base) e IVA trasladado; abono Clientes (total).
 *  - Recibido, tipo I: cargo la cuenta de gasto de su categoría (base) e IVA acreditable; abono la cuenta de pasivo/banco del mapeo.
 * Cualquier otro (nómina, traslado, pago, nota de crédito recibida, categoría sin clasificar, sentido indeterminado) devuelve el motivo
 * para que el staff registre la póliza a mano. El cobro/pago (Bancos contra Clientes/Proveedores) es otra póliza y no se arma aquí.
 */
export function construirPolizaDesdeCfdi(f: InvoiceRecord, opciones: OpcionesPolizaCfdi = {}): ResultadoPolizaCfdi {
  const noAplica = (motivo: string): ResultadoPolizaCfdi => ({ ok: false, motivo });
  if (f.estadoSat === "cancelado") return noAplica("El CFDI está cancelado ante el SAT: no se contabiliza.");
  if (f.direccion !== "emitido" && f.direccion !== "recibido") return noAplica("No se sabe si el CFDI es emitido o recibido: captura la ficha del cliente (RFC) y vuelve a ingerirlo.");
  if (f.totalCentavos == null || f.subtotalCentavos == null) return noAplica("El CFDI se ingirió antes del modelo completo (D-22) y no tiene montos en centavos: vuelve a cargar el XML.");
  if ((f.moneda ?? "MXN") !== "MXN") return noAplica("CFDI en moneda extranjera: la póliza requiere el tipo de cambio y se registra a mano.");
  const isrRetenido = f.isrRetenidoCentavos ?? 0;
  const ivaRetenido = f.ivaRetenidoCentavos ?? 0;
  const ieps = f.iepsCentavos ?? 0;
  const conImpuestos = isrRetenido > 0 || ivaRetenido > 0 || ieps > 0;
  if (conImpuestos && f.tipo !== "I") return noAplica("Un CFDI que no es de ingreso y trae retenciones o IEPS no genera póliza automática: regístrala a mano.");
  const base = f.subtotalCentavos - (f.descuentoCentavos ?? 0);
  const iva = f.ivaTrasladadoCentavos ?? 0;
  if (base <= 0) return noAplica("El CFDI no tiene base gravable positiva.");
  // D-P3-17: total = base + IVA + IEPS - retenciones (centavos). Con retenciones o IEPS la póliza lleva sus cuentas (ver poliza-impuestos.ts).
  if (base + iva + ieps - isrRetenido - ivaRetenido !== f.totalCentavos) return noAplica("El total del CFDI no es igual a base más IVA e IEPS menos retenciones (centavos): revisa el comprobante antes de contabilizarlo.");
  const montos = { base, iva, ieps, isrRetenido, ivaRetenido, total: f.totalCentavos };
  const concepto = `CFDI ${f.folioFiscal}`;

  // PENDIENTE DE VALIDAR CON EL CONTADOR: estas pólizas son DEVENGADAS (Clientes/Proveedores contra ingreso/gasto), pero se rotulan
  // `ingreso`/`egreso`, que en contabilidad electrónica suelen significar cobro/pago; las notas de crédito van como `diario`. Las cuentas
  // (1050000 clientes, 4080000 ingresos, 4020000 devoluciones, 2600400/2600300 IVA y el mapeo de gastos) son supuestos del catálogo base.
  if (f.direccion === "emitido" && f.tipo === "I") {
    if (conImpuestos) {
      const r = polizaEmitidoConImpuestos(f, montos, concepto);
      return r.ok ? { ok: true, poliza: r.poliza } : r;
    }
    const movimientos: MovimientoPolizaInput[] = [
      { cuenta: CUENTA_CLIENTES, concepto, debeCentavos: f.totalCentavos, haberCentavos: 0 },
      { cuenta: CUENTA_INGRESOS_SERVICIOS, concepto, debeCentavos: 0, haberCentavos: base },
    ];
    if (iva > 0) movimientos.push({ cuenta: CUENTA_IVA_TRASLADADO, concepto: "IVA trasladado", debeCentavos: 0, haberCentavos: iva });
    return { ok: true, poliza: { tipo: "ingreso", fecha: f.fecha, concepto, movimientos } };
  }
  if (f.direccion === "emitido" && f.tipo === "E") {
    const movimientos: MovimientoPolizaInput[] = [{ cuenta: CUENTA_DEVOLUCIONES_VENTAS, concepto, debeCentavos: base, haberCentavos: 0 }];
    if (iva > 0) movimientos.push({ cuenta: CUENTA_IVA_TRASLADADO, concepto: "IVA trasladado", debeCentavos: iva, haberCentavos: 0 });
    movimientos.push({ cuenta: CUENTA_CLIENTES, concepto, debeCentavos: 0, haberCentavos: f.totalCentavos });
    return { ok: true, poliza: { tipo: "diario", fecha: f.fecha, concepto: `Nota de crédito ${f.folioFiscal}`, movimientos } };
  }
  if (f.direccion === "recibido" && f.tipo === "I") {
    const clave = MAPEO_POR_CATEGORIA[f.categoria];
    const mapeo = clave ? DEFAULT_MAPPINGS[mappingKey("I", clave)] : undefined;
    if (!mapeo) return noAplica("La categoría del CFDI no tiene una cuenta de gasto que se pueda asignar sola (activo fijo, inversión, nómina o sin clasificar): regístrala a mano.");
    if (iva > 0 && !mapeo.ivaCargo) return noAplica("La categoría del CFDI no tiene cuenta de IVA acreditable: regístralo a mano.");
    if (conImpuestos) {
      const r = polizaRecibidoConImpuestos(f, montos, concepto, mapeo, opciones);
      return r.ok ? { ok: true, poliza: r.poliza } : r;
    }
    const movimientos: MovimientoPolizaInput[] = [{ cuenta: opciones.cuentaGasto ?? mapeo.cargo, concepto, debeCentavos: base, haberCentavos: 0 }];
    if (iva > 0 && mapeo.ivaCargo) movimientos.push({ cuenta: mapeo.ivaCargo, concepto: "IVA acreditable", debeCentavos: iva, haberCentavos: 0 });
    movimientos.push({ cuenta: mapeo.abono, concepto, debeCentavos: 0, haberCentavos: f.totalCentavos });
    return { ok: true, poliza: { tipo: "egreso", fecha: f.fecha, concepto, movimientos } };
  }
  return noAplica(`Un CFDI ${f.direccion} de tipo ${f.tipo} no genera póliza automática: regístrala a mano.`);
}

/** Centavos -> "1234.56" exacto (sin flotantes). */
export function centavosATexto(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const enteros = Math.trunc(abs / 100);
  const resto = abs % 100;
  return `${negativo ? "-" : ""}${enteros}.${String(resto).padStart(2, "0")}`;
}
