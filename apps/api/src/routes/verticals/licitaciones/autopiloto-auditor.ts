// Auditor y mensajero deterministas del expediente (paridad3 L-P3-11). POR CODIGO (REQ-070): ningun LLM decide nada.
//
// Se invoca DESPUES de cada escritura que cambia un insumo del expediente (checklist, propuesta tecnica, mapeo de requisitos,
// propuesta economica), dentro de la transaccion del request y en un SAVEPOINT: un fallo del auditor NUNCA cambia ni revierte la
// escritura de negocio. Que hace:
//   1. Re-sincroniza las aprobaciones con el hash VIVO de insumos (el mismo choke point AE-14 del cierre). Si un insumo invalido
//      una aprobacion vigente, avisa: campana `licitaciones.expediente.aprobacion_invalidada` (a quienes pueden aprobar) y
//      correo a owner/admin.
//   2. Clasifica el checklist persistido (`clasificarExpediente`): sin bloqueos = corrido al menos una vez y ninguna dimension en
//      rojo. Si pasa de "con bloqueos" (o nunca auditado) a "sin bloqueos" y las aprobaciones aun no estan completas, avisa:
//      campana `licitaciones.expediente.listo_para_aprobar` + correo. Guarda el ultimo estado (migracion 039).
// NADA se aprueba solo: la aprobacion sigue siendo humana, con rol de decision y step-up (REQ-044). Sin PII: la campana lleva solo
// ids y el prefijo del hash de insumos; el correo (a miembros de la organizacion) lleva el titulo de la convocatoria.
//
// "Idempotencia existente" (`withIdempotency`): el auditor no ejecuta el checklist (necesita archivos y firmas que declara una
// persona en `POST .../checklist/run`, que ya es idempotente por `Idempotency-Key`); audita su RESULTADO persistido, asi que
// repetirlo sobre el mismo estado no avisa dos veces (transicion + clave de dedupe de la campana + dedupe_key del outbox).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import { clasificarExpediente, correoAprobacionInvalidada, correoExpedienteListo, evaluateExpedienteStages, sealInputs, transicionDeExpediente } from "@atiende/domain-licitaciones";
import type { ExpedienteInputs } from "@atiende/domain-licitaciones";
import type { AppDeps } from "../../../deps.ts";

export interface AuditoriaExpedienteResultado {
  readonly auditado: boolean;
  readonly estado: "con_bloqueos" | "sin_bloqueos" | null;
  readonly aprobacionInvalidada: boolean;
  readonly listoParaAprobar: boolean;
  /** La base aun no tiene la tabla `expediente_auditoria` (migracion 039): se avisa solo con la clave de dedupe de la campana. */
  readonly sinRegistroPersistente: boolean;
}

const VACIO: AuditoriaExpedienteResultado = { auditado: false, estado: null, aprobacionInvalidada: false, listoParaAprobar: false, sinRegistroPersistente: false };

