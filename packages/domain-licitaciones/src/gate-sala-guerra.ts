// L-25 (REQ-040) -- gate final de la sala de guerra: "anti-desechamiento".
//
// Funcion de dominio PURA (sin I/O, sin reloj propio: `ahora` entra como parametro) que junta lo que
// la sala de guerra no consultaba -- checklist de integridad, paquete ensamblado, hash del ZIP contra
// el manifiesto, doble aprobacion (L-26) y holgura al cierre -- y devuelve un semaforo por condicion y
// un veredicto "listo / no listo" con motivos legibles.
//
// Esto NO presenta nada ante ningun portal: es una ayuda para que una persona no llegue al cierre con
// un paquete incompleto, alterado o sin aprobar. La verificacion de bytes del ZIP la hace quien llama
// (necesita I/O) con `verifyZipAgainstManifest` y entrega aqui el resultado ya resuelto.
import type { ChecklistReport } from "./integrity-checklist.ts";
import type { ExpedienteApprovalStage } from "./approval-workflow.ts";

export type GateColor = "verde" | "ambar" | "rojo";
export type GateConditionId = "aprobaciones" | "checklist" | "paquete" | "zip_manifiesto" | "holgura";
/** A donde lleva el enlace "lo que falta" de cada condicion (la pantalla decide la ruta concreta). */
export type GateLink = "aprobaciones" | "checklist" | "paquete" | "sala_tablero" | null;

export const GATE_HOLGURA_HORAS = 24;
export const GATE_DEFAULT_TIME_ZONE = "America/Mexico_City";

export interface GateCondition {
  readonly id: GateConditionId;
  readonly label: string;
  readonly color: GateColor;
  readonly motivo: string;
  readonly enlace: GateLink;
}

/** Resultado de comparar los bytes del ZIP guardado contra el manifiesto guardado (lo calcula quien llama). */
export type GateZipCheck =
  | { readonly state: "ok"; readonly documentos: number }
  | { readonly state: "no_coincide"; readonly documentos: readonly string[]; readonly faltantes: readonly string[] }
  | { readonly state: "ilegible" };

export interface GatePackageInput {
  readonly generatedAt: string;
  /** Estado con el que se guardo el ultimo ensamblado. */
  readonly storedStatus: "draft" | "ready";
  /** Estado re-derivado contra el expediente VIVO (AE-14): un "ready" viejo puede ya no serlo. */
  readonly vigenteStatus: "draft" | "ready";
  readonly draftReasons: readonly string[];
}

export interface GateApprovalsInput {
  /** "doble" = migracion 033 aplicada (2/2 por dos personas); "legacy" = aprobacion unica de siempre. */
  readonly mode: "doble" | "legacy" | "sin_propuesta";
  readonly complete: boolean;
  readonly missing: readonly ExpedienteApprovalStage[];
  readonly sameApprover?: boolean;
}

export interface GateSalaGuerraInput {
  /** Checklist de integridad VIVO del expediente; `null` = nunca corrio. */
  readonly checklist: ChecklistReport | null;
  /** Ultimo paquete ensamblado; `null` = nunca se ensamblo. */
  readonly paquete: GatePackageInput | null;
  /** `null` = no hay ZIP guardado que verificar. */
  readonly zip: GateZipCheck | null;
  readonly aprobaciones: GateApprovalsInput;
  /** Fecha limite de presentacion (ISO con offset o UTC); `null` = la convocatoria no la declara. */
  readonly fechaCierre: string | null;
  readonly ahora: string;
  readonly zonaHoraria: string;
  /** Ya se declaro la presentacion: el gate se sigue mostrando pero ya no genera alerta. */
  readonly presentado?: boolean;
}

export interface GateCuentaRegresiva {
  readonly estado: "sin_fecha" | "abierto" | "vencido";
  /** Milisegundos hasta el cierre (negativo si ya paso); `null` sin fecha. */
  readonly msRestantes: number | null;
  readonly dias: number;
  readonly horas: number;
  readonly minutos: number;
  /** Fecha civil del cierre en la zona de la organizacion (YYYY-MM-DD) y hora local (HH:mm). */
  readonly fechaCierreLocal: string | null;
  readonly horaCierreLocal: string | null;
  readonly zonaHoraria: string;
}

