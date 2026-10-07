// Cierre del dia y resumen semanal de restaurantes (R-42, migracion 041). Tipos y calculos puros: las definiciones de cada cifra
// viven en el encabezado de packages/domain-restaurantes/migrations/041_cierre_dia_resumen_semanal.sql y los rotulos de la
// pantalla las repiten. Todo dinero en CENTAVOS enteros; un dato que no existe es `null`, jamas 0. Sin PII: solo agregados.

export type CierreTipo = "dia" | "semana";
export const CIERRE_TIPOS: readonly CierreTipo[] = ["dia", "semana"];
export type CierreCanalId = "web" | "whatsapp" | "voice" | "admin";
export const CIERRE_CANALES: readonly CierreCanalId[] = ["web", "whatsapp", "voice", "admin"];

export interface CierreCanal {
  readonly canal: CierreCanalId;
  readonly pedidos: number;
  readonly ventasCentavos: number;
  readonly cancelados: number;
}

export interface CierreTiempos {
  /** Pedidos entregados con hora de entrega registrada (la base de los tiempos). */
  readonly entregados: number;
  readonly promedioMin: number | null;
  readonly medianaMin: number | null;
  readonly p90Min: number | null;
}

export interface CierreDiaSerie {
  readonly fecha: string;
  readonly pedidos: number;
  readonly ventasCentavos: number;
}

export interface CierreComparativo {
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly pedidos: number;
  readonly ventasCentavos: number;
}

export interface CierreDatos {
  readonly pedidos: number;
  readonly ventasCentavos: number;
  readonly ticketPromedioCentavos: number | null;
  readonly conProblema: number;
  readonly cancelados: number;
  readonly canceladosCentavos: number;
  readonly noRecogidos: number;
  /** cancelados / (pedidos + cancelados), un decimal; null si no hubo ninguno de los dos. */
  readonly cancelacionPct: number | null;
  readonly porCanal: readonly CierreCanal[];
  readonly tiempos: CierreTiempos;
  readonly comparativo: CierreComparativo | null;
  /** Solo en el resumen semanal: los 7 dias lunes-domingo. */
  readonly porDia: readonly CierreDiaSerie[] | null;
}

export interface CierreReporte {
  readonly id: string;
  readonly tipo: CierreTipo;
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly zonaHoraria: string;
  readonly generadoPor: "sistema" | "staff";
  readonly generadoAt: string;
  readonly datos: CierreDatos;
}

export interface CierreLectura<T> {
  /** false = la base aun no tiene la migracion 041 (estado honesto "no disponible aun", nunca un 500). */
  readonly disponible: boolean;
  readonly valor: T;
}

export type GenerarCierreResultado =
  | { readonly estado: "creado"; readonly reporte: CierreReporte }
  | { readonly estado: "existente"; readonly reporte: CierreReporte }
  /** Solo en barrido de sistema: el periodo no tuvo ningun pedido, no se guarda un cierre vacio. */
  | { readonly estado: "sin_actividad" }
  /** El periodo todavia no termina en el DIA DE NEGOCIO de la sucursal (migracion 076: el turno que cruza la medianoche sigue abierto). */
  | { readonly estado: "periodo_abierto" }
  | { readonly estado: "no_disponible" };

export interface CierreSucursal {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly zonaHoraria: string;
}

export interface CierreRepository {
  /** Cierres mas recientes primero (por fecha de inicio). `limite` entre 1 y 60. */
  listar(organizationId: string, propertyId: string, tipo: CierreTipo, limite: number): Promise<CierreLectura<readonly CierreReporte[]>>;
  /** Genera UNA vez el cierre de un periodo ya terminado; repetir devuelve el mismo (`existente`). */
  generar(
    organizationId: string,
    propertyId: string,
    tipo: CierreTipo,
    fechaInicio: string,
    opciones?: { readonly omitirSinActividad?: boolean },
  ): Promise<GenerarCierreResultado>;
  /** Solo sesion de sistema: sucursales a barrer (sin organizaciones demo). */
  sucursalesParaBarrido(): Promise<CierreLectura<readonly CierreSucursal[]>>;
}

// ---- Fechas de negocio (YYYY-MM-DD, aritmetica calendario en UTC: sin zona horaria de por medio) ----------------------------------------

