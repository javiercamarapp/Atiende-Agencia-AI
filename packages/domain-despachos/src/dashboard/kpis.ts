// Dashboard gerencial de despachos (D-01) — KPIs por cliente (contribuyente = property) y
// consolidado del despacho (organización). Motor PURO: sin I/O, sin reloj (`hoy` llega
// inyectado, ya resuelto en la zona horaria del negocio por la capa de ruta), y sin
// inventar cifras: cada bloque de KPIs se calcula SOLO desde datos que el modelo ya
// persiste (CFDI, cuentas por cobrar + eventos de cobranza, revisiones humanas,
// vencimientos fiscales, períodos de cierre mensual y sus tareas).
//
// Contrato de "sin datos" (hallazgo de compatibilidad con la base sin migrar): cada
// fuente llega como `T | null`. `null` = la fuente no se pudo leer (p. ej. la base real
// todavía no tiene la tabla, SQLSTATE 42P01/42703/42883) y el bloque que dependía solo de
// ella queda en `null` en vez de un cero engañoso; `fuentesNoDisponibles` lo declara
// para que la UI muestre "sin datos" y no una cifra falsa.
//
// Lo que NO existe en el modelo y por lo tanto NO se calcula aquí: asignación de trabajo
// por miembro del staff (ninguna tabla guarda "responsable" de una revisión/tarea),
// CFDI emitidos por el contribuyente (IVA trasladado), nómina procesada y asientos
// contables. La "carga de trabajo" es por cliente (pendientes accionables), no por persona.
import type { CloseTask, ClosePeriod } from "../cierre-mensual/types.ts";
import { calcularEstadoPeriodo, recomputeOverdue } from "../cierre-mensual/engine.ts";
import { COBRANZA_AGE_BUCKETS, cobranzaAgeBucket, diasVencidoCartera, scoreCobrabilidadCartera } from "../cobranza/engine.ts";
import type { CobranzaAgeBucket, HistorialCobranzaEntry } from "../cobranza/engine.ts";
import { diasHasta } from "../vencimientos/engine.ts";
import type { FiscalDeadlineRecord, InvoiceRecord, InvoiceReviewRecord, ReceivableRecord } from "../types.ts";

export type FuenteDashboard = "cartera" | "revisiones" | "vencimientos" | "cierre" | "cfdi";
export type SeveridadAnomalia = "alta" | "media" | "baja";
export type NivelAtencion = "critico" | "atencion" | "al_corriente" | "sin_datos";

/** Días de una revisión humana pendiente antes de considerarla "antigua" (anomalía media). */
export const DIAS_REVISION_ANTIGUA = 7;
/** Ventana (días) para considerar un vencimiento fiscal "próximo". */
export const DIAS_VENCIMIENTO_PROXIMO = 7;
/** Score de cobrabilidad por debajo del cual una cuenta se considera de riesgo (mismo umbral que `resumenCobranza`). */
export const SCORE_COBRANZA_BAJO = 0.4;

export interface AnomaliaDashboard {
  readonly codigo: string;
  readonly severidad: SeveridadAnomalia;
  readonly mensaje: string;
  readonly cantidad: number;
  /** Monto asociado (MXN) cuando la anomalía es monetaria; `null` si no aplica. */
  readonly monto: number | null;
}

export interface CarteraEntrada {
  /** Cartera completa (pendiente y pagada). */
  readonly cuentas: readonly ReceivableRecord[];
  /** `invoice.total` por `invoiceId`; una cuenta cuyo CFDI no aparece se cuenta con monto 0 y en `cuentasSinMonto`. */
  readonly totalPorInvoiceId: ReadonlyMap<string, number>;
  readonly historialPorCuenta: ReadonlyMap<string, readonly HistorialCobranzaEntry[]>;
}

export interface CierreEntrada {
  readonly periodo: ClosePeriod;
  readonly tareas: readonly CloseTask[];
}

export interface EntradaKpisCliente {
  readonly propertyId: string;
  readonly nombre: string;
  /** Fecha de negocio "YYYY-MM-DD" ya resuelta en la zona horaria del cliente. */
  readonly hoy: string;
  readonly cartera: CarteraEntrada | null;
  readonly revisionesPendientes: readonly Pick<InvoiceReviewRecord, "id" | "createdAt">[] | null;
  readonly vencimientos: readonly Pick<FiscalDeadlineRecord, "id" | "tipo" | "estado" | "fechaLimite">[] | null;
  readonly cierres: readonly CierreEntrada[] | null;
  /** CFDI del mes en curso (`invoice.fecha` dentro de `hoy`'s mes). */
  readonly cfdiMes: readonly Pick<InvoiceRecord, "valido" | "requiresHumanReview">[] | null;
}

