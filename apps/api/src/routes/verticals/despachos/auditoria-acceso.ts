// D-38 -- bitacora de lecturas sensibles, descargas y exportaciones de despachos.
//
// Hasta ahora solo las ESCRITURAS dejaban fila en `despachos.audit_log` (via `despachosAuditSink`). Un documento que sale
// del sistema (descarga del portal, PDF/XLSX de un reporte, paquete XML de contabilidad electronica, layout DIOT, export de
// pagos provisionales, cartera en PDF) tambien es un evento que el dueno y el auditor deben poder reconstruir.
//
// Que se guarda: actor (id de usuario, sin correo), organizacion, accion `despachos.<recurso>:<lectura|descarga|export>`,
// ruta y metodo, y en `metadata` solo identificadores y parametros de forma (propertyId, periodo, formato, id de documento).
// NUNCA el contenido, nombres de archivo ni datos del contribuyente.
//
// El sink de produccion (`ProductionDespachosAuditSink`) escribe con su propia sesion de sistema y no lanza: un fallo de
// bitacora no convierte un export en un 500 (queda en el log estructurado del sink).
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";

export const TIPOS_EVENTO_ACCESO = ["lectura", "descarga", "export"] as const;
export type TipoEventoAcceso = (typeof TIPOS_EVENTO_ACCESO)[number];

export type MetadataAcceso = Readonly<Record<string, string | number | boolean | null>>;

export interface EventoAcceso {
  /** Recurso en minusculas con puntos, p. ej. `reporte.balanza` o `portal_cliente.documento`. */
  readonly recurso: string;
  readonly tipo: TipoEventoAcceso;
  readonly metadata?: MetadataAcceso;
}

/** Registra un evento de acceso (lectura/descarga/export) de la sesion autenticada. */
export async function auditarAccesoDespachos(deps: AppDeps, c: Context<CoreAuthHonoEnv>, evento: EventoAcceso): Promise<void> {
  const propertyId = c.req.param("propertyId") ?? null;
  await deps.despachosAuditSink.record({
    at: new Date().toISOString(),
    actorUserId: c.get("userId"),
    actorEmail: null,
    organizationId: c.get("organizationId"),
    action: `despachos.${evento.recurso}:${evento.tipo}`,
    route: c.req.path,
    method: c.req.method,
    decision: "allowed",
    metadata: { ...(evento.metadata ?? {}), tipoEvento: evento.tipo, recurso: evento.recurso, propertyId },
  });
}
