// Resumen semanal por organizacion (paridad3 L-P3-11, cierra el digest de L-15). SIN cron nuevo: corre al final del barrido existente
// `/internal/licitaciones/alert-notifications` (diario); el dedupe por semana hace que el primer barrido de la semana (el lunes) lo
// envie y los demas dias no repitan. Una transaccion de sistema por organizacion: un fallo en una no afecta a las demas.
//
// Contenido (todo sale de datos que el sistema ya tiene; nada inventado): convocatorias nuevas con match de los ultimos 7 dias
// (`new_match_notice`), plazos de presentacion de los proximos 7 dias, documentos de empresa por vencer (30 dias), facturas de
// contratos vencidas y garantias por vencer. Se emite SOLO si hay algo que contar. La campana lleva solo conteos (sin PII); el
// correo (a owner/admin de la organizacion) lleva los titulos de las convocatorias. Base sin la migracion 039/034/035: ese
// componente cuenta 0 (nunca un 500).
import { emitirNotificacion } from "@atiende/db";
import { GARANTIA_POR_VENCER_DIAS, correoResumenSemanal } from "@atiende/domain-licitaciones";
import type { AppDeps } from "../../../deps.ts";
import { DOCUMENTOS_POR_VENCER_DIAS, inicioDeSemana } from "./avisos-campana.ts";

export const DIAS_VENTANA_RESUMEN = 7;
const MAX_MATCHES_EN_CORREO = 5;
const MAX_PLAZOS_EN_CORREO = 10;

export interface ResumenSemanalResultado {
  readonly organizacionesConResumen: number;
  readonly correosEncolados: number;
  readonly errores: number;
}

function etiquetaPlazo(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" }).format(d);
}

/**
 * Resumen semanal de cada organizacion del barrido (una organizacion con error en el barrido no lo recibe; la siguiente corrida
 * lo reintenta mientras no haya salido en la semana).
 */
export async function avisarResumenSemanal(deps: AppDeps, sweep: readonly { readonly organizationId: string; readonly error?: string }[], hoyIso: string, ahora: Date = new Date()): Promise<ResumenSemanalResultado> {
  const semana = inicioDeSemana(hoyIso);
  const total = { organizacionesConResumen: 0, correosEncolados: 0, errores: 0 };
  for (const r of sweep) {
    if (r.error != null) continue;
    const org = r.organizationId;
    try {
      await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo = deps.licitacionesRepo(db);
        const desde = new Date(ahora.getTime() - DIAS_VENTANA_RESUMEN * 86_400_000).toISOString();

        const nuevosMatches = (await repo.listNewMatches(org, desde, 50)) ?? [];
        const plazos = await repo.listUpcomingDeadlines(org, ahora.toISOString(), DIAS_VENTANA_RESUMEN);
        const documentos = deps.licitacionesAvisosRepo ? ((await deps.licitacionesAvisosRepo(db).contarDocumentosPorVencer(org, hoyIso, DOCUMENTOS_POR_VENCER_DIAS)) ?? 0) : 0;
        const facturas = (await repo.listOverdueContractInvoices(org, hoyIso)).length;
        const garantias = deps.licitacionesPostAdjudicacionRepo
          ? ((await deps.licitacionesPostAdjudicacionRepo(db).listAlertCandidates(org, hoyIso, GARANTIA_POR_VENCER_DIAS)) ?? []).filter((c) => c.tipo === "garantia_por_vencer").length
          : 0;

        if (nuevosMatches.length + plazos.length + documentos + facturas + garantias === 0) return;

        const e = await emitirNotificacion(db, {
          evento: "licitaciones.resumen.semanal",
          organizationId: org,
          clave: `${org}:${semana}`,
          parametros: { matches: nuevosMatches.length, plazos: plazos.length, documentos, facturas, garantias },
        });
        // Un resumen ya enviado esta semana (dedupe) no se repite por correo.
        if (e.estado !== "emitida") return;
        total.organizacionesConResumen += 1;

        const correo = correoResumenSemanal({
          semanaDesde: semana,
          totalMatches: nuevosMatches.length,
          matches: nuevosMatches.slice(0, MAX_MATCHES_EN_CORREO).map((m) => ({ title: m.tenderTitle, score: m.score, deadlineLabel: null })),
          plazos: plazos.slice(0, MAX_PLAZOS_EN_CORREO).map((p) => ({ title: p.title, deadlineLabel: etiquetaPlazo(p.submissionDeadline) })),
          documentosPorVencer: documentos,
          facturasVencidas: facturas,
          garantiasPorVencer: garantias,
        });
        for (const d of await repo.listOrganizationNotificationRecipients(org)) {
          await repo.enqueueMessagingOutbox(org, "email", "tender.resumen_semanal", `resumen-semanal:${org}:${semana}:${d.email}`, { to: d.email, subject: correo.asunto, html: correo.html, text: correo.texto });
          total.correosEncolados += 1;
        }
      });
    } catch (err) {
      total.errores += 1;
      console.error("autopiloto-resumen: el resumen semanal fallo para una organizacion (best-effort):", err instanceof Error ? err.message : err);
    }
  }
  return total;
}
