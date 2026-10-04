// Adaptador Postgres de `RepartidorPerfilRepository` (migracion 044). REGLA DURA de compatibilidad con la base SIN migrar: mergear
// despliega el codigo al instante y la 044 no se aplica sola. Toda llamada corre en la transaccion UNICA del request: un error de
// Postgres la deja abortada (25P02), por eso usa `runWithSavepointFallback` y degrada a "no disponible" (42883 funcion, 42P01 tabla,
// 42703 columna). Los rechazos de negocio de la funcion SQL (42501, P0002, 22023) tambien se contienen en el SAVEPOINT y se
// convierten en un resultado explicito; cualquier otro error se repropaga.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { Disponibilidad, GuardarPerfilResultado, LicenciaPorVencer, PerfilLectura, RepartidorPerfil, RepartidorPerfilEntrada, RepartidorPerfilRepository, VehiculoTipo } from "./perfil.ts";

function codigo(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function esBaseSinMigrar(err: unknown): boolean {
  const c = codigo(err);
  return c === "42P01" || c === "42703" || c === "42883";
}
function esRechazoDeNegocio(err: unknown): boolean {
  const c = codigo(err);
  return esBaseSinMigrar(err) || c === "42501" || c === "P0002" || c === "22023";
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresRepartidorPerfilRepository: la tabla/funcion del perfil del repartidor todavia no existe en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/044_repartidor_perfil_operativo.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

interface FilaPerfil {
  user_id: string;
  vehiculo_tipo: VehiculoTipo | null;
  placas: string | null;
  disponibilidad: Disponibilidad;
  turno: string | null;
  updated_at: string | Date;
  licencia_numero: string | null;
  licencia_vigencia: string | null;
  emergencia_nombre: string | null;
  emergencia_telefono: string | null;
}

export class PostgresRepartidorPerfilRepository implements RepartidorPerfilRepository {
  constructor(private readonly db: TenantDbSession) {}

  async obtener(organizationId: string, userId: string): Promise<PerfilLectura> {
    return runWithSavepointFallback<PerfilLectura>({
      session: this.db,
      savepointName: "sp_repartidor_perfil_obtener",
      primary: async () => {
        // LEFT JOIN: la tabla personal puede no ser visible (RLS) o no existir para esa fila; la operativa manda.
        const { rows } = await this.db.query<FilaPerfil>(
          `select p.user_id, p.vehiculo_tipo, p.placas, p.disponibilidad, p.turno, p.updated_at,
                  q.licencia_numero, to_char(q.licencia_vigencia, 'YYYY-MM-DD') as licencia_vigencia, q.emergencia_nombre, q.emergencia_telefono
             from restaurantes.repartidor_perfil p
             left join restaurantes.repartidor_perfil_privado q on q.organization_id = p.organization_id and q.user_id = p.user_id
            where p.organization_id = $1 and p.user_id = $2;`,
          [organizationId, userId],
        );
        const r = rows[0];
        if (!r) return { disponible: true, perfil: null };
        const perfil: RepartidorPerfil = {
          userId: r.user_id,
          vehiculoTipo: r.vehiculo_tipo,
          placas: r.placas,
          disponibilidad: r.disponibilidad,
          turno: r.turno,
          licenciaNumero: r.licencia_numero,
          licenciaVigencia: r.licencia_vigencia,
          emergenciaNombre: r.emergencia_nombre,
          emergenciaTelefono: r.emergencia_telefono,
          updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        };
        return { disponible: true, perfil };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, perfil: null };
      },
    });
  }

  async guardar(organizationId: string, userId: string, e: RepartidorPerfilEntrada): Promise<GuardarPerfilResultado> {
    return runWithSavepointFallback<GuardarPerfilResultado>({
      session: this.db,
      savepointName: "sp_repartidor_perfil_guardar",
      primary: async () => {
        await this.db.query(
          `select restaurantes.guardar_perfil_repartidor($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10);`,
          [organizationId, userId, e.vehiculoTipo, e.placas, e.disponibilidad, e.turno, e.licenciaNumero, e.licenciaVigencia, e.emergenciaNombre, e.emergenciaTelefono],
        );
        return { estado: "ok" };
      },
      isRecoverable: esRechazoDeNegocio,
      fallback: async (err) => {
        const c = codigo(err);
        if (c === "42501") return { estado: "prohibido" };
        if (c === "P0002") return { estado: "no_es_repartidor" };
        if (c === "22023") return { estado: "invalido", detalle: err instanceof Error ? err.message.replace(/^guardar_perfil_repartidor:\s*/, "") : "Datos inválidos." };
        advertirNoDisponible(err);
        return { estado: "no_disponible" };
      },
    });
  }

  async suprimir(organizationId: string, userId: string): Promise<{ readonly disponible: boolean; readonly borrado: boolean; readonly prohibido: boolean }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly borrado: boolean; readonly prohibido: boolean }>({
      session: this.db,
      savepointName: "sp_repartidor_perfil_suprimir",
      primary: async () => {
        const { rows } = await this.db.query<{ suprimido: boolean }>(`select restaurantes.suprimir_perfil_repartidor($1, $2) as suprimido;`, [organizationId, userId]);
        return { disponible: true, borrado: rows[0]?.suprimido === true, prohibido: false };
      },
      isRecoverable: (err) => esBaseSinMigrar(err) || codigo(err) === "42501",
      fallback: async (err) => {
        if (codigo(err) === "42501") return { disponible: true, borrado: false, prohibido: true };
        advertirNoDisponible(err);
        return { disponible: false, borrado: false, prohibido: false };
      },
    });
  }

  async licenciasPorVencer(dias: number): Promise<{ readonly disponible: boolean; readonly valor: readonly LicenciaPorVencer[] }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly valor: readonly LicenciaPorVencer[] }>({
      session: this.db,
      savepointName: "sp_repartidor_licencias_vencer",
      primary: async () => {
        const { rows } = await this.db.query<{ organization_id: string; user_id: string; dias_restantes: number }>(
          `select organization_id, user_id, dias_restantes from restaurantes.licencias_por_vencer_sistema($1::int);`,
          [dias],
        );
        return { disponible: true, valor: rows.map((r) => ({ organizationId: r.organization_id, userId: r.user_id, diasRestantes: Number(r.dias_restantes) })) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }
}
