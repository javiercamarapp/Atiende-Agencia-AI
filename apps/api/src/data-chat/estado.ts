// GET .../chat-datos/estado: que necesita la UI para decidir si ofrece el chat y que decirle al usuario.
//   available   = hay proveedor de IA y lector de la vertical (igual que siempre).
//   permitido   = el usuario puede preguntar AHORA (available y sin tope diario agotado).
//   motivo      = null si permitido; si no, "no_activado" | "tope_diario" (texto fijo, sin PII).
//   usoHoyPct   = 0..100 del uso de hoy frente al tope diario, o null cuando todavia no se puede medir.
// El rol sin acceso sigue siendo 403 (lo decide cada ruta antes de llamar aqui).
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: la medicion del uso corre en SAVEPOINT; si la tabla o funcion no existe
// (42883/42P01/42703) -- o cualquier otro fallo -- el uso es `null` ("sin medir"), nunca un 500 ni una transaccion
// abortada.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import type { AppDeps } from "../deps.ts";

export type DataChatMotivo = "no_activado" | "tope_diario";

export interface DataChatEstado {
  readonly available: boolean;
  readonly permitido: boolean;
  readonly motivo: DataChatMotivo | null;
  readonly usoHoyPct: number | null;
}

export function normalizeUsoPct(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(100, Math.round(v));
}

export async function buildDataChatEstado(deps: AppDeps, db: TenantDbSession, scope: { organizationId: string; userId: string }, available: boolean): Promise<DataChatEstado> {
  const reader = deps.dataChat?.usageTodayPct;
  let usoHoyPct: number | null = null;
  if (available && reader) {
    usoHoyPct = await runWithSavepointFallback<number | null>({
      session: db,
      primary: async () => normalizeUsoPct(await reader(db, scope.organizationId, scope.userId)),
      isRecoverable: () => true,
      fallback: async () => null,
    });
  }
  if (!available) return { available, permitido: false, motivo: "no_activado", usoHoyPct: null };
  if (usoHoyPct !== null && usoHoyPct >= 100) return { available, permitido: false, motivo: "tope_diario", usoHoyPct };
  return { available, permitido: true, motivo: null, usoHoyPct };
}
