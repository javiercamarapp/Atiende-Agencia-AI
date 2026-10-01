// Rn-06 -- lógica PURA del calendario visual de rentas (vista mes, línea de tiempo por unidad, agenda móvil y capas).
// Separada de components/CalendarioVisual.tsx para probarla con vitest en entorno "node" (mismo criterio que
// calendario-client.ts). No toca la red ni el DOM.
//
// Reglas de fechas (las mismas que `packages/domain-rentas/src/fechas.ts`):
//   - Toda fecha es `YYYY-MM-DD` de calendario, SIN hora ni zona; la aritmética se ancla a medianoche UTC y solo suma días
//     enteros, así que nunca depende de la zona del navegador ni del horario de verano.
//   - Una estancia o bloqueo es el rango semiabierto `[inicio, fin)` en NOCHES: `inicio` es el check-in y `fin` el
//     check-out. La última noche ocupada es `fin - 1`; el día `fin` es de salida y la unidad queda libre esa noche.
//   - "Hoy" lo decide la zona IANA de la property (`hoyEnZona`), no el reloj ni la zona del navegador: Cancún (UTC-5,
//     sin horario de verano) y CDMX (UTC-6) no comparten día durante una hora cada noche.
import type { StatusTone } from "@atiende/ui";
import type { ConflictoCalendario } from "./ical-monitor-client.ts";
import type { OcupacionVisual } from "./calendario-client.ts";
import type { EstadoTareaOperativa, TareaOperativa, TipoTareaOperativa } from "./limpieza-client.ts";

export type FechaLocal = string;

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DIA = 86_400_000;
export const ZONA_POR_DEFECTO = "America/Mexico_City";

function aEpoca(fecha: FechaLocal): number | null {
  const m = FECHA_RE.exec(fecha);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Round-trip: rechaza "2026-02-30", que `Date` normalizaría en silencio al 2 de marzo.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms / MS_DIA;
}

