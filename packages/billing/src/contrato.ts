// ═══════════════════════════════════════════════════════════════════════════
// CONTRATO POR CLIENTE Y FACTURACION ESTIMADA DEL MES (superadmin "CFO", SA-43)
//
// Funciones PURAS (sin reloj, sin base de datos, sin flotantes en dinero): reciben las
// versiones del contrato de una organizacion tal como las guarda
// `core.customer_contract_version` y calculan que le tocaria facturar en un mes.
//
// REGLAS DE LA CASA
//   * Todo el dinero son CENTAVOS MXN ENTEROS. Los porcentajes son puntos base enteros
//     (100 bp = 1 %). Las divisiones redondean "mitad hacia arriba" con aritmetica entera.
//   * NUNCA inventar una cifra: sin contrato vigente en el mes el estado es `sin_contrato` y
//     los totales son `null` con su razon; sin minutos medidos el excedente es `null`.
//   * Esto es una ESTIMACION para el CFO: NO cobra, NO emite factura, NO envia nada. El total
//     es SUBTOTAL antes de IVA y NO incluye la instalacion (se factura por hito, no mensual).
//
// SEMANTICA DE VIGENCIAS (identica a la de la migracion 0037)
//   * Un contrato (`contractId`) es una linea de versiones inmutables. La version `n` rige
//     desde su `vigenteDesde` hasta el dia anterior al `vigenteDesde` de la version `n+1`
//     (o hasta el `vigenteHasta` del contrato, inclusivo, o sin fin si es `null`).
//   * Dos contratos distintos de una misma organizacion no pueden traslaparse.
// ═══════════════════════════════════════════════════════════════════════════

export interface VersionContrato {
  readonly contractId: string;
  readonly version: number;
  /** `YYYY-MM-DD`, inclusivo. */
  readonly vigenteDesde: string;
  /** `YYYY-MM-DD`, inclusivo; `null` = sin fecha de fin. Fin del CONTRATO, copiado en cada version. */
  readonly vigenteHasta: string | null;
  readonly baseCentavos: number;
  readonly porSucursalCentavos: number;
  readonly sucursalesIncluidas: number;
  readonly bolsaMinutos: number;
  readonly excedenteCentavosMinuto: number;
  readonly instalacionCentavos: number;
  /** Descuento porcentual sobre el recurrente bruto, en puntos base (0-10000). */
  readonly descuentoBp: number;
  /** Descuento fijo mensual en centavos, se resta despues del porcentual. */
  readonly descuentoFijoCentavos: number;
}

export type TerminosContrato = Omit<VersionContrato, "contractId" | "version">;

export interface EntradaEstimacion {
  /** `YYYY-MM`. */
  readonly mes: string;
  readonly versiones: readonly VersionContrato[];
  /** Sucursales activas hoy (no hay historial de altas/bajas por dia: supuesto declarado). */
  readonly sucursalesActivas: number;
  /** Minutos de voz usados en el mes, enteros (ya redondeados hacia arriba); `null` = no medidos. */
  readonly minutosVoz: number | null;
}

export interface SegmentoEstimado {
  readonly contractId: string;
  readonly version: number;
  /** Primer y ultimo dia EFECTIVOS dentro del mes. */
  readonly desde: string;
  readonly hasta: string;
  readonly dias: number;
  readonly brutoMensualCentavos: number;
  readonly sucursalesExtra: number;
  readonly descuentoPorcentualCentavos: number;
  readonly descuentoFijoCentavos: number;
  /** Recurrente mensual completo de esta version, ya con descuentos. */
  readonly mensualCentavos: number;
  /** La parte que corresponde a los dias vigentes en el mes. */
  readonly proporcionalCentavos: number;
}

export type EstadoEstimacion = "estimado" | "sin_contrato";

