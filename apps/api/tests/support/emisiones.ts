// Doble de prueba para los productores de notificaciones: envuelve `deps.engine` para que cada llamada a
// `core.emit_notification` quede registrada (con sus parametros) en vez de ir a una base. El resto de las
// consultas y los SAVEPOINT siguen al motor original. `alEmitir` permite simular el resultado (numero de
// destinatarios) o un error de Postgres (p. ej. 42883 de la base sin migrar).
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";

export interface EmisionRegistrada {
  readonly evento: string;
  readonly organizationId: string | null;
  readonly propertyId: string | null;
  readonly categoria: string;
  readonly severidad: string;
  readonly titulo: string;
  readonly cuerpo: string | null;
  readonly enlace: string;
  readonly dedupeKey: string;
  readonly roles: readonly string[] | null;
}

export function conEmisiones<D extends { engine: TenancyEngine }>(deps: D, opciones: { alEmitir?: () => number; alRegistrar?: (emision: EmisionRegistrada) => void } = {}): { deps: D; emisiones: EmisionRegistrada[] } {
  const emisiones: EmisionRegistrada[] = [];
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        const n = opciones.alEmitir ? opciones.alEmitir() : 1;
        const registrada: EmisionRegistrada = {
          evento: String(p[2]),
          organizationId: (p[0] as string | null) ?? null,
          propertyId: (p[1] as string | null) ?? null,
          categoria: String(p[3]),
          severidad: String(p[4]),
          titulo: String(p[5]),
          cuerpo: (p[6] as string | null) ?? null,
          enlace: String(p[7]),
          dedupeKey: String(p[10]),
          roles: (p[11] as string[] | null) ?? null,
        };
        emisiones.push(registrada);
        opciones.alRegistrar?.(registrada);
        return { rows: [{ emit_notification: n }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (session) => fn(envolver(session))) };
  return { deps: { ...deps, engine }, emisiones };
}
