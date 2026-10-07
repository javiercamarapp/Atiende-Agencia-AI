// Helpers puros del Resumen de licitaciones (UNI-RES-licitaciones). Sin red ni estado: la pagina inyecta lo que leyo de los
// endpoints existentes y estas funciones solo cuentan, agrupan y formatean (sin inventar nada).
import type { StatusTone } from "@atiende/ui";
import type { SourceConnectorInfo, SourceHealthState, SourceRun } from "./sources-client.ts";
import { SOURCE_STATE_LABELS } from "./sources-client.ts";

export const DIA_MS = 24 * 60 * 60 * 1000;
export const VENTANA_PLAZO_DIAS = 7;

/** Zona por defecto: la de Ciudad de Mexico, la misma que usa el resto del vertical (radar, dias inhabiles). El Resumen la usa
 * SOLO cuando la organizacion no configuro la suya (`timezone: null`), cuando la lectura de tenant-config fallo (por ejemplo
 * en una base sin la migracion 027) o cuando el valor guardado no es una zona IANA valida. */
export const ZONA_LICITACIONES = "America/Mexico_City";

/** Zona efectiva del Resumen: la configurada por la organizacion si es una zona IANA valida; si no, `ZONA_LICITACIONES`. */
export function zonaEfectiva(configurada: string | null | undefined): string {
  if (!configurada) return ZONA_LICITACIONES;
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: configurada });
    return configurada;
  } catch {
    return ZONA_LICITACIONES;
  }
}

// Abiertas / por vencer / en preparacion ya NO se calculan aqui sobre una lista: las cuenta el servidor sobre TODA la organizacion
// (GET .../tenders/summary, tender-list-filter.ts), porque la lista que llega al navegador esta paginada.

function partesEnZona(fecha: Date, zona: string, opciones: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, ...opciones }).formatToParts(fecha);
}

/** Saludo segun la hora de la ORGANIZACION (no la del navegador): mismos cortes que `saludoPorHora`. */
export function saludoEnZona(fecha: Date, zona: string = ZONA_LICITACIONES): "Buenos días" | "Buenas tardes" | "Buenas noches" {
  const hora = Number(partesEnZona(fecha, zona, { hour: "numeric", hourCycle: "h23" }).find((p) => p.type === "hour")?.value);
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

/** "sábado, 3 de octubre" en la zona de la organizacion. */
export function fechaLargaEnZona(fecha: Date, zona: string = ZONA_LICITACIONES): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, weekday: "long", day: "numeric", month: "long" }).format(fecha);
}

/** "3 oct, 14:05" en la zona de la organizacion. */
export function fechaHoraCortaEnZona(iso: string, zona: string = ZONA_LICITACIONES): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: zona, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

const TONO_CORRIDA: Readonly<Record<SourceHealthState, StatusTone>> = {
  ok: "success",
  down: "danger",
  captcha_detected: "warning",
  interface_changed: "warning",
  permission_missing: "warning",
  rate_limited: "warning",
  not_configured: "neutral",
};

export interface CorridaFuente {
  readonly source: string;
  readonly nombre: string;
  readonly estado?: { readonly tone: StatusTone; readonly etiqueta: string };
  readonly meta?: string;
}

/**
 * Ultima corrida de la ingesta por fuente: una fila por conector registrado (y por cada fuente que aparezca en las corridas
 * sin estar en el registro), con la corrida MAS RECIENTE por `finishedAt`. Una fuente sin corridas queda sin estado ni meta,
 * y la tarjeta dice "Sin corridas registradas." en vez de inventar un OK.
 */
export function ultimaCorridaPorFuente(conectores: readonly SourceConnectorInfo[], corridas: readonly SourceRun[], zona: string = ZONA_LICITACIONES): readonly CorridaFuente[] {
  const masReciente = new Map<string, SourceRun>();
  for (const r of corridas) {
    const previa = masReciente.get(r.source);
    if (!previa || new Date(r.finishedAt).getTime() > new Date(previa.finishedAt).getTime()) masReciente.set(r.source, r);
  }
  const ids = [...conectores.map((c) => c.id), ...[...masReciente.keys()].filter((id) => !conectores.some((c) => c.id === id))];
  const etiquetaDe = new Map(conectores.map((c) => [c.id, c.label]));
  return ids.map((id) => {
    const nombre = etiquetaDe.get(id) ?? id;
    const r = masReciente.get(id);
    if (!r) return { source: id, nombre };
    const cobertura = r.evidence.coverage ? ` · ${r.evidence.coverage.obtained} de ${r.evidence.coverage.expected} resultados` : "";
    return { source: id, nombre, estado: { tone: TONO_CORRIDA[r.state] ?? "neutral", etiqueta: r.state === "ok" ? "OK" : SOURCE_STATE_LABELS[r.state] ?? r.state }, meta: `${fechaHoraCortaEnZona(r.finishedAt, zona)}${cobertura}` };
  });
}

/** La fecha ISO mas reciente de la lista (ignora las no parseables); null si no hay ninguna. */
export function fechaMasReciente(isos: readonly string[]): string | null {
  let mejor: string | null = null;
  let mejorMs = Number.NEGATIVE_INFINITY;
  for (const iso of isos) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms) && ms > mejorMs) {
      mejor = iso;
      mejorMs = ms;
    }
  }
  return mejor;
}

export interface CorridaSimple {
  readonly estado: { readonly tone: StatusTone; readonly etiqueta: string };
  readonly meta: string;
}

/** Ultima ingesta del listado 69-B del SAT (GET .../kyc-69b -> `lista`); sin lista ingerida no hay corrida que mostrar. */
export function corridaKyc(lista: { readonly periodo: string; readonly filas: number; readonly ingestadoEn: string } | null | undefined, zona: string = ZONA_LICITACIONES): CorridaSimple | null {
  if (!lista || Number.isNaN(new Date(lista.ingestadoEn).getTime())) return null;
  return { estado: { tone: "success", etiqueta: "Lista ingerida" }, meta: `Listado SAT ${lista.periodo} · ${plural(lista.filas, "fila", "filas")} · ${fechaHoraCortaEnZona(lista.ingestadoEn, zona)}` };
}

/** Ultimo recordatorio o cambio de convocatoria generado (`createdAt` real); null si no hay ninguno. */
export function corridaSeguimiento(creados: readonly string[], zona: string = ZONA_LICITACIONES): CorridaSimple | null {
  const ultima = fechaMasReciente(creados);
  return ultima ? { estado: { tone: "success", etiqueta: "Generó avisos" }, meta: `Último aviso generado ${fechaHoraCortaEnZona(ultima, zona)}` } : null;
}
