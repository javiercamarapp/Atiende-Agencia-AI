// Gasto del agente de WhatsApp de restaurantes por organizacion: avisos por umbral y corte opcional (Ola 4, H1).
//
// Decision de Omar (9-nov-2026): «no hay techo, es lo que necesite PM o el cliente».
//   * Por omision NO se corta nunca: el agente sigue atendiendo.
//   * Se AVISA (notificacion in-app al dueño/admin de la organizacion y al superadmin) al cruzar umbrales INFORMATIVOS del gasto del mes,
//     una vez por organizacion, mes y umbral. Umbrales por omision: UMBRALES_AVISO_POR_OMISION_USD; por organizacion los fija un superadmin.
//   * El CORTE (no llamar al modelo, texto fijo y pasar a una persona) existe solo si un superadmin lo configura explicitamente para esa
//     organizacion (`core.whatsapp_agente_techo.corte_micro_usd`).
//
// Gasto del mes (zona America/Merida) = LLM de los roles del agente (core.llm_usage_daily) + costo de WhatsApp (core.usage_cost_event),
// leido con `core.whatsapp_agente_techo_estado_for_system` (migracion 0102, solo sistema). Base sin la 0102 o error al leer -> se
// atiende igual (`sin_medir`). La vista previa del panel (`modo: "preview"`) no se corta ni avisa: no es trafico de clientes.
import { emitirNotificacion, isMigrationPendingError } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";

/** Umbrales informativos por omision (USD por mes) para una organizacion sin configuracion propia. Solo avisan; nunca cortan. */
export const UMBRALES_AVISO_POR_OMISION_USD: readonly number[] = [50, 100, 250, 500];
export const MOTIVO_CORTE_GASTO = "corte_gasto_whatsapp";
export const TEXTO_CORTE_GASTO = "En este momento no puedo seguir atendiéndole por aquí. Ya avisé al equipo y una persona le responde en breve.";

const USD = 1_000_000;

export type EstadoGasto =
  | {
      readonly estado: "medido";
      readonly gastoMicroUsd: number;
      readonly umbralesMicroUsd: readonly number[];
      /** null = nunca corta (lo normal). */
      readonly corteMicroUsd: number | null;
      readonly periodo: string;
      readonly slug: string | null;
    }
  | { readonly estado: "sin_medir"; readonly motivo: "funcion_no_migrada" | "error" };

/** Pura: el umbral MAS ALTO ya cruzado (o null) y si corresponde cortar (solo con corte configurado). */
export function evaluarGastoWhatsApp(
  gastoMicroUsd: number,
  config: { readonly umbralesMicroUsd: readonly number[]; readonly corteMicroUsd: number | null },
): { readonly umbralMicroUsd: number | null; readonly corta: boolean } {
  const cruzados = config.umbralesMicroUsd.filter((u) => u > 0 && gastoMicroUsd >= u);
  const umbralMicroUsd = cruzados.length > 0 ? Math.max(...cruzados) : null;
  const corta = config.corteMicroUsd !== null && config.corteMicroUsd > 0 && gastoMicroUsd >= config.corteMicroUsd;
  return { umbralMicroUsd, corta };
}

export interface AvisoGasto {
  readonly tipo: "umbral" | "corte";
  readonly organizationId: string;
  readonly slug: string | null;
  readonly periodo: string;
  /** Umbral cruzado o corte configurado, en USD. */
  readonly montoUsd: number;
  readonly gastoUsd: number;
}

export interface OpcionesTecho {
  readonly leer: (organizationId: string) => Promise<EstadoGasto>;
  /** Aviso in-app (dedupe por organizacion, mes y monto). Un fallo aqui nunca tumba el turno. */
  readonly avisar: (aviso: AvisoGasto) => Promise<void>;
}

const aUsd = (microUsd: number): number => Math.round(microUsd / USD);

