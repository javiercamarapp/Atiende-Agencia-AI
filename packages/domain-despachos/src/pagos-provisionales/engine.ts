// D-25 -- motor del papel de pagos provisionales de ISR e IVA por FLUJO DE EFECTIVO. Puro y determinista. Centavos enteros (los
// factores se aplican con BigInt: sin flotantes). No inventa cifras: lo que falta se declara ("faltan parámetros", "no soportado")
// y los CFDI que no se pueden contar se reportan en `exclusiones` con su motivo y su importe.
//
// Reglas (todas citadas para validarlas con el fiscalista; ver docs/fiscalista del PR -- lo dudoso va marcado en `advertencias`):
//  - Flujo de efectivo: un CFDI PUE cuenta en el mes de su fecha; uno PPD cuenta solo por los pagos de su complemento (REP) en el
//    mes de la FECHA DE PAGO, por la base e IVA proporcionales (LISR arts. 14, 105 y 106; LIVA arts. 1-B y 5).
//  - Se excluyen: CFDI cancelados o no encontrados ante el SAT, en moneda extranjera (no hay tipo de cambio persistido a prueba),
//    de sentido indeterminado, sin método de pago, y -- como deducción o acreditamiento -- los inválidos (EFOS definitivo u otro
//    hallazgo), los pagados en efectivo por más de $2,000.00 (LISR 27-III, LIVA 5-I) y los de uso personal/sin efectos (D01-D10,
//    S01, CP01). Los de uso I01-I08 (inversiones) NO se deducen de golpe (LISR 31-34): se reportan aparte; su IVA sí se acredita.
//  - ISR 601 (LISR 14 y 17): utilidad fiscal estimada = INGRESOS NOMINALES acumulados x coeficiente de utilidad - pérdidas pendientes;
//    ISR = 30%; menos pagos provisionales previos y retenciones. Los ingresos nominales de una persona moral se acumulan al expedir
//    el CFDI (LISR 17): son los CFDI emitidos del periodo por su FECHA, incluidos los PPD aún no cobrados (NO flujo de efectivo).
//    Quedan fuera (a validar con el fiscalista): anticipos o cobros sin CFDI y entregas/servicios aún sin CFDI. El coeficiente es un
//    DATO del contador (no se calcula aquí). El IVA sí es por flujo (LIVA 1-B) también para el 601.
//  - ISR 612 (LISR 106): (ingresos cobrados - deducciones pagadas) acumulados - pérdidas pendientes, con la tarifa del art. 96
//    escalada al periodo acumulado (tarifa mensual x meses transcurridos). ADVERTENCIA: el escalado de la tarifa es la práctica
//    habitual pero va a la lista del fiscalista. Solo con tabla mensual del ejercicio verificada (2025, 2026); otro ejercicio = no soportado.
//    Solo personas físicas: un RFC de persona moral en 612 es no soportado.
//  - ISR 626 (LISR 113-E): tasa mensual (1.00 a 2.50%) sobre los ingresos cobrados del MES, sin deducciones. RESICO PF: el RFC debe
//    ser de persona física (13); persona moral (12) o sin RFC = no soportado.
//  - IVA (LIVA 5 y 6): IVA trasladado cobrado - IVA acreditable pagado - IVA retenido - saldo a favor anterior; si es negativo, a favor.
import { proporcionCentavos } from "../cfdi/rep.ts";
import type {
  EntradaPapel,
  ExclusionPapel,
  LineaPapel,
  PagoRepProvisional,
  PapelProvisional,
  ParametrosPapelIsr,
  ResultadoImpuesto,
} from "./types.ts";
import { esRegimenIsrSoportado } from "./types.ts";
import { ISR_MENSUAL_2025, ISR_MENSUAL_2026 } from "../declaraciones/isr-tablas.ts";
import type { TablaIsr } from "../declaraciones/isr-tablas.ts";

