// F4c (1) -- BORRAR un producto del menu. Reglas:
//  * Sin pedidos en su historial: se borra de verdad (DELETE; `branch_products` cae en cascada).
//  * Con pedidos en su historial (`orders.items` guarda el id y el nombre del producto): SOFT-DELETE -- se archiva (`products.archived_at`, migracion 180),
//    se apaga su disponibilidad en todas las sucursales y el panel deja de listarlo. Los pedidos viejos y los reportes siguen leyendo su nombre.
//  * La confirmacion es explicita (la ruta exige `confirmar: true`) y la vista previa (`evaluarBaja`) dice al dueno cual de los dos caminos tomara.
//  * Permisos y auditoria viven en la ruta (`catalogo.precio` + alcance de toda la organizacion + bitacora OBLIGATORIA).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { ParidadNoDisponibleError, codigoPg, esBaseSinMigrar } from "./comun.ts";

export type TipoBaja = "eliminar" | "archivar";

export interface EvaluacionBaja {
  readonly productId: string;
  readonly nombre: string;
  /** Pedidos (de cualquier estado) cuyo renglon trae este producto; 0 = se puede borrar de verdad. */
  readonly pedidosConHistorial: number;
  readonly tipo: TipoBaja;
  readonly yaArchivado: boolean;
}

export type ResultadoBaja = { readonly estado: "eliminado" | "archivado"; readonly productId: string; readonly nombre: string; readonly pedidosConHistorial: number };

export function tipoDeBaja(pedidosConHistorial: number): TipoBaja {
  return pedidosConHistorial > 0 ? "archivar" : "eliminar";
}

/** Texto que el panel muestra en la confirmacion (sin inventar: depende solo del historial real). */
export function mensajeConfirmacionBaja(e: Pick<EvaluacionBaja, "nombre" | "tipo" | "pedidosConHistorial">): string {
  return e.tipo === "eliminar"
    ? `Se borrara "${e.nombre}" del menu de forma definitiva. No tiene pedidos en su historial.`
    : `"${e.nombre}" aparece en ${e.pedidosConHistorial} pedido(s) y no se puede borrar sin perder su historial: se archivara (dejara de venderse y de listarse; los pedidos y reportes viejos conservan su nombre).`;
}

export interface ProductoBajaRepository {
  /** Ids archivados de la organizacion; vacio contra la base sin la migracion 180 (nada se oculta, nada se rompe). */
  listarArchivados(organizationId: string): Promise<ReadonlySet<string>>;
  /** `null` si el producto no existe en la organizacion. */
  evaluar(organizationId: string, productId: string): Promise<EvaluacionBaja | null>;
  /** Borra o archiva segun el historial. `null` si no existe. Archivar sin la migracion 180 lanza `ParidadNoDisponibleError`. */
  ejecutar(organizationId: string, productId: string): Promise<ResultadoBaja | null>;
}

