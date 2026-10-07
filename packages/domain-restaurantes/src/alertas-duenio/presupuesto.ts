// Aviso al DUEÑO del presupuesto de IA de su organizacion al 80 % y al 100 % del mes (hoy solo existia el aviso de superadmin). El productor corre
// para organizaciones de CUALQUIER vertical (el gateway de LLM es de plataforma), asi que primero pregunta a la base si la organizacion es de
// restaurantes (`restaurantes.es_organizacion_restaurantes`, solo sistema): el enlace del aviso apunta a la consola de restaurantes.
// Sin PII: solo el porcentaje. Dedupe una por umbral y mes (de Merida). Best-effort: nunca lanza ni cambia el resultado de la reserva de IA.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { diaMerida } from "./dia.ts";

export type UmbralPresupuestoIa = 80 | 100;

export type ResultadoAvisoPresupuesto = "emitida" | "sin_nuevas" | "no_aplica" | "no_disponible" | "error";

export async function avisarPresupuestoIaAlDuenio(session: TenantDbSession, input: { readonly organizationId: string; readonly porcentaje: UmbralPresupuestoIa; readonly now: Date }): Promise<ResultadoAvisoPresupuesto> {
  try {
    const esRestaurantes = await runWithSavepointFallback<boolean | null>({
      session,
      savepointName: "sp_presupuesto_ia_vertical",
      primary: async () => {
        const { rows } = await session.query<{ es: boolean }>(`select restaurantes.es_organizacion_restaurantes($1::uuid) as es;`, [input.organizationId]);
        return rows[0]?.es === true;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
    if (esRestaurantes === null) return "no_disponible";
    if (!esRestaurantes) return "no_aplica";
    const mes = diaMerida(input.now).slice(0, 7);
    const r = await emitirNotificacion(session, {
      evento: "restaurantes.ia.presupuesto_umbral",
      organizationId: input.organizationId,
      clave: `${input.porcentaje}:${mes}`,
      parametros: { porcentaje: input.porcentaje },
      ...(input.porcentaje >= 100 ? { severidad: "critica" as const } : {}),
    });
    return r.estado === "emitida" ? "emitida" : r.estado === "sin_nuevas" ? "sin_nuevas" : r.estado === "no_disponible" ? "no_disponible" : "error";
  } catch {
    return "error";
  }
}
