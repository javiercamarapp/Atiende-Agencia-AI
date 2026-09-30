// ComandaOutboxStore sobre Postgres (migracion 024). REGLA DURA de compatibilidad con
// la base SIN migrar: cada operacion corre dentro de `runWithSavepointFallback`
// (SAVEPOINT / ROLLBACK TO SAVEPOINT), porque la sesion es UNA transaccion compartida
// por request o por lote: un 42883/42P01/42703 sin SAVEPOINT la dejaria abortada
// (25P02) y el COMMIT devolveria ROLLBACK en silencio. Sin la migracion:
//   - la bandera efectiva es "apagado" (comportamiento actual intacto),
//   - encolar devuelve `disponible: false`, reclamar devuelve vacio,
//   - listar/resumen devuelven `disponible: false` (vacio honesto, nunca un 500).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { esEstadoComanda, type DecisionTransicion } from "./outbox-state.ts";
import { esModoSoftRestaurant, resumenVacio } from "./outbox-store.ts";
import type {
  ComandaOutboxStore,
  EntradaEncolar,
  FilaComandaOutbox,
  FiltroListarComandas,
  ModoEncolado,
  ModoSoftRestaurant,
  ResultadoCaptura,
  ResultadoEncolar,
  ResultadoListar,
  ResumenComandas,
} from "./outbox-store.ts";
import type { ComandaInput } from "./types.ts";

/** SQLSTATE de "funcion/tabla/columna inexistente" = la base no tiene la migracion 024. */
function esBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

let advertido = false;
function advertirBaseSinMigrar(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresComandaOutboxStore: la base no tiene la migracion 024 (SQLSTATE 42883/42P01/42703) -- SoftRestaurant " +
      "queda APAGADO y el outbox no disponible. Aplica packages/domain-restaurantes/migrations/024_softrestaurant_comanda_outbox.sql " +
      "(o su espejo en supabase/migrations/).",
    err,
  );
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

interface RawFila {
  id: string;
  organization_id: string;
  property_id: string;
  order_id: string;
  estado: string;
  modo: string;
  payload: unknown;
  intentos: number | string;
  max_intentos: number | string;
  proximo_intento_en: unknown;
  folio: string | null;
  ultimo_error: string | null;
  capturado_por: string | null;
  capturado_en: unknown;
  nota_captura: string | null;
  creado_en: unknown;
  actualizado_en: unknown;
}