export interface GateSalaGuerraResult {
  readonly listo: boolean;
  readonly veredicto: "listo" | "no_listo";
  readonly condiciones: readonly GateCondition[];
  /** Motivos de todo lo que no esta en verde, primero los rojos. */
  readonly motivos: readonly string[];
  readonly cuentaRegresiva: GateCuentaRegresiva;
  /** Horas de holgura al cierre; `null` sin fecha. Negativo = vencido. */
  readonly holguraHoras: number | null;
  /** A menos de 24 h del cierre (aun abierto), sin presentar y NO listo. */
  readonly alerta24h: boolean;
}

const LABELS: Readonly<Record<GateConditionId, string>> = {
  aprobaciones: "Doble aprobación",
  checklist: "Checklist de integridad",
  paquete: "Paquete de envío",
  zip_manifiesto: "ZIP contra manifiesto",
  holgura: "Holgura al cierre",
};

const STAGE_TEXT: Readonly<Record<ExpedienteApprovalStage, string>> = {
  tecnica_legal: "la aprobación técnico-legal (1/2)",
  economica: "la aprobación económica (2/2)",
};

function cond(id: GateConditionId, color: GateColor, motivo: string, enlace: GateLink): GateCondition {
  return { id, label: LABELS[id], color, motivo, enlace };
}

/** Zona IANA valida o el default de la plataforma (una zona mal guardada nunca debe tumbar el gate). */
export function resolveGateTimeZone(zone: string | null | undefined): string {
  if (!zone) return GATE_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return GATE_DEFAULT_TIME_ZONE;
  }
}

function localParts(instant: Date, zone: string): { fecha: string; hora: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { fecha: `${get("year")}-${get("month")}-${get("day")}`, hora: `${get("hour")}:${get("minute")}` };
}

export function buildCuentaRegresiva(fechaCierre: string | null, ahora: string, zonaHoraria: string): GateCuentaRegresiva {
  const zone = resolveGateTimeZone(zonaHoraria);
  const cierre = fechaCierre ? new Date(fechaCierre) : null;
  const now = new Date(ahora);
  if (!cierre || Number.isNaN(cierre.getTime()) || Number.isNaN(now.getTime())) {
    return { estado: "sin_fecha", msRestantes: null, dias: 0, horas: 0, minutos: 0, fechaCierreLocal: null, horaCierreLocal: null, zonaHoraria: zone };
  }
  const ms = cierre.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const local = localParts(cierre, zone);
  return {
    estado: ms < 0 ? "vencido" : "abierto",
    msRestantes: ms,
    dias: Math.floor(abs / 86_400_000),
    horas: Math.floor((abs % 86_400_000) / 3_600_000),
    minutos: Math.floor((abs % 3_600_000) / 60_000),
    fechaCierreLocal: local.fecha,
    horaCierreLocal: local.hora,
    zonaHoraria: zone,
  };
}

function textoRestante(c: GateCuentaRegresiva): string {
  const partes: string[] = [];
  if (c.dias > 0) partes.push(`${c.dias} d`);
  if (c.dias > 0 || c.horas > 0) partes.push(`${c.horas} h`);
  partes.push(`${c.minutos} min`);
  return partes.join(" ");
}

function evaluarAprobaciones(a: GateApprovalsInput): GateCondition {
  if (a.mode === "sin_propuesta") return cond("aprobaciones", "rojo", "Todavía no hay propuesta: no hay nada que aprobar.", "aprobaciones");
  if (a.mode === "legacy") {
    return a.complete
      ? cond("aprobaciones", "ambar", "Hay aprobación única vigente; la doble aprobación (2/2) se exigirá cuando se aplique la migración 033 en esta base.", "aprobaciones")
      : cond("aprobaciones", "rojo", "Falta la aprobación del expediente.", "aprobaciones");
  }
  if (a.complete) return cond("aprobaciones", "verde", "Aprobado 2/2: técnico-legal y económica, por personas distintas.", null);
  if (a.sameApprover) return cond("aprobaciones", "rojo", "Las dos aprobaciones deben darlas personas distintas.", "aprobaciones");
  const faltan = a.missing.map((m) => STAGE_TEXT[m]).join(" y ");
  return cond("aprobaciones", "rojo", `Falta ${faltan || "la doble aprobación"}.`, "aprobaciones");
}

function evaluarChecklist(r: ChecklistReport | null): GateCondition {
  if (!r || r.items.length === 0) return cond("checklist", "rojo", "El checklist de integridad nunca se ha corrido.", "checklist");
  const rojos = r.items.filter((i) => i.status === "rojo").length;
  const ambares = r.items.filter((i) => i.status === "ambar").length;
  if (r.overallStatus === "rojo" || rojos > 0) return cond("checklist", "rojo", `El checklist tiene ${rojos || 1} punto(s) en rojo.`, "checklist");
  if (r.overallStatus === "ambar" || ambares > 0) return cond("checklist", "ambar", `El checklist tiene ${ambares || 1} punto(s) en ámbar por revisar.`, "checklist");
  return cond("checklist", "verde", "Checklist de integridad en verde.", null);
}