function deEpoca(dias: number): FechaLocal {
  const d = new Date(dias * MS_DIA);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function esFechaValida(fecha: string): boolean {
  return aEpoca(fecha) !== null;
}

/** Suma `dias` (puede ser negativo) a una fecha. Una fecha inválida lanza: es un error de programación, no de datos. */
export function sumarDias(fecha: FechaLocal, dias: number): FechaLocal {
  const e = aEpoca(fecha);
  if (e === null) throw new Error(`Fecha inválida: "${fecha}"`);
  return deEpoca(e + dias);
}

/** Días entre dos fechas (`b - a`). */
export function diasEntre(a: FechaLocal, b: FechaLocal): number {
  const ea = aEpoca(a);
  const eb = aEpoca(b);
  if (ea === null || eb === null) throw new Error(`Fecha inválida: "${ea === null ? a : b}"`);
  return eb - ea;
}

/** Noches de `[inicio, fin)`; 0 si el rango está vacío, invertido o es inválido (nunca lanza: es dato de servidor). */
export function nochesDe(inicio: FechaLocal, fin: FechaLocal): number {
  const ei = aEpoca(inicio);
  const ef = aEpoca(fin);
  return ei === null || ef === null ? 0 : Math.max(0, ef - ei);
}

/** Día de la semana de la fecha, con el LUNES como 0 y el domingo como 6 (la rejilla de México empieza en lunes). */
export function diaSemanaLunes(fecha: FechaLocal): number {
  const e = aEpoca(fecha);
  if (e === null) throw new Error(`Fecha inválida: "${fecha}"`);
  return (new Date(e * MS_DIA).getUTCDay() + 6) % 7;
}

/**
 * "Hoy" (`YYYY-MM-DD`) en la zona IANA dada. Una zona inválida o vacía cae a Ciudad de México en vez de lanzar
 * (mismo criterio fail-closed que `resolverZonaHorariaNegocio` del servidor). Nunca usa `toISOString()` (día UTC).
 */
export function hoyEnZona(zona: string | null | undefined, ahora: Date = new Date()): FechaLocal {
  const formatear = (z: string) => {
    const partes = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ahora);
    const v = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
    return `${v("year")}-${v("month")}-${v("day")}`;
  };
  try {
    return formatear(zona && zona.trim() !== "" ? zona : ZONA_POR_DEFECTO);
  } catch {
    return formatear(ZONA_POR_DEFECTO);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mes y rejilla
// ---------------------------------------------------------------------------------------------------------------------

/** Clave de mes `YYYY-MM`. */
export type ClaveMes = string;

const MES_RE = /^(\d{4})-(\d{2})$/;

export function claveMesDe(fecha: FechaLocal): ClaveMes {
  if (!esFechaValida(fecha)) throw new Error(`Fecha inválida: "${fecha}"`);
  return fecha.slice(0, 7);
}

export function esClaveMesValida(clave: string): boolean {
  const m = MES_RE.exec(clave);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

export function primerDiaDelMes(clave: ClaveMes): FechaLocal {
  if (!esClaveMesValida(clave)) throw new Error(`Mes inválido: "${clave}"`);
  return `${clave}-01`;
}

export function moverMes(clave: ClaveMes, delta: number): ClaveMes {
  const m = MES_RE.exec(clave);
  if (!m || !esClaveMesValida(clave)) throw new Error(`Mes inválido: "${clave}"`);
  const indice = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const anio = Math.floor(indice / 12);
  return `${String(anio).padStart(4, "0")}-${String((((indice % 12) + 12) % 12) + 1).padStart(2, "0")}`;
}

/** Días del mes (28-31), con febrero bisiesto resuelto por el calendario real. */
export function diasDelMes(clave: ClaveMes): FechaLocal[] {
  const primero = primerDiaDelMes(clave);
  const total = diasEntre(primero, primerDiaDelMes(moverMes(clave, 1)));
  return Array.from({ length: total }, (_, i) => sumarDias(primero, i));
}

/** Ventana de la rejilla del mes (lunes a domingo, 5 o 6 semanas completas) como `[inicio, fin)` -- es la ventana que se
 * pide al servidor, así los días de relleno de las semanas vecinas también muestran sus reservas. */
export function ventanaDeRejilla(clave: ClaveMes): { readonly inicio: FechaLocal; readonly fin: FechaLocal } {
  const dias = diasDelMes(clave);
  const primero = dias[0]!;
  const ultimo = dias[dias.length - 1]!;
  const inicio = sumarDias(primero, -diaSemanaLunes(primero));
  const fin = sumarDias(ultimo, 7 - diaSemanaLunes(ultimo));
  return { inicio, fin };
}

/** Semanas de la rejilla: cada una con 7 fechas (lunes a domingo). */
export function semanasDeRejilla(clave: ClaveMes): FechaLocal[][] {
  const { inicio, fin } = ventanaDeRejilla(clave);
  const total = diasEntre(inicio, fin);
  const semanas: FechaLocal[][] = [];
  for (let s = 0; s < total / 7; s++) semanas.push(Array.from({ length: 7 }, (_, d) => sumarDias(inicio, s * 7 + d)));
  return semanas;
}

const NOMBRES_MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;
const ABREV_MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
export const NOMBRES_DIA_SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
export const ABREV_DIA_SEMANA = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;

/** "octubre de 2026". */
export function etiquetaMes(clave: ClaveMes): string {
  primerDiaDelMes(clave);
  return `${NOMBRES_MES[Number(clave.slice(5, 7)) - 1]} de ${clave.slice(0, 4)}`;
}

/** "10 oct" (sin zona: es una fecha de calendario). */
export function etiquetaDiaCorta(fecha: FechaLocal): string {
  if (!esFechaValida(fecha)) return "—";
  return `${Number(fecha.slice(8, 10))} ${ABREV_MES[Number(fecha.slice(5, 7)) - 1]}`;
}

/** "sábado 10 de octubre de 2026". */
export function etiquetaDiaLarga(fecha: FechaLocal): string {
  if (!esFechaValida(fecha)) return "—";
  return `${NOMBRES_DIA_SEMANA[diaSemanaLunes(fecha)]} ${Number(fecha.slice(8, 10))} de ${NOMBRES_MES[Number(fecha.slice(5, 7)) - 1]} de ${fecha.slice(0, 4)}`;
}

/** "10 oct → 12 oct · 2 noches" para una estancia o bloqueo. */
export function etiquetaRango(inicio: FechaLocal, fin: FechaLocal): string {
  const n = nochesDe(inicio, fin);
  return `${etiquetaDiaCorta(inicio)} → ${etiquetaDiaCorta(fin)}${n > 0 ? ` · ${n} ${n === 1 ? "noche" : "noches"}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Elementos del calendario (capas)
// ---------------------------------------------------------------------------------------------------------------------

export type TipoElemento = "reserva" | "bloqueo" | "limpieza";

export interface ElementoCalendario {
  readonly id: string;
  readonly tipo: TipoElemento;
  readonly unidadId: string;
  /** `[inicio, fin)` en noches. Una tarea de limpieza es de un solo día: `[día, día + 1)`. */
  readonly inicio: FechaLocal;
  readonly fin: FechaLocal;
  /** Texto corto de la barra: huésped, razón del bloqueo o tipo de tarea. */
  readonly etiqueta: string;
  /** Texto accesible completo (tipo, canal, estado). */
  readonly descripcion: string;
  /** Código del canal de una reserva (`airbnb`, `manual`...); `null` en bloqueos y tareas. */
  readonly canal: string | null;
  readonly estado: string;
  /** Participa en un conflicto abierto de Rn-02 (o la propia ocupación está `conflicto_pendiente`). */
  readonly enConflicto: boolean;
  /** `true` si el elemento ya no requiere atención (tarea completada/cancelada): se pinta apagado. */
  readonly apagado: boolean;
}

const RAZON_ETIQUETA: Record<string, string> = {
  RESERVA_CANAL: "Reserva",
  BLOQUEO_PROPIETARIO: "Bloqueo del propietario",
  MANTENIMIENTO: "Mantenimiento",
  BUFFER_LIMPIEZA: "Buffer de limpieza",
};

const ESTADO_OCUPACION_ETIQUETA: Record<string, string> = { confirmado: "confirmada", provisional: "provisional", conflicto_pendiente: "con conflicto pendiente", cancelado: "cancelada" };
const ESTADO_BLOQUEO_ETIQUETA: Record<string, string> = { confirmado: "activo", provisional: "provisional", conflicto_pendiente: "con conflicto pendiente", cancelado: "liberado" };
const TIPO_TAREA_ETIQUETA: Record<TipoTareaOperativa, string> = { limpieza: "Limpieza", mantenimiento: "Mantenimiento", inspeccion: "Inspección" };
const ESTADO_TAREA_ETIQUETA: Record<EstadoTareaOperativa, string> = {
  pendiente: "pendiente",
  asignada: "asignada",
  en_progreso: "en progreso",
  completada: "completada",
  bloqueada: "bloqueada",
  cancelada: "cancelada",
};

/** Etiqueta legible de un canal (`airbnb` -> "Airbnb", `manual` -> "Directa"). */
export function etiquetaCanal(canal: string | null): string {
  if (!canal || canal === "manual") return "Directa";
  return canal.charAt(0).toUpperCase() + canal.slice(1);
}

/** Ids de las ocupaciones que participan en algún conflicto ABIERTO. */
export function idsEnConflicto(conflictos: readonly ConflictoCalendario[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const k of conflictos) {
    if (k.estado !== "abierto") continue;
    ids.add(k.ocupacionA.id);
    if (k.ocupacionB) ids.add(k.ocupacionB.id);
  }
  return ids;
}

export function elementoDeOcupacion(o: OcupacionVisual, enConflictoIds: ReadonlySet<string> = new Set()): ElementoCalendario {
  const esReserva = o.capa === "reserva";
  const razon = RAZON_ETIQUETA[o.razon] ?? o.razon;
  const etiqueta = esReserva ? (o.huespedNombre?.trim() || etiquetaCanal(o.canalCodigo)) : razon;
  const estadoTxt = (esReserva ? ESTADO_OCUPACION_ETIQUETA : ESTADO_BLOQUEO_ETIQUETA)[o.estado] ?? o.estado;
  const partes = [esReserva ? `Reserva ${estadoTxt}` : `${razon} (${estadoTxt})`];
  if (esReserva) partes.push(`canal ${etiquetaCanal(o.canalCodigo)}`);
  if (esReserva && o.huespedNombre?.trim()) partes.push(`huésped ${o.huespedNombre.trim()}`);
  return {
    id: o.id,
    tipo: esReserva ? "reserva" : "bloqueo",
    unidadId: o.unidadId,
    inicio: o.rango.inicio,
    fin: o.rango.fin,
    etiqueta,
    descripcion: partes.join(", "),
    canal: esReserva ? (o.canalCodigo ?? "manual") : null,
    estado: o.estado,
    enConflicto: o.estado === "conflicto_pendiente" || enConflictoIds.has(o.id),
    apagado: false,
  };
}

/** Una tarea operativa es de un solo día (`programadaPara`); una cancelada no se pinta. */
export function elementoDeTarea(t: TareaOperativa): ElementoCalendario | null {
  if (t.estado === "cancelada" || !esFechaValida(t.programadaPara)) return null;
  const tipo = TIPO_TAREA_ETIQUETA[t.tipo] ?? t.tipo;
  return {
    id: `tarea:${t.id}`,
    tipo: "limpieza",
    unidadId: t.unidadId,
    inicio: t.programadaPara,
    fin: sumarDias(t.programadaPara, 1),
    etiqueta: tipo,
    descripcion: `${tipo} ${ESTADO_TAREA_ETIQUETA[t.estado] ?? t.estado}`,
    canal: null,
    estado: t.estado,
    enConflicto: false,
    apagado: t.estado === "completada",
  };
}

export function construirElementos(entrada: {
  readonly ocupaciones: readonly OcupacionVisual[];
  readonly tareas: readonly TareaOperativa[];
  readonly conflictos: readonly ConflictoCalendario[];
}): ElementoCalendario[] {
  const enConflicto = idsEnConflicto(entrada.conflictos);
  const items: ElementoCalendario[] = entrada.ocupaciones
    .filter((o) => o.estado !== "cancelado" && nochesDe(o.rango.inicio, o.rango.fin) > 0)
    .map((o) => elementoDeOcupacion(o, enConflicto));
  for (const t of entrada.tareas) {
    const e = elementoDeTarea(t);
    if (e) items.push(e);
  }
  return items.sort(compararElementos);
}

const ORDEN_TIPO: Record<TipoElemento, number> = { reserva: 0, bloqueo: 1, limpieza: 2 };

/** Orden estable: conflictos primero, luego por inicio, tipo e id. */
export function compararElementos(a: ElementoCalendario, b: ElementoCalendario): number {
  if (a.enConflicto !== b.enConflicto) return a.enConflicto ? -1 : 1;
  if (a.inicio !== b.inicio) return a.inicio < b.inicio ? -1 : 1;
  if (a.tipo !== b.tipo) return ORDEN_TIPO[a.tipo] - ORDEN_TIPO[b.tipo];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Filtros y capas
// ---------------------------------------------------------------------------------------------------------------------

export interface CapasVisibles {
  readonly reservas: boolean;
  readonly bloqueos: boolean;
  readonly limpiezas: boolean;
  /** Resalta los elementos con conflicto abierto de Rn-02. Apagada, siguen visibles pero sin el resalte. */
  readonly conflictos: boolean;
}

export const CAPAS_POR_DEFECTO: CapasVisibles = { reservas: true, bloqueos: true, limpiezas: true, conflictos: true };

export interface FiltrosCalendario {
  /** `null` = todas las unidades. */
  readonly unidadId: string | null;
  /** `null` = todos los canales. El filtro de canal solo aplica a las RESERVAS (un bloqueo o una tarea no tiene canal). */
  readonly canal: string | null;
  readonly capas: CapasVisibles;
}

export const FILTROS_POR_DEFECTO: FiltrosCalendario = { unidadId: null, canal: null, capas: CAPAS_POR_DEFECTO };

export function filtrarElementos(items: readonly ElementoCalendario[], f: FiltrosCalendario): ElementoCalendario[] {
  return items
    .filter((e) => (f.unidadId === null || e.unidadId === f.unidadId) && (e.tipo !== "reserva" || f.canal === null || e.canal === f.canal))
    .filter((e) => (e.tipo === "reserva" ? f.capas.reservas : e.tipo === "bloqueo" ? f.capas.bloqueos : f.capas.limpiezas))
    .map((e) => (e.enConflicto && !f.capas.conflictos ? { ...e, enConflicto: false } : e));
}

/** Canales presentes en los datos, `manual` (directa) primero y el resto en orden alfabético. */
export function canalesPresentes(items: readonly ElementoCalendario[]): string[] {
  const set = new Set<string>();
  for (const e of items) if (e.tipo === "reserva" && e.canal) set.add(e.canal);
  return [...set].sort((a, b) => (a === "manual" ? -1 : b === "manual" ? 1 : a.localeCompare(b)));
}

const TONOS_CANAL: readonly StatusTone[] = ["info", "warning", "neutral"];

/**
 * Tono (de la tabla de tokens del DS v2, con contraste medido en claro y oscuro) de un canal. La reserva directa es siempre
 * `success`; los canales externos reciben un tono estable por su posición en `canales`. El color nunca es la única señal: la
 * barra lleva el nombre del canal y la leyenda lo repite.
 */
export function tonoDeCanal(canal: string | null, canales: readonly string[]): StatusTone {
  if (!canal || canal === "manual") return "success";
  const externos = canales.filter((c) => c !== "manual");
  const i = externos.indexOf(canal);
  return TONOS_CANAL[(i < 0 ? 0 : i) % TONOS_CANAL.length]!;
}

/** Tono de un elemento: conflicto = danger; limpieza/bloqueo = neutral; reserva = tono de su canal (provisional = warning). */
export function tonoDeElemento(e: ElementoCalendario, canales: readonly string[]): StatusTone {
  if (e.enConflicto) return "danger";
  if (e.tipo !== "reserva") return "neutral";
  if (e.estado === "provisional") return "warning";
  return tonoDeCanal(e.canal, canales);
}

// ---------------------------------------------------------------------------------------------------------------------
// Vista mes
// ---------------------------------------------------------------------------------------------------------------------

/** `true` si el elemento ocupa la NOCHE del día `dia` (`inicio <= dia < fin`). */
export function cubreNoche(e: Pick<ElementoCalendario, "inicio" | "fin">, dia: FechaLocal): boolean {
  return e.inicio <= dia && dia < e.fin;
}

export interface ContenidoDia {
  /** Elementos que ocupan la noche del día (llegan o siguen). */
  readonly noches: readonly ElementoCalendario[];
  /** Reservas y bloqueos que terminan este día (check-out): la unidad queda libre esa noche. */
  readonly salidas: readonly ElementoCalendario[];
}

/** Contenido de cada día de `dias`, recorriendo solo los días de cada elemento que caen en la ventana (O(elementos x noches visibles)). */
export function contenidoPorDia(items: readonly ElementoCalendario[], dias: readonly FechaLocal[]): Map<FechaLocal, ContenidoDia> {
  const mapa = new Map<FechaLocal, { noches: ElementoCalendario[]; salidas: ElementoCalendario[] }>();
  for (const d of dias) mapa.set(d, { noches: [], salidas: [] });
  if (dias.length === 0) return mapa as Map<FechaLocal, ContenidoDia>;
  const primero = dias[0]!;
  const ultimo = dias[dias.length - 1]!;
  for (const e of items) {
    const desde = e.inicio > primero ? e.inicio : primero;
    const hastaExcl = e.fin <= ultimo ? e.fin : sumarDias(ultimo, 1);
    for (let d = desde; d < hastaExcl; d = sumarDias(d, 1)) mapa.get(d)?.noches.push(e);
    if (e.tipo !== "limpieza") mapa.get(e.fin)?.salidas.push(e);
  }
  return mapa as Map<FechaLocal, ContenidoDia>;
}

/** Parte visible de una celda con tope (rendimiento y legibilidad con cientos de reservas): el resto va a "+N más". */
export function limitarPorDia<T>(items: readonly T[], max: number): { readonly visibles: readonly T[]; readonly ocultos: number } {
  if (items.length <= max) return { visibles: items, ocultos: 0 };
  return { visibles: items.slice(0, max), ocultos: items.length - max };
}

// ---------------------------------------------------------------------------------------------------------------------
// Línea de tiempo por unidad
// ---------------------------------------------------------------------------------------------------------------------

export interface SegmentoBarra {
  readonly elemento: ElementoCalendario;
  /** Columna inicial (0 = primer día de la ventana) y número de columnas (noches visibles). */
  readonly columna: number;
  readonly span: number;
  /** `true` si la estancia empezó antes de la ventana / termina después de ella (bordes abiertos, no redondeados). */
  readonly continuaAntes: boolean;
  readonly continuaDespues: boolean;
  /** Carril vertical dentro de la fila de la unidad: elementos que se solapan no se pintan uno sobre otro. */
  readonly carril: number;
}

/**
 * Barras de UNA unidad recortadas a la ventana `[desde, hasta)`, con carril asignado (reparto voraz: el primer carril
 * donde no se solape con la barra anterior). Una estancia contigua (check-out de una = check-in de otra) comparte carril.
 */
export function segmentosDeUnidad(items: readonly ElementoCalendario[], desde: FechaLocal, hasta: FechaLocal): { readonly segmentos: readonly SegmentoBarra[]; readonly carriles: number } {
  const visibles = items
    .filter((e) => e.inicio < hasta && desde < e.fin)
    .slice()
    .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : a.id < b.id ? -1 : 1));
  const finPorCarril: FechaLocal[] = [];
  const segmentos: SegmentoBarra[] = [];
  for (const e of visibles) {
    let carril = finPorCarril.findIndex((fin) => fin <= e.inicio);
    if (carril < 0) carril = finPorCarril.length;
    finPorCarril[carril] = e.fin;
    const ini = e.inicio < desde ? desde : e.inicio;
    const fin = e.fin > hasta ? hasta : e.fin;
    segmentos.push({ elemento: e, columna: diasEntre(desde, ini), span: diasEntre(ini, fin), continuaAntes: e.inicio < desde, continuaDespues: e.fin > hasta, carril });
  }
  return { segmentos, carriles: Math.max(1, finPorCarril.length) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Agenda (móvil)
// ---------------------------------------------------------------------------------------------------------------------

export interface DiaAgenda {
  readonly fecha: FechaLocal;
  readonly elementos: readonly ElementoCalendario[];
}

/**
 * Agenda del mes: un día por cada fecha con actividad, con los elementos que EMPIEZAN ese día (llegadas, bloqueos,
 * limpiezas). Lo que ya venía de antes del mes se agrupa bajo el primer día del mes. Acotada por la cantidad de elementos,
 * nunca por los días del mes.
 */
export function agendaDelMes(items: readonly ElementoCalendario[], clave: ClaveMes): DiaAgenda[] {
  const dias = diasDelMes(clave);
  const primero = dias[0]!;
  const ultimo = dias[dias.length - 1]!;
  const porDia = new Map<FechaLocal, ElementoCalendario[]>();
  for (const e of items) {
    if (e.fin <= primero || e.inicio > ultimo) continue;
    const dia = e.inicio < primero ? primero : e.inicio;
    const lista = porDia.get(dia);
    if (lista) lista.push(e);
    else porDia.set(dia, [e]);
  }
  return [...porDia.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([fecha, elementos]) => ({ fecha, elementos: elementos.sort(compararElementos) }));
}

/** Resumen accesible de un día para el `aria-label` de su celda. */
export function resumenDia(fecha: FechaLocal, contenido: ContenidoDia | undefined, esHoy: boolean): string {
  const noches = contenido?.noches.length ?? 0;
  const salidas = contenido?.salidas.length ?? 0;
  const conflictos = contenido?.noches.filter((e) => e.enConflicto).length ?? 0;
  const partes = [etiquetaDiaLarga(fecha)];
  if (esHoy) partes.push("hoy");
  partes.push(noches === 0 ? "sin ocupación" : `${noches} ${noches === 1 ? "elemento" : "elementos"}`);
  if (salidas > 0) partes.push(`${salidas} ${salidas === 1 ? "salida" : "salidas"}`);
  if (conflictos > 0) partes.push(`${conflictos} con conflicto`);
  return partes.join(", ");
}
