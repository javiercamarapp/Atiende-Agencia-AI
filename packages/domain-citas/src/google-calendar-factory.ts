// Fábrica de producción de GoogleCalendarPort — port de
// citas-reservaciones/supabase/functions/_shared/google-calendar-factory.ts:
// resuelve, por proveedor, un RealGoogleCalendarPort ya autenticado, o `null`
// cuando ese proveedor todavía no puede sincronizar (sin GOOGLE_CLIENT_ID/SECRET de
// plataforma configurados, sin cuenta conectada, o cuenta marcada en error — ver
// diseño Fase 3 §4/§8).
//
// `createPort` es inyectable (por defecto construye un `RealGoogleCalendarPort`
// real) para que las pruebas de integración de apps/api puedan sustituirlo por un
// `FakeGoogleCalendarPort` compartido SIN reescribir la lógica real de
// resolución/rotación de token — mismo patrón de inyección que `hotelesPaymentsPort`
// en apps/api/src/deps.ts.
import { RealGoogleCalendarPort } from "./google-calendar-port.ts";
import type { GoogleCalendarPort, RealGoogleCalendarPortConfig } from "./google-calendar-port.ts";
import type { ResolveCalendarPort } from "./calendar-sync.ts";
import type { CitasRepository } from "./repository.ts";

export interface GoogleOAuthPlatformConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * `config: null` es el estado real de este monorepo hoy (ver diseño §4/§9: ningún
 * GOOGLE_CLIENT_ID/SECRET de plataforma configurado todavía) — el resolver
 * resultante siempre devuelve `null`, exactamente igual que "sin proveedor
 * conectado", nunca lanza. Actívalo pasando `loadApiEnv().googleOAuth` cuando la
 * plataforma tenga credenciales OAuth reales.
 */
export function createGoogleCalendarPortResolver(
  repo: CitasRepository,
  config: GoogleOAuthPlatformConfig | null,
  createPort: (cfg: RealGoogleCalendarPortConfig) => GoogleCalendarPort = (cfg) => new RealGoogleCalendarPort(cfg),
): ResolveCalendarPort {
  return async (providerId: string): Promise<GoogleCalendarPort | null> => {
    if (!config) return null; // credenciales de plataforma pendientes (ver diseño §4/§9)

    const account = await repo.findProviderCalendarAccount(providerId);
    if (!account || account.syncStatus !== "connected") return null; // sin conectar, o desconectada por invalid_grant (ver diseño §8)

    const refreshToken = await repo.resolveProviderCalendarRefreshToken(providerId);
    if (!refreshToken) return null;

    return createPort({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
      onRefreshTokenRotated: async (nextRefreshToken: string) => {
        // Google puede rotar el refresh_token; si no persistimos el nuevo, la
        // siguiente corrida vuelve a fallar con el token viejo revocado (ver
        // diseño §4 paso 5).
        try {
          await repo.rotateProviderCalendarRefreshToken(providerId, nextRefreshToken);
        } catch (err) {
          console.error("createGoogleCalendarPortResolver: no se pudo persistir el refresh_token rotado:", err);
        }
      },
    });
  };
}