export interface EstimacionFacturacion {
  readonly mes: string;
  readonly diasDelMes: number;
  readonly moneda: "MXN";
  readonly estado: EstadoEstimacion;
  readonly segmentos: readonly SegmentoEstimado[];
  readonly recurrenteCentavos: number | null;
  readonly bolsaMinutos: number | null;
  readonly minutosUsados: number | null;
  readonly minutosExcedentes: number | null;
  readonly tarifaExcedenteCentavosMinuto: number | null;
  readonly excedenteCentavos: number | null;
  /** Subtotal antes de IVA; `null` si falta el contrato o los minutos medidos. */
  readonly totalCentavos: number | null;
  readonly razonTotal: string | null;
  readonly supuestos: readonly string[];
}

export class ContratoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContratoInvalidoError";
  }
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/u;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const MAX_CENTAVOS = 100_000_000_000; // 1,000 millones de pesos: tope de cordura, lejos de 2^53.
const MS_DIA = 86_400_000;

function aDiaUtc(fecha: string): number {
  if (!FECHA_RE.test(fecha)) throw new ContratoInvalidoError(`fecha invalida: ${fecha}`);
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const chk = new Date(ms);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) throw new ContratoInvalidoError(`fecha inexistente: ${fecha}`);
  return Math.round(ms / MS_DIA);
}

function deDiaUtc(dia: number): string {
  return new Date(dia * MS_DIA).toISOString().slice(0, 10);
}