/** Correo a owner/admin en una transaccion de SISTEMA aparte (la lectura de destinatarios y el outbox exigen auth.uid() nulo). Nunca lanza. */
async function correoAlEquipo(deps: AppDeps, organizationId: string, eventType: string, dedupeBase: string, correo: { asunto: string; html: string; texto: string }): Promise<number> {
  try {
    return await deps.engine.withAppSession({ userId: null }, async (sistema) => {
      const repo = deps.licitacionesRepo(sistema);
      const destinatarios = await repo.listOrganizationNotificationRecipients(organizationId);
      for (const d of destinatarios) {
        await repo.enqueueMessagingOutbox(organizationId, "email", eventType, `${dedupeBase}:${d.email}`, { to: d.email, subject: correo.asunto, html: correo.html, text: correo.texto });
      }
      return destinatarios.length;
    });
  } catch (err) {
    console.error(`autopiloto-auditor: el correo "${eventType}" fallo (best-effort):`, err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Audita el expediente de una convocatoria tras un cambio de insumo. Nunca lanza (SAVEPOINT + fallback que solo registra): si la
 * base no tiene la migracion 039 o algo falla, la escritura de negocio que lo invoco sigue intacta.
 */
export async function auditarExpediente(deps: AppDeps, db: TenantDbSession, input: { readonly organizationId: string; readonly tenderId: string }): Promise<AuditoriaExpedienteResultado> {
  return runWithSavepointFallback<AuditoriaExpedienteResultado>({
    session: db,
    savepointName: "sp_autopiloto_auditor",
    primary: async () => {
      const repo = deps.licitacionesRepo(db);
      const { organizationId, tenderId } = input;
      const proposal = await repo.findProposal(organizationId, tenderId);
      if (!proposal) return VACIO;

      // 1) Sincroniza las aprobaciones con el hash VIVO: si un insumo cambio, invalida lo que ya no es valido.
      const { raw } = await repo.computeCurrentInputsHash(organizationId, tenderId, proposal.id);
      const sealed = sealInputs(raw as ExpedienteInputs);
      const cambio = await repo.syncExpedienteApprovalWithCurrentHash(organizationId, proposal.id, sealed, raw as ExpedienteInputs);
      const claveHash = `${proposal.id}:${sealed.hash.slice(0, 12)}`;
      const tender = await repo.findTender(organizationId, tenderId);
      const titulo = tender?.title ?? "la convocatoria";

      let aprobacionInvalidada = false;
      if (cambio && cambio.invalidatedApprovalIds.length > 0) {
        const e = await emitirNotificacion(db, { evento: "licitaciones.expediente.aprobacion_invalidada", organizationId, clave: claveHash, entidadTipo: "convocatoria", entidadId: tenderId });
        aprobacionInvalidada = e.estado === "emitida";
        if (aprobacionInvalidada) await correoAlEquipo(deps, organizationId, "expediente.aprobacion_invalidada", `aprobacion-invalidada:${claveHash}`, correoAprobacionInvalidada({ tenderTitle: titulo }));
      }

      // 2) Clasifica el checklist persistido y detecta la transicion hacia "sin bloqueos".
      const items = await repo.listComplianceItems(organizationId, proposal.id);
      const { estado, bloqueos } = clasificarExpediente(items);
      const previo = await repo.getExpedienteAuditoria(organizationId, proposal.id);
      const transicion = transicionDeExpediente(previo.registro?.estado ?? null, estado);

      // Si las aprobaciones ya estan completas para este hash no hay nada que pedir.
      const snapshot = await repo.listExpedienteStageApprovals(organizationId, proposal.id);
      const aprobado = snapshot.mode === "doble" ? evaluateExpedienteStages(snapshot.approvals, sealed.hash).complete : snapshot.approvals.some((a) => a.inputsHash === sealed.hash);

      let listoParaAprobar = false;
      if (transicion === "listo_para_aprobar" && !aprobado) {
        const e = await emitirNotificacion(db, { evento: "licitaciones.expediente.listo_para_aprobar", organizationId, clave: claveHash, entidadTipo: "convocatoria", entidadId: tenderId });
        listoParaAprobar = e.estado === "emitida";
        if (listoParaAprobar) await correoAlEquipo(deps, organizationId, "expediente.listo_para_aprobar", `listo-para-aprobar:${claveHash}`, correoExpedienteListo({ tenderTitle: titulo }));
      }

      const guardado = await repo.saveExpedienteAuditoria(organizationId, { proposalId: proposal.id, tenderId, estado, bloqueos, inputsHash: sealed.hash });
      return { auditado: true, estado, aprobacionInvalidada, listoParaAprobar, sinRegistroPersistente: !previo.disponible || !guardado };
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      console.error("autopiloto-auditor: la auditoria del expediente fallo (la escritura de negocio queda intacta):", err instanceof Error ? err.message : err);
      return VACIO;
    },
  });
}
