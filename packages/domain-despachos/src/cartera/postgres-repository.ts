// D-21 -- adaptador Postgres de la cartera (migración 018). Cada operación corre bajo `runWithSavepointFallback`
// porque la sesión es UNA transacción compartida por request: contra la base SIN migrar el 42883/42P01/42703
// degrada a "no disponible" (lectura) o a `CarteraNoDisponibleError` (escritura) sin dejar la transacción
// abortada (25P02). Los SQLSTATE de las funciones definer se traducen a errores de dominio tipados.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { FichaClienteNormalizada, PeriodicidadPagos } from "./ficha.ts";
import type { TipoPersona } from "./rfc.ts";
import { CarteraDatosInvalidosError, CarteraNoDisponibleError, CarteraSinPermisoError, CarteraTopeExcedidoError, ClienteRfcDuplicadoError } from "./types.ts";
import type { CarteraRepository, CarteraResultado, ClienteCarteraRow, ClienteFichaRecord } from "./types.ts";

const CARTERA_FN_PREFIX = "despachos.cliente_";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migración 018 -> error de dominio (sin filtrar más detalle de Postgres del necesario). */
function traducirError(err: unknown): unknown {
  switch (pgCode(err)) {
    case "42501":
      return new CarteraSinPermisoError();
    case "22023":
    case "23514":
      return new CarteraDatosInvalidosError(err instanceof Error ? err.message.replace(/^cliente_[a-z_]+:\s*/, "") : "Datos inválidos.");
    case "23505":
      return new ClienteRfcDuplicadoError();
    case "54000":
      return new CarteraTopeExcedidoError();
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

interface FichaRaw {
  property_id: string;
  organization_id: string;
  rfc: string;
  tipo_persona: TipoPersona;
  razon_social: string;
  regimenes_fiscales: string[];
  cp_fiscal: string;
  periodicidad: PeriodicidadPagos;
  responsable_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const FICHA_COLUMNAS = "property_id, organization_id, rfc, tipo_persona, razon_social, regimenes_fiscales, cp_fiscal, periodicidad, responsable_id, created_at, updated_at";

function mapFicha(r: FichaRaw): ClienteFichaRecord {
  return {
    propertyId: r.property_id,
    organizationId: r.organization_id,
    rfc: r.rfc,
    tipoPersona: r.tipo_persona,
    razonSocial: r.razon_social,
    regimenesFiscales: r.regimenes_fiscales,
    cpFiscal: r.cp_fiscal,
    periodicidad: r.periodicidad,
    responsableId: r.responsable_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export class PostgresCarteraRepository implements CarteraRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listar(organizationId: string): Promise<CarteraResultado> {
    return runWithSavepointFallback<CarteraResultado>({
      session: this.db,
      savepointName: "sp_cartera_listar",
      primary: async () => {
        const { rows } = await this.db.query<FichaRaw & { prop_id: string; prop_name: string; tiene_ficha: boolean }>(
          `select p.id as prop_id, p.name as prop_name, (f.property_id is not null) as tiene_ficha,
                  f.property_id, f.organization_id, f.rfc, f.tipo_persona, f.razon_social, f.regimenes_fiscales, f.cp_fiscal,
                  f.periodicidad, f.responsable_id, f.created_at, f.updated_at
           from core.property p
           left join despachos.cliente_ficha f on f.property_id = p.id
           where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active'
           order by p.name, p.id limit 1000;`,
          [organizationId],
        );
        const clientes: ClienteCarteraRow[] = rows.map((r) => ({ propertyId: r.prop_id, nombre: r.prop_name, ficha: r.tiene_ficha ? mapFicha(r) : null }));
        return { estado: "disponible", clientes };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        const { rows } = await this.db.query<{ id: string; name: string }>(
          `select id, name from core.property where organization_id = $1 and vertical = 'despachos' and status = 'active' order by name, id limit 1000;`,
          [organizationId],
        );
        return { estado: "no_disponible", clientes: rows.map((r) => ({ propertyId: r.id, nombre: r.name, ficha: null })) };
      },
    });
  }

  async obtenerFicha(propertyId: string): Promise<ClienteFichaRecord | null> {
    return runWithSavepointFallback<ClienteFichaRecord | null>({
      session: this.db,
      savepointName: "sp_cartera_ficha",
      primary: async () => {
        const { rows } = await this.db.query<FichaRaw>(`select ${FICHA_COLUMNAS} from despachos.cliente_ficha where property_id = $1;`, [propertyId]);
        return rows[0] ? mapFicha(rows[0]) : null;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  async alta(organizationId: string, nombre: string, f: FichaClienteNormalizada): Promise<{ readonly propertyId: string }> {
    try {
      return await runWithSavepointFallback<{ readonly propertyId: string }>({
        session: this.db,
        savepointName: "sp_cartera_alta",
        primary: async () => {
          const { rows } = await this.db.query<{ out_property_id: string }>(
            "select out_property_id from despachos.cliente_alta($1, $2, $3, $4, $5::text[], $6, $7, $8);",
            [organizationId, nombre, f.rfc, f.razonSocial, [...f.regimenesFiscales], f.cpFiscal, f.periodicidad, f.responsableId],
          );
          return { propertyId: rows[0]!.out_property_id };
        },
        isRecoverable: (err) => isMigrationPendingError(err, CARTERA_FN_PREFIX),
        fallback: async () => {
          throw new CarteraNoDisponibleError();
        },
      });
    } catch (err) {
      throw traducirError(err);
    }
  }

  async guardarFicha(propertyId: string, f: FichaClienteNormalizada): Promise<void> {
    try {
      await runWithSavepointFallback<void>({
        session: this.db,
        savepointName: "sp_cartera_guardar",
        primary: async () => {
          await this.db.query("select despachos.cliente_ficha_guardar($1, $2, $3, $4::text[], $5, $6, $7);", [
            propertyId,
            f.rfc,
            f.razonSocial,
            [...f.regimenesFiscales],
            f.cpFiscal,
            f.periodicidad,
            f.responsableId,
          ]);
        },
        isRecoverable: (err) => isMigrationPendingError(err, CARTERA_FN_PREFIX),
        fallback: async () => {
          throw new CarteraNoDisponibleError();
        },
      });
    } catch (err) {
      throw traducirError(err);
    }
  }
}
