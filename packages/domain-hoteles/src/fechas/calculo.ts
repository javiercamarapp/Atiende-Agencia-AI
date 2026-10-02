// H-28 -- previsualizacion y reglas puras del cambio de fechas. Determinista y sin I/O: recibe tarifas, impuestos,
// politica de cancelacion e inventario ya leidos. El total SIEMPRE sale del motor de cotizacion (`computeQuote`), nunca de
// un monto que mande el cliente. La base (`hoteles.change_reservation_dates`) revalida lo que importa bajo bloqueo.
import { roundCurrency } from "../money.ts";
import { canBook } from "../overbooking.ts";
import { QuoteError, computeQuote, nightsBetween } from "../quote.ts";
import { evaluateCancellation } from "../reservationStateMachine.ts";
import type { ReservationStatus } from "../reservationStateMachine.ts";
import { applyTaxes } from "../taxes.ts";
import type { TaxConfig } from "../taxes.ts";
import type { CancellationPolicyRecord, NightlyRateRecord } from "../types.ts";
import type { BloqueoCambioFechas, DesgloseEstancia, DisponibilidadTipo, PenalidadAcortamiento, PrevisualizacionCambioFechas } from "./tipos.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODIFICABLES: ReadonlySet<ReservationStatus> = new Set(["confirmada", "check_in", "en_estancia"]);
const EN_CASA: ReadonlySet<ReservationStatus> = new Set(["check_in", "en_estancia"]);
export const MAX_NOCHES_CAMBIO = 365;

