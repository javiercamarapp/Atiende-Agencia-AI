// Fábrica de producción del resolver GENÉRICO multi-proveedor
// (`ResolveCalendarSyncPort`, ver calendar-sync.ts) — análoga a
// `createGoogleCalendarPortResolver` (google-calendar-factory.ts, Fase 3, sin
// tocar) pero cubre las tres plataformas: para UN proveedor concreto, prueba
// Google primero (mismo orden de prioridad que tenía el sistema antes de esta
// fase — un proveedor que ya conectó Google sigue sincronizando por Google
// exactamente igual, sin ambigüedad nueva), luego Cal.com, luego CalDAV, y
// devuelve `null` si ninguna está conectada (o las que hay están en error/sin
// credenciales de plataforma) — el motor genérico (calendar-sync.ts) lo trata
// igual que "sin calendario conectado": skip, nunca un error a reintentar.
//
// Un proveedor normalmente conecta UNA sola plataforma (la UI de "Calendarios
// conectados" no impide técnicamente conectar más de una a la vez, pero no hay
// caso de negocio real para eso) — el orden de prioridad de abajo solo importa en
// el caso de borde de una cuenta vieja de Google que sigue conectada mientras el
// proveedor también conecta Cal.com/CalDAV sin desconectar la primera.
import { RealGoogleCalendarPort } from "./google-calendar-port.ts";
import type { GoogleCalendarPort, RealGoogleCalendarPortConfig } from "./google-calendar-port.ts";
import { createGoogleCalendarPortResolver } from "./google-calendar-factory.ts";
import type { GoogleOAuthPlatformConfig } from "./google-calendar-factory.ts";
import { GoogleCalendarSyncAdapter } from "./calendar-sync-port.ts";
import type { CalendarSyncPort } from "./calendar-sync-port.ts";
import type { ResolvedCalendarSync, ResolveCalendarSyncPort } from "./calendar-sync.ts";
import { RealCalComPort } from "./calcom-port.ts";
import type { CalComPortConfig } from "./calcom-port.ts";
import { RealCalDavPort } from "./caldav-port.ts";
import type { CalDavPortConfig } from "./caldav-port.ts";
import type { CitasRepository } from "./repository.ts";

export interface CalendarSyncPortResolverFactories {
  readonly createGooglePort?: (cfg: RealGoogleCalendarPortConfig) => GoogleCalendarPort;
  readonly createCalComPort?: (cfg: CalComPortConfig) => CalendarSyncPort;
  readonly createCalDavPort?: (cfg: CalDavPortConfig) => CalendarSyncPort;
}

/**
 * Construye el `ResolveCalendarSyncPort` real que producción usa (ver
 * apps/api/src/production/deps.ts) — pruebas inyectan `createGooglePort`/
 * `createCalComPort`/`createCalDavPort` para sustituir el puerto real por un
 * `FakeGoogleCalendarPort`/`FakeCalendarSyncPort` (o los simuladores HTTP reales,
 * tests/calcom-sim.ts/tests/caldav-sim.ts), mismo patrón de inyección que
 * `createGoogleCalendarPortResolver`.
 */
export function createCalendarSyncPortResolver(repo: CitasRepository, googleConfig: GoogleOAuthPlatformConfig | null, factories: CalendarSyncPortResolverFactories = {}): ResolveCalendarSyncPort {
  const resolveGooglePort = createGoogleCalendarPortResolver(repo, googleConfig, factories.createGooglePort ?? ((cfg) => new RealGoogleCalendarPort(cfg)));
  const createCalComPort = factories.createCalComPort ?? ((cfg: CalComPortConfig) => new RealCalComPort(cfg));
  const createCalDavPort = factories.createCalDavPort ?? ((cfg: CalDavPortConfig) => new RealCalDavPort(cfg));

  return async (providerId: string): Promise<ResolvedCalendarSync | null> => {
    // 1. Google (Fase 3) — `createGoogleCalendarPortResolver` ya hace su propia
    // compuerta de cuenta/credenciales de plataforma internamente.
    const googleAccount = await repo.findProviderCalendarAccount(providerId);
    if (googleAccount && googleAccount.syncStatus === "connected") {
      const googlePort = await resolveGooglePort(providerId);
      if (googlePort) return { port: new GoogleCalendarSyncAdapter(googlePort), externalCalendarRef: googleAccount.googleCalendarId };
    }

    // 2. Cal.com.
    const calcomAccount = await repo.findProviderCalComAccount(providerId);
    if (calcomAccount && calcomAccount.syncStatus === "connected") {
      const apiKey = await repo.resolveProviderCalComApiKey(providerId);
      if (apiKey) {
        const port = createCalComPort({ apiKey, ...(calcomAccount.baseUrl ? { baseUrl: calcomAccount.baseUrl } : {}) });
        return { port, externalCalendarRef: calcomAccount.calcomEventTypeId };
      }
    }

    // 3. CalDAV.
    const caldavAccount = await repo.findProviderCalDavAccount(providerId);
    if (caldavAccount && caldavAccount.syncStatus === "connected") {
      const password = await repo.resolveProviderCalDavPassword(providerId);
      if (password) {
        const port = createCalDavPort({ calendarCollectionUrl: caldavAccount.calendarCollectionUrl, username: caldavAccount.username, password });
        return { port, externalCalendarRef: caldavAccount.calendarCollectionUrl };
      }
    }

    return null;
  };
}
