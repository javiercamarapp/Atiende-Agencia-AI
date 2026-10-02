// Lado SUPERADMIN de la lista de supresion de plataforma (SA-L-46): conteos agregados (sin valores ni hashes)
// y "no contactar" manual. Las funciones SQL exigen auth.uid() = p_caller_id y delegan en
// core.platform_superadmin (migracion 0043). Base sin migrar (42P01/42883/42703): `no_migrada`, nunca un 500.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { avisarSupresionNoMigrada, esSupresionNoMigrada } from "./acceso.ts";
import { hashearContacto } from "./normalizar.ts";
import type { TipoContacto } from "./normalizar.ts";

export interface GrupoSupresion {
  readonly tipo: TipoContacto;
  readonly motivo: string;
  readonly origen: string;
  readonly total: number;
  readonly ultimoEnMs: number | null;
}

export type ListaSupresion = { readonly disponible: true; readonly grupos: readonly GrupoSupresion[] } | { readonly disponible: false };

export async function listarSupresiones(db: TenantDbSession, callerId: string): Promise<ListaSupresion> {
  return runWithSavepointFallback<ListaSupresion>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ tipo: TipoContacto; motivo: string; origen: string; total: string | number; ultimo_en: Date | string | null }>(
        "select tipo, motivo, origen, total, ultimo_en from core.list_supresiones_for_superadmin($1);",
        [callerId],
      );
      return {
        disponible: true as const,
        grupos: rows.map((r) => ({ tipo: r.tipo, motivo: r.motivo, origen: r.origen, total: Number(r.total), ultimoEnMs: r.ultimo_en === null ? null : new Date(r.ultimo_en).getTime() })),
      };
    },
    isRecoverable: esSupresionNoMigrada,
    fallback: async () => {
      avisarSupresionNoMigrada("list_supresiones_for_superadmin");
      return { disponible: false as const };
    },
  });
}

export type ResultadoNoContactar = "registrada" | "ya_existia" | "no_migrada" | "valor_invalido";

export async function agregarNoContactar(db: TenantDbSession, callerId: string, tipo: TipoContacto, valor: string): Promise<ResultadoNoContactar> {
  const hash = hashearContacto(tipo, valor);
  if (hash === null) return "valor_invalido";
  return runWithSavepointFallback<ResultadoNoContactar>({
    session: db,
    primary: async () => {
      const { rows } = await db.query<{ nueva: boolean }>("select core.agregar_no_contactar_for_superadmin($1, $2, $3) as nueva;", [callerId, tipo, hash]);
      return rows[0]?.nueva === true ? "registrada" : "ya_existia";
    },
    isRecoverable: esSupresionNoMigrada,
    fallback: async () => {
      avisarSupresionNoMigrada("agregar_no_contactar_for_superadmin");
      return "no_migrada";
    },
  });
}

/** Agrega los grupos por motivo y por origen (solo conteos). */
export function agregarConteos(grupos: readonly GrupoSupresion[]): { total: number; porMotivo: Array<{ clave: string; total: number }>; porOrigen: Array<{ clave: string; total: number }> } {
  const suma = (clave: (g: GrupoSupresion) => string) => {
    const m = new Map<string, number>();
    for (const g of grupos) m.set(clave(g), (m.get(clave(g)) ?? 0) + g.total);
    return [...m.entries()].map(([k, total]) => ({ clave: k, total })).sort((a, b) => b.total - a.total || a.clave.localeCompare(b.clave));
  };
  return { total: grupos.reduce((s, g) => s + g.total, 0), porMotivo: suma((g) => g.motivo), porOrigen: suma((g) => g.origen) };
}
