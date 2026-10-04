// Esquema del ledger de la simulacion (ledger.json): UN registro por dia con eventos, filas creadas, costo por concepto y asserts.
// Mismo espiritu que docs/qa/2026-08-29-simulacion-mes/ledger.json de Likida, pero con un solo formato validable: `validarLedger`
// devuelve la lista de errores de forma (vacia = valido). Lo usa la prueba apps/api/tests/simular-mes-hoteles-ledger.spec.ts y el
// propio main.ts antes de escribir el archivo, para que un ledger mal formado nunca llegue a docs/qa/.
export const LEDGER_VERSION = 1;

export type EstadoDato = "medido" | "calculado" | "sin_verificar";
export type ConceptoCosto = "llm" | "whatsapp" | "pac" | "voz" | "correo" | "pagos";
export type ActorEvento = "staff" | "sistema" | "huesped" | "agente";

export interface EventoLedger {
  readonly tipo: string;
  readonly actor: ActorEvento;
  /** true si la API respondio < 400 o el rechazo era el esperado por el escenario. */
  readonly ok: boolean;
  readonly status: number | null;
  readonly detalle: Readonly<Record<string, string | number | boolean | null>>;
}

export interface LineaCosto {
  readonly concepto: ConceptoCosto;
  readonly unidades: number;
  readonly unidad: string;
  /** USD por unidad; null cuando no hay tarifa defendible (entonces `costoUsd` es null y el estado es sin_verificar). */
  readonly precioUnitarioUsd: number | null;
  readonly costoUsd: number | null;
  /** medido = leido de una fila real; calculado = unidades medidas x tarifa; sin_verificar = la tarifa no tiene fuente primaria. */
  readonly estado: EstadoDato;
  readonly fuente: string;
}

export interface ResultadoAssert {
  readonly id: string;
  readonly descripcion: string;
  readonly ok: boolean;
  readonly detalle: string;
}

export interface ResumenHttp {
  readonly total: number;
  readonly porStatus: Readonly<Record<string, number>>;
  /** Respuestas 5xx: el assert duro exige 0. */
  readonly cincoXX: number;
}

export interface DiaLedger {
  readonly dia: number;
  /** Fecha de negocio local de la property (YYYY-MM-DD). */
  readonly fecha: string;
  readonly eventos: readonly EventoLedger[];
  /** Filas nuevas por tabla durante el dia (diferencia de conteos antes/despues, solo tablas con cambio). */
  readonly filasCreadas: Readonly<Record<string, number>>;
  readonly costos: readonly LineaCosto[];
  /** Suma de lineas con costoUsd != null (calculado + medido). */
  readonly costoTotalUsd: number;
  readonly http: ResumenHttp;
  readonly asserts: readonly ResultadoAssert[];
}

export interface TarifaCitada {
  readonly usd: number | null;
  readonly estado: EstadoDato;
  readonly fuente: string;
}

/** Bug real o hueco que la simulacion expuso. No es un assert fallido: el simulador lo registra, sigue por el camino alterno y lo reporta. */
export interface Hallazgo {
  readonly id: string;
  readonly severidad: "alta" | "media" | "baja";
  readonly titulo: string;
  readonly evidencia: string;
  /** Dias (1..N) en que se reprodujo. */
  readonly dias: readonly number[];
  /** Camino alterno que uso el simulador para poder seguir (vacio si no hizo falta). */
  readonly caminoAlterno: string;
}

export interface Ledger {
  readonly version: typeof LEDGER_VERSION;
  readonly corrida: string;
  readonly modo: "corto" | "mes";
  readonly zonaHoraria: string;
  readonly propiedad: { readonly habitaciones: number; readonly tipos: number };
  readonly tarifas: Readonly<Record<string, TarifaCitada>>;
  readonly dias: readonly DiaLedger[];
  readonly hallazgos: readonly Hallazgo[];
  readonly resumen: {
    readonly dias: number;
    readonly eventos: number;
    readonly costoTotalUsd: number;
    readonly costoSinVerificarUnidades: Readonly<Record<string, number>>;
    readonly asserts: { readonly total: number; readonly fallidos: number };
  };
}

