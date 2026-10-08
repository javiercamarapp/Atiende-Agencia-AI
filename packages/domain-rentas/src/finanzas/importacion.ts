// Rn-P3-06 -- importacion del reporte de pagos de la OTA. Orquesta el parseo ya hecho (csv/*), el emparejamiento por codigo de
// confirmacion y la creacion/conciliacion de movimientos, sobre el puerto `RentasRepository`. NO hace IO propio: la ruta HTTP abre la
// transaccion (una por archivo; un error en cualquier linea revierte todo el archivo) y decide la bitacora.
//
// Reglas por linea de tipo `reserva` (una `ajuste` siempre queda `pendiente` para revision humana):
//   * huella ya importada y resuelta -> `ya_importada` (idempotente: nada se escribe). Una pendiente se REEVALUA (puede que la reserva
//     haya llegado despues por iCal).
//   * sin reserva con ese codigo en esta property/canal, reserva cancelada o codigo ambiguo -> `pendiente`.
//   * reserva sin movimiento -> se crea con la regla de comision vigente (Rn-18). Finanzas-1: si el canal entrega neto, el monto de la
//     linea es el recibido y la comision de canal NO se resta otra vez. Sin regla -> `pendiente`. Si la comision que reporta el archivo
//     difiere de la esperada por la regla en mas de 1 % del bruto -> se crea igual pero `discrepancia` y el movimiento queda en revision.
//   * reserva con movimiento -> se concilia: monto recibido igual -> `conciliada`; distinto o moneda distinta -> `discrepancia`.
import { ReglaComisionCanalNoConfiguradaError } from "../errors.ts";
import type { LineaReporteCanal, ResultadoParseoReporte } from "./csv/tipos.ts";
import { calcularMovimientoReserva } from "./movimiento.ts";
import { aplicarPorcentaje } from "./redondeo.ts";
import type { CandidataImportacion, ConfiguracionComisionCanal, RentasRepository, ResultadoLineaImportacion } from "../repository.ts";
import type { ConfiguracionComisionGestor } from "./tipos.ts";

export type ResultadoLineaPresentado = ResultadoLineaImportacion | "ya_importada";

export interface LineaResultadoImportacion {
  readonly fila: number;
  readonly tipoLinea: "reserva" | "ajuste";
  readonly codigoConfirmacion: string | null;
  readonly moneda: string;
  readonly montoNetoCentavos: number;
  readonly resultado: ResultadoLineaPresentado;
  readonly nota: string | null;
  readonly ocupacionId: string | null;
}

export interface ResumenImportacion {
  readonly totalLineas: number;
  readonly creadas: number;
  readonly conciliadas: number;
  readonly discrepancias: number;
  readonly pendientes: number;
  readonly yaImportadas: number;
  readonly ignoradas: number;
  readonly errores: number;
}

export interface ResultadoImportacion {
  readonly aplicado: boolean;
  readonly importacionId: string | null;
  readonly resumen: ResumenImportacion;
  readonly lineas: readonly LineaResultadoImportacion[];
}

export interface EntradaImportarPagos {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly userId: string;
  readonly canal: { readonly id: string; readonly codigo: string };
  readonly parseo: ResultadoParseoReporte;
  readonly archivoSha256: string;
  /** `false` = vista previa: calcula el mismo resultado sin escribir nada. */
  readonly aplicar: boolean;
  readonly comisionGestor: ConfiguracionComisionGestor;
}

/** Tolerancia de la comision reportada frente a la esperada: 1 % del ingreso bruto (100 pb). */
export const TOLERANCIA_COMISION_BASIS_POINTS = 100;

export const NOTA_SIN_RESERVA = "No hay una reserva con ese codigo en esta propiedad: sincroniza el calendario del canal o registra la reserva.";
export const NOTA_AJUSTE = "Ajuste, devolucion o monto negativo: revisalo a mano, no se convierte en movimiento solo.";

