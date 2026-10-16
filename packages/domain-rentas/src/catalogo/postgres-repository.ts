// Rn-18 / Rn-19 -- adaptador Postgres del catalogo, sobre el TenantDbSession del request (staff, RLS real).
//
// Base sin migrar (migracion 027 pendiente: SQLSTATE 42883/42P01/42703): las ESCRITURAS devuelven
// `no_disponible` (la ruta responde 503 honesto, nunca un 500). La sesion es UNA transaccion por request y
// Postgres la deja ABORTADA tras cualquier error (25P02, y el COMMIT final devolveria ROLLBACK): por eso cada
// escritura corre bajo SAVEPOINT (runWithSavepointFallback) y las reglas de negocio de la funcion SQL (rol,
// duplicado, validacion) tambien se recuperan ahi y se traducen a `rechazado`. Las LECTURAS solo tocan tablas
// que existen desde las migraciones 001/003: no necesitan fallback.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { RentasCatalogoRepository } from "./repository.ts";
import type {
  CanalRecordCatalogo,
  EntradaActualizarPropiedad,
  EntradaActualizarPropietario,
  EntradaActualizarReglaComision,
  EntradaActualizarUnidad,
  EntradaCrearPropiedad,
  EntradaCrearPropietario,
  EntradaCrearUnidad,
  EntradaReglaComision,
  MotivoRechazoCatalogo,
  PropiedadCatalogoRecord,
  PropietarioRecord,
  ReglaComisionRecord,
  ResultadoCatalogo,
  UnidadCatalogoRecord,
} from "./tipos.ts";

/** SQLSTATE con los que las funciones de la migracion 027 comunican una regla de negocio. */
const MOTIVO_POR_SQLSTATE: Readonly<Record<string, MotivoRechazoCatalogo>> = {
  "42501": "sin_permiso",
  "22023": "invalido",
  "23505": "duplicado",
  "55000": "regla_integridad",
  P0002: "no_encontrado",
};

const MENSAJE_GENERICO: Readonly<Record<MotivoRechazoCatalogo, string>> = {
  sin_permiso: "No tienes permiso para esta acción.",
  invalido: "Los datos no son válidos.",
  duplicado: "Ya existe un registro con esos datos.",
  regla_integridad: "La operación no está permitida por una regla de integridad.",
  no_encontrado: "No se encontró el registro.",
};

