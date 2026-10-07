// Autopiloto de la ingesta (paridad3 L-P3-08 / L-P3-09): lo que pasa DESPUES de que el cron de descubrimiento
// (`/internal/licitaciones/discover-tenders`) guardo las convocatorias. El orquestador es POR CODIGO (REQ-070): ningun LLM
// decide que paso sigue.
//
//   1. Cambio de bases (vigilante): la version y la cascada de invalidacion YA quedaron persistidas por el repositorio (en la
//      transaccion de la fuente); aqui solo se AVISA: campana `licitaciones.convocatoria.bases_modificadas` (clave = id de la
//      convocatoria + version), campana `licitaciones.expediente.aprobacion_invalidada` si la cascada invalido una aprobacion
//      y correo a los responsables de la organizacion (owner/admin). Un canal que falla NUNCA revierte la version ni la
//      invalidacion: cada aviso corre en su propia transaccion de sistema y un error se cuenta, no se propaga.
//   2. Nuevo match: para cada convocatoria NUEVA de la corrida calcula el matching contra el perfil de la organizacion
//      (`evaluateNewMatch`: plazo vigente, elegible o con puntuacion >= el umbral de `tenant_config`), registra el aviso con
//      dedupe por organizacion y convocatoria y emite campana (las mejores 5, una por convocatoria, sin PII: solo la
//      puntuacion), correo (un correo por organizacion con las mejores) y WhatsApp con plantilla solo a contactos con opt-in.
//
// Sin PII en la campana (ninguna notificacion lleva titulos, entidades ni montos). El correo SI lleva el titulo: va a miembros de
// la organizacion duena de la convocatoria. Base sin la migracion 039: el contexto de matching/registro devuelve `null` y el
// resultado lo declara (`noDisponible`), nunca un 500.
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import { WhatsAppNotAvailableError, correoBasesModificadas, correoNuevoMatch, enqueueTenderNotices, evaluateNewMatch } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, TenderBasesChange, TenderRecord } from "@atiende/domain-licitaciones";
import type { DiscoverTendersSweepResult } from "@atiende/worker";
import type { AppDeps } from "../../../deps.ts";
import { avisarCambioDeBases } from "./avisos-campana.ts";

/** Cuantas convocatorias nuevas con match salen UNA POR UNA en la campana (el resto queda en el correo y en el resumen semanal). */
export const TOPE_MATCHES_EN_CAMPANA = 5;

export interface AutopilotoIngestaResumen {
  readonly cambiosDeBases: number;
  readonly avisosAprobacionInvalidada: number;
  readonly correosCambioDeBases: number;
  readonly nuevosMatches: number;
  readonly avisosNuevoMatch: number;
  readonly correosNuevoMatch: number;
  readonly whatsappNuevoMatch: number;
  /** Organizaciones cuyo contexto de matching no se pudo leer (base sin la migracion 039). */
  readonly matchNoDisponible: number;
  /** Avisos que fallaron con un error real (se cuentan, no se propagan). */
  readonly errores: number;
}

/** Corre `fn` en un SAVEPOINT: un fallo del canal (correo/WhatsApp) deja la transaccion utilizable y se reporta como `false`. */
async function mejorEsfuerzo(db: TenantDbSession, etiqueta: string, fn: () => Promise<void>): Promise<boolean> {
  return runWithSavepointFallback<boolean>({
    session: db,
    primary: async () => {
      await fn();
      return true;
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      if (!(err instanceof WhatsAppNotAvailableError)) console.error(`autopiloto-ingesta: ${etiqueta} fallo (best-effort):`, err instanceof Error ? err.message : err);
      return false;
    },
  });
}

/** Etiqueta legible del plazo en la zona de plataforma por omision (sin PII). */
function etiquetaPlazo(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" }).format(d);
}

function huellaIds(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

async function encolarCorreo(repo: LicitacionesRepository, organizationId: string, eventType: string, dedupeBase: string, correo: { asunto: string; html: string; texto: string }): Promise<number> {
  const destinatarios = await repo.listOrganizationNotificationRecipients(organizationId);
  let n = 0;
  for (const d of destinatarios) {
    await repo.enqueueMessagingOutbox(organizationId, "email", eventType, `${dedupeBase}:${d.email}`, { to: d.email, subject: correo.asunto, html: correo.html, text: correo.texto });
    n += 1;
  }
  return n;
}

async function avisarUnCambioDeBases(deps: AppDeps, organizationId: string, cambio: TenderBasesChange): Promise<{ aprobacion: boolean; correos: number }> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    await avisarCambioDeBases(db, { organizationId, tenderId: cambio.tenderId, version: cambio.version });
    let aprobacion = false;
    if (cambio.invalidatedApprovals > 0) {
      const e = await emitirNotificacion(db, { evento: "licitaciones.expediente.aprobacion_invalidada", organizationId, clave: `${cambio.tenderId}:v${cambio.version}`, entidadTipo: "convocatoria", entidadId: cambio.tenderId });
      aprobacion = e.estado === "emitida";
    }
    let correos = 0;
    await mejorEsfuerzo(db, "correo de cambio de bases", async () => {
      const correo = correoBasesModificadas({ tenderTitle: cambio.tenderTitle, version: cambio.version, camposCambiados: cambio.changedFieldNames, aprobacionesInvalidadas: cambio.invalidatedApprovals });
      correos = await encolarCorreo(deps.licitacionesRepo(db), organizationId, "tender.bases_modificadas", `bases-modificadas:${cambio.tenderId}:v${cambio.version}`, correo);
    });
    return { aprobacion, correos };
  });
}