export const FECHA_NEGOCIO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function fechaNegocioValida(f: string): boolean {
  if (!FECHA_NEGOCIO_RE.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

export function sumarDiasFecha(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** 1 = lunes ... 7 = domingo (ISO). */
export function diaSemanaIso(fecha: string): number {
  const d = new Date(`${fecha}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function lunesDeSemana(fecha: string): string {
  return sumarDiasFecha(fecha, 1 - diaSemanaIso(fecha));
}

export const BARRIDO_DIAS_POR_DEFECTO = 3;
export const BARRIDO_DIAS_MAX = 14;

export interface PeriodoACerrar {
  readonly tipo: CierreTipo;
  readonly fechaInicio: string;
}

/**
 * Periodos terminados que el barrido debe asegurar dada la fecha de HOY local de la sucursal: los `dias` dias cerrados mas
 * recientes (ayer hacia atras) y, por cada domingo entre ellos, la semana que termina ese domingo. Del mas viejo al mas nuevo.
 * Hoy NUNCA se cierra (el dia sigue abierto). Como cada generacion es idempotente, correrlo todos los dias o una vez por semana
 * converge al mismo resultado: ningun dia cerrado dentro de la ventana queda sin cierre.
 */
export function periodosACerrar(hoyLocal: string, dias: number): readonly PeriodoACerrar[] {
  const n = Math.min(Math.max(Math.trunc(dias), 1), BARRIDO_DIAS_MAX);
  const periodos: PeriodoACerrar[] = [];
  for (let k = n; k >= 1; k--) {
    const dia = sumarDiasFecha(hoyLocal, -k);
    periodos.push({ tipo: "dia", fechaInicio: dia });
    if (diaSemanaIso(dia) === 7) periodos.push({ tipo: "semana", fechaInicio: sumarDiasFecha(dia, -6) });
  }
  return periodos;
}

/** Cambio porcentual con un decimal contra el periodo anterior; null si el anterior fue 0 (no hay base: nunca "+infinito"). */
export function variacionPct(actual: number, anterior: number): number | null {
  if (anterior <= 0) return null;
  return Math.round(((actual - anterior) * 1000) / anterior) / 10;
}

/** Centavos -> pesos enteros redondeados (para la notificacion, que solo admite codigos numericos cortos). */
export function pesosEnteros(centavos: number): number {
  return Math.round(centavos / 100);
}

// ---- Lectura del JSON que guarda la base ------------------------------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Convierte el jsonb `datos` (snake_case) al contrato tipado. Tolerante: un campo ausente es 0/null, nunca revienta una lectura. */
export function leerCierreDatos(raw: unknown): CierreDatos {
  const d = objeto(raw);
  const canalesRaw = Array.isArray(d.por_canal) ? d.por_canal : [];
  const porCanal: CierreCanal[] = CIERRE_CANALES.map((canal) => {
    const f = objeto(canalesRaw.find((c) => objeto(c).canal === canal));
    return { canal, pedidos: num(f.pedidos), ventasCentavos: num(f.ventas_centavos), cancelados: num(f.cancelados) };
  });
  const t = objeto(d.tiempos);
  const c = d.comparativo === undefined || d.comparativo === null ? null : objeto(d.comparativo);
  const porDia = Array.isArray(d.por_dia)
    ? d.por_dia.map((x) => ({ fecha: String(objeto(x).fecha ?? "").slice(0, 10), pedidos: num(objeto(x).pedidos), ventasCentavos: num(objeto(x).ventas_centavos) }))
    : null;
  return {
    pedidos: num(d.pedidos),
    ventasCentavos: num(d.ventas_centavos),
    ticketPromedioCentavos: numNull(d.ticket_promedio_centavos),
    conProblema: num(d.con_problema),
    cancelados: num(d.cancelados),
    canceladosCentavos: num(d.cancelados_centavos),
    noRecogidos: num(d.no_recogidos),
    cancelacionPct: numNull(d.cancelacion_pct),
    porCanal,
    tiempos: { entregados: num(t.entregados), promedioMin: numNull(t.promedio_min), medianaMin: numNull(t.mediana_min), p90Min: numNull(t.p90_min) },
    comparativo: c ? { fechaInicio: String(c.fecha_inicio ?? "").slice(0, 10), fechaFin: String(c.fecha_fin ?? "").slice(0, 10), pedidos: num(c.pedidos), ventasCentavos: num(c.ventas_centavos) } : null,
    porDia,
  };
}
