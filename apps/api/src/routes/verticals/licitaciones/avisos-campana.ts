// L-30 / L-32 -- productores de la campana (core.notification) de licitaciones. UN solo archivo para que cada evento
// quede junto a su regla de dedupe, y SIEMPRE en el punto de ESCRITURA o en el barrido existente, nunca en un GET:
//
//   * licitaciones.renovacion.por_vencer / licitaciones.cobranza.factura_vencida / licitaciones.documentos.por_vencer:
//     despues del barrido `/internal/licitaciones/alert-notifications` (el cron YA agendado en vercel.json). Solo
//     conteos; una transaccion propia por organizacion.
//   * licitaciones.convocatoria.bases_modificadas: justo despues de la escritura que CREA una version nueva sobre una
//     convocatoria que ya tenia una (alta manual con cambios, recalculo, re-extraccion de requisitos). Un recalculo
//     sin cambios (`created: false`) no emite.
//   * licitaciones.kyc.proveedor_empeoro: despues del re-tamizado de la cartera KYC (ruta interna idempotente);
//     solo cuando el semaforo de un PROVEEDOR propio empeora respecto de la evaluacion anterior.
//
// Contrato: `emitirNotificacion` nunca lanza y corre en SAVEPOINT; un aviso fallido (o la base sin la 0039/034) jamas
// cambia el barrido, la respuesta ni la escritura de negocio. Sin PII: parametros solo numericos y claves de dedupe
// con ids y fechas (ningun RFC, nombre ni titulo).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../../../deps.ts";

/** Ventana de "por vencer" de los documentos de empresa (dias). */
export const DOCUMENTOS_POR_VENCER_DIAS = 30;