interface MatchAceptado {
  readonly tender: TenderRecord;
  readonly score: number;
}

async function avisarNuevosMatches(deps: AppDeps, organizationId: string, nuevas: readonly TenderRecord[], ahora: Date): Promise<{ nuevos: number; campana: number; correos: number; whatsapp: number; noDisponible: boolean }> {
  const waFactory = deps.licitacionesWhatsAppRepo;
  const whatsappActivo = Boolean(waFactory && deps.env.licitacionesWhatsappPhoneNumberId);
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.licitacionesRepo(db);
    const contexto = await repo.getNewMatchContext(organizationId);
    if (!contexto) return { nuevos: 0, campana: 0, correos: 0, whatsapp: 0, noDisponible: true };

    const aceptados: MatchAceptado[] = [];
    for (const tender of nuevas) {
      const evaluacion = evaluateNewMatch(tender, contexto, ahora);
      if (!evaluacion.notify) continue;
      const registrado = await repo.recordNewMatch(organizationId, tender.id, { score: evaluacion.score, eligible: evaluacion.eligible });
      if (registrado === null) return { nuevos: 0, campana: 0, correos: 0, whatsapp: 0, noDisponible: true };
      if (registrado) aceptados.push({ tender, score: evaluacion.score });
    }
    if (aceptados.length === 0) return { nuevos: 0, campana: 0, correos: 0, whatsapp: 0, noDisponible: false };

    aceptados.sort((a, b) => b.score - a.score);
    const mejores = aceptados.slice(0, TOPE_MATCHES_EN_CAMPANA);

    let campana = 0;
    for (const m of mejores) {
      // SAVEPOINT por aviso: si la campana falla no se revierte el dedupe (recordNewMatch) de la organizacion ni los demas avisos.
      await mejorEsfuerzo(db, "campana de nuevo match", async () => {
        const e = await emitirNotificacion(db, { evento: "licitaciones.convocatoria.nuevo_match", organizationId, clave: m.tender.id, parametros: { puntuacion: m.score }, entidadTipo: "convocatoria", entidadId: m.tender.id });
        if (e.estado === "emitida") campana += 1;
      });
    }

    let correos = 0;
    await mejorEsfuerzo(db, "correo de nuevo match", async () => {
      const correo = correoNuevoMatch({ total: aceptados.length, items: mejores.map((m) => ({ title: m.tender.title, score: m.score, deadlineLabel: etiquetaPlazo(m.tender.submissionDeadline) })) });
      correos = await encolarCorreo(repo, organizationId, "tender.nuevo_match", `nuevo-match:${organizationId}:${huellaIds(aceptados.map((m) => m.tender.id))}`, correo);
    });

    let whatsapp = 0;
    if (whatsappActivo) {
      await mejorEsfuerzo(db, "WhatsApp de nuevo match", async () => {
        for (const m of mejores) {
          whatsapp += await enqueueTenderNotices(waFactory!(db), {
            organizationId,
            kind: "convocatoria",
            tender: { title: m.tender.title, deadlineLabel: etiquetaPlazo(m.tender.submissionDeadline) },
            dedupeRef: m.tender.id,
            extra: `Afinidad ${m.score}/100.`,
          });
        }
      });
    }
    return { nuevos: aceptados.length, campana, correos, whatsapp, noDisponible: false };
  });
}

/**
 * Avisos del barrido de descubrimiento. Una organizacion con error en el barrido no avisa nada (la siguiente corrida
 * reintenta lo que siga pendiente). Cada aviso corre en su propia transaccion de sistema: un fallo en uno no afecta a los demas ni
 * a la version ya persistida.
 */
export async function avisarAutopilotoDeIngesta(deps: AppDeps, sweep: readonly DiscoverTendersSweepResult[], ahora: Date = new Date()): Promise<AutopilotoIngestaResumen> {
  const total = { cambiosDeBases: 0, avisosAprobacionInvalidada: 0, correosCambioDeBases: 0, nuevosMatches: 0, avisosNuevoMatch: 0, correosNuevoMatch: 0, whatsappNuevoMatch: 0, matchNoDisponible: 0, errores: 0 };
  for (const org of sweep) {
    if (org.error) continue;
    const cambios = org.results.flatMap((r) => r.basesModificadas);
    for (const cambio of cambios) {
      try {
        const r = await avisarUnCambioDeBases(deps, org.organizationId, cambio);
        total.cambiosDeBases += 1;
        if (r.aprobacion) total.avisosAprobacionInvalidada += 1;
        total.correosCambioDeBases += r.correos;
      } catch (err) {
        total.errores += 1;
        console.error("autopiloto-ingesta: el aviso de cambio de bases fallo (la version y la invalidacion ya estaban guardadas):", err instanceof Error ? err.message : err);
      }
    }
    const nuevas = org.results.flatMap((r) => r.createdTenders);
    if (nuevas.length === 0) continue;
    try {
      const r = await avisarNuevosMatches(deps, org.organizationId, nuevas, ahora);
      if (r.noDisponible) total.matchNoDisponible += 1;
      total.nuevosMatches += r.nuevos;
      total.avisosNuevoMatch += r.campana;
      total.correosNuevoMatch += r.correos;
      total.whatsappNuevoMatch += r.whatsapp;
    } catch (err) {
      total.errores += 1;
      console.error("autopiloto-ingesta: el nuevo match fallo para una organizacion:", err instanceof Error ? err.message : err);
    }
  }
  return total;
}