interface Evaluacion {
  readonly resultado: ResultadoLineaImportacion;
  readonly nota: string | null;
  readonly ocupacionId: string | null;
  /** Solo si hay que crear el movimiento. */
  readonly crear?: { readonly requiereRevision: boolean; readonly motivo: "discrepancia_importacion"; readonly calculo: ReturnType<typeof calcularMovimientoReserva>; readonly regla: ConfiguracionComisionCanal; readonly montoBrutoCentavos: number };
}

function diferenciaExcedeTolerancia(reportada: number, esperada: number, brutoCentavos: number): boolean {
  const dif = Math.abs(reportada - esperada);
  if (dif === 0) return false;
  return dif * 10000 > brutoCentavos * TOLERANCIA_COMISION_BASIS_POINTS;
}

function evaluarLinea(
  linea: LineaReporteCanal,
  candidatas: readonly CandidataImportacion[],
  regla: ConfiguracionComisionCanal | null,
  gestor: ConfiguracionComisionGestor,
  codigosCreadosOConciliados: Set<string>,
): Evaluacion {
  if (linea.tipoLinea === "ajuste") return { resultado: "pendiente", nota: NOTA_AJUSTE, ocupacionId: null };
  const codigo = linea.codigoConfirmacion!;
  const vivas = candidatas.filter((c) => c.estado !== "cancelado");
  if (vivas.length === 0) {
    if (candidatas.length > 0) return { resultado: "pendiente", nota: "La reserva con ese codigo esta cancelada en Atiende: revisa si el pago corresponde.", ocupacionId: candidatas[0]!.ocupacionId };
    return { resultado: "pendiente", nota: NOTA_SIN_RESERVA, ocupacionId: null };
  }
  if (vivas.length > 1) return { resultado: "pendiente", nota: "Hay mas de una reserva activa con ese codigo: resuelve el duplicado antes de conciliar.", ocupacionId: null };
  const reserva = vivas[0]!;
  if (codigosCreadosOConciliados.has(codigo)) return { resultado: "pendiente", nota: "El codigo se repite en el archivo: solo una linea de reserva por codigo se concilia.", ocupacionId: reserva.ocupacionId };

  if (reserva.tieneMovimiento) {
    if (reserva.moneda !== null && reserva.moneda !== linea.moneda) return { resultado: "discrepancia", nota: `Moneda distinta: el movimiento esta en ${reserva.moneda} y el reporte en ${linea.moneda}.`, ocupacionId: reserva.ocupacionId };
    const esperado = reserva.montoRecibidoCentavos ?? 0;
    if (esperado === linea.montoNetoCentavos) return { resultado: "conciliada", nota: null, ocupacionId: reserva.ocupacionId };
    return { resultado: "discrepancia", nota: `El monto recibido del reporte (${linea.montoNetoCentavos}) no coincide con el movimiento registrado (${esperado}), en centavos.`, ocupacionId: reserva.ocupacionId };
  }

  if (regla === null) {
    return { resultado: "pendiente", nota: "El canal no tiene regla de comision: configurala en Finanzas > Comisiones de canal y vuelve a subir el archivo.", ocupacionId: reserva.ocupacionId };
  }
  let montoBruto: number;
  if (regla.yaNetoDeComision) {
    // Finanzas-1: el canal entrega neto -> el monto de entrada es lo recibido; la comision de canal no se vuelve a restar.
    montoBruto = linea.montoNetoCentavos;
  } else {
    if (linea.montoBrutoCentavos === null) {
      return { resultado: "pendiente", nota: "El reporte no trae el ingreso bruto y la regla del canal parte del bruto: no se puede calcular la comision.", ocupacionId: reserva.ocupacionId };
    }
    montoBruto = linea.montoBrutoCentavos;
  }
  const calculo = calcularMovimientoReserva({ ocupacionUnidadId: reserva.ocupacionId, moneda: linea.moneda, montoBrutoCentavos: montoBruto, comisionCanal: regla, comisionGestor: gestor, gastos: [], impuestos: [] });

  // Comision esperada por la regla vs la que reporta el archivo (bruto - neto).
  let esperada: number | null = null;
  if (!regla.yaNetoDeComision) esperada = calculo.comisionCanalCentavos;
  else if (regla.comisionBasisPoints > 0 && linea.montoBrutoCentavos !== null) esperada = aplicarPorcentaje(linea.montoBrutoCentavos, regla.comisionBasisPoints);
  const baseTolerancia = linea.montoBrutoCentavos ?? montoBruto;
  const discrepa = esperada !== null && linea.comisionCanalCentavos !== null && diferenciaExcedeTolerancia(linea.comisionCanalCentavos, esperada, baseTolerancia);
  if (discrepa) {
    return {
      resultado: "discrepancia",
      nota: `La comision del reporte (${linea.comisionCanalCentavos}) difiere de la esperada por la regla (${esperada}) en mas de 1 % del bruto, en centavos. El movimiento se creo y queda en revision.`,
      ocupacionId: reserva.ocupacionId,
      crear: { requiereRevision: true, motivo: "discrepancia_importacion", calculo, regla, montoBrutoCentavos: montoBruto },
    };
  }
  return { resultado: "creada", nota: null, ocupacionId: reserva.ocupacionId, crear: { requiereRevision: false, motivo: "discrepancia_importacion", calculo, regla, montoBrutoCentavos: montoBruto } };
}

