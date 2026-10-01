// D-24 -- adaptador Postgres del libro contable (migración 020). Cada operación corre bajo `runWithSavepointFallback`: la sesión
// es UNA transacción compartida por request y un error de Postgres la deja abortada (25P02). Contra la base SIN migrar el
// 42883/42P01/42703 degrada a "no disponible" (lecturas: vacío honesto + estado) o a `LibroNoDisponibleError` (escrituras);
// nunca a un 500. Los SQLSTATE de las funciones definer se traducen a errores de dominio tipados.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  LibroDatosInvalidosError,
  LibroNoDisponibleError,
  LibroNoEncontradoError,
  LibroSinPermisoError,
  LibroTopeExcedidoError,
  PeriodoLibroCerradoError,
  PolizaDuplicadaError,
} from "./types.ts";
import type {
  CuentaLibro,
  FiltroPolizas,
  LecturaLibro,
  LibroRepository,
  LineaBalanzaLibro,
  OrigenPoliza,
  PolizaConMovimientos,
  PolizaInput,
  PolizaRecord,
  RegistroPolizaResultado,
  TipoPoliza,
} from "./types.ts";

const FN_PREFIX = "despachos.libro_";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migración 020 -> error de dominio (sin filtrar más detalle de Postgres del necesario). */
export function traducirErrorLibro(err: unknown): unknown {
  const mensaje = err instanceof Error ? err.message.replace(/^libro_[a-z_]+:\s*/, "") : "Datos inválidos.";
  switch (pgCode(err)) {
    case "42501":
      return new LibroSinPermisoError();
    case "22023":
    case "23514":
      return new LibroDatosInvalidosError(mensaje);
    case "55000":
      return new PeriodoLibroCerradoError(mensaje);
    case "23505":
      return new PolizaDuplicadaError();
    case "P0002":
      return new LibroNoEncontradoError();
    case "54000":
      return new LibroTopeExcedidoError(mensaje);
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const fechaIso = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
function entero(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("El monto devuelto por la base excede el rango entero seguro.");
  return n;
}

interface PolizaRaw {
  id: string;
  property_id: string;
  ejercicio: number;
  mes: number;
  tipo: TipoPoliza;
  folio: number;
  fecha: string | Date;
  concepto: string;
  origen: OrigenPoliza;
  invoice_id: string | null;
  reversa_de: string | null;
  reversada: boolean;
  total_centavos: string | number;
  created_at: string | Date;
}
const POLIZA_COLUMNAS = "id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, invoice_id, reversa_de, reversada, total_centavos, created_at";

function mapPoliza(r: PolizaRaw): PolizaRecord {
  return {
    id: r.id,
    propertyId: r.property_id,
    ejercicio: r.ejercicio,
    mes: r.mes,
    tipo: r.tipo,
    folio: r.folio,
    fecha: fechaIso(r.fecha),
    concepto: r.concepto,
    origen: r.origen,
    invoiceId: r.invoice_id,
    reversaDe: r.reversa_de,
    reversada: r.reversada,
    totalCentavos: entero(r.total_centavos),
    createdAt: iso(r.created_at),
  };
}

export class PostgresLibroRepository implements LibroRepository {
  constructor(private readonly db: TenantDbSession) {}

  private lectura<T>(nombre: string, vacio: T, primary: () => Promise<T>): Promise<LecturaLibro<T>> {
    return runWithSavepointFallback<LecturaLibro<T>>({
      session: this.db,
      savepointName: `sp_libro_${nombre}`,
      primary: async () => ({ estado: "disponible", datos: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ estado: "no_disponible", datos: vacio }),
    });
  }

  private async escritura<T>(nombre: string, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName: `sp_libro_${nombre}`,
        primary,
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new LibroNoDisponibleError();
        },
      });
    } catch (err) {
      throw traducirErrorLibro(err);
    }
  }

  listarCuentas(propertyId: string): Promise<LecturaLibro<readonly CuentaLibro[]>> {
    return this.lectura<readonly CuentaLibro[]>("cuentas", [], async () => {
      const { rows } = await this.db.query<{ codigo: string; descripcion: string; naturaleza: "D" | "A" }>(
        "select codigo, descripcion, naturaleza from despachos.libro_cuenta where property_id = $1 order by codigo limit 2000;",
        [propertyId],
      );
      return rows.map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, naturaleza: r.naturaleza }));
    });
  }

  sembrarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<number> {
    return this.escritura("sembrar", async () => {
      const { rows } = await this.db.query<{ libro_catalogo_sembrar: number }>("select despachos.libro_catalogo_sembrar($1, $2::jsonb) as libro_catalogo_sembrar;", [
        propertyId,
        JSON.stringify(cuentas.map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza }))),
      ]);
      return Number(rows[0]?.libro_catalogo_sembrar ?? 0);
    });
  }

  guardarCuenta(propertyId: string, c: CuentaLibro): Promise<void> {
    return this.escritura("cuenta", async () => {
      await this.db.query("select despachos.libro_cuenta_guardar($1, $2, $3, $4);", [propertyId, c.codigo, c.descripcion, c.naturaleza]);
    });
  }

  registrarPoliza(propertyId: string, p: PolizaInput, invoiceId: string | null = null): Promise<RegistroPolizaResultado> {
    return this.escritura("poliza", async () => {
      const partidas = p.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debe: m.debeCentavos, haber: m.haberCentavos }));
      const { rows } = await this.db.query<{ out_poliza_id: string; out_folio: number }>(
        "select out_poliza_id, out_folio from despachos.libro_poliza_registrar($1, $2, $3::date, $4, $5::jsonb, $6);",
        [propertyId, p.tipo, p.fecha, p.concepto, JSON.stringify(partidas), invoiceId],
      );
      return { polizaId: rows[0]!.out_poliza_id, folio: rows[0]!.out_folio };
    });
  }

  reversarPoliza(_propertyId: string, polizaId: string, fecha: string, concepto: string): Promise<RegistroPolizaResultado> {
    return this.escritura("reversa", async () => {
      const { rows } = await this.db.query<{ out_poliza_id: string; out_folio: number }>("select out_poliza_id, out_folio from despachos.libro_poliza_reversar($1, $2::date, $3);", [
        polizaId,
        fecha,
        concepto,
      ]);
      return { polizaId: rows[0]!.out_poliza_id, folio: rows[0]!.out_folio };
    });
  }

  listarPolizas(propertyId: string, f: FiltroPolizas): Promise<LecturaLibro<readonly PolizaRecord[]>> {
    return this.lectura<readonly PolizaRecord[]>("listar", [], async () => {
      const { rows } = await this.db.query<PolizaRaw>(
        `select ${POLIZA_COLUMNAS} from despachos.libro_poliza
         where property_id = $1 and ejercicio = $2 and ($3::int is null or mes = $3)
         order by fecha desc, tipo, folio desc limit $4 offset $5;`,
        [propertyId, f.ejercicio, f.mes ?? null, f.limit, f.offset],
      );
      return rows.map(mapPoliza);
    });
  }

  async obtenerPoliza(propertyId: string, polizaId: string): Promise<PolizaConMovimientos | null> {
    const r = await this.lectura<PolizaConMovimientos | null>("obtener", null, async () => {
      const cab = await this.db.query<PolizaRaw>(`select ${POLIZA_COLUMNAS} from despachos.libro_poliza where property_id = $1 and id = $2;`, [propertyId, polizaId]);
      if (!cab.rows[0]) return null;
      const mov = await this.db.query<{ linea: number; cuenta: string; concepto: string; debe_centavos: string | number; haber_centavos: string | number }>(
        "select linea, cuenta, concepto, debe_centavos, haber_centavos from despachos.libro_movimiento where poliza_id = $1 and property_id = $2 order by linea;",
        [polizaId, propertyId],
      );
      return {
        ...mapPoliza(cab.rows[0]),
        movimientos: mov.rows.map((m) => ({ linea: m.linea, cuenta: m.cuenta, concepto: m.concepto, debeCentavos: entero(m.debe_centavos), haberCentavos: entero(m.haber_centavos) })),
      };
    });
    return r.datos;
  }

  async polizasDeCfdi(propertyId: string, invoiceIds: readonly string[]): Promise<ReadonlyMap<string, PolizaRecord>> {
    if (invoiceIds.length === 0) return new Map();
    const r = await this.lectura<ReadonlyMap<string, PolizaRecord>>("cfdi", new Map(), async () => {
      const { rows } = await this.db.query<PolizaRaw>(
        `select ${POLIZA_COLUMNAS} from despachos.libro_poliza where property_id = $1 and invoice_id = any($2::uuid[]) and not reversada;`,
        [propertyId, [...invoiceIds]],
      );
      return new Map(rows.map((x) => [x.invoice_id as string, mapPoliza(x)] as const));
    });
    return r.datos;
  }

  balanza(propertyId: string, ejercicio: number, mes: number): Promise<LecturaLibro<readonly LineaBalanzaLibro[]>> {
    return this.lectura<readonly LineaBalanzaLibro[]>("balanza", [], async () => {
      const { rows } = await this.db.query<{
        out_cuenta: string;
        out_descripcion: string;
        out_naturaleza: "D" | "A";
        out_saldo_inicial_centavos: string | number;
        out_debe_centavos: string | number;
        out_haber_centavos: string | number;
        out_saldo_final_centavos: string | number;
      }>("select * from despachos.libro_balanza($1, $2, $3);", [propertyId, ejercicio, mes]);
      return rows.map((r) => ({
        cuenta: r.out_cuenta,
        descripcion: r.out_descripcion,
        naturaleza: r.out_naturaleza,
        saldoInicialCentavos: entero(r.out_saldo_inicial_centavos),
        debeCentavos: entero(r.out_debe_centavos),
        haberCentavos: entero(r.out_haber_centavos),
        saldoFinalCentavos: entero(r.out_saldo_final_centavos),
      }));
    });
  }
}