/** Lunes (UTC) de la semana de `hoyIso` ("YYYY-MM-DD"): clave de dedupe semanal estable para eventos que se re-detectan a diario. */
export function inicioDeSemana(hoyIso: string): string {
  const d = new Date(`${hoyIso}T00:00:00Z`);
  const dia = d.getUTCDay(); // 0 = domingo
  d.setUTCDate(d.getUTCDate() - ((dia + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Resumen minimo, por organizacion, que necesita el aviso (subconjunto estructural de `AlertNotificationSweepResult`). */
export interface ResumenBarridoOrganizacion {
  readonly organizationId: string;
  readonly error?: string;
  readonly renewalAlerts: { readonly alertsCreated: number };
  readonly collectionAlerts: { readonly overdueInvoices: number };
}

export interface AvisosBarridoResultado {
  readonly renovacion: number;
  readonly cobranza: number;
  readonly documentos: number;
}

/**
 * Avisos del barrido de alertas. Una organizacion con error en el barrido no emite nada (su resumen es vacio y la
 * siguiente corrida lo reintenta). Cada organizacion usa transacciones propias: un fallo en una no afecta a las demas.
 */
export async function avisarAlertasDelBarrido(deps: AppDeps, sweep: readonly ResumenBarridoOrganizacion[], hoyIso: string): Promise<AvisosBarridoResultado> {
  const semana = inicioDeSemana(hoyIso);
  let renovacion = 0;
  let cobranza = 0;
  let documentos = 0;
  for (const r of sweep) {
    if (r.error != null) continue;
    const org = r.organizationId;
    if (r.renewalAlerts.alertsCreated > 0 || r.collectionAlerts.overdueInvoices > 0) {
      await deps.engine
        .withAppSession({ userId: null }, async (db) => {
          if (r.renewalAlerts.alertsCreated > 0) {
            const e = await emitirNotificacion(db, { evento: "licitaciones.renovacion.por_vencer", organizationId: org, clave: `${org}:${hoyIso}`, parametros: { cantidad: r.renewalAlerts.alertsCreated } });
            if (e.estado === "emitida") renovacion += 1;
          }
          if (r.collectionAlerts.overdueInvoices > 0) {
            const e = await emitirNotificacion(db, { evento: "licitaciones.cobranza.factura_vencida", organizationId: org, clave: `${org}:${semana}`, parametros: { cantidad: r.collectionAlerts.overdueInvoices } });
            if (e.estado === "emitida") cobranza += 1;
          }
        })
        .catch(() => undefined);
    }
    const avisosFactory = deps.licitacionesAvisosRepo;
    if (avisosFactory) {
      // Transaccion propia: si el conteo falla con un error de Postgres distinto de "migracion pendiente" no arrastra
      // los avisos de renovacion/cobranza de arriba.
      await deps.engine
        .withAppSession({ userId: null }, async (db) => {
          const n = await avisosFactory(db).contarDocumentosPorVencer(org, hoyIso, DOCUMENTOS_POR_VENCER_DIAS);
          if (n === null || n <= 0) return;
          const e = await emitirNotificacion(db, { evento: "licitaciones.documentos.por_vencer", organizationId: org, clave: `${org}:${semana}`, parametros: { cantidad: n } });
          if (e.estado === "emitida") documentos += 1;
        })
        .catch(() => undefined);
    }
  }
  return { renovacion, cobranza, documentos };
}

/** Aviso de cambio de bases tras la escritura que creo la version `version` de la convocatoria. Mejor esfuerzo (nunca lanza). */
export async function avisarCambioDeBases(db: TenantDbSession, input: { organizationId: string; tenderId: string; version: number | null | undefined }): Promise<void> {
  if (input.version === null || input.version === undefined) return;
  await emitirNotificacion(db, {
    evento: "licitaciones.convocatoria.bases_modificadas",
    organizationId: input.organizationId,
    clave: `${input.tenderId}:v${input.version}`,
    entidadTipo: "convocatoria",
    entidadId: input.tenderId,
  });
}

export interface RetamizadoResumen {
  readonly disponible: boolean;
  readonly organizaciones: number;
  readonly fichasEvaluadas: number;
  readonly alertasEmitidas: number;
}

/** El aviso de un empeoramiento no pudo emitirse: la corrida entera se revierte para que la siguiente reintente (el dedupe evita duplicados). */
export class AvisoKycNoEmitidoError extends Error {
  constructor(detalle: string) {
    super(`licitaciones.kyc.proveedor_empeoro no se emitio (${detalle}); el re-tamizado se revierte y se reintenta en la siguiente corrida.`);
    this.name = "AvisoKycNoEmitidoError";
  }
}

/**
 * Re-tamiza la cartera KYC y emite la alerta de cada organizacion cuyo proveedor empeoro, TODO en UNA transaccion de
 * sistema: la evaluacion y su aviso se guardan juntos o no se guarda ninguno. Asi un aviso que no pudo emitirse
 * (`error`, `no_disponible`, `invalida`) revierte la evaluacion y la siguiente corrida lo reintenta en vez de perder la
 * alerta para siempre (la evaluacion ya guardada no se volveria a comparar). Repetir con la misma edicion y el mismo
 * SHA no devuelve filas y por tanto no emite nada; el dedupe por organizacion + periodo cubre el reintento.
 */
export async function retamizarCarteraYAvisar(deps: AppDeps): Promise<RetamizadoResumen> {
  const factory = deps.licitacionesAvisosRepo;
  if (!factory) return { disponible: false, organizaciones: 0, fichasEvaluadas: 0, alertasEmitidas: 0 };
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const resultado = await factory(db).retamizarCarteraKyc();
    if (!resultado.disponible) return { disponible: false, organizaciones: 0, fichasEvaluadas: 0, alertasEmitidas: 0 };
    let alertasEmitidas = 0;
    for (const o of resultado.organizaciones) {
      if (o.proveedoresEmpeorados <= 0) continue;
      const e = await emitirNotificacion(db, {
        evento: "licitaciones.kyc.proveedor_empeoro",
        organizationId: o.organizationId,
        clave: `${o.organizationId}:${o.periodo}`,
        parametros: { cantidad: o.proveedoresEmpeorados },
      });
      if (e.estado === "emitida") alertasEmitidas += 1;
      else if (e.estado !== "sin_nuevas") throw new AvisoKycNoEmitidoError(e.estado);
    }
    return {
      disponible: true,
      organizaciones: resultado.organizaciones.length,
      fichasEvaluadas: resultado.organizaciones.reduce((a, o) => a + o.evaluadas, 0),
      alertasEmitidas,
    };
  });
}