/** Dias del mes `YYYY-MM` (28 a 31). */
export function diasDelMes(mes: string): number {
  if (!MES_RE.test(mes)) throw new ContratoInvalidoError(`mes invalido: ${mes}`);
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Division entera con redondeo mitad hacia arriba para enteros no negativos. */
export function divRedondeada(numerador: number, denominador: number): number {
  if (!Number.isSafeInteger(numerador) || !Number.isSafeInteger(denominador) || numerador < 0 || denominador <= 0) throw new ContratoInvalidoError("division entera invalida");
  return Math.floor((2 * numerador + denominador) / (2 * denominador));
}

function entero(valor: number, campo: string, max = MAX_CENTAVOS): void {
  if (!Number.isInteger(valor) || valor < 0 || valor > max) throw new ContratoInvalidoError(`${campo} debe ser un entero entre 0 y ${max}`);
}

/** Valida los terminos de UNA version (la base de datos aplica los mismos limites con CHECK). */
export function validarTerminos(t: TerminosContrato): void {
  const desde = aDiaUtc(t.vigenteDesde);
  if (t.vigenteHasta !== null && aDiaUtc(t.vigenteHasta) < desde) throw new ContratoInvalidoError("vigenteHasta no puede ser anterior a vigenteDesde");
  entero(t.baseCentavos, "baseCentavos");
  entero(t.porSucursalCentavos, "porSucursalCentavos");
  entero(t.sucursalesIncluidas, "sucursalesIncluidas", 100_000);
  entero(t.bolsaMinutos, "bolsaMinutos", 100_000_000);
  entero(t.excedenteCentavosMinuto, "excedenteCentavosMinuto");
  entero(t.instalacionCentavos, "instalacionCentavos");
  entero(t.descuentoBp, "descuentoBp", 10_000);
  entero(t.descuentoFijoCentavos, "descuentoFijoCentavos");
}

/** Dos rangos de fechas inclusivos (`hasta` null = sin fin) se traslapan. */
export function vigenciasSeTraslapan(a: { desde: string; hasta: string | null }, b: { desde: string; hasta: string | null }): boolean {
  const aDesde = aDiaUtc(a.desde);
  const bDesde = aDiaUtc(b.desde);
  const aHasta = a.hasta === null ? Number.POSITIVE_INFINITY : aDiaUtc(a.hasta);
  const bHasta = b.hasta === null ? Number.POSITIVE_INFINITY : aDiaUtc(b.hasta);
  return aDesde <= bHasta && bDesde <= aHasta;
}

export interface VigenciaEfectiva {
  readonly v: VersionContrato;
  readonly desde: number;
  /** Infinity = sin fin. */
  readonly hasta: number;
}

/** Rango efectivo de cada version: hasta el dia anterior a la siguiente version del mismo contrato o el fin del contrato. */
export function resolverVigencias(versiones: readonly VersionContrato[]): readonly VigenciaEfectiva[] {
  const porContrato = new Map<string, VersionContrato[]>();
  for (const v of versiones) {
    validarTerminos(v);
    if (!Number.isInteger(v.version) || v.version < 1) throw new ContratoInvalidoError("version debe ser un entero >= 1");
    const lista = porContrato.get(v.contractId) ?? [];
    lista.push(v);
    porContrato.set(v.contractId, lista);
  }
  const out: VigenciaEfectiva[] = [];
  for (const lista of porContrato.values()) {
    lista.sort((x, y) => x.version - y.version);
    for (let i = 0; i < lista.length; i += 1) {
      const v = lista[i] as VersionContrato;
      const sig = lista[i + 1];
      if (sig && aDiaUtc(sig.vigenteDesde) <= aDiaUtc(v.vigenteDesde)) throw new ContratoInvalidoError("las versiones de un contrato deben tener vigenteDesde estrictamente creciente");
      const finContrato = v.vigenteHasta === null ? Number.POSITIVE_INFINITY : aDiaUtc(v.vigenteHasta);
      const finPorSiguiente = sig ? aDiaUtc(sig.vigenteDesde) - 1 : Number.POSITIVE_INFINITY;
      out.push({ v, desde: aDiaUtc(v.vigenteDesde), hasta: Math.min(finContrato, finPorSiguiente) });
    }
  }
  out.sort((a, b) => a.desde - b.desde);
  return out;
}

/** Recurrente mensual completo (centavos) de una version, con los descuentos aplicados y piso en 0. */
export function recurrenteMensual(t: TerminosContrato, sucursalesActivas: number): { brutoMensualCentavos: number; sucursalesExtra: number; descuentoPorcentualCentavos: number; descuentoFijoCentavos: number; mensualCentavos: number } {
  entero(sucursalesActivas, "sucursalesActivas", 1_000_000);
  const sucursalesExtra = Math.max(0, sucursalesActivas - t.sucursalesIncluidas);
  const brutoMensualCentavos = t.baseCentavos + sucursalesExtra * t.porSucursalCentavos;
  if (!Number.isSafeInteger(brutoMensualCentavos) || brutoMensualCentavos > MAX_CENTAVOS * 10) throw new ContratoInvalidoError("el recurrente bruto excede el limite de cordura");
  const descuentoPorcentualCentavos = divRedondeada(brutoMensualCentavos * t.descuentoBp, 10_000);
  const descuentoFijoCentavos = Math.min(t.descuentoFijoCentavos, Math.max(0, brutoMensualCentavos - descuentoPorcentualCentavos));
  const mensualCentavos = Math.max(0, brutoMensualCentavos - descuentoPorcentualCentavos - descuentoFijoCentavos);
  return { brutoMensualCentavos, sucursalesExtra, descuentoPorcentualCentavos, descuentoFijoCentavos, mensualCentavos };
}

const SUPUESTOS = [
  "Subtotal antes de IVA, en MXN, en centavos enteros. Es una estimacion: no cobra ni emite ninguna factura.",
  "La instalacion no entra en la estimacion mensual (se factura por hito).",
  "El numero de sucursales es el de HOY: no hay historial de altas y bajas por dia.",
  "Con un cambio de condiciones a mitad de mes, el recurrente se prorratea por dias vigentes de cada version; la bolsa de minutos se prorratea igual y el excedente se cobra a la tarifa de la ultima version vigente del mes.",
];

/**
 * Facturacion estimada de un mes a partir del contrato. Lanza `ContratoInvalidoError` si los datos son
 * incoherentes (versiones no crecientes, dos contratos traslapados dentro del mes, montos fuera de rango).
 */
export function estimarFacturacionMes(entrada: EntradaEstimacion): EstimacionFacturacion {
  const dias = diasDelMes(entrada.mes);
  const primero = aDiaUtc(`${entrada.mes}-01`);
  const ultimo = primero + dias - 1;
  const efectivas = resolverVigencias(entrada.versiones);

  const delMes = efectivas
    .map((e) => ({ e, desde: Math.max(e.desde, primero), hasta: Math.min(e.hasta, ultimo) }))
    .filter((x) => x.desde <= x.hasta);

  for (let i = 1; i < delMes.length; i += 1) {
    const prev = delMes[i - 1] as (typeof delMes)[number];
    const cur = delMes[i] as (typeof delMes)[number];
    if (cur.desde <= prev.hasta) throw new ContratoInvalidoError("hay dos versiones de contrato vigentes el mismo dia dentro del mes (vigencias traslapadas)");
  }

  if (delMes.length === 0) {
    return {
      mes: entrada.mes,
      diasDelMes: dias,
      moneda: "MXN",
      estado: "sin_contrato",
      segmentos: [],
      recurrenteCentavos: null,
      bolsaMinutos: null,
      minutosUsados: entrada.minutosVoz,
      minutosExcedentes: null,
      tarifaExcedenteCentavosMinuto: null,
      excedenteCentavos: null,
      totalCentavos: null,
      razonTotal: "No hay un contrato vigente en este mes: no se inventa una cifra.",
      supuestos: SUPUESTOS,
    };
  }

  const calculos = delMes.map((x) => {
    const diasSeg = x.hasta - x.desde + 1;
    const r = recurrenteMensual(x.e.v, entrada.sucursalesActivas);
    return { x, diasSeg, r, numerador: r.mensualCentavos * diasSeg, bolsaNumerador: x.e.v.bolsaMinutos * diasSeg };
  });

  // Un solo redondeo del total (mitad hacia arriba) y reparto del residuo por mayor fraccion (empate: la mas antigua).
  const totalNumerador = calculos.reduce((s, c) => s + c.numerador, 0);
  const recurrente = divRedondeada(totalNumerador, dias);
  const base = calculos.map((c) => Math.floor(c.numerador / dias));
  let residuo = recurrente - base.reduce((s, b) => s + b, 0);
  const orden = calculos.map((c, i) => ({ i, frac: c.numerador % dias })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of orden) {
    if (residuo <= 0) break;
    base[o.i] = (base[o.i] as number) + 1;
    residuo -= 1;
  }

  const segmentos: SegmentoEstimado[] = calculos.map((c, i) => ({
    contractId: c.x.e.v.contractId,
    version: c.x.e.v.version,
    desde: deDiaUtc(c.x.desde),
    hasta: deDiaUtc(c.x.hasta),
    dias: c.diasSeg,
    brutoMensualCentavos: c.r.brutoMensualCentavos,
    sucursalesExtra: c.r.sucursalesExtra,
    descuentoPorcentualCentavos: c.r.descuentoPorcentualCentavos,
    descuentoFijoCentavos: c.r.descuentoFijoCentavos,
    mensualCentavos: c.r.mensualCentavos,
    proporcionalCentavos: base[i] as number,
  }));

  const bolsa = divRedondeada(
    calculos.reduce((s, c) => s + c.bolsaNumerador, 0),
    dias,
  );
  const ultima = calculos[calculos.length - 1] as (typeof calculos)[number];
  const tarifa = ultima.x.e.v.excedenteCentavosMinuto;

  if (entrada.minutosVoz !== null) entero(entrada.minutosVoz, "minutosVoz", 1_000_000_000);
  const minutosExcedentes = entrada.minutosVoz === null ? null : Math.max(0, entrada.minutosVoz - bolsa);
  const excedente = minutosExcedentes === null ? null : minutosExcedentes * tarifa;
  if (excedente !== null && !Number.isSafeInteger(excedente)) throw new ContratoInvalidoError("el excedente excede el limite de cordura");

  return {
    mes: entrada.mes,
    diasDelMes: dias,
    moneda: "MXN",
    estado: "estimado",
    segmentos,
    recurrenteCentavos: recurrente,
    bolsaMinutos: bolsa,
    minutosUsados: entrada.minutosVoz,
    minutosExcedentes,
    tarifaExcedenteCentavosMinuto: tarifa,
    excedenteCentavos: excedente,
    totalCentavos: excedente === null ? null : recurrente + excedente,
    razonTotal: excedente === null ? "Los minutos de voz del mes no estan medidos todavia: solo se conoce el recurrente." : null,
    supuestos: SUPUESTOS,
  };
}