export async function importarReportePagos(repo: RentasRepository, entrada: EntradaImportarPagos): Promise<ResultadoImportacion> {
  const { parseo, canal } = entrada;
  if (entrada.aplicar) await repo.bloquearImportacionPagos(entrada.propertyId, canal.id);

  const codigos = [...new Set(parseo.lineas.filter((l) => l.tipoLinea === "reserva" && l.codigoConfirmacion).map((l) => l.codigoConfirmacion!))];
  const candidatas = codigos.length === 0 ? [] : await repo.findCandidatasImportacion(entrada.propertyId, canal.id, codigos);
  const porCodigo = new Map<string, CandidataImportacion[]>();
  for (const c of candidatas) porCodigo.set(c.codigoConfirmacion, [...(porCodigo.get(c.codigoConfirmacion) ?? []), c]);

  const existentes = new Map((parseo.lineas.length === 0 ? [] : await repo.findLineasImportadas(entrada.propertyId, canal.id, parseo.lineas.map((l) => l.huella))).map((e) => [e.huella, e]));

  let regla: ConfiguracionComisionCanal | null = null;
  try {
    regla = await repo.findReglaComisionCanal(entrada.propertyId, canal.id);
  } catch (err) {
    if (!(err instanceof ReglaComisionCanalNoConfiguradaError)) throw err;
  }

  const usados = new Set<string>();
  const evaluadas: Array<{ linea: LineaReporteCanal; evaluacion: Evaluacion; existente: ReturnType<typeof existentes.get>; presentado: ResultadoLineaPresentado }> = [];
  for (const linea of parseo.lineas) {
    const existente = existentes.get(linea.huella);
    if (existente && existente.resultado !== "pendiente") {
      evaluadas.push({ linea, evaluacion: { resultado: existente.resultado, nota: existente.nota, ocupacionId: null }, existente, presentado: "ya_importada" });
      continue;
    }
    const evaluacion = evaluarLinea(linea, linea.codigoConfirmacion ? (porCodigo.get(linea.codigoConfirmacion) ?? []) : [], regla, entrada.comisionGestor, usados);
    if (evaluacion.resultado === "creada" || evaluacion.resultado === "conciliada" || (evaluacion.resultado === "discrepancia" && evaluacion.crear)) {
      if (linea.codigoConfirmacion) usados.add(linea.codigoConfirmacion);
    }
    // Una pendiente que sigue igual no cambia nada: se presenta como ya importada.
    const sinCambio = existente !== undefined && evaluacion.resultado === "pendiente" && evaluacion.nota === existente.nota;
    evaluadas.push({ linea, evaluacion, existente, presentado: sinCambio ? "ya_importada" : evaluacion.resultado });
  }

  const cuenta = (r: ResultadoLineaPresentado) => evaluadas.filter((e) => e.presentado === r).length;
  const resumen: ResumenImportacion = {
    totalLineas: parseo.lineas.length,
    creadas: cuenta("creada"),
    conciliadas: cuenta("conciliada"),
    discrepancias: cuenta("discrepancia"),
    pendientes: cuenta("pendiente"),
    yaImportadas: cuenta("ya_importada"),
    ignoradas: parseo.ignoradas,
    errores: parseo.errores.length,
  };

  const lineas: LineaResultadoImportacion[] = evaluadas.map((e) => ({
    fila: e.linea.fila,
    tipoLinea: e.linea.tipoLinea,
    codigoConfirmacion: e.linea.codigoConfirmacion,
    moneda: e.linea.moneda,
    montoNetoCentavos: e.linea.montoNetoCentavos,
    resultado: e.presentado,
    nota: e.evaluacion.nota,
    ocupacionId: e.evaluacion.ocupacionId,
  }));

  if (!entrada.aplicar) return { aplicado: false, importacionId: null, resumen, lineas };

  const importacion = await repo.insertImportacionPagos({
    organizationId: entrada.organizationId,
    propertyId: entrada.propertyId,
    canalId: canal.id,
    archivoSha256: entrada.archivoSha256,
    lineasTotal: resumen.totalLineas,
    creadas: resumen.creadas,
    conciliadas: resumen.conciliadas,
    discrepancias: resumen.discrepancias,
    pendientes: resumen.pendientes,
    yaImportadas: resumen.yaImportadas,
    ignoradas: resumen.ignoradas,
    createdBy: entrada.userId,
  });

  for (const e of evaluadas) {
    if (e.presentado === "ya_importada") continue;
    const { linea, evaluacion } = e;
    if (evaluacion.crear) {
      const { calculo, regla: reglaUsada, montoBrutoCentavos } = evaluacion.crear;
      await repo.insertReservaFinanciero({
        organizationId: entrada.organizationId,
        propertyId: entrada.propertyId,
        ocupacionId: evaluacion.ocupacionId!,
        moneda: linea.moneda,
        montoBrutoCentavos,
        yaNetoDeComision: reglaUsada.yaNetoDeComision,
        comisionCanalBasisPoints: reglaUsada.comisionBasisPoints,
        comisionCanalFuente: calculo.comisionCanalFuente,
        comisionCanalCentavos: calculo.comisionCanalCentavos,
        comisionGestorBasisPoints: entrada.comisionGestor.basisPoints,
        comisionGestorBase: entrada.comisionGestor.base,
        comisionGestorCentavos: calculo.comisionGestorCentavos,
        montoRecibidoCentavos: calculo.montoRecibidoCentavos,
        gastos: [],
        gastosCentavos: 0,
        impuestos: [],
        impuestosCentavos: 0,
        netoCentavos: calculo.netoCentavos,
        createdBy: entrada.userId,
        origen: "importacion_csv",
        requiereRevision: evaluacion.crear.requiereRevision,
        motivoRevision: evaluacion.crear.requiereRevision ? evaluacion.crear.motivo : null,
      });
    }
    if (e.existente) {
      await repo.actualizarLineaImportada({ id: e.existente.id, ocupacionId: evaluacion.ocupacionId, resultado: evaluacion.resultado, nota: evaluacion.nota });
    } else {
      await repo.insertLineaImportada({
        importacionId: importacion.id,
        organizationId: entrada.organizationId,
        propertyId: entrada.propertyId,
        canalId: canal.id,
        huella: linea.huella,
        codigoConfirmacion: linea.codigoConfirmacion,
        tipoLinea: linea.tipoLinea,
        fecha: linea.fecha,
        moneda: linea.moneda,
        montoNetoCentavos: linea.montoNetoCentavos,
        montoBrutoCentavos: linea.montoBrutoCentavos,
        comisionCanalCentavos: linea.comisionCanalCentavos,
        ocupacionId: evaluacion.ocupacionId,
        resultado: evaluacion.resultado,
        nota: evaluacion.nota,
      });
    }
  }

  return { aplicado: true, importacionId: importacion.id, resumen, lineas };
}