export function mapFilaComanda(r: RawFila): FilaComandaOutbox {
  if (!esEstadoComanda(r.estado)) throw new Error(`pos_comanda_outbox: estado desconocido "${r.estado}"`);
  const payload = (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as ComandaInput;
  return {
    id: r.id,
    organizationId: r.organization_id,
    propertyId: r.property_id,
    orderId: r.order_id,
    estado: r.estado,
    modo: r.modo as ModoEncolado,
    payload,
    intentos: Number(r.intentos),
    maxIntentos: Number(r.max_intentos),
    proximoIntentoEn: iso(r.proximo_intento_en),
    folio: r.folio,
    ultimoError: r.ultimo_error,
    capturadoPor: r.capturado_por,
    capturadoEn: isoOrNull(r.capturado_en),
    notaCaptura: r.nota_captura,
    creadoEn: iso(r.creado_en),
    actualizadoEn: iso(r.actualizado_en),
  };
}

// Solo columnas con GRANT SELECT para `authenticated` (migracion 024): idempotency_key y
// reclamada_en NO se leen directo.
const COLUMNAS_LECTURA =
  "id, organization_id, property_id, order_id, estado, modo, payload, intentos, max_intentos, proximo_intento_en, folio, ultimo_error, capturado_por, capturado_en, nota_captura, creado_en, actualizado_en";

export class PostgresComandaOutboxStore implements ComandaOutboxStore {
  constructor(private readonly db: TenantDbSession) {}

  async leerModo(organizationId: string): Promise<ModoSoftRestaurant> {
    return runWithSavepointFallback<ModoSoftRestaurant>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<{ modo: string }>("select restaurantes.softrestaurant_modo($1) as modo", [organizationId]);
        const modo = r.rows[0]?.modo;
        return esModoSoftRestaurant(modo) ? modo : "apagado";
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve("apagado");
      },
    });
  }

  async fijarModo(organizationId: string, modo: ModoSoftRestaurant): Promise<{ disponible: boolean }> {
    return runWithSavepointFallback<{ disponible: boolean }>({
      session: this.db,
      primary: async () => {
        await this.db.query("select restaurantes.set_softrestaurant_modo($1, $2) as modo", [organizationId, modo]);
        return { disponible: true };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve({ disponible: false });
      },
    });
  }

  async encolar(e: EntradaEncolar): Promise<ResultadoEncolar> {
    return runWithSavepointFallback<ResultadoEncolar>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<RawFila>("select * from restaurantes.pos_comanda_encolar($1, $2, $3, $4, $5, $6::jsonb, $7)", [
          e.organizationId,
          e.propertyId,
          e.orderId,
          e.idempotencyKey,
          e.modo,
          JSON.stringify(e.payload),
          e.maxIntentos,
        ]);
        const fila = r.rows[0];
        if (!fila) throw new Error("pos_comanda_encolar no devolvio fila");
        return { disponible: true, fila: mapFilaComanda(fila) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve({ disponible: false });
      },
    });
  }

  private async reclamar(id: string | null, limite: number, leaseMs: number): Promise<FilaComandaOutbox[]> {
    return runWithSavepointFallback<FilaComandaOutbox[]>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<RawFila>("select * from restaurantes.pos_comanda_reclamar($1, $2, $3)", [id, limite, Math.max(1, Math.ceil(leaseMs / 1000))]);
        return r.rows.map(mapFilaComanda);
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve([]);
      },
    });
  }

  async reclamarPorId(id: string, _ahora: Date, leaseMs: number): Promise<FilaComandaOutbox | null> {
    return (await this.reclamar(id, 1, leaseMs))[0] ?? null;
  }

  async reclamarLote(limite: number, _ahora: Date, leaseMs: number): Promise<readonly FilaComandaOutbox[]> {
    return this.reclamar(null, limite, leaseMs);
  }

  async completar(id: string, d: DecisionTransicion): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<{ ok: boolean }>("select restaurantes.pos_comanda_completar($1, $2, $3, $4, $5) as ok", [
          id,
          d.estado,
          d.folio,
          d.ultimoError,
          d.proximoIntentoEn ? d.proximoIntentoEn.toISOString() : null,
        ]);
        return r.rows[0]?.ok === true;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve(false);
      },
    });
  }

  async listar(organizationId: string, f: FiltroListarComandas): Promise<ResultadoListar> {
    const limite = Math.min(200, Math.max(1, Math.trunc(f.limite)));
    const offset = Math.max(0, Math.trunc(f.offset));
    const params: unknown[] = [organizationId];
    const condiciones = ["organization_id = $1"];
    if (f.propertyIds !== null) {
      params.push([...f.propertyIds]);
      condiciones.push(`property_id = any($${params.length}::uuid[])`);
    }
    if (f.estados && f.estados.length > 0) {
      params.push([...f.estados]);
      condiciones.push(`estado = any($${params.length}::text[])`);
    }
    params.push(limite, offset);
    const sql = `select ${COLUMNAS_LECTURA} from restaurantes.pos_comanda_outbox where ${condiciones.join(" and ")} order by creado_en desc, id desc limit $${params.length - 1} offset $${params.length}`;
    return runWithSavepointFallback<ResultadoListar>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<RawFila>(sql, params);
        return { disponible: true, filas: r.rows.map(mapFilaComanda) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve({ disponible: false, filas: [] });
      },
    });
  }

  async obtener(organizationId: string, id: string): Promise<FilaComandaOutbox | null> {
    return runWithSavepointFallback<FilaComandaOutbox | null>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<RawFila>(`select ${COLUMNAS_LECTURA} from restaurantes.pos_comanda_outbox where organization_id = $1 and id = $2::uuid`, [organizationId, id]);
        return r.rows[0] ? mapFilaComanda(r.rows[0]) : null;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve(null);
      },
    });
  }

  async resumen(organizationId: string, propertyIds: readonly string[] | null): Promise<ResumenComandas> {
    const params: unknown[] = [organizationId];
    let filtro = "";
    if (propertyIds !== null) {
      params.push([...propertyIds]);
      filtro = ` and property_id = any($2::uuid[])`;
    }
    return runWithSavepointFallback<ResumenComandas>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<{ estado: string; total: string | number }>(
          `select estado, count(*)::int as total from restaurantes.pos_comanda_outbox where organization_id = $1${filtro} group by estado`,
          params,
        );
        const porEstado = resumenVacio();
        for (const row of r.rows) if (esEstadoComanda(row.estado)) porEstado[row.estado] = Number(row.total);
        return { disponible: true, porEstado };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: (err) => {
        advertirBaseSinMigrar(err);
        return Promise.resolve({ disponible: false, porEstado: resumenVacio() });
      },
    });
  }

  async marcarCapturada(organizationId: string, id: string, _actorUserId: string, nota: string | null): Promise<ResultadoCaptura> {
    return runWithSavepointFallback<ResultadoCaptura>({
      session: this.db,
      primary: async () => {
        const r = await this.db.query<RawFila>("select * from restaurantes.pos_comanda_marcar_capturada($1, $2, $3)", [organizationId, id, nota]);
        const fila = r.rows[0];
        if (!fila) return { resultado: "no_encontrada" };
        return { resultado: "ok", fila: mapFilaComanda(fila) };
      },
      // Errores de NEGOCIO de la funcion (no encontrada / estado / permiso) y base sin migrar se traducen
      // a resultado; cualquier otro error se repropaga.
      isRecoverable: (err) => {
        const code = (err as { code?: string } | null)?.code;
        return esBaseSinMigrar(err) || code === "P0002" || code === "55000" || code === "42501";
      },
      fallback: (err) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "P0002") return Promise.resolve({ resultado: "no_encontrada" });
        if (code === "55000") return Promise.resolve({ resultado: "estado_invalido" });
        if (code === "42501") return Promise.resolve({ resultado: "prohibido" });
        advertirBaseSinMigrar(err);
        return Promise.resolve({ resultado: "no_disponible" });
      },
    });
  }
}