export interface KpisCartera {
  readonly cuentasPendientes: number;
  readonly montoPendiente: number;
  readonly cuentasVencidas: number;
  readonly montoVencido: number;
  readonly cuentas90Mas: number;
  readonly monto90Mas: number;
  readonly porAntiguedad: Readonly<Record<CobranzaAgeBucket, { readonly count: number; readonly monto: number }>>;
  /** Promedio del score de cobrabilidad de la cartera pendiente; `null` si no hay cuentas pendientes. */
  readonly scorePromedio: number | null;
  readonly cuentasSinCorreo: number;
  readonly cuentasSinMonto: number;
  readonly cuentasCobradas: number;
  readonly montoCobrado: number;
  /** cobrado / (cobrado + pendiente) × 100, 1 decimal; `null` si no hay cartera registrada. */
  readonly tasaCobranzaPct: number | null;
}

export interface KpisCargaTrabajo {
  readonly revisionesPendientes: number | null;
  readonly revisionesAntiguas: number | null;
  readonly vencimientosAbiertos: number | null;
  readonly vencimientosVencidos: number | null;
  readonly vencimientosProximos: number | null;
  readonly tareasCierrePendientes: number | null;
  readonly tareasCierreVencidas: number | null;
  /** Suma de los pendientes accionables de las fuentes disponibles (revisiones + vencimientos abiertos + tareas de cierre). */
  readonly totalPendientes: number;
}

export interface KpisCierres {
  readonly periodosSinCerrar: number;
  readonly periodosVencidos: number;
  readonly mesAnterior: { readonly year: number; readonly month: number; readonly estado: "cerrado" | "abierto" | "vencido" | "sin_periodo" };
  readonly periodoReciente: { readonly year: number; readonly month: number; readonly estado: "cerrado" | "abierto" | "vencido"; readonly avancePct: number } | null;
}

export interface KpisCfdiMes {
  readonly periodo: string;
  readonly total: number;
  readonly invalidos: number;
  readonly requierenRevision: number;
}

