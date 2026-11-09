// Techo duro de gasto por organizacion para el agente de WhatsApp de restaurantes (Ola 4, H1).
//
// Gasto del mes (zona America/Merida) = LLM de los roles del agente (core.llm_usage_daily) + costo de WhatsApp (core.usage_cost_event),
// leido con `core.whatsapp_agente_techo_estado_for_system` (migracion 0102, solo sistema). Politica por organizacion
// (`core.whatsapp_agente_techo`, la fija un superadmin) o, sin fila, la de omision de este archivo:
//   * `avisar_y_cortar` (omision): al 100 % del techo se avisa y el agente sigue; desde `cortePct` (120 %) el agente deja de llamar al
//     modelo, contesta TEXTO_TECHO_CORTE y escala a una persona (abre la toma de handoff).
//   * `avisar`: solo avisa, nunca corta.
// Los valores de omision (100 USD, avisar_y_cortar, 120 %) son una propuesta: la decision final es de Javier (docs/COSTOS-AGENTE-WHATSAPP.md).
//
// Nunca deja a un cliente sin respuesta por un fallo del medidor: base sin la 0102 o error al leer -> se atiende igual (`sin_medir`).
// La vista previa del panel (`modo: "preview"`) no se corta ni avisa: no es trafico de clientes.
import { emitirNotificacion, isMigrationPendingError } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";

export const TECHO_WHATSAPP_POR_OMISION_USD = 100;
export const ACCION_TECHO_POR_OMISION = "avisar_y_cortar" as const;
export const CORTE_PCT_POR_OMISION = 120;
export const MOTIVO_TECHO_CORTE = "techo_gasto_whatsapp";
export const TEXTO_TECHO_CORTE = "En este momento no puedo seguir atendiéndole por aquí. Ya avisé al equipo y una persona le responde en breve.";

export type AccionTecho = "avisar" | "avisar_y_cortar";

export interface PoliticaTecho {
  readonly techoMicroUsd: number;
  readonly accion: AccionTecho;
  readonly cortePct: number;
}

export type EstadoTecho =
  | ({ readonly estado: "medido"; readonly gastoMicroUsd: number; readonly periodo: string } & PoliticaTecho)
  | { readonly estado: "sin_medir"; readonly motivo: "funcion_no_migrada" | "error" };

export type NivelTecho = "ok" | "aviso" | "corte";

/** Pura: en que nivel esta el gasto respecto al techo. `pct` es el porcentaje entero (piso). */
export function evaluarTechoGasto(gastoMicroUsd: number, politica: PoliticaTecho): { readonly nivel: NivelTecho; readonly pct: number } {
  const pct = politica.techoMicroUsd > 0 ? Math.floor((gastoMicroUsd * 100) / politica.techoMicroUsd) : 0;
  if (gastoMicroUsd < politica.techoMicroUsd) return { nivel: "ok", pct };
  if (politica.accion === "avisar_y_cortar" && gastoMicroUsd * 100 >= politica.techoMicroUsd * politica.cortePct) return { nivel: "corte", pct };
  return { nivel: "aviso", pct };
}

export interface AvisoTecho {
  readonly nivel: "aviso" | "corte";
  readonly organizationId: string;
  readonly periodo: string;
  readonly pct: number;
  readonly techoUsd: number;
}

export interface OpcionesTecho {
  readonly leer: (organizationId: string) => Promise<EstadoTecho>;
  /** Aviso in-app (dedupe por organizacion, nivel y mes). Un fallo aqui nunca tumba el turno. */
  readonly avisar: (aviso: AvisoTecho) => Promise<void>;
}

/** Envuelve el turn handler del agente de WhatsApp con el techo de gasto. */
export function conTechoDeGastoWhatsApp<H extends WhatsAppTurnHandler>(handler: H, opciones: OpcionesTecho): H {
  return {
    ...handler,
    handleInboundMessage: async (args: Parameters<H["handleInboundMessage"]>[0]) => {
      if (args.modo === "preview") return handler.handleInboundMessage(args);
      let estado: EstadoTecho;
      try {
        estado = await opciones.leer(args.organizationId);
      } catch {
        estado = { estado: "sin_medir", motivo: "error" };
      }
      if (estado.estado !== "medido") return handler.handleInboundMessage(args);
      const { nivel, pct } = evaluarTechoGasto(estado.gastoMicroUsd, estado);
      if (nivel !== "ok") {
        await opciones
          .avisar({ nivel, organizationId: args.organizationId, periodo: estado.periodo, pct, techoUsd: Math.round(estado.techoMicroUsd / 1_000_000) })
          .catch(() => undefined);
      }
      if (nivel === "corte") {
        return { reply: TEXTO_TECHO_CORTE, orderId: null, propertyId: args.propertyId ?? null, escalacion: { motivo: MOTIVO_TECHO_CORTE } };
      }
      return handler.handleInboundMessage(args);
    },
  } as H;
}

/** Lector de produccion: `core.whatsapp_agente_techo_estado_for_system` en una sesion de sistema propia (su propia transaccion). */
export function lectorTechoPostgres(engine: TenancyEngine, techoOmisionUsd: number = TECHO_WHATSAPP_POR_OMISION_USD): (organizationId: string) => Promise<EstadoTecho> {
  return async (organizationId) => {
    try {
      const filas = await engine.withAppSession({ userId: null }, async (db) => {
        const r = await db.query<{ gasto_micro_usd: string | number; techo_micro_usd: string | number; accion: string; corte_pct: number; periodo: string }>(
          "select gasto_micro_usd, techo_micro_usd, accion, corte_pct, periodo from core.whatsapp_agente_techo_estado_for_system($1::uuid, $2::bigint);",
          [organizationId, Math.round(techoOmisionUsd * 1_000_000)],
        );
        return r.rows;
      });
      const f = filas[0];
      if (!f) return { estado: "sin_medir", motivo: "error" };
      return {
        estado: "medido",
        gastoMicroUsd: Number(f.gasto_micro_usd),
        techoMicroUsd: Number(f.techo_micro_usd),
        accion: f.accion === "avisar" ? "avisar" : "avisar_y_cortar",
        cortePct: Number(f.corte_pct),
        periodo: f.periodo,
      };
    } catch (err) {
      if (isMigrationPendingError(err, "core.whatsapp_agente_techo_estado_for_system")) return { estado: "sin_medir", motivo: "funcion_no_migrada" };
      return { estado: "sin_medir", motivo: "error" };
    }
  };
}

/** Avisos de produccion: notificacion in-app (catalogo `restaurantes.whatsapp.techo_gasto_*`) en una sesion de sistema propia. */
export function avisosTechoPostgres(engine: TenancyEngine): (aviso: AvisoTecho) => Promise<void> {
  return async (aviso) => {
    await engine.withAppSession({ userId: null }, async (db) => {
      await emitirNotificacion(db, {
        evento: aviso.nivel === "corte" ? "restaurantes.whatsapp.techo_gasto_corte" : "restaurantes.whatsapp.techo_gasto_alcanzado",
        organizationId: aviso.organizationId,
        clave: `${aviso.organizationId}:${aviso.periodo}`,
        parametros: { porcentaje: aviso.pct, techo: aviso.techoUsd },
        entidadTipo: "techo_gasto_whatsapp",
      });
    });
  };
}