export class PostgresProductoBajaRepository implements ProductoBajaRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listarArchivados(organizationId: string): Promise<ReadonlySet<string>> {
    return runWithSavepointFallback<ReadonlySet<string>>({
      session: this.db,
      savepointName: "sp_producto_archivados",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`select id from restaurantes.products where organization_id = $1 and archived_at is not null;`, [organizationId]);
        return new Set(rows.map((r) => r.id));
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => new Set<string>(),
    });
  }

  private async pedidosConProducto(organizationId: string, productId: string): Promise<number> {
    // `orders.items` es un arreglo jsonb de renglones { id, name, price, quantity, ... }: la contencion `@>` encuentra el id sin recorrer cada pedido en la aplicacion.
    const { rows } = await this.db.query<{ n: string | number }>(
      `select count(*) as n from restaurantes.orders where organization_id = $1 and jsonb_typeof(items) = 'array' and items @> $2::jsonb;`,
      [organizationId, JSON.stringify([{ id: productId }])],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async archivadoYa(organizationId: string, productId: string): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_producto_archivado_ya",
      primary: async () => {
        const { rows } = await this.db.query<{ archived_at: Date | string | null }>(`select archived_at from restaurantes.products where organization_id = $1 and id = $2;`, [organizationId, productId]);
        return rows[0]?.archived_at != null;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => false,
    });
  }

  async evaluar(organizationId: string, productId: string): Promise<EvaluacionBaja | null> {
    const { rows } = await this.db.query<{ name: string }>(`select name from restaurantes.products where organization_id = $1 and id = $2;`, [organizationId, productId]);
    const fila = rows[0];
    if (!fila) return null;
    const pedidosConHistorial = await this.pedidosConProducto(organizationId, productId);
    return { productId, nombre: fila.name, pedidosConHistorial, tipo: tipoDeBaja(pedidosConHistorial), yaArchivado: await this.archivadoYa(organizationId, productId) };
  }

  async ejecutar(organizationId: string, productId: string): Promise<ResultadoBaja | null> {
    const ev = await this.evaluar(organizationId, productId);
    if (!ev) return null;
    if (ev.tipo === "eliminar") {
      // Borra el producto (y, en cascada, su fila por sucursal). El `organization_id` en el WHERE impide tocar un producto ajeno aunque la policy lo permitiera.
      await this.db.query(`delete from restaurantes.products where organization_id = $1 and id = $2;`, [organizationId, productId]);
      return { estado: "eliminado", productId, nombre: ev.nombre, pedidosConHistorial: 0 };
    }
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_producto_archivar",
      primary: async () => {
        await this.db.query(`update restaurantes.products set archived_at = coalesce(archived_at, now()), is_available = false, updated_at = now() where organization_id = $1 and id = $2;`, [organizationId, productId]);
      },
      isRecoverable: (err) => codigoPg(err) === "42703",
      fallback: async () => {
        throw new ParidadNoDisponibleError("Archivar un producto con historial requiere aplicar la migracion 180 (producto archivado); no se cambio nada.");
      },
    });
    // Apagar en TODAS las sucursales: ningun canal (agente, tienda, panel) puede volver a venderlo.
    await this.db.query(
      `update restaurantes.branch_products bp set is_available = false, updated_at = now()
         from core.property p
        where bp.product_id = $2 and p.id = bp.property_id and p.organization_id = $1 and bp.is_available;`,
      [organizationId, productId],
    );
    return { estado: "archivado", productId, nombre: ev.nombre, pedidosConHistorial: ev.pedidosConHistorial };
  }
}

/** Adaptador en memoria para pruebas de rutas. `historial` = ids con pedidos; `nombres` = productos existentes por organizacion. */
export class InMemoryProductoBajaRepository implements ProductoBajaRepository {
  migrada = true;
  readonly productos = new Map<string, { organizationId: string; nombre: string }>();
  readonly historial = new Map<string, number>();
  readonly archivados = new Set<string>();
  readonly eliminados: string[] = [];
  /** Gancho para que la prueba de ruta tambien quite el producto de su repositorio de catalogo. */
  onEliminar: ((productId: string) => void) | undefined;

  sembrar(organizationId: string, productId: string, nombre: string, pedidos = 0): void {
    this.productos.set(productId, { organizationId, nombre });
    if (pedidos > 0) this.historial.set(productId, pedidos);
  }

  async listarArchivados(organizationId: string): Promise<ReadonlySet<string>> {
    if (!this.migrada) return new Set();
    return new Set([...this.archivados].filter((id) => this.productos.get(id)?.organizationId === organizationId));
  }

  async evaluar(organizationId: string, productId: string): Promise<EvaluacionBaja | null> {
    const p = this.productos.get(productId);
    if (!p || p.organizationId !== organizationId) return null;
    const pedidosConHistorial = this.historial.get(productId) ?? 0;
    return { productId, nombre: p.nombre, pedidosConHistorial, tipo: tipoDeBaja(pedidosConHistorial), yaArchivado: this.archivados.has(productId) };
  }

  async ejecutar(organizationId: string, productId: string): Promise<ResultadoBaja | null> {
    const ev = await this.evaluar(organizationId, productId);
    if (!ev) return null;
    if (ev.tipo === "eliminar") {
      this.productos.delete(productId);
      this.eliminados.push(productId);
      this.onEliminar?.(productId);
      return { estado: "eliminado", productId, nombre: ev.nombre, pedidosConHistorial: 0 };
    }
    if (!this.migrada) throw new ParidadNoDisponibleError("Archivar un producto con historial requiere aplicar la migracion 180 (producto archivado); no se cambio nada.");
    this.archivados.add(productId);
    return { estado: "archivado", productId, nombre: ev.nombre, pedidosConHistorial: ev.pedidosConHistorial };
  }
}