export interface KpisCliente {
  readonly propertyId: string;
  readonly nombre: string;
  readonly hoy: string;
  readonly fuentesNoDisponibles: readonly FuenteDashboard[];
  readonly cartera: KpisCartera | null;
  readonly cargaTrabajo: KpisCargaTrabajo | null;
  readonly cierres: KpisCierres | null;
  readonly cfdiMes: KpisCfdiMes | null;
  readonly anomalias: readonly AnomaliaDashboard[];
  readonly nivelAtencion: NivelAtencion;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function estadoEfectivoCierre(periodo: ClosePeriod, tareas: readonly CloseTask[], hoy: string): "cerrado" | "abierto" | "vencido" {
  const efectivo = recomputeOverdue(periodo, tareas, hoy);
  return efectivo.status === "closed" ? "cerrado" : efectivo.status === "overdue" ? "vencido" : "abierto";
}

function mesAnteriorDe(hoy: string): { year: number; month: number } {
  const year = Number(hoy.slice(0, 4));
  const month = Number(hoy.slice(5, 7));
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** Fecha "YYYY-MM-DD" de un timestamp ISO de BD ("2026-09-01T10:00:00Z" o "2026-09-01 10:00:00+00"). */
function diaDeTimestamp(ts: string): string {
  return ts.slice(0, 10);
}

function calcularCartera(entrada: CarteraEntrada, hoy: string): KpisCartera {
  const porAntiguedad: Record<CobranzaAgeBucket, { count: number; monto: number }> = {
    "0-30": { count: 0, monto: 0 },
    "31-60": { count: 0, monto: 0 },
    "61-90": { count: 0, monto: 0 },
    "90+": { count: 0, monto: 0 },
  };
  let cuentasPendientes = 0;
  let montoPendiente = 0;
  let cuentasVencidas = 0;
  let montoVencido = 0;
  let sumaScore = 0;
  let cuentasSinCorreo = 0;
  let cuentasSinMonto = 0;
  let cuentasCobradas = 0;
  let montoCobrado = 0;

  for (const cuenta of entrada.cuentas) {
    const totalFactura = entrada.totalPorInvoiceId.get(cuenta.invoiceId);
    if (cuenta.pagadoEn !== null) {
      cuentasCobradas += 1;
      montoCobrado += cuenta.montoPagado ?? totalFactura ?? 0;
      continue;
    }
    const monto = totalFactura ?? 0;
    if (totalFactura === undefined) cuentasSinMonto += 1;
    const dias = diasVencidoCartera(cuenta.fechaVencimiento, hoy);
    const bucket = cobranzaAgeBucket(dias);
    cuentasPendientes += 1;
    montoPendiente += monto;
    // Bucket "0-30" agrupa también las cuentas aún no vencidas (dias <= 30), igual que el motor de cobranza.
    porAntiguedad[bucket].count += 1;
    porAntiguedad[bucket].monto += monto;
    if (dias > 0) {
      cuentasVencidas += 1;
      montoVencido += monto;
    }
    sumaScore += scoreCobrabilidadCartera(dias, entrada.historialPorCuenta.get(cuenta.id) ?? []);
    if (cuenta.clienteEmail === null || cuenta.clienteEmail.trim() === "") cuentasSinCorreo += 1;
  }

  const base = montoCobrado + montoPendiente;
  const porAntiguedadRedondeado = Object.fromEntries(COBRANZA_AGE_BUCKETS.map((b) => [b, { count: porAntiguedad[b].count, monto: r2(porAntiguedad[b].monto) }])) as Record<
    CobranzaAgeBucket,
    { count: number; monto: number }
  >;

  return {
    cuentasPendientes,
    montoPendiente: r2(montoPendiente),
    cuentasVencidas,
    montoVencido: r2(montoVencido),
    cuentas90Mas: porAntiguedad["90+"].count,
    monto90Mas: r2(porAntiguedad["90+"].monto),
    porAntiguedad: porAntiguedadRedondeado,
    scorePromedio: cuentasPendientes > 0 ? r2(sumaScore / cuentasPendientes) : null,
    cuentasSinCorreo,
    cuentasSinMonto,
    cuentasCobradas,
    montoCobrado: r2(montoCobrado),
    tasaCobranzaPct: base > 0 ? Math.round((montoCobrado / base) * 1000) / 10 : null,
  };
}

/** Cuentas pendientes de bajo score — insumo de la anomalía `cartera_score_bajo` (mismo umbral que `resumenCobranza`). */
function cuentasScoreBajo(entrada: CarteraEntrada, hoy: string): { count: number; monto: number } {
  let count = 0;
  let monto = 0;
  for (const cuenta of entrada.cuentas) {
    if (cuenta.pagadoEn !== null) continue;
    const dias = diasVencidoCartera(cuenta.fechaVencimiento, hoy);
    if (scoreCobrabilidadCartera(dias, entrada.historialPorCuenta.get(cuenta.id) ?? []) < SCORE_COBRANZA_BAJO) {
      count += 1;
      monto += entrada.totalPorInvoiceId.get(cuenta.invoiceId) ?? 0;
    }
  }
  return { count, monto: r2(monto) };
}

/** KPIs y anomalías de UN cliente (contribuyente). Puro y determinista. */
export function calcularKpisCliente(entrada: EntradaKpisCliente): KpisCliente {
  const { hoy } = entrada;
  const fuentesNoDisponibles: FuenteDashboard[] = [];
  const anomalias: AnomaliaDashboard[] = [];

  // ---- Cartera / cobranza ----
  let cartera: KpisCartera | null = null;
  if (entrada.cartera === null) {
    fuentesNoDisponibles.push("cartera");
  } else {
    cartera = calcularCartera(entrada.cartera, hoy);
    if (cartera.cuentas90Mas > 0) {
      anomalias.push({
        codigo: "cartera_90_mas",
        severidad: "alta",
        mensaje: `${cartera.cuentas90Mas} cuenta(s) por cobrar con más de 90 días de atraso.`,
        cantidad: cartera.cuentas90Mas,
        monto: cartera.monto90Mas,
      });
    }
    const bajo = cuentasScoreBajo(entrada.cartera, hoy);
    if (bajo.count > 0) {
      anomalias.push({
        codigo: "cartera_score_bajo",
        severidad: "media",
        mensaje: `${bajo.count} cuenta(s) con score de cobrabilidad bajo (< ${SCORE_COBRANZA_BAJO}).`,
        cantidad: bajo.count,
        monto: bajo.monto,
      });
    }
    if (cartera.cuentasSinCorreo > 0) {
      anomalias.push({
        codigo: "cuenta_sin_correo",
        severidad: "baja",
        mensaje: `${cartera.cuentasSinCorreo} cuenta(s) pendientes sin correo de contacto: no reciben recordatorios automáticos.`,
        cantidad: cartera.cuentasSinCorreo,
        monto: null,
      });
    }
  }

  // ---- Revisiones humanas de CFDI ----
  let revisionesPendientes: number | null = null;
  let revisionesAntiguas: number | null = null;
  if (entrada.revisionesPendientes === null) {
    fuentesNoDisponibles.push("revisiones");
  } else {
    revisionesPendientes = entrada.revisionesPendientes.length;
    revisionesAntiguas = entrada.revisionesPendientes.filter((r) => diasHasta(hoy, diaDeTimestamp(r.createdAt)) > DIAS_REVISION_ANTIGUA).length;
    if (revisionesAntiguas > 0) {
      anomalias.push({
        codigo: "revision_cfdi_antigua",
        severidad: "media",
        mensaje: `${revisionesAntiguas} revisión(es) humana(s) de CFDI pendiente(s) hace más de ${DIAS_REVISION_ANTIGUA} días.`,
        cantidad: revisionesAntiguas,
        monto: null,
      });
    }
  }

  // ---- Vencimientos fiscales (SAT) ----
  let vencimientosAbiertos: number | null = null;
  let vencimientosVencidos: number | null = null;
  let vencimientosProximos: number | null = null;
  if (entrada.vencimientos === null) {
    fuentesNoDisponibles.push("vencimientos");
  } else {
    const abiertos = entrada.vencimientos.filter((v) => v.estado !== "completado");
    vencimientosAbiertos = abiertos.length;
    vencimientosVencidos = abiertos.filter((v) => v.fechaLimite < hoy).length;
    vencimientosProximos = abiertos.filter((v) => {
      const d = diasHasta(v.fechaLimite, hoy);
      return d >= 0 && d <= DIAS_VENCIMIENTO_PROXIMO;
    }).length;
    if (vencimientosVencidos > 0) {
      anomalias.push({
        codigo: "vencimiento_vencido",
        severidad: "alta",
        mensaje: `${vencimientosVencidos} obligación(es) fiscal(es) vencida(s) sin presentar.`,
        cantidad: vencimientosVencidos,
        monto: null,
      });
    }
    if (vencimientosProximos > 0) {
      anomalias.push({
        codigo: "vencimiento_proximo",
        severidad: "media",
        mensaje: `${vencimientosProximos} obligación(es) fiscal(es) vencen en los próximos ${DIAS_VENCIMIENTO_PROXIMO} días.`,
        cantidad: vencimientosProximos,
        monto: null,
      });
    }
  }

  // ---- Cierre mensual ----
  let cierres: KpisCierres | null = null;
  let tareasCierrePendientes: number | null = null;
  let tareasCierreVencidas: number | null = null;
  if (entrada.cierres === null) {
    fuentesNoDisponibles.push("cierre");
  } else {
    let periodosSinCerrar = 0;
    let periodosVencidos = 0;
    let pendientes = 0;
    let vencidas = 0;
    for (const { periodo, tareas } of entrada.cierres) {
      const estado = estadoEfectivoCierre(periodo, tareas, hoy);
      if (estado === "cerrado") continue;
      periodosSinCerrar += 1;
      if (estado === "vencido") periodosVencidos += 1;
      const e = calcularEstadoPeriodo(tareas, hoy);
      pendientes += e.pending + e.inProgress + e.blocked.length;
      vencidas += e.overdue.length;
    }
    tareasCierrePendientes = pendientes;
    tareasCierreVencidas = vencidas;

    const ant = mesAnteriorDe(hoy);
    const delMesAnterior = entrada.cierres.find((c) => c.periodo.year === ant.year && c.periodo.month === ant.month);
    const estadoMesAnterior = delMesAnterior ? estadoEfectivoCierre(delMesAnterior.periodo, delMesAnterior.tareas, hoy) : "sin_periodo";
    const masReciente = [...entrada.cierres].sort((a, b) => b.periodo.year * 100 + b.periodo.month - (a.periodo.year * 100 + a.periodo.month))[0];
    cierres = {
      periodosSinCerrar,
      periodosVencidos,
      mesAnterior: { year: ant.year, month: ant.month, estado: estadoMesAnterior },
      periodoReciente: masReciente
        ? {
            year: masReciente.periodo.year,
            month: masReciente.periodo.month,
            estado: estadoEfectivoCierre(masReciente.periodo, masReciente.tareas, hoy),
            avancePct: calcularEstadoPeriodo(masReciente.tareas, hoy).progressPercent,
          }
        : null,
    };
    if (periodosVencidos > 0) {
      anomalias.push({
        codigo: "cierre_vencido",
        severidad: "alta",
        mensaje: `${periodosVencidos} período(s) de cierre mensual con tareas requeridas vencidas.`,
        cantidad: periodosVencidos,
        monto: null,
      });
    }
    if (estadoMesAnterior === "abierto") {
      anomalias.push({ codigo: "cierre_mes_anterior_abierto", severidad: "media", mensaje: "El cierre del mes anterior sigue abierto.", cantidad: 1, monto: null });
    } else if (estadoMesAnterior === "sin_periodo") {
      anomalias.push({ codigo: "cierre_mes_anterior_sin_periodo", severidad: "baja", mensaje: "No hay período de cierre registrado para el mes anterior.", cantidad: 1, monto: null });
    }
  }

  // ---- CFDI del mes ----
  let cfdiMes: KpisCfdiMes | null = null;
  if (entrada.cfdiMes === null) {
    fuentesNoDisponibles.push("cfdi");
  } else {
    const invalidos = entrada.cfdiMes.filter((i) => !i.valido).length;
    cfdiMes = {
      periodo: hoy.slice(0, 7),
      total: entrada.cfdiMes.length,
      invalidos,
      requierenRevision: entrada.cfdiMes.filter((i) => i.requiresHumanReview).length,
    };
    if (invalidos > 0) {
      anomalias.push({
        codigo: "cfdi_invalido",
        severidad: "media",
        mensaje: `${invalidos} CFDI 4.0 del mes con hallazgos de validación fiscal.`,
        cantidad: invalidos,
        monto: null,
      });
    }
  }

  const hayAlgunaFuente = fuentesNoDisponibles.length < 5;
  const cargaTrabajo: KpisCargaTrabajo | null = hayAlgunaFuente
    ? {
        revisionesPendientes,
        revisionesAntiguas,
        vencimientosAbiertos,
        vencimientosVencidos,
        vencimientosProximos,
        tareasCierrePendientes,
        tareasCierreVencidas,
        totalPendientes: (revisionesPendientes ?? 0) + (vencimientosAbiertos ?? 0) + (tareasCierrePendientes ?? 0),
      }
    : null;

  const nivelAtencion: NivelAtencion = !hayAlgunaFuente
    ? "sin_datos"
    : anomalias.some((a) => a.severidad === "alta")
      ? "critico"
      : anomalias.some((a) => a.severidad === "media")
        ? "atencion"
        : "al_corriente";

  return {
    propertyId: entrada.propertyId,
    nombre: entrada.nombre,
    hoy,
    fuentesNoDisponibles,
    cartera,
    cargaTrabajo,
    cierres,
    cfdiMes,
    anomalias,
    nivelAtencion,
  };
}

// ---------------------------------------------------------------------------
// Consolidado del despacho
// ---------------------------------------------------------------------------

export interface KpisDespacho {
  readonly totalClientes: number;
  readonly clientesPorNivel: Readonly<Record<NivelAtencion, number>>;
  /** Suma de la cartera de los clientes cuya fuente sí estuvo disponible; `null` si ninguno la tuvo. */
  readonly cartera: {
    readonly cuentasPendientes: number;
    readonly montoPendiente: number;
    readonly montoVencido: number;
    readonly monto90Mas: number;
    readonly montoCobrado: number;
    readonly tasaCobranzaPct: number | null;
    readonly clientesConDato: number;
  } | null;
  readonly cargaTrabajo: {
    readonly revisionesPendientes: number;
    readonly vencimientosAbiertos: number;
    readonly vencimientosVencidos: number;
    readonly tareasCierrePendientes: number;
    readonly totalPendientes: number;
  } | null;
  readonly cierres: { readonly periodosSinCerrar: number; readonly periodosVencidos: number; readonly clientesMesAnteriorSinCerrar: number } | null;
  readonly anomaliasPorSeveridad: Readonly<Record<SeveridadAnomalia, number>>;
  readonly fuentesNoDisponibles: readonly FuenteDashboard[];
  /** Clientes ordenados por urgencia: nivel (crítico primero), luego monto vencido, luego pendientes. */
  readonly ranking: readonly KpisCliente[];
}

const ORDEN_NIVEL: Record<NivelAtencion, number> = { critico: 0, atencion: 1, al_corriente: 2, sin_datos: 3 };

export function consolidarKpisDespacho(clientes: readonly KpisCliente[]): KpisDespacho {
  const clientesPorNivel: Record<NivelAtencion, number> = { critico: 0, atencion: 0, al_corriente: 0, sin_datos: 0 };
  const anomaliasPorSeveridad: Record<SeveridadAnomalia, number> = { alta: 0, media: 0, baja: 0 };
  const fuentes = new Set<FuenteDashboard>();
  for (const c of clientes) {
    clientesPorNivel[c.nivelAtencion] += 1;
    for (const f of c.fuentesNoDisponibles) fuentes.add(f);
    for (const a of c.anomalias) anomaliasPorSeveridad[a.severidad] += 1;
  }

  const conCartera = clientes.filter((c) => c.cartera !== null);
  let cartera: KpisDespacho["cartera"] = null;
  if (conCartera.length > 0) {
    const sum = (f: (k: KpisCartera) => number): number => r2(conCartera.reduce((acc, c) => acc + f(c.cartera!), 0));
    const montoCobrado = sum((k) => k.montoCobrado);
    const montoPendiente = sum((k) => k.montoPendiente);
    cartera = {
      cuentasPendientes: conCartera.reduce((acc, c) => acc + c.cartera!.cuentasPendientes, 0),
      montoPendiente,
      montoVencido: sum((k) => k.montoVencido),
      monto90Mas: sum((k) => k.monto90Mas),
      montoCobrado,
      tasaCobranzaPct: montoCobrado + montoPendiente > 0 ? Math.round((montoCobrado / (montoCobrado + montoPendiente)) * 1000) / 10 : null,
      clientesConDato: conCartera.length,
    };
  }

  const conCarga = clientes.filter((c) => c.cargaTrabajo !== null);
  const cargaTrabajo: KpisDespacho["cargaTrabajo"] =
    conCarga.length === 0
      ? null
      : {
          revisionesPendientes: conCarga.reduce((acc, c) => acc + (c.cargaTrabajo!.revisionesPendientes ?? 0), 0),
          vencimientosAbiertos: conCarga.reduce((acc, c) => acc + (c.cargaTrabajo!.vencimientosAbiertos ?? 0), 0),
          vencimientosVencidos: conCarga.reduce((acc, c) => acc + (c.cargaTrabajo!.vencimientosVencidos ?? 0), 0),
          tareasCierrePendientes: conCarga.reduce((acc, c) => acc + (c.cargaTrabajo!.tareasCierrePendientes ?? 0), 0),
          totalPendientes: conCarga.reduce((acc, c) => acc + c.cargaTrabajo!.totalPendientes, 0),
        };

  const conCierre = clientes.filter((c) => c.cierres !== null);
  const cierres: KpisDespacho["cierres"] =
    conCierre.length === 0
      ? null
      : {
          periodosSinCerrar: conCierre.reduce((acc, c) => acc + c.cierres!.periodosSinCerrar, 0),
          periodosVencidos: conCierre.reduce((acc, c) => acc + c.cierres!.periodosVencidos, 0),
          clientesMesAnteriorSinCerrar: conCierre.filter((c) => c.cierres!.mesAnterior.estado !== "cerrado").length,
        };

  const ranking = [...clientes].sort(
    (a, b) =>
      ORDEN_NIVEL[a.nivelAtencion] - ORDEN_NIVEL[b.nivelAtencion] ||
      (b.cartera?.montoVencido ?? 0) - (a.cartera?.montoVencido ?? 0) ||
      (b.cargaTrabajo?.totalPendientes ?? 0) - (a.cargaTrabajo?.totalPendientes ?? 0) ||
      a.nombre.localeCompare(b.nombre, "es"),
  );

  return { totalClientes: clientes.length, clientesPorNivel, cartera, cargaTrabajo, cierres, anomaliasPorSeveridad, fuentesNoDisponibles: [...fuentes], ranking };
}