export function esFechaIso(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export interface PrevisualizarCambioFechasInput {
  readonly estado: ReservationStatus;
  readonly entrada: string;
  readonly salida: string;
  /** Monto NETO guardado en la reserva. */
  readonly totalNeto: number;
  readonly nuevaEntrada: string;
  readonly nuevaSalida: string;
  /** Fecha de hoy en la zona horaria de la property (YYYY-MM-DD). */
  readonly hoy: string;
  readonly ahora: Date;
  /** Tarifas que cubren desde la fecha mas temprana hasta la mas tardia (inclusive) de ambas estadias. */
  readonly tarifas: readonly NightlyRateRecord[];
  readonly impuestos: TaxConfig;
  readonly politica: CancellationPolicyRecord | null;
  readonly disponibilidad: DisponibilidadTipo;
}

function desglose(entrada: string, salida: string, neto: number, impuestos: TaxConfig): DesgloseEstancia {
  const t = applyTaxes(neto, impuestos);
  return { entrada, salida, noches: nightsBetween(entrada, salida).length, neto: t.netAmount, iva: t.ivaAmount, ish: t.ishAmount, total: t.totalAmount };
}

function diferencia(a: readonly string[], b: ReadonlySet<string>): string[] {
  return a.filter((x) => !b.has(x));
}

/** Calcula la recotizacion y todo lo que impide (o condiciona) el cambio. No lanza: los motivos van en `bloqueos`. */
export function previsualizarCambioFechas(i: PrevisualizarCambioFechasInput): PrevisualizacionCambioFechas {
  const bloqueos: BloqueoCambioFechas[] = [];
  const bloquear = (codigo: string, mensaje: string) => bloqueos.push({ codigo, mensaje });
  const actual = desglose(i.entrada, i.salida, i.totalNeto, i.impuestos);
  const enCasa = EN_CASA.has(i.estado);

  const vacia = (): PrevisualizacionCambioFechas => ({
    puedeCambiar: false,
    bloqueos,
    estado: i.estado,
    actual,
    nueva: null,
    diferenciaTotal: null,
    nochesAgregadas: [],
    nochesQuitadas: [],
    nochesSinCupo: [],
    penalidad: { monto: 0, porcentaje: 0, horasParaLaNoche: null },
  });

  if (!MODIFICABLES.has(i.estado)) {
    bloquear("reserva_no_modificable", `La reserva esta en estado "${i.estado}": solo se cambian fechas de reservas confirmadas o en casa.`);
    return vacia();
  }
  if (!esFechaIso(i.nuevaEntrada) || !esFechaIso(i.nuevaSalida) || i.nuevaSalida <= i.nuevaEntrada) {
    bloquear("fechas_invalidas", "La salida debe ser posterior a la llegada (formato YYYY-MM-DD).");
    return vacia();
  }
  if (nightsBetween(i.nuevaEntrada, i.nuevaSalida).length > MAX_NOCHES_CAMBIO) {
    bloquear("fechas_invalidas", `La estancia no puede pasar de ${MAX_NOCHES_CAMBIO} noches.`);
    return vacia();
  }
  if (i.nuevaEntrada === i.entrada && i.nuevaSalida === i.salida) {
    bloquear("sin_cambio", "Las fechas son las mismas que las actuales.");
    return vacia();
  }
  if (enCasa && i.nuevaEntrada !== i.entrada) {
    bloquear("llegada_no_modificable", "Con el huesped en casa solo se puede cambiar la fecha de salida.");
  }
  if (!enCasa && i.nuevaEntrada < i.hoy) {
    bloquear("llegada_pasada", "La nueva llegada no puede ser anterior a hoy.");
  }
  if (enCasa && i.nuevaSalida < i.hoy) {
    bloquear("salida_pasada", "La nueva salida no puede ser anterior a hoy.");
  }

  const viejas = nightsBetween(i.entrada, i.salida);
  const nuevas = nightsBetween(i.nuevaEntrada, i.nuevaSalida);
  const setViejas = new Set(viejas);
  const setNuevas = new Set(nuevas);
  const nochesAgregadas = diferencia(nuevas, setViejas);
  const nochesQuitadas = diferencia(viejas, setNuevas);

  // Recotizacion con el motor determinista. Con el huesped en casa la llegada ya ocurrio: se neutralizan las restricciones
  // de llegada (CTA / estancia minima) de la fecha original para no rechazar una extension legitima.
  const tarifas = i.tarifas.map((r) => (enCasa && r.date === i.entrada ? { ...r, closedToArrival: false, minStay: 1 } : r));
  let nueva: DesgloseEstancia | null = null;
  try {
    const q = computeQuote({
      checkInDate: i.nuevaEntrada,
      checkOutDate: i.nuevaSalida,
      currency: "MXN",
      nightlyRates: tarifas,
      taxConfig: { ivaRate: i.impuestos.ivaRate, ishRate: i.impuestos.ishRate },
    });
    nueva = { entrada: i.nuevaEntrada, salida: i.nuevaSalida, noches: q.nights, neto: q.netAmount, iva: q.ivaAmount, ish: q.ishAmount, total: q.totalAmount };
  } catch (err) {
    if (err instanceof QuoteError) bloquear(err.code, err.message);
    else throw err;
  }

  // Cupo: solo las noches AGREGADAS piden inventario (las que ya tenia la propia reserva siguen siendo suyas).
  const nochesSinCupo: string[] = [];
  for (const night of nochesAgregadas) {
    const fila = i.disponibilidad.noches.find((n) => n.date === night);
    if (!fila || !canBook(fila.totalRooms, fila.bookedRooms, 1, i.disponibilidad.overbooking)) nochesSinCupo.push(night);
  }
  if (nochesSinCupo.length > 0) bloquear("sin_disponibilidad", `No hay habitaciones libres en: ${nochesSinCupo.join(", ")}.`);

  const penalidad = calcularPenalidadAcortamiento({ nochesQuitadas, tarifas: i.tarifas, totalNetoActual: i.totalNeto, nochesActuales: viejas.length, ahora: i.ahora, politica: i.politica });

  return {
    puedeCambiar: bloqueos.length === 0 && nueva !== null,
    bloqueos,
    estado: i.estado,
    actual,
    nueva,
    diferenciaTotal: nueva ? roundCurrency(nueva.total - actual.total) : null,
    nochesAgregadas,
    nochesQuitadas,
    nochesSinCupo,
    penalidad,
  };
}

/** Penalidad por quitar noches segun la politica de cancelacion: dentro de la ventana libre no hay cargo; fuera de ella se
 *  cobra `penaltyPct` del valor neto de las noches quitadas (medido desde la primera noche quitada). Informativa: no se
 *  postea sola al folio. */
export function calcularPenalidadAcortamiento(i: {
  readonly nochesQuitadas: readonly string[];
  readonly tarifas: readonly NightlyRateRecord[];
  readonly totalNetoActual: number;
  readonly nochesActuales: number;
  readonly ahora: Date;
  readonly politica: CancellationPolicyRecord | null;
}): PenalidadAcortamiento {
  if (i.nochesQuitadas.length === 0) return { monto: 0, porcentaje: 0, horasParaLaNoche: null };
  const primera = [...i.nochesQuitadas].sort()[0] as string;
  const politica = i.politica ?? { freeUntilHours: Number.POSITIVE_INFINITY, penaltyPct: 0 };
  const ev = evaluateCancellation({ checkInDate: primera, now: i.ahora, policy: { freeUntilHours: politica.freeUntilHours, penaltyPct: politica.penaltyPct } });
  const promedio = i.nochesActuales > 0 ? i.totalNetoActual / i.nochesActuales : 0;
  const porFecha = new Map(i.tarifas.map((r) => [r.date, r.price]));
  const valor = i.nochesQuitadas.reduce((acc, n) => acc + (porFecha.get(n) ?? promedio), 0);
  return { monto: roundCurrency(valor * ev.penaltyPct), porcentaje: ev.penaltyPct, horasParaLaNoche: Math.round(ev.hoursUntilCheckIn * 10) / 10 };
}