/** Umbral del pago en efectivo no deducible: $2,000.00 (LISR 27-III). */
export const LIMITE_EFECTIVO_CENTAVOS = 200_000;
/** Tasa del ISR de personas morales (LISR 9): 30%. */
const TASA_PM_PORCENTAJE = 30n;
/** Tope anual de ingresos de RESICO PF (LISR 113-E): $3,500,000.00. */
export const TOPE_RESICO_CENTAVOS = 350_000_000;

/** Tasas mensuales de RESICO PF (LISR 113-E): [límite superior del ingreso mensual en centavos, puntos base (100 = 1.00%)]. */
export const TASAS_RESICO_MENSUAL: readonly (readonly [number, number])[] = [
  [2_500_000, 100],
  [5_000_000, 110],
  [8_333_333, 150],
  [20_833_333, 200],
  [350_000_000, 250],
];

const USOS_SIN_DEDUCCION = /^(D\d{2}|S01|CP01)$/;
const USOS_INVERSION = /^I\d{2}$/;

function suma(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** a x numerador / denominador con enteros no negativos, mitad hacia arriba (BigInt). */
function porFraccion(a: number, numerador: bigint, denominador: bigint): number {
  const num = BigInt(a) * numerador;
  return Number((2n * num + denominador) / (2n * denominador));
}

/** "0.234567" -> 234567 (millonésimas). null si el formato no es un decimal con hasta 6 decimales entre 0 y 9.999999. */
export function coeficienteAMicros(texto: string | null | undefined): number | null {
  if (typeof texto !== "string") return null;
  const m = /^(\d)(?:\.(\d{1,6}))?$/.exec(texto.trim());
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

export function tasaResicoBp(ingresoMensualCentavos: number): number | null {
  for (const [limite, bp] of TASAS_RESICO_MENSUAL) if (ingresoMensualCentavos <= limite) return bp;
  return null;
}

/** Tabla mensual del art. 96 por ejercicio. Solo los ejercicios con tabla verificada en isr-tablas.ts; otro ejercicio = undefined ("no soportado"). */
const TABLAS_ISR_MENSUAL: Readonly<Record<number, TablaIsr>> = { 2025: ISR_MENSUAL_2025, 2026: ISR_MENSUAL_2026 };
export function tablaIsrMensualDe(ejercicio: number): TablaIsr | undefined {
  return TABLAS_ISR_MENSUAL[ejercicio];
}

/** Persona moral = RFC de 12 caracteres; persona física = 13; null si no hay RFC utilizable. */
export function tipoPersonaPorRfc(rfc: string | null | undefined): "moral" | "fisica" | null {
  const largo = typeof rfc === "string" ? rfc.trim().length : 0;
  return largo === 12 ? "moral" : largo === 13 ? "fisica" : null;
}

/** Tarifa del art. 96 (tabla mensual del ejercicio; por omisión la 2026) escalada a `meses` meses, en centavos enteros. Tasa en puntos base (0.0192 -> 192). */
export function isrTarifaAcumuladaCentavos(baseCentavos: number, meses: number, tabla: TablaIsr = ISR_MENSUAL_2026): number {
  if (baseCentavos <= 0) return 0;
  const m = BigInt(meses);
  for (let i = tabla.length - 1; i >= 0; i -= 1) {
    const [limiteInferior, , cuotaFija, tasa] = tabla[i]!;
    const liCentavos = BigInt(Math.round(limiteInferior * 100)) * m;
    if (BigInt(baseCentavos) >= liCentavos || i === 0) {
      const excedente = BigInt(baseCentavos) > liCentavos ? BigInt(baseCentavos) - liCentavos : 0n;
      const tasaBp = BigInt(Math.round(tasa * 10_000));
      const cuota = BigInt(Math.round(cuotaFija * 100)) * m;
      const variable = (2n * excedente * tasaBp + 10_000n) / 20_000n;
      return Number(cuota + variable);
    }
  }
  return 0;
}

interface Normalizado {
  /** Importe con signo: positivo suma, negativo (nota de crédito) resta. */
  readonly id: string;
  readonly mes: number;
  readonly baseCentavos: number;
  readonly ivaCentavos: number;
  readonly isrRetenidoCentavos: number;
  readonly ivaRetenidoCentavos: number;
  readonly origen: "pue" | "rep";
}

interface Clasificacion {
  readonly emitidos: Normalizado[];
  readonly recibidos: Normalizado[];
  readonly nominas: Normalizado[];
  readonly inversionesBaseCentavos: number;
  readonly exclusiones: ExclusionPapel[];
  readonly pendientesPpd: { cantidad: number; importeCentavos: number };
  readonly advertencias: string[];
  readonly incluidos: number;
}

const mesDe = (fecha: string): number => Number(fecha.slice(5, 7));
const anioDe = (fecha: string): number => Number(fecha.slice(0, 4));

/** Ingresos nominales (LISR 17) de personas morales: CFDI emitidos I/E del ejercicio hasta el mes, por su FECHA (los PPD cuentan aunque no
 * estén cobrados), sin IVA y en centavos con signo (la nota de crédito resta). Sin cancelados, no encontrados, sin montos ni moneda extranjera
 * (sin método de pago tampoco; esos casos ya se reportan en `exclusiones` por el clasificador de flujo). Las retenciones NO se toman de aquí: se acreditan por flujo. */
function ingresosNominalesEmitidos(e: EntradaPapel): { baseCentavos: number; documentos: number } {
  let baseCentavos = 0;
  let documentos = 0;
  for (const f of e.facturas) {
    if (f.direccion !== "emitido" || (f.tipo !== "I" && f.tipo !== "E")) continue;
    if (anioDe(f.fecha) !== e.ejercicio || mesDe(f.fecha) < 1 || mesDe(f.fecha) > e.mes) continue;
    if (f.estadoSat === "cancelado" || f.estadoSat === "no_encontrado") continue;
    if (f.totalCentavos == null || f.subtotalCentavos == null || (f.moneda ?? "MXN") !== "MXN") continue;
    if (f.metodoPago !== "PUE" && f.metodoPago !== "PPD") continue;
    baseCentavos += (f.tipo === "E" ? -1 : 1) * (f.subtotalCentavos - (f.descuentoCentavos ?? 0));
    documentos += 1;
  }
  return { baseCentavos, documentos };
}

function clasificar(e: EntradaPapel): Clasificacion {
  const emitidos: Normalizado[] = [];
  const recibidos: Normalizado[] = [];
  const nominas: Normalizado[] = [];
  const excl = new Map<string, { cantidad: number; importe: number }>();
  const advertencias: string[] = [];
  const excluir = (motivo: string, importe: number): void => {
    const x = excl.get(motivo) ?? { cantidad: 0, importe: 0 };
    x.cantidad += 1;
    x.importe += importe;
    excl.set(motivo, x);
  };
  let inversionesBase = 0;
  let incluidos = 0;
  const pendientesPpd = { cantidad: 0, importeCentavos: 0 };
  const pagosPorFactura = new Map<string, PagoRepProvisional[]>();
  for (const p of e.pagos) pagosPorFactura.set(p.invoiceId, [...(pagosPorFactura.get(p.invoiceId) ?? []), p]);

  const enPeriodo = (f: string): boolean => anioDe(f) === e.ejercicio && mesDe(f) >= 1 && mesDe(f) <= e.mes;

  for (const f of e.facturas) {
    const importe = f.totalCentavos ?? 0;
    const tipoSoportado = f.tipo === "I" || f.tipo === "E" || f.tipo === "N";
    if (!tipoSoportado) continue; // T (traslado) y P (pago) no son ingreso ni deducción por sí mismos.
    const delPeriodo = enPeriodo(f.fecha);
    const pagosDelCfdi = pagosPorFactura.get(f.id) ?? [];
    const pagosDelPeriodo = pagosDelCfdi.filter((p) => enPeriodo(p.fechaPago));
    // El CFDI cuenta si su fecha (PUE) o alguno de sus pagos (PPD) cae en el ejercicio hasta el mes.
    if (!delPeriodo && pagosDelPeriodo.length === 0) continue;

    if (f.estadoSat === "cancelado" || f.estadoSat === "no_encontrado") { excluir(f.estadoSat === "cancelado" ? "CFDI cancelado ante el SAT" : "CFDI no encontrado ante el SAT", importe); continue; }
    if (f.direccion !== "emitido" && f.direccion !== "recibido") { excluir("Sentido (emitido/recibido) indeterminado: captura el RFC en la ficha del cliente", importe); continue; }
    if (f.totalCentavos == null || f.subtotalCentavos == null) { excluir("CFDI sin montos en centavos (ingerido antes del modelo completo): vuelve a cargar el XML", importe); continue; }
    if ((f.moneda ?? "MXN") !== "MXN") { excluir("CFDI en moneda extranjera: requiere tipo de cambio y revisión del fiscalista", importe); continue; }
    if (f.metodoPago !== "PUE" && f.metodoPago !== "PPD") { excluir("CFDI sin método de pago (PUE/PPD): vuelve a cargar el XML", importe); continue; }

    const esRecibidoOEgreso = f.direccion === "recibido" || f.tipo === "N";
    // Filtros de deducibilidad/acreditamiento (solo recibidos y nómina; el ingreso se acumula aunque el CFDI tenga hallazgos).
    let esInversion = false;
    if (esRecibidoOEgreso) {
      if (!f.valido) { excluir("CFDI con hallazgos de validación o en la lista 69-B (no deducible ni acreditable)", importe); continue; }
      if (f.metodoPago === "PUE" && f.formaPago === "01" && f.totalCentavos > LIMITE_EFECTIVO_CENTAVOS && f.tipo !== "N") { excluir("Pago en efectivo mayor a $2,000.00 (LISR 27-III y LIVA 5-I)", importe); continue; }
      if (f.usoCfdi && USOS_SIN_DEDUCCION.test(f.usoCfdi)) { excluir("Uso del CFDI personal o sin efectos fiscales (D01-D10, S01, CP01)", importe); continue; }
      esInversion = !!f.usoCfdi && USOS_INVERSION.test(f.usoCfdi);
    }

    const base = f.subtotalCentavos - (f.descuentoCentavos ?? 0);
    const signo = f.tipo === "E" ? -1 : 1;
    const destino = f.tipo === "N" ? nominas : f.direccion === "emitido" ? emitidos : recibidos;

    if (f.metodoPago === "PUE") {
      if (!delPeriodo) continue;
      const n: Normalizado = {
        id: f.id,
        mes: mesDe(f.fecha),
        baseCentavos: signo * base,
        ivaCentavos: signo * (f.ivaTrasladadoCentavos ?? 0),
        isrRetenidoCentavos: signo * (f.isrRetenidoCentavos ?? 0),
        ivaRetenidoCentavos: signo * (f.ivaRetenidoCentavos ?? 0),
        origen: "pue",
      };
      incluidos += 1;
      if (esInversion && destino === recibidos) {
        inversionesBase += n.baseCentavos;
        recibidos.push({ ...n, baseCentavos: 0 }); // solo su IVA se acredita
      } else destino.push(n);
      continue;
    }

    // PPD: solo cuentan los pagos del complemento. Una nota de crédito PPD no se cuenta (no hay a qué ligarla).
    if (f.tipo === "E") { excluir("Nota de crédito con método PPD: se registra a mano (no hay pago al que ligarla)", importe); continue; }
    if (!e.pagosDisponibles) { excluir("CFDI PPD: los pagos de complementos no están disponibles en esta base (migración pendiente)", importe); continue; }
    if (delPeriodo && pagosDelCfdi.length === 0) {
      pendientesPpd.cantidad += 1;
      pendientesPpd.importeCentavos += importe;
    }
    let contado = false;
    for (const p of pagosDelPeriodo) {
      const n: Normalizado = {
        id: f.id,
        mes: mesDe(p.fechaPago),
        baseCentavos: p.baseCentavos,
        ivaCentavos: p.ivaCentavos,
        isrRetenidoCentavos: f.totalCentavos > 0 ? proporcionCentavos(f.isrRetenidoCentavos ?? 0, p.importePagadoCentavos, f.totalCentavos) : 0,
        ivaRetenidoCentavos: p.ivaRetenidoCentavos,
        origen: "rep",
      };
      contado = true;
      if (esInversion && destino === recibidos) {
        inversionesBase += n.baseCentavos;
        recibidos.push({ ...n, baseCentavos: 0 });
      } else destino.push(n);
    }
    if (contado) incluidos += 1;
  }

  const exclusiones: ExclusionPapel[] = [...excl.entries()].map(([motivo, x]) => ({ motivo, cantidad: x.cantidad, importeCentavos: x.importe }));
  if (inversionesBase !== 0) {
    advertencias.push("Hay CFDI de inversiones (uso I01-I08): su deducción es por tasa anual de depreciación (LISR 31-34) y NO está incluida en las deducciones; su IVA sí se acredita.");
  }
  return { emitidos, recibidos, nominas, inversionesBaseCentavos: inversionesBase, exclusiones, pendientesPpd, advertencias, incluidos };
}

const sinCalcular = (impuesto: "ISR" | "IVA", estado: "no_soportado" | "faltan_parametros", motivo: string): ResultadoImpuesto => ({
  impuesto,
  estado,
  motivo,
  lineas: [],
  baseCentavos: 0,
  determinadoCentavos: 0,
  acreditableCentavos: 0,
  aCargoCentavos: 0,
  aFavorCentavos: 0,
});

function resultado(impuesto: "ISR" | "IVA", lineas: LineaPapel[], base: number, determinado: number, acreditable: number): ResultadoImpuesto {
  const neto = determinado - acreditable;
  return { impuesto, estado: "calculado", motivo: null, lineas, baseCentavos: base, determinadoCentavos: determinado, acreditableCentavos: acreditable, aCargoCentavos: neto > 0 ? neto : 0, aFavorCentavos: neto < 0 ? -neto : 0 };
}

function parametroCentavos(valor: number | null | undefined): number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0 ? valor : 0;
}

function calcularIsr(e: EntradaPapel, c: Clasificacion, params: ParametrosPapelIsr): ResultadoImpuesto {
  const regimen = e.regimen;
  if (!esRegimenIsrSoportado(regimen)) {
    return sinCalcular("ISR", "no_soportado", `El papel de ISR para el régimen ${regimen} aún no está modelado (soportados: 601, 612 y 626). El IVA sí se calcula.`);
  }
  const ingresosFlujo = suma(c.emitidos.map((x) => x.baseCentavos));
  const retenciones = suma(c.emitidos.map((x) => x.isrRetenidoCentavos));
  const pagosPrevios = e.pagosPreviosIsrPresentadosCentavos + parametroCentavos(params.ajustePagosPreviosCentavos);
  const perdidas = parametroCentavos(params.perdidasPendientesCentavos);
  const lineas: LineaPapel[] = [];

  if (regimen === "601") {
    const micros = coeficienteAMicros(params.coeficienteUtilidad);
    if (micros === null) return sinCalcular("ISR", "faltan_parametros", "Captura el coeficiente de utilidad del contribuyente (art. 14 LISR, del último ejercicio de 12 meses) para calcular el pago provisional.");
    // Persona moral: ingresos NOMINALES (LISR 17), no el flujo de efectivo con que se calcula el IVA.
    const ingresos = ingresosNominalesEmitidos(e).baseCentavos;
    const utilidad = porFraccion(Math.max(0, ingresos), BigInt(micros), 1_000_000n);
    const base = Math.max(0, utilidad - perdidas);
    const isr = porFraccion(base, TASA_PM_PORCENTAJE, 100n);
    lineas.push(
      { clave: "ingresos", concepto: "Ingresos nominales acumulados (CFDI emitidos del periodo, incluidos PPD aún no cobrados; sin IVA)", centavos: ingresos },
      { clave: "utilidad", concepto: "Utilidad fiscal estimada (ingresos x coeficiente)", centavos: utilidad, detalle: `coeficiente ${params.coeficienteUtilidad}` },
      { clave: "perdidas", concepto: "Pérdidas fiscales pendientes de amortizar", centavos: perdidas },
      { clave: "base", concepto: "Base del pago provisional", centavos: base },
      { clave: "isr", concepto: "ISR determinado (30%)", centavos: isr },
      { clave: "previos", concepto: "Pagos provisionales de meses anteriores", centavos: pagosPrevios },
      { clave: "retenciones", concepto: "ISR retenido por clientes", centavos: retenciones },
    );
    return resultado("ISR", lineas, base, isr, pagosPrevios + retenciones);
  }

  const ingresos = ingresosFlujo;
  if (regimen === "612") {
    if (tipoPersonaPorRfc(e.rfc) === "moral") return sinCalcular("ISR", "no_soportado", "El régimen 612 es de personas físicas y el RFC del cliente es de persona moral (12 caracteres): revisa la ficha del cliente o valida con el fiscalista. El IVA sí se calcula.");
    const tabla = tablaIsrMensualDe(e.ejercicio);
    if (!tabla) return sinCalcular("ISR", "no_soportado", `No hay tabla mensual del art. 96 verificada para el ejercicio ${e.ejercicio} (disponibles: ${Object.keys(TABLAS_ISR_MENSUAL).join(", ")}): no se calcula un número engañoso. El IVA sí se calcula.`);
    // PENDIENTE DE VALIDAR CON EL FISCALISTA: la nómina se deduce por la base del CFDI de nómina (subtotal - descuento, es decir, en neto
    // según como venga el comprobante), no por el bruto de percepciones; y por la fecha del CFDI, no por la de pago de la nómina.
    const deducciones = suma(c.recibidos.map((x) => x.baseCentavos)) + suma(c.nominas.map((x) => x.baseCentavos));
    const utilidad = ingresos - deducciones;
    const base = Math.max(0, utilidad - perdidas);
    const isr = isrTarifaAcumuladaCentavos(base, e.mes, tabla);
    lineas.push(
      { clave: "ingresos", concepto: "Ingresos acumulados cobrados (sin IVA)", centavos: ingresos },
      { clave: "deducciones", concepto: "Deducciones acumuladas efectivamente pagadas (sin IVA)", centavos: deducciones },
      { clave: "utilidad", concepto: "Utilidad fiscal del periodo acumulado", centavos: utilidad },
      { clave: "perdidas", concepto: "Pérdidas fiscales pendientes de amortizar", centavos: perdidas },
      { clave: "base", concepto: "Base del pago provisional", centavos: base },
      { clave: "isr", concepto: `ISR por la tarifa del art. 96 acumulada a ${e.mes} mes(es)`, centavos: isr },
      { clave: "previos", concepto: "Pagos provisionales de meses anteriores", centavos: pagosPrevios },
      { clave: "retenciones", concepto: "ISR retenido por clientes", centavos: retenciones },
    );
    return resultado("ISR", lineas, base, isr, pagosPrevios + retenciones);
  }

  // 626 RESICO PF: solo personas físicas (LISR 113-E). Las morales tributan por el título II / RESICO PM (aún no modelado).
  const persona = tipoPersonaPorRfc(e.rfc);
  if (persona !== "fisica") return sinCalcular("ISR", "no_soportado", persona === "moral" ? "El régimen 626 (RESICO persona física) no aplica a un RFC de persona moral (12 caracteres): el papel de ISR de personas morales en 626 no está soportado; valida con el fiscalista. El IVA sí se calcula." : "No hay RFC de persona física (13 caracteres) en la ficha del cliente: sin él no se puede confirmar que el 626 sea RESICO PF. El IVA sí se calcula.");
  // 626 RESICO PF: tasa sobre los ingresos cobrados del MES; sin deducciones ni pagos previos acreditables.
  const delMes = c.emitidos.filter((x) => x.mes === e.mes);
  const ingresoMes = suma(delMes.map((x) => x.baseCentavos));
  const retencionMes = suma(delMes.map((x) => x.isrRetenidoCentavos));
  const bp = tasaResicoBp(Math.max(0, ingresoMes));
  if (bp === null) return sinCalcular("ISR", "no_soportado", "Los ingresos del mes rebasan el tope de RESICO ($3,500,000.00): el contribuyente debe salir del régimen; revisa con el fiscalista.");
  const isr = porFraccion(Math.max(0, ingresoMes), BigInt(bp), 10_000n);
  lineas.push(
    { clave: "ingresos", concepto: "Ingresos cobrados del mes (sin IVA)", centavos: ingresoMes },
    { clave: "isr", concepto: `ISR mensual (${(bp / 100).toFixed(2)}% del ingreso del mes)`, centavos: isr },
    { clave: "retenciones", concepto: "ISR retenido por clientes del mes", centavos: retencionMes },
  );
  return resultado("ISR", lineas, Math.max(0, ingresoMes), isr, retencionMes);
}

/** Umbral de la advertencia "acreditable > 3x trasladado" (riesgo de revisión del SAT; el sistema suelto avisaba igual). */
const FACTOR_ALERTA_ACREDITABLE = 3;

function calcularIva(e: EntradaPapel, c: Clasificacion): { readonly resultado: ResultadoImpuesto; readonly advertencias: string[] } {
  const delMes = (xs: readonly Normalizado[]): Normalizado[] => xs.filter((x) => x.mes === e.mes);
  const trasladado = suma(delMes(c.emitidos).map((x) => x.ivaCentavos));
  const acreditableBruto = suma(delMes(c.recibidos).map((x) => x.ivaCentavos));
  const retenido = suma(delMes(c.emitidos).map((x) => x.ivaRetenidoCentavos));
  const advertencias: string[] = [];

  // D-P3-06 (LIVA 5-V y art. 5 RLIVA): cuando el contribuyente realiza ademas actos EXENTOS, el IVA de gastos de uso mixto solo se
  // acredita en la proporcion actos gravados / (gravados + exentos). PENDIENTE DE VALIDAR CON EL FISCALISTA: se aplica la proporcion del
  // MES a todo el IVA acreditable (no se separa gasto de uso exclusivo gravado, exclusivo exento y mixto) -- ver PREGUNTAS-AL-FISCALISTA.
  const exentos = parametroCentavos(e.iva.actosExentosCentavos);
  let acreditable = acreditableBruto;
  let detalleAcreditable: string | undefined;
  if (exentos > 0) {
    const gravadosCapturados = parametroCentavos(e.iva.actosGravadosCentavos);
    const gravados = gravadosCapturados > 0 ? gravadosCapturados : suma(delMes(c.emitidos).map((x) => x.baseCentavos));
    const total = gravados + exentos;
    if (gravadosCapturados === 0) advertencias.push("IVA proporcional: los actos gravados se tomaron de la base de los CFDI emitidos del mes (captura los actos gravados si difieren).");
    if (total > 0) {
      acreditable = porFraccion(acreditableBruto, BigInt(gravados), BigInt(total));
      const pct = (Number((BigInt(gravados) * 1_000_000n) / BigInt(total)) / 10_000).toFixed(2);
      detalleAcreditable = `Proporcion de acreditamiento ${pct} % (actos gravados ${gravados} / gravados + exentos ${total}, centavos); IVA acreditable antes de la proporcion: ${acreditableBruto}.`;
    }
  } else {
    advertencias.push("Proporción no aplicada: sin actos exentos registrados. El IVA acreditable se tomó al 100 %; si el cliente realiza actos exentos captura actosExentosCentavos (LIVA 5-V).");
  }
  if (trasladado > 0 && acreditable > trasladado * FACTOR_ALERTA_ACREDITABLE) {
    advertencias.push(`IVA acreditable (${acreditable} centavos) mayor a ${FACTOR_ALERTA_ACREDITABLE} veces el IVA trasladado (${trasladado} centavos): revisa el origen del acreditable antes de presentar (un saldo a favor así suele ser revisado por el SAT).`);
  }

  // PENDIENTE DE VALIDAR CON EL FISCALISTA: el saldo a favor de IVA del mes anterior (del papel presentado) se arrastra y acredita solo
  // contra el IVA del mes; no se modela compensación contra otros impuestos ni solicitud de devolución.
  const saldoAnterior = e.saldoFavorIvaMesAnteriorCentavos ?? parametroCentavos(e.iva.saldoFavorAnteriorCentavos);
  const lineas: LineaPapel[] = [
    { clave: "trasladado", concepto: "IVA trasladado efectivamente cobrado", centavos: trasladado },
    { clave: "acreditable", concepto: "IVA acreditable efectivamente pagado", centavos: acreditable, ...(detalleAcreditable ? { detalle: detalleAcreditable } : {}) },
    { clave: "retenido", concepto: "IVA retenido por clientes", centavos: retenido },
    { clave: "saldo_anterior", concepto: "Saldo a favor de meses anteriores", centavos: saldoAnterior },
  ];
  return { resultado: resultado("IVA", lineas, Math.max(0, trasladado), Math.max(0, trasladado), acreditable + retenido + saldoAnterior), advertencias };
}

export function calcularPapelProvisional(e: EntradaPapel): PapelProvisional {
  const c = clasificar(e);
  const advertencias = [...c.advertencias];
  if (!e.pagosDisponibles) advertencias.push("Los pagos de complementos de pago (REP) no están disponibles en esta base: los CFDI PPD no se contaron.");
  if (c.pendientesPpd.cantidad > 0) advertencias.push(`${c.pendientesPpd.cantidad} CFDI PPD del periodo no tienen complemento de pago registrado: no cuentan como flujo de efectivo (IVA${e.regimen === "601" ? "; el ISR 601 sí los acumula como ingreso nominal" : ", ISR"}) hasta que lo registres.`);
  const isr = calcularIsr(e, c, e.isr);
  if (e.regimen === "601" && isr.estado === "calculado") advertencias.push("ISR 601: el ingreso se acumula por CFDI emitido (LISR 17: incluye PPD no cobrados); anticipos o cobros sin CFDI y entregas sin CFDI no se incluyen. El IVA sí es por flujo de efectivo (LIVA 1-B). Valida ambos criterios con el fiscalista.");
  if (e.regimen === "612" && isr.estado === "calculado") advertencias.push("ISR 612: la tarifa del art. 96 se escala al periodo acumulado (tarifa mensual x meses); confírmalo con el fiscalista antes de presentar.");
  if (e.regimen === "626" && isr.estado === "calculado") {
    const acumulado = suma(c.emitidos.map((x) => x.baseCentavos));
    if (acumulado > TOPE_RESICO_CENTAVOS) advertencias.push("Los ingresos acumulados del ejercicio rebasan $3,500,000.00: el contribuyente deja RESICO; revisa con el fiscalista.");
  }
  const calculoIva = calcularIva(e, c);
  const iva = calculoIva.resultado;
  advertencias.push(...calculoIva.advertencias);
  return { ejercicio: e.ejercicio, mes: e.mes, regimen: e.regimen, isr, iva, documentosIncluidos: c.incluidos, exclusiones: c.exclusiones, pendientesPpd: { cantidad: c.pendientesPpd.cantidad, importeCentavos: c.pendientesPpd.importeCentavos }, advertencias };
}
