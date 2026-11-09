// Hitos de onboarding que no dejan fila en ninguna tabla de negocio (migracion 0073, core.onboarding_evento): p. ej. «la prueba del agente
// llego a un pedido simulado». Lo derivable NUNCA se guarda aqui (el checklist sigue calculandose de los datos reales).
//
// Compatibilidad con la base sin migrar: ambas funciones corren dentro de runWithSavepointFallback. Sin la 0073 (42P01/42883/42703)
// `registrarOnboardingEvento` devuelve "no_migrado" y `hayOnboardingEvento` devuelve null ("no se puede medir"); la sesion compartida del
// request sigue utilizable. Cualquier otro error (p. ej. 42501 de un caller sin permiso) tampoco rompe al llamador: es best-effort.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

/** `metodos_pago_confirmados` requiere la 0078 (sin ella `registrar` devuelve "error" por el CHECK/lista cerrada y la ruta lo dice). */
export type TipoOnboardingEvento = "prueba_agente_whatsapp" | "prueba_voz" | "celebracion_listo_vista" | "celebracion_primer_valor" | "metodos_pago_confirmados";

export interface OnboardingEventoInput {
  readonly organizationId: string;
  readonly vertical: string;
  readonly tipo: TipoOnboardingEvento;
  readonly propertyId?: string | null;
  /** Solo conteos/ids, nunca datos personales. */
  readonly detalle?: Readonly<Record<string, string | number | boolean | null>>;
}

export type ResultadoRegistroEvento = "registrado" | "ya_existia" | "no_migrado" | "error";

export async function registrarOnboardingEvento(db: TenantDbSession, input: OnboardingEventoInput): Promise<ResultadoRegistroEvento> {
  return runWithSavepointFallback<ResultadoRegistroEvento>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ insertado: boolean }>(`select core.registrar_onboarding_evento($1::uuid, $2, $3, $4::uuid, $5::jsonb) as insertado;`, [
        input.organizationId,
        input.vertical,
        input.tipo,
        input.propertyId ?? null,
        JSON.stringify(input.detalle ?? {}),
      ]);
      return rows[0]?.insertado === true ? "registrado" : "ya_existia";
    },
    isRecoverable: () => true,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) return "no_migrado";
      console.error("onboarding-evento: no se pudo registrar el hito:", err instanceof Error ? err.message : String(err));
      return "error";
    },
  });
}

/** ¿La organizacion ya tiene el hito? `null` = no se puede medir (base sin la 0073 o error de lectura). Lee con RLS (owner/admin). */
export async function hayOnboardingEvento(db: TenantDbSession, organizationId: string, vertical: string, tipo: TipoOnboardingEvento, propertyId?: string): Promise<boolean | null> {
  return runWithSavepointFallback<boolean | null>({
    session: db,
    primary: async () => {
      // Con `propertyId`, solo cuenta el hito de ESA sucursal (p. ej. metodos de pago confirmados por sucursal).
      const { rows } = await db.query<{ hay: boolean }>(
        propertyId
          ? `select exists (select 1 from core.onboarding_evento where organization_id = $1::uuid and vertical = $2 and tipo = $3 and property_id = $4::uuid) as hay;`
          : `select exists (select 1 from core.onboarding_evento where organization_id = $1::uuid and vertical = $2 and tipo = $3) as hay;`,
        propertyId ? [organizationId, vertical, tipo, propertyId] : [organizationId, vertical, tipo],
      );
      return rows[0]?.hay === true;
    },
    isRecoverable: () => true,
    fallback: async () => null,
  });
}
