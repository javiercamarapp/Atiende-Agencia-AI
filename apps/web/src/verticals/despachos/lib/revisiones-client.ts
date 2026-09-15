// Cliente web de la cola de revisión humana de CFDI (Fase 9, hallazgo de auditoría
// severidad ALTA: "backend completo -listar/aprobar/rechazar con auditoría- sin
// ninguna pantalla ni botón"). Llama a `GET/POST /despachos/:propertyId/revisiones*`
// (apps/api/.../despachos/revisiones.ts, `serializeReview`) — el motor real
// (`fnbAllergyGuard`-style: nunca se declara un CFDI resuelto sin que un humano
// confirme cuando `validarCfdiDespachos()` tenía dudas) vive en @atiende/domain-despachos;
// este cliente solo transporta lo que la ruta ya serializa, mismo patrón que
// cfdi-client.ts/cierre-mensual-client.ts de este mismo panel.
//
// Nota importante: `GET .../revisiones` SIEMPRE devuelve solo las revisiones con
// estado "pendiente" (repo.listPendingReviews, sin parámetro de filtro) — no hay
// endpoint para listar revisiones ya resueltas salvo por id conocido
// (`GET .../revisiones/:reviewId`, usado por fetchRevision). Por eso
// CfdiDetalle.tsx resuelve "¿hay una revisión pendiente para este invoiceId?"
// buscando dentro de fetchRevisionesPendientes() en vez de pedir un endpoint que
// no existe.
import { fetchJson, postJson } from "./admin-client.ts";

export type EstadoRevision = "pendiente" | "aprobado" | "rechazado";

export interface RevisionCfdi {
  readonly id: string;
  readonly invoiceId: string;
  readonly motivo: string;
  readonly estado: EstadoRevision;
  readonly notaDecision: string | null;
  readonly resueltoPor: string | null;
  readonly resueltoEn: string | null;
  readonly creadoEn: string;
}

export async function fetchRevisionesPendientes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RevisionCfdi[]> {
  return fetchJson<readonly RevisionCfdi[]>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/revisiones`, token);
}

export async function fetchRevision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reviewId: string): Promise<RevisionCfdi> {
  return fetchJson<RevisionCfdi>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/revisiones/${reviewId}`, token);
}

export async function aprobarRevision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reviewId: string, nota?: string): Promise<RevisionCfdi> {
  return postJson<RevisionCfdi>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/revisiones/${reviewId}/aprobar`, token, nota ? { nota } : {});
}

export async function rechazarRevision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reviewId: string, nota?: string): Promise<RevisionCfdi> {
  return postJson<RevisionCfdi>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/revisiones/${reviewId}/rechazar`, token, nota ? { nota } : {});
}
