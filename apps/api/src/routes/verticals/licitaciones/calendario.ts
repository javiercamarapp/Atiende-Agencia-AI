// L-22 -- punto UNICO por donde las rutas de licitaciones obtienen el calendario efectivo de dias
// inhabiles para calcular un plazo (pago art. 73, inconformidad art. 95, sala de guerra, junta).
// Sin repositorio inyectado (o base sin migrar) devuelve los dias oficiales de plataforma: el
// calculo NUNCA se queda sin calendario ni falla por falta de la migracion 032.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { officialOnlyCalendar } from "@atiende/domain-licitaciones";
import type { CalendarioPlazos } from "@atiende/domain-licitaciones";
import type { AppDeps } from "../../../deps.ts";

export async function resolveCalendarioFor(deps: AppDeps, c: Context<CoreAuthHonoEnv>, tenderId: string | null): Promise<CalendarioPlazos> {
  const factory = deps.licitacionesDiasInhabilesRepo;
  if (!factory) return officialOnlyCalendar();
  return factory(c.get("db")).resolveCalendario(c.get("organizationId"), { tenderId });
}
