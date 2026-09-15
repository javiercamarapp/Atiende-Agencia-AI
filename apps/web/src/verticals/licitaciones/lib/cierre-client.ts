// Cliente web del cierre del expediente (Fase 14) — cierra la porción de
// hallazgo ALTA de auditoría sobre `cierre.ts`: "expone POST
// .../expediente/approval (DECISION_ROLES), POST
// .../proposal/sections/:sectionKey/approval, POST .../package/assemble, GET
// .../package/latest y GET .../package/download [...] -- ninguno tiene
// cliente ni página". Junto con `runChecklist` (checklist-client.ts), este
// módulo alimenta `pages/Cierre.tsx`: correr el checklist de integridad,
// aprobar el expediente/una sección, ensamblar el paquete final y
// descargarlo -- el cierre completo del ciclo antes de la presentación.
//
// El "ready" del manifiesto SIEMPRE lo deriva `PackageAssembler` server-side
// (ver cabecera de cierre.ts, AE-14): este cliente nunca decide ni declara
// ese estado, solo transporta lo que el servidor ya calculó.
//
// Deliberadamente FUERA de esta pieza (alcance de rondas futuras, ver README
// de este vertical): `GET`/`POST .../submission[/declare]` (declarar que YA
// se presentó ante el portal), contratos, cobranza e inconformidades -- todo
// post-adjudicación.
import { postJson, defaultAuthCtx, LicitacionesAdminError } from "./admin-client.ts";
import { withAuthRefresh, apiBaseUrlFromRequestUrl } from "../../../lib/authed-fetch.ts";

export type ApprovalScope = "seccion" | "documento" | "expediente";

/** Espejo de la respuesta 201 de `POST .../expediente/approval` y `POST .../proposal/sections/:sectionKey/approval` (`cierre.ts`) -- nunca el `Approval` completo del dominio (sin `approvedBy`/`approvedByRole` en el borde, el actor ya es quien hizo la request). */
export interface ApprovalResult {
  readonly id: string;
  readonly scope: ApprovalScope;
  readonly scopeRef: string;
  readonly status: "vigente" | "invalidada";
  readonly inputsHash: string;
  readonly decidedAt: string;
}

/**
 * `POST .../expediente/approval` -- DECISION_ROLES en el servidor
 * (owner/admin/analyst, ver roles.ts); esta función no valida rol, solo
 * transporta. El hash de insumos que queda aprobado SIEMPRE se recalcula
 * server-side contra el estado VIVO del expediente -- este cliente nunca
 * envía uno propio (no hay campo para eso en el body: el servidor lo ignoraría
 * igual, ver cierre.ts). Un 403 (autoaprobación, o el rol no pertenece a
 * DECISION_ROLES) o 400 (scope/scopeRef inconsistente) llegan aquí como
 * `LicitacionesAdminError` con el mensaje que ya tradujo `mapApprovalRejectedError`.
 */
export async function approveExpediente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ApprovalResult> {
  return postJson<ApprovalResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/expediente/approval`, token, {});
}

/**
 * `POST .../proposal/sections/:sectionKey/approval` -- mismas DECISION_ROLES
 * que aprobar el expediente completo (revisar CUALQUIER alcance es una
 * decisión, nunca redacción, ver cabecera de cierre.ts). Revisión granular
 * INCREMENTAL: no afecta por sí sola si el paquete queda "ready" --
 * `PackageAssembler.buildManifest` solo consume aprobaciones de scope
 * "expediente" (ver comentario de cabecera de `buildAssembleInput` en
 * cierre.ts); esto es una capa de auditoría/revisión por sección, no un gate.
 */
export async function approveProposalSection(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, sectionKey: string): Promise<ApprovalResult> {
  return postJson<ApprovalResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal/sections/${encodeURIComponent(sectionKey)}/approval`, token, {});
}

export type PackageStatus = "draft" | "ready";

/** Espejo de la respuesta de `POST .../package/assemble` y `GET .../package/latest` (`cierre.ts`) -- nunca el `PackageManifest` completo del dominio (documentos/checklist/approvals detallados solo viven dentro del ZIP mismo, ver `PackageAssembler`). */
export interface PackageStatusResult {
  readonly id: string;
  readonly status: PackageStatus;
  readonly draftReasons: readonly string[];
  readonly missing: readonly string[];
  readonly generatedAt: string;
  readonly notice: string;
}