/** Envuelve el turn handler del agente de WhatsApp: avisa por umbral y solo corta si la organizacion tiene corte configurado. */
export function conTechoDeGastoWhatsApp<H extends WhatsAppTurnHandler>(handler: H, opciones: OpcionesTecho): H {
  return {
    ...handler,
    handleInboundMessage: async (args: Parameters<H["handleInboundMessage"]>[0]) => {
      if (args.modo === "preview") return handler.handleInboundMessage(args);
      let estado: EstadoGasto;
      try {
        estado = await opciones.leer(args.organizationId);
      } catch {
        estado = { estado: "sin_medir", motivo: "error" };
      }
      if (estado.estado !== "medido") return handler.handleInboundMessage(args);
      const { umbralMicroUsd, corta } = evaluarGastoWhatsApp(estado.gastoMicroUsd, estado);
      const base = { organizationId: args.organizationId, slug: estado.slug, periodo: estado.periodo, gastoUsd: aUsd(estado.gastoMicroUsd) };
      if (corta && estado.corteMicroUsd !== null) {
        await opciones.avisar({ ...base, tipo: "corte", montoUsd: aUsd(estado.corteMicroUsd) }).catch(() => undefined);
        return { reply: TEXTO_CORTE_GASTO, orderId: null, propertyId: args.propertyId ?? null, escalacion: { motivo: MOTIVO_CORTE_GASTO } };
      }
      if (umbralMicroUsd !== null) await opciones.avisar({ ...base, tipo: "umbral", montoUsd: aUsd(umbralMicroUsd) }).catch(() => undefined);
      return handler.handleInboundMessage(args);
    },
  } as H;
}

/** Lector de produccion: `core.whatsapp_agente_techo_estado_for_system` en una sesion de sistema propia (su propia transaccion). */
export function lectorTechoPostgres(engine: TenancyEngine, umbralesOmisionUsd: readonly number[] = UMBRALES_AVISO_POR_OMISION_USD): (organizationId: string) => Promise<EstadoGasto> {
  return async (organizationId) => {
    try {
      const filas = await engine.withAppSession({ userId: null }, async (db) => {
        const r = await db.query<{ gasto_micro_usd: string | number; umbrales_aviso_micro_usd: Array<string | number> | null; corte_micro_usd: string | number | null; periodo: string; slug: string | null }>(
          "select gasto_micro_usd, umbrales_aviso_micro_usd, corte_micro_usd, periodo, slug from core.whatsapp_agente_techo_estado_for_system($1::uuid);",
          [organizationId],
        );
        return r.rows;
      });
      const f = filas[0];
      if (!f) return { estado: "sin_medir", motivo: "error" };
      return {
        estado: "medido",
        gastoMicroUsd: Number(f.gasto_micro_usd),
        umbralesMicroUsd: f.umbrales_aviso_micro_usd ? f.umbrales_aviso_micro_usd.map(Number) : umbralesOmisionUsd.map((u) => u * USD),
        corteMicroUsd: f.corte_micro_usd === null ? null : Number(f.corte_micro_usd),
        periodo: f.periodo,
        slug: f.slug ?? null,
      };
    } catch (err) {
      if (isMigrationPendingError(err, "core.whatsapp_agente_techo_estado_for_system")) return { estado: "sin_medir", motivo: "funcion_no_migrada" };
      return { estado: "sin_medir", motivo: "error" };
    }
  };
}

/** Slug como codigo para el aviso al superadmin (sin PII; recortado a lo que admite un parametro). */
function slugCorto(slug: string | null): string {
  const limpio = (slug ?? "organizacion").replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 40);
  return limpio.length > 0 ? limpio : "organizacion";
}

/** Avisos de produccion: al dueño/admin de la organizacion Y al superadmin, en una sesion de sistema propia. */
export function avisosTechoPostgres(engine: TenancyEngine): (aviso: AvisoGasto) => Promise<void> {
  return async (aviso) => {
    const clave = `${aviso.organizationId}:${aviso.periodo}:${aviso.montoUsd}`;
    const parametros = { gasto: aviso.gastoUsd, monto: aviso.montoUsd };
    await engine.withAppSession({ userId: null }, async (db) => {
      await emitirNotificacion(db, {
        evento: aviso.tipo === "corte" ? "restaurantes.whatsapp.gasto_corte" : "restaurantes.whatsapp.gasto_umbral",
        organizationId: aviso.organizationId,
        clave,
        parametros,
        entidadTipo: "gasto_whatsapp",
      });
      await emitirNotificacion(db, {
        evento: aviso.tipo === "corte" ? "superadmin.whatsapp.gasto_corte" : "superadmin.whatsapp.gasto_umbral",
        organizationId: null,
        clave,
        parametros: { ...parametros, organizacion: slugCorto(aviso.slug) },
        entidadTipo: "gasto_whatsapp",
      });
    });
  };
}