const ESTADOS: readonly string[] = ["medido", "calculado", "sin_verificar"];
const CONCEPTOS: readonly string[] = ["llm", "whatsapp", "pac", "voz", "correo", "pagos"];
const ACTORES: readonly string[] = ["staff", "sistema", "huesped", "agente"];
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function esNumeroFinito(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Devuelve la lista de errores de forma/consistencia del ledger (vacia = valido). */
export function validarLedger(crudo: unknown): string[] {
  const errores: string[] = [];
  if (!esObjeto(crudo)) return ["el ledger debe ser un objeto"];
  if (crudo.version !== LEDGER_VERSION) errores.push(`version: se esperaba ${LEDGER_VERSION}`);
  if (typeof crudo.corrida !== "string" || crudo.corrida.length === 0) errores.push("corrida: texto no vacio requerido");
  if (crudo.modo !== "corto" && crudo.modo !== "mes") errores.push("modo: corto|mes");
  if (typeof crudo.zonaHoraria !== "string" || crudo.zonaHoraria.length === 0) errores.push("zonaHoraria: texto requerido");
  if (!esObjeto(crudo.propiedad) || !esNumeroFinito(crudo.propiedad.habitaciones) || !esNumeroFinito(crudo.propiedad.tipos)) errores.push("propiedad: {habitaciones, tipos} numericos");
  if (!esObjeto(crudo.tarifas)) errores.push("tarifas: objeto requerido");
  else {
    for (const [k, t] of Object.entries(crudo.tarifas)) {
      if (!esObjeto(t) || !(t.usd === null || esNumeroFinito(t.usd)) || !ESTADOS.includes(String(t.estado)) || typeof t.fuente !== "string" || t.fuente.length === 0) errores.push(`tarifas.${k}: {usd|null, estado, fuente} requeridos`);
      else if (t.usd === null && t.estado !== "sin_verificar") errores.push(`tarifas.${k}: sin precio solo puede ser sin_verificar`);
    }
  }
  if (!Array.isArray(crudo.dias) || crudo.dias.length === 0) {
    errores.push("dias: arreglo no vacio requerido");
    return errores;
  }
  let esperado = 1;
  let eventos = 0;
  let totalAsserts = 0;
  let fallidos = 0;
  let costoTotal = 0;
  for (const d of crudo.dias as unknown[]) {
    const p = `dias[${esperado - 1}]`;
    if (!esObjeto(d)) {
      errores.push(`${p}: objeto requerido`);
      esperado += 1;
      continue;
    }
    if (d.dia !== esperado) errores.push(`${p}.dia: consecutivo desde 1 (se esperaba ${esperado})`);
    if (typeof d.fecha !== "string" || !FECHA_RE.test(d.fecha)) errores.push(`${p}.fecha: YYYY-MM-DD`);
    if (!Array.isArray(d.eventos)) errores.push(`${p}.eventos: arreglo`);
    else {
      eventos += d.eventos.length;
      d.eventos.forEach((e: unknown, i: number) => {
        if (!esObjeto(e) || typeof e.tipo !== "string" || !ACTORES.includes(String(e.actor)) || typeof e.ok !== "boolean" || !(e.status === null || esNumeroFinito(e.status)) || !esObjeto(e.detalle)) errores.push(`${p}.eventos[${i}]: {tipo, actor, ok, status|null, detalle} requeridos`);
      });
    }
    if (!esObjeto(d.filasCreadas)) errores.push(`${p}.filasCreadas: objeto`);
    else for (const [t, n] of Object.entries(d.filasCreadas)) if (!esNumeroFinito(n) || n < 0) errores.push(`${p}.filasCreadas.${t}: entero >= 0`);
    let sumaLineas = 0;
    if (!Array.isArray(d.costos)) errores.push(`${p}.costos: arreglo`);
    else {
      d.costos.forEach((c: unknown, i: number) => {
        const q = `${p}.costos[${i}]`;
        if (!esObjeto(c)) return void errores.push(`${q}: objeto`);
        if (!CONCEPTOS.includes(String(c.concepto))) errores.push(`${q}.concepto invalido`);
        if (!esNumeroFinito(c.unidades) || c.unidades < 0) errores.push(`${q}.unidades >= 0`);
        if (typeof c.unidad !== "string") errores.push(`${q}.unidad texto`);
        if (!ESTADOS.includes(String(c.estado))) errores.push(`${q}.estado invalido`);
        if (typeof c.fuente !== "string" || c.fuente.length === 0) errores.push(`${q}.fuente requerida (cada tarifa cita su fuente o se marca sin_verificar)`);
        if (!(c.precioUnitarioUsd === null || esNumeroFinito(c.precioUnitarioUsd))) errores.push(`${q}.precioUnitarioUsd numero|null`);
        if (!(c.costoUsd === null || esNumeroFinito(c.costoUsd))) errores.push(`${q}.costoUsd numero|null`);
        if (c.precioUnitarioUsd === null && c.costoUsd !== null) errores.push(`${q}: costo sin tarifa`);
        if (c.estado === "sin_verificar" && c.costoUsd !== null && c.precioUnitarioUsd === null) errores.push(`${q}: sin_verificar no puede traer costo sin tarifa`);
        if (esNumeroFinito(c.costoUsd)) sumaLineas += c.costoUsd;
      });
    }
    if (!esNumeroFinito(d.costoTotalUsd) || Math.abs(d.costoTotalUsd - sumaLineas) > 0.000001) errores.push(`${p}.costoTotalUsd debe ser la suma de las lineas con costo (${sumaLineas})`);
    else costoTotal += d.costoTotalUsd;
    if (!esObjeto(d.http) || !esNumeroFinito(d.http.total) || !esNumeroFinito(d.http.cincoXX) || !esObjeto(d.http.porStatus)) errores.push(`${p}.http: {total, porStatus, cincoXX}`);
    if (!Array.isArray(d.asserts)) errores.push(`${p}.asserts: arreglo`);
    else {
      d.asserts.forEach((a: unknown, i: number) => {
        if (!esObjeto(a) || typeof a.id !== "string" || typeof a.descripcion !== "string" || typeof a.ok !== "boolean" || typeof a.detalle !== "string") errores.push(`${p}.asserts[${i}]: {id, descripcion, ok, detalle}`);
        else {
          totalAsserts += 1;
          if (!a.ok) fallidos += 1;
        }
      });
    }
    esperado += 1;
  }
  if (!Array.isArray(crudo.hallazgos)) errores.push("hallazgos: arreglo requerido (puede ser vacio)");
  else {
    crudo.hallazgos.forEach((h: unknown, i: number) => {
      if (!esObjeto(h) || typeof h.id !== "string" || !["alta", "media", "baja"].includes(String(h.severidad)) || typeof h.titulo !== "string" || typeof h.evidencia !== "string" || h.evidencia.length === 0 || !Array.isArray(h.dias) || typeof h.caminoAlterno !== "string") errores.push(`hallazgos[${i}]: {id, severidad, titulo, evidencia, dias[], caminoAlterno} requeridos`);
    });
  }
  if (!esObjeto(crudo.resumen)) errores.push("resumen: objeto requerido");
  else {
    const r = crudo.resumen;
    if (r.dias !== (crudo.dias as unknown[]).length) errores.push("resumen.dias no coincide con dias.length");
    if (r.eventos !== eventos) errores.push("resumen.eventos no coincide con la suma de eventos");
    if (!esNumeroFinito(r.costoTotalUsd) || Math.abs(r.costoTotalUsd - costoTotal) > 0.000001) errores.push("resumen.costoTotalUsd no coincide con la suma diaria");
    if (!esObjeto(r.costoSinVerificarUnidades)) errores.push("resumen.costoSinVerificarUnidades: objeto");
    if (!esObjeto(r.asserts) || r.asserts.total !== totalAsserts || r.asserts.fallidos !== fallidos) errores.push("resumen.asserts no coincide con los asserts diarios");
  }
  return errores;
}
