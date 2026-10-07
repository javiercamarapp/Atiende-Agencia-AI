// Cliente HTTP del piloto automatico de documentos y cierre (paridad3 D-31 / D-P3-15 / D-P3-21). Separado de las pantallas a proposito (mismo
// motivo que el resto de lib/*.ts): probarlo con vitest en entorno "node" sin DOM. Llama a apps/api/.../despachos/piloto.ts y cierre-mensual.ts.
import { fetchJson, postJson, putJson } from "./admin-client.ts";
import type { SemaforoDocumentos } from "./cartera-client.ts";

export type TipoRenglon = "estado_cuenta" | "xml_emitidos" | "xml_recibidos" | "nomina" | "otros";
export type EstadoRenglon = "pendiente" | "en_revision" | "recibido" | "no_aplica";

export interface PlantillaSolicitud {
  readonly xmlEmitidos?: boolean;
  readonly xmlRecibidos?: boolean;
  readonly nomina?: boolean;
  readonly otros?: boolean;
  readonly estadosCuenta?: readonly string[];
}

export interface AutomatizacionCliente {
  readonly contactoCorreo: string | null;
  readonly envioReportesCierre: boolean;
  readonly solicitudActiva: boolean;
  readonly solicitudDia: number;
  readonly plantilla: PlantillaSolicitud;
}

export interface RenglonSolicitud {
  readonly id: string;
  readonly tipo: TipoRenglon;
  readonly etiqueta: string;
  readonly estado: EstadoRenglon;
  readonly motivoNoAplica: string | null;
  readonly documentoId: string | null;
  readonly resueltoEn: string | null;
}

export interface SolicitudDocumentos {
  readonly id: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly estado: "abierta" | "completa";
  readonly creadaEn: string;
  readonly completadaEn: string | null;
  readonly ultimoRecordatorioNivel: number;
  readonly renglones: readonly RenglonSolicitud[];
}

export const ETIQUETA_SEMAFORO: Readonly<Record<SemaforoDocumentos, string>> = {
  verde: "Completo",
  amarillo: "En proceso",
  rojo: "Atrasado",
  sin_solicitud: "Sin pedir",
};
export const TONO_SEMAFORO: Readonly<Record<SemaforoDocumentos, "success" | "warning" | "danger" | "neutral">> = { verde: "success", amarillo: "warning", rojo: "danger", sin_solicitud: "neutral" };

export const ETIQUETA_ESTADO_RENGLON: Readonly<Record<EstadoRenglon, string>> = { pendiente: "Pendiente", en_revision: "En revisión", recibido: "Recibido", no_aplica: "No aplica" };
export const TONO_ESTADO_RENGLON: Readonly<Record<EstadoRenglon, "success" | "warning" | "danger" | "neutral" | "info">> = { pendiente: "warning", en_revision: "info", recibido: "success", no_aplica: "neutral" };

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}`;

export async function fetchAutomatizacion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly disponible: boolean; readonly automatizacion: AutomatizacionCliente | null }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/automatizacion`, token);
}

export async function guardarAutomatizacion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, a: AutomatizacionCliente): Promise<AutomatizacionCliente> {
  const r = await putJson<{ automatizacion: AutomatizacionCliente }>(f, `${base(apiBaseUrl, propertyId)}/automatizacion`, token, a);
  return r.automatizacion;
}

export async function fetchSolicitudes(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly disponible: boolean; readonly solicitudes: readonly SolicitudDocumentos[] }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/solicitudes-documentos`, token);
}

export type EstadoCorreoSolicitud = "enviado" | "sin_contacto" | "no_enviado" | "ya_existia";
export async function pedirDocumentos(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<{ readonly id: string; readonly creada: boolean; readonly correo: EstadoCorreoSolicitud }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/solicitudes-documentos`, token, { periodo });
}

export async function marcarNoAplica(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, renglonId: string, motivo: string): Promise<void> {
  await postJson(f, `${base(apiBaseUrl, propertyId)}/solicitudes-documentos/renglones/${renglonId}/no-aplica`, token, { motivo });
}

export async function reabrirRenglon(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, renglonId: string): Promise<void> {
  await postJson(f, `${base(apiBaseUrl, propertyId)}/solicitudes-documentos/renglones/${renglonId}/reabrir`, token, {});
}

/** Periodo anterior al mes de `hoy` (AAAA-MM-DD): el que normalmente se pide al cliente. */
export function periodoAnterior(hoy: string): string {
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7));
  return mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, "0")}`;
}

export const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Retroalimentacion inmediata del formulario de automatizacion; el servidor y la base validan de verdad. */
export function erroresAutomatizacion(a: AutomatizacionCliente): Record<string, string> {
  const e: Record<string, string> = {};
  const correo = (a.contactoCorreo ?? "").trim();
  if (correo !== "" && (correo.length > 254 || !CORREO_RE.test(correo))) e.contactoCorreo = "Escribe un correo válido.";
  if (a.envioReportesCierre && correo === "") e.envioReportesCierre = "Para enviar reportes al cerrar captura primero el correo de contacto.";
  if (!Number.isInteger(a.solicitudDia) || a.solicitudDia < 1 || a.solicitudDia > 28) e.solicitudDia = "Un día del 1 al 28.";
  const cuentas = a.plantilla.estadosCuenta ?? [];
  if (cuentas.length > 10 || cuentas.some((c) => c.trim().length < 1 || c.trim().length > 40)) e.estadosCuenta = "Hasta 10 cuentas de 1 a 40 caracteres.";
  return e;
}

export function textoACuentas(texto: string): readonly string[] {
  return texto
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

export function resumenRenglones(s: SolicitudDocumentos): string {
  const n = (e: EstadoRenglon) => s.renglones.filter((r) => r.estado === e).length;
  const partes = [`${n("recibido")} recibido(s)`];
  if (n("en_revision") > 0) partes.push(`${n("en_revision")} en revisión`);
  if (n("pendiente") > 0) partes.push(`${n("pendiente")} pendiente(s)`);
  if (n("no_aplica") > 0) partes.push(`${n("no_aplica")} no aplica`);
  return partes.join(" · ");
}
