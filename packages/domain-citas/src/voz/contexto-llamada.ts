// Contexto de UNA llamada que el worker de voz pide al servidor al contestar (`GET /v1/citas/:orgSlug/voz/contexto`): el prompt del agente ya armado
// con la personalidad de C-15, el rubro y "hoy" calculado en el servidor, los pregrabados con el nombre del negocio y si el rubro exige la guardia de
// crisis. Todo es lectura; cada lectura corre en su SAVEPOINT y, contra la base sin migrar, cae a lo de siempre (nunca un 500).
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { CatalogoMensajes } from "@atiende/voice-core";
import { zonedDateStr } from "../availability.ts";
import type { CitasRepository } from "../repository.ts";
import { crisisGuardActivaPara } from "../vertical-config.ts";
import { instruccionVozCita, mensajesPregrabadosCita } from "./perfil-voz.ts";

export interface ContextoLlamadaVoz {
  readonly negocio: string;
  readonly timezone: string;
  /** AAAA-MM-DD en la zona del negocio. */
  readonly hoy: string;
  /** "HH:MM" en la zona del negocio. */
  readonly horaLocal: string;
  readonly rubro: string | null;
  /** El rubro exige la guardia de crisis (misma regla que WhatsApp): el worker debe armar `crearGuardiaCrisisVoz`. */
  readonly guardiaCrisis: boolean;
  readonly instruccion: string;
  readonly pregrabados: CatalogoMensajes;
}

function horaLocalDe(ahora: Date, timezone: string): string {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ahora);
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "00";
  return `${g("hour")}:${g("minute")}`;
}

export async function obtenerContextoLlamadaVoz(repo: CitasRepository, org: { readonly id: string; readonly name: string }, ahora: Date = new Date()): Promise<ContextoLlamadaVoz> {
  const tenant = await repo.runWithRowSavepoint(() => repo.findTenantConfig(org.id)).catch(() => null);
  const agente = await repo.runWithRowSavepoint(() => repo.getWhatsappAgentConfigForTurn(org.id)).catch(() => null);
  const timezone = resolverZonaHorariaNegocio(tenant?.defaultTimezone);
  const horaLocal = horaLocalDe(ahora, timezone);
  const rubro = tenant?.rubro ?? null;
  return {
    negocio: org.name,
    timezone,
    hoy: zonedDateStr(ahora, timezone),
    horaLocal,
    rubro,
    guardiaCrisis: crisisGuardActivaPara(rubro),
    instruccion: instruccionVozCita({ businessName: org.name, agente, rubro, ahora, timezone, horaLocal }),
    pregrabados: mensajesPregrabadosCita(org.name),
  };
}