/**
 * `POST .../package/assemble` -- WRITE_ROLES en el servidor. Ensambla (y
 * persiste) el manifiesto + ZIP contra el estado VIVO del expediente en este
 * instante -- "ready" solo si el checklist está en verde, hay una aprobación
 * de alcance "expediente" vigente cuyo hash coincide con el actual, y no
 * faltan documentos requeridos (ver `PackageAssembler.buildManifest`, nunca
 * decidido aquí). Exige `idempotency-key`: un reintento manual siempre genera
 * una key nueva para que un doble clic nunca vuelva a escribir el ZIP dos
 * veces.
 */
export async function assemblePackage(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, idempotencyKey: string = crypto.randomUUID()): Promise<PackageStatusResult> {
  return postJson<PackageStatusResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/package/assemble`, token, {}, { "idempotency-key": idempotencyKey });
}

/**
 * `GET .../package/latest` -- ningún rol restringido en el servidor (lectura).
 * Devuelve `null` cuando nunca se ensambló ningún paquete todavía para este
 * expediente (404 explícito de `cierre.ts`, "No se ha generado ningún paquete
 * todavía..." -- tratado aquí como estado normal "sin paquete", no como
 * error). Si el último ensamblado guardado era "ready", el servidor
 * RE-DERIVA el estado contra el expediente vivo antes de responder (AE-14) --
 * este cliente siempre refleja lo que el servidor acaba de recalcular, nunca
 * cachea nada localmente entre llamadas.
 */
export async function fetchLatestPackage(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<PackageStatusResult | null> {
  const url = `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/package/latest`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LicitacionesAdminError(body?.message ?? `No se pudo consultar el último paquete (${res.status}).`);
  }
  return (await res.json()) as PackageStatusResult;
}

/** Espejo del 409 explícito de `GET .../package/download` (REQ-LIC-009/AE-14): el último ZIP guardado ERA "ready" pero la re-derivación en vivo ya no lo es -- nunca se sirve el ZIP viejo como si siguiera vigente. */
export interface PackageDownloadConflict {
  readonly code: "conflict";
  readonly message: string;
  readonly draftReasons: readonly string[];
  readonly missing: readonly string[];
}

export class PackageDownloadConflictError extends Error {
  constructor(readonly conflict: PackageDownloadConflict) {
    super(conflict.message);
    this.name = "PackageDownloadConflictError";
  }
}

export interface DownloadedPackage {
  readonly blob: Blob;
  readonly filename: string;
}

const DEFAULT_DOWNLOAD_FILENAME_PATTERN = /filename="([^"]+)"/;

/**
 * `GET .../package/download` -- ningún rol restringido en el servidor
 * (lectura). Responde bytes de ZIP (`application/zip`), nunca JSON en el
 * camino feliz -- por eso este cliente no puede reusar `fetchJson`/`postJson`
 * y arma su propio `withAuthRefresh` (mismo mecanismo de refresh-y-reintento
 * ante un 401, ver `admin-client.ts::fetchJson`). Un 409 (el "ready" guardado
 * ya no lo es, REQ-LIC-009) se traduce a `PackageDownloadConflictError` con el
 * detalle -- nunca se descarga un ZIP potencialmente obsoleto.
 */
export async function downloadPackage(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<DownloadedPackage> {
  const url = `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/package/download`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));

  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as PackageDownloadConflict | null;
    throw new PackageDownloadConflictError(
      body ?? { code: "conflict", message: "El paquete generado quedó desactualizado. Vuelve a ejecutar el ensamblado.", draftReasons: [], missing: [] },
    );
  }
  if (!res.ok) {
    // El camino de error de `cierre.ts` para 404/otros sigue siendo JSON
    // (`Errors.notFound`, etc.) -- solo el 200 feliz es binario.
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LicitacionesAdminError(body?.message ?? `No se pudo descargar el paquete (${res.status}).`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = DEFAULT_DOWNLOAD_FILENAME_PATTERN.exec(disposition);
  const filename = match?.[1] ?? `expediente-${tenderId}.zip`;
  return { blob, filename };
}