function evaluarPaquete(p: GatePackageInput | null): GateCondition {
  if (!p) return cond("paquete", "rojo", "Todavía no hay un paquete de envío ensamblado.", "paquete");
  if (p.storedStatus !== "ready") {
    const why = p.draftReasons[0] ? ` ${p.draftReasons[0]}` : "";
    return cond("paquete", "rojo", `El último paquete quedó en borrador.${why}`.trim(), "paquete");
  }
  if (p.vigenteStatus !== "ready") {
    const why = p.draftReasons[0] ? ` ${p.draftReasons[0]}` : "";
    return cond("paquete", "rojo", `El paquete ensamblado ya no está vigente: el expediente cambió.${why}`.trim(), "paquete");
  }
  return cond("paquete", "verde", "Paquete listo y vigente para el estado actual del expediente.", null);
}

function evaluarZip(z: GateZipCheck | null): GateCondition {
  if (!z) return cond("zip_manifiesto", "rojo", "No hay un ZIP guardado que verificar contra el manifiesto.", "paquete");
  if (z.state === "ilegible") return cond("zip_manifiesto", "rojo", "No se pudo leer el ZIP guardado: verifica el almacenamiento y vuelve a ensamblar.", "paquete");
  if (z.state === "no_coincide") {
    const n = z.documentos.length + z.faltantes.length;
    return cond("zip_manifiesto", "rojo", `El ZIP no coincide con el manifiesto (${n} documento(s) alterado(s) o ausente(s)). Vuelve a ensamblar el paquete.`, "paquete");
  }
  return cond("zip_manifiesto", "verde", `El ZIP coincide con el manifiesto (${z.documentos} documento(s) verificados por sha256).`, null);
}

function evaluarHolgura(c: GateCuentaRegresiva): GateCondition {
  if (c.estado === "sin_fecha") return cond("holgura", "ambar", "La convocatoria no declara fecha de cierre: no se puede medir la holgura.", "sala_tablero");
  const cuando = `${c.fechaCierreLocal} ${c.horaCierreLocal} (${c.zonaHoraria})`;
  if (c.estado === "vencido") return cond("holgura", "rojo", `El plazo de presentación ya venció (${cuando}).`, "sala_tablero");
  const horas = (c.msRestantes ?? 0) / 3_600_000;
  if (horas < GATE_HOLGURA_HORAS) return cond("holgura", "ambar", `Quedan ${textoRestante(c)}: menos de ${GATE_HOLGURA_HORAS} h de holgura al cierre (${cuando}).`, "sala_tablero");
  return cond("holgura", "verde", `Quedan ${textoRestante(c)} al cierre (${cuando}).`, null);
}

export function evaluarGateSalaGuerra(input: GateSalaGuerraInput): GateSalaGuerraResult {
  const cuentaRegresiva = buildCuentaRegresiva(input.fechaCierre, input.ahora, input.zonaHoraria);
  const condiciones: GateCondition[] = [
    evaluarAprobaciones(input.aprobaciones),
    evaluarChecklist(input.checklist),
    evaluarPaquete(input.paquete),
    evaluarZip(input.zip),
    evaluarHolgura(cuentaRegresiva),
  ];
  const orden: Record<GateColor, number> = { rojo: 0, ambar: 1, verde: 2 };
  const motivos = condiciones.filter((c) => c.color !== "verde").sort((a, b) => orden[a.color] - orden[b.color]).map((c) => c.motivo);
  const listo = !condiciones.some((c) => c.color === "rojo");
  const holguraHoras = cuentaRegresiva.msRestantes === null ? null : cuentaRegresiva.msRestantes / 3_600_000;
  // La alerta mira solo el paquete (no la propia holgura): "a menos de 24 h y el paquete no esta listo".
  const paqueteListo = !condiciones.some((c) => c.id !== "holgura" && c.color === "rojo");
  const alerta24h = !input.presentado && cuentaRegresiva.estado === "abierto" && holguraHoras !== null && holguraHoras < GATE_HOLGURA_HORAS && !paqueteListo;
  return { listo, veredicto: listo ? "listo" : "no_listo", condiciones, motivos, cuentaRegresiva, holguraHoras, alerta24h };
}