function sqlstate(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

function motivoDe(err: unknown): MotivoRechazoCatalogo | null {
  const code = sqlstate(err);
  return code !== undefined && code in MOTIVO_POR_SQLSTATE ? MOTIVO_POR_SQLSTATE[code]! : null;
}

/** El mensaje de las funciones SQL ya viene en espanol ("rentas.crear_unidad: ya existe ..."); cualquier otro
 *  texto (por ejemplo un "permission denied for table ..." del motor) se reemplaza por uno generico. */
function mensajeDe(err: unknown, motivo: MotivoRechazoCatalogo): string {
  const msg = typeof err === "object" && err !== null ? (err as { message?: unknown }).message : undefined;
  const m = typeof msg === "string" ? /^rentas\.[a-z_]+: (.+)$/s.exec(msg) : null;
  return m ? m[1]!.trim() : MENSAJE_GENERICO[motivo];
}

interface ReglaRow {
  id: string;
  property_id: string | null;
  codigo: string;
  nombre: string;
  ya_neto_de_comision: boolean;
  comision_basis_points: number;
  fuente: string;
  vigente_desde: string;
}

export class PostgresRentasCatalogoRepository implements RentasCatalogoRepository {
  constructor(private readonly db: TenantDbSession) {}

  private escribir<T>(funcion: string, primary: () => Promise<T>): Promise<ResultadoCatalogo<T>> {
    return runWithSavepointFallback<ResultadoCatalogo<T>>({
      session: this.db,
      savepointName: `sp_catalogo_${funcion}`,
      primary: async () => ({ estado: "ok", valor: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err, `rentas.${funcion}`) || motivoDe(err) !== null,
      fallback: async (err) => {
        const motivo = motivoDe(err);
        if (motivo === null) return { estado: "no_disponible" };
        return { estado: "rechazado", motivo, mensaje: mensajeDe(err, motivo) };
      },
    });
  }

  async listarReglasComision(organizationId: string, propertyId: string): Promise<readonly ReglaComisionRecord[]> {
    const { rows } = await this.db.query<ReglaRow>(
      `select r.id, r.property_id, c.codigo, c.nombre, r.ya_neto_de_comision, r.comision_basis_points, r.fuente, r.vigente_desde::text as vigente_desde
       from rentas.regla_comision_canal r
       join rentas.canal c on c.id = r.canal_id
       where r.organization_id = $1 and (r.property_id is null or r.property_id = $2)
       order by c.codigo, r.property_id nulls first;`,
      [organizationId, propertyId],
    );
    return rows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      canalCodigo: r.codigo,
      canalNombre: r.nombre,
      yaNetoDeComision: r.ya_neto_de_comision,
      comisionBasisPoints: r.comision_basis_points,
      fuente: r.fuente,
      vigenteDesde: r.vigente_desde,
      sugerida: r.fuente.startsWith("default_sugerido"),
    }));
  }

  async listarCanales(): Promise<readonly CanalRecordCatalogo[]> {
    const { rows } = await this.db.query<CanalRecordCatalogo>(`select codigo, nombre from rentas.canal order by codigo;`);
    return rows;
  }

  async listarPropiedades(organizationId: string): Promise<readonly PropiedadCatalogoRecord[]> {
    const { rows } = await this.db.query<{ property_id: string; nombre: string; zona_horaria: string | null; moneda: string | null }>(
      `select p.id as property_id, p.name as nombre, pc.zona_horaria, pc.moneda
       from core.property p
       left join rentas.property_config pc on pc.property_id = p.id
       where p.organization_id = $1 and p.status = 'active'
       order by p.name;`,
      [organizationId],
    );
    return rows.map((r) => ({ propertyId: r.property_id, nombre: r.nombre, zonaHoraria: r.zona_horaria, moneda: r.moneda }));
  }

  async listarUnidades(propertyId: string): Promise<readonly UnidadCatalogoRecord[]> {
    type Fila = { id: string; property_id: string; name: string; duracion_minima_noches: number; owner_id: string | null; owner_name: string | null; responsable_limpieza_default?: string | null };
    // La columna `responsable_limpieza_default` es de la migracion 033: contra la base sin migrar (42703) la lectura cae a la consulta
    // anterior (sin responsable). Dentro de un SAVEPOINT: la sesion es UNA transaccion por request y un error la dejaria abortada.
    const rows = await runWithSavepointFallback<Fila[]>({
      session: this.db,
      savepointName: "sp_catalogo_listar_unidades",
      primary: async () =>
        (
          await this.db.query<Fila>(
            `select u.id, u.property_id, u.name, u.duracion_minima_noches, u.owner_id, o.name as owner_name, u.responsable_limpieza_default
             from rentas.unidad u
             left join rentas.owner o on o.id = u.owner_id
             where u.property_id = $1
             order by u.name;`,
            [propertyId],
          )
        ).rows,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () =>
        (
          await this.db.query<Fila>(
            `select u.id, u.property_id, u.name, u.duracion_minima_noches, u.owner_id, o.name as owner_name
             from rentas.unidad u
             left join rentas.owner o on o.id = u.owner_id
             where u.property_id = $1
             order by u.name;`,
            [propertyId],
          )
        ).rows,
    });
    return rows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      nombre: r.name,
      duracionMinimaNoches: r.duracion_minima_noches,
      propietarioId: r.owner_id,
      propietarioNombre: r.owner_name,
      responsableLimpiezaId: r.responsable_limpieza_default ?? null,
    }));
  }

  async listarPropietarios(organizationId: string): Promise<readonly PropietarioRecord[]> {
    const { rows } = await this.db.query<{ id: string; name: string; email: string | null }>(
      `select o.id, o.name, o.email
       from rentas.owner o
       join rentas.owner_organization oo on oo.owner_id = o.id
       where oo.organization_id = $1
       order by o.name;`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, nombre: r.name, email: r.email }));
  }

  crearReglaComision(organizationId: string, propertyId: string, e: EntradaReglaComision): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("crear_regla_comision_canal", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.crear_regla_comision_canal($1::uuid, $2::uuid, $3, $4, $5, $6) as id;`, [
        organizationId,
        e.alcance === "propiedad" ? propertyId : null,
        e.canalCodigo,
        e.yaNetoDeComision,
        e.comisionBasisPoints,
        e.fuente,
      ]);
      return { id: rows[0]!.id };
    });
  }

  actualizarReglaComision(reglaId: string, e: EntradaActualizarReglaComision): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("actualizar_regla_comision_canal", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.actualizar_regla_comision_canal($1::uuid, $2, $3, $4) as id;`, [reglaId, e.yaNetoDeComision, e.comisionBasisPoints, e.fuente]);
      return { id: rows[0]!.id };
    });
  }

  sembrarReglasComisionPorDefecto(organizationId: string): Promise<ResultadoCatalogo<{ creadas: number }>> {
    return this.escribir("sembrar_reglas_comision_por_defecto", async () => {
      const { rows } = await this.db.query<{ creadas: number }>(`select rentas.sembrar_reglas_comision_por_defecto($1::uuid) as creadas;`, [organizationId]);
      return { creadas: Number(rows[0]!.creadas) };
    });
  }

  crearPropiedad(organizationId: string, e: EntradaCrearPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>> {
    return this.escribir("crear_propiedad", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.crear_propiedad($1::uuid, $2, $3, $4) as id;`, [organizationId, e.nombre, e.zonaHoraria, e.moneda]);
      return { propertyId: rows[0]!.id };
    });
  }

  actualizarPropiedad(propertyId: string, e: EntradaActualizarPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>> {
    return this.escribir("actualizar_propiedad", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.actualizar_propiedad($1::uuid, $2, $3, $4) as id;`, [propertyId, e.nombre ?? null, e.zonaHoraria ?? null, e.moneda ?? null]);
      return { propertyId: rows[0]!.id };
    });
  }

  crearPropietario(organizationId: string, e: EntradaCrearPropietario): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("crear_propietario", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.crear_propietario($1::uuid, $2, $3) as id;`, [organizationId, e.nombre, e.email]);
      return { id: rows[0]!.id };
    });
  }

  actualizarPropietario(organizationId: string, propietarioId: string, e: EntradaActualizarPropietario): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("actualizar_propietario", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.actualizar_propietario($1::uuid, $2::uuid, $3, $4, $5::boolean) as id;`, [
        organizationId,
        propietarioId,
        e.nombre ?? null,
        e.email ?? null,
        e.email === null,
      ]);
      return { id: rows[0]!.id };
    });
  }

  crearUnidad(propertyId: string, e: EntradaCrearUnidad): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("crear_unidad", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.crear_unidad($1::uuid, $2, $3::uuid, $4::integer) as id;`, [propertyId, e.nombre, e.propietarioId, e.duracionMinimaNoches]);
      return { id: rows[0]!.id };
    });
  }

  actualizarUnidad(unidadId: string, e: EntradaActualizarUnidad): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("actualizar_unidad", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.actualizar_unidad($1::uuid, $2, $3::uuid, $4::boolean, $5::integer) as id;`, [
        unidadId,
        e.nombre ?? null,
        e.propietarioId ?? null,
        e.propietarioId === null,
        e.duracionMinimaNoches ?? null,
      ]);
      return { id: rows[0]!.id };
    });
  }

  fijarResponsableLimpieza(unidadId: string, responsableId: string | null): Promise<ResultadoCatalogo<{ id: string }>> {
    return this.escribir("fijar_responsable_limpieza_unidad", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select rentas.fijar_responsable_limpieza_unidad($1::uuid, $2::uuid) as id;`, [unidadId, responsableId]);
      return { id: rows[0]!.id };
    });
  }
}
