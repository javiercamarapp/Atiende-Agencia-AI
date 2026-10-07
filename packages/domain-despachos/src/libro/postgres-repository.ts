// D-24 -- adaptador Postgres del libro contable (migración 020). Cada operación corre bajo `runWithSavepointFallback`: la sesión
// es UNA transacción compartida por request y un error de Postgres la deja abortada (25P02). Contra la base SIN migrar el
// 42883/42P01/42703 degrada a "no disponible" (lecturas: vacío honesto + estado) o a `LibroNoDisponibleError` (escrituras);
// nunca a un 500. Los SQLSTATE de las funciones definer se traducen a errores de dominio tipados.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, isUndefinedColumnError, runWithSavepointFallback } from "@atiende/db";
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
  AsignacionAgrupador,
  CuentaLibro,
  FiltroPagosRep,
  FiltroPolizas,
  LecturaLibro,
  LibroRepository,
  LineaBalanzaLibro,
  OrigenPoliza,
  PagoRepConPoliza,
  PolizaConMovimientos,
  PolizaInput,
  PolizaRecord,
  RegistroPolizaResultado,
  ResultadoImportacionCatalogo,
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

/** Cuenta -> JSON de las funciones de la migración 028 (campos de jerarquía y código solo si vienen). */
function cuentaAJson(c: CuentaLibro): Record<string, unknown> {
  const out: Record<string, unknown> = { codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza };
  if (c.nivel !== undefined) out.nivel = c.nivel;
  if (c.cuentaPadre) out.cuenta_padre = c.cuentaPadre;
  if (c.codigoAgrupador) out.codigo_agrupador = c.codigoAgrupador;
  return out;
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

  /** Catálogo con nivel, padre y código agrupador (migración 028). Contra una base SIN la 028 (42703: columna inexistente) cae, dentro de SAVEPOINT,
   * al SELECT de tres columnas de la 020: las cuentas salen sin código agrupador (el XML se niega y lo dice) en vez de un 500. */
  listarCuentas(propertyId: string): Promise<LecturaLibro<readonly CuentaLibro[]>> {
    return runWithSavepointFallback<LecturaLibro<readonly CuentaLibro[]>>({
      session: this.db,
      savepointName: "sp_libro_cuentas_sat",
      primary: async () => {
        const { rows } = await this.db.query<{ codigo: string; descripcion: string; naturaleza: "D" | "A"; nivel: number; cuenta_padre: string | null; codigo_agrupador: string | null }>(
          "select codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador from despachos.libro_cuenta where property_id = $1 order by codigo limit 2000;",
          [propertyId],
        );
        return {
          estado: "disponible" as const,
          datos: rows.map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, naturaleza: r.naturaleza, nivel: Number(r.nivel), cuentaPadre: r.cuenta_padre, codigoAgrupador: r.codigo_agrupador })),
        };
      },
      isRecoverable: (err) => isUndefinedColumnError(err),
      fallback: () =>
        this.lectura<readonly CuentaLibro[]>("cuentas", [], async () => {
          const { rows } = await this.db.query<{ codigo: string; descripcion: string; naturaleza: "D" | "A" }>(
            "select codigo, descripcion, naturaleza from despachos.libro_cuenta where property_id = $1 order by codigo limit 2000;",
            [propertyId],
          );
          return rows.map((r) => ({ codigo: r.codigo, descripcion: r.descripcion, naturaleza: r.naturaleza }));
        }),
    });
  }

  sembrarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<number> {
    return this.escritura("sembrar", async () => {
      const { rows } = await this.db.query<{ libro_catalogo_sembrar: number }>("select despachos.libro_catalogo_sembrar($1, $2::jsonb) as libro_catalogo_sembrar;", [
        propertyId,
        JSON.stringify(cuentas.map((c) => cuentaAJson(c))),
      ]);
      return Number(rows[0]?.libro_catalogo_sembrar ?? 0);
    });
  }

  guardarCuenta(propertyId: string, c: CuentaLibro): Promise<void> {
    return this.escritura("cuenta", async () => {
      // Sin jerarquía ni código: la llamada de 4 argumentos existe igual en la base sin migrar 028 (camino anterior, sin degradar nada).
      if (c.nivel === undefined && c.codigoAgrupador === undefined && c.cuentaPadre === undefined) {
        await this.db.query("select despachos.libro_cuenta_guardar($1, $2, $3, $4);", [propertyId, c.codigo, c.descripcion, c.naturaleza]);
        return;
      }
      await this.db.query("select despachos.libro_cuenta_guardar($1, $2, $3, $4, $5::int, $6, $7);", [propertyId, c.codigo, c.descripcion, c.naturaleza, c.nivel ?? null, c.cuentaPadre ?? null, c.codigoAgrupador ?? null]);
    });
  }

  asignarCodigosAgrupadores(propertyId: string, asignaciones: readonly AsignacionAgrupador[]): Promise<number> {
    return this.escritura("agrupador", async () => {
      const { rows } = await this.db.query<{ libro_cuenta_agrupador_asignar: number }>("select despachos.libro_cuenta_agrupador_asignar($1, $2::jsonb) as libro_cuenta_agrupador_asignar;", [
        propertyId,
        JSON.stringify(asignaciones.map((a) => ({ codigo: a.codigo, codigo_agrupador: a.codigoAgrupador }))),
      ]);
      return Number(rows[0]?.libro_cuenta_agrupador_asignar ?? 0);
    });
  }

  importarCatalogo(propertyId: string, cuentas: readonly CuentaLibro[]): Promise<ResultadoImportacionCatalogo> {
    return this.escritura("importar", async () => {
      const { rows } = await this.db.query<{ out_agregadas: number; out_actualizadas: number }>("select out_agregadas, out_actualizadas from despachos.libro_catalogo_importar($1, $2::jsonb);", [
        propertyId,
        JSON.stringify(cuentas.map((c) => cuentaAJson(c))),
      ]);
      return { agregadas: Number(rows[0]?.out_agregadas ?? 0), actualizadas: Number(rows[0]?.out_actualizadas ?? 0) };
    });
  }

  listarPagosRep(propertyId: string, f: FiltroPagosRep): Promise<LecturaLibro<readonly PagoRepConPoliza[]>> {
    return this.lectura<readonly PagoRepConPoliza[]>("pagos_rep", [], async () => {
      const { rows } = await this.db.query<{
        id: string;
        folio_fiscal_rep: string;
        pago_index: number;
        fecha_pago: string | Date;
        flujo: "trasladado" | "acreditable";
        num_parcialidad: number | null;
        importe_pagado_centavos: string | number;
        base_centavos: string | number;
        iva_centavos: string | number;
        iva_retenido_centavos: string | number;
        folio_fiscal: string;
        direccion: "emitido" | "recibido" | null;
        metodo_pago: string | null;
        moneda: string | null;
        estado_sat: string | null;
        poliza_id: string | null;
        poliza_folio: number | null;
        poliza_tipo: TipoPoliza | null;
      }>(
        `select pc.id, pc.folio_fiscal_rep, pc.pago_index, pc.fecha_pago, pc.flujo, pc.num_parcialidad, pc.importe_pagado_centavos, pc.base_centavos,
                pc.iva_centavos, pc.iva_retenido_centavos, i.folio_fiscal::text as folio_fiscal, i.direccion, i.metodo_pago, i.moneda, i.estado_sat,
                v.poliza_id, v.folio as poliza_folio, v.tipo as poliza_tipo
         from despachos.pago_cfdi pc
         join despachos.invoice i on i.id = pc.invoice_id and i.property_id = pc.property_id
         left join lateral (
           select p.id as poliza_id, p.folio, p.tipo from despachos.libro_poliza_rep r join despachos.libro_poliza p on p.id = r.poliza_id
           where r.pago_cfdi_id = pc.id and not p.reversada limit 1
         ) v on true
         where pc.property_id = $1
           and ($2::text is null or pc.folio_fiscal_rep = lower($2))
           and ($3::date is null or (pc.fecha_pago >= $3::date and pc.fecha_pago < ($3::date + interval '1 month')))
         order by pc.fecha_pago, pc.folio_fiscal_rep, pc.pago_index limit 200;`,
        [propertyId, f.folioFiscalRep ?? null, f.ejercicio !== undefined && f.mes !== undefined ? `${f.ejercicio}-${String(f.mes).padStart(2, "0")}-01` : null],
      );
      return rows.map((r) => ({
        pagoId: r.id,
        folioFiscalRep: r.folio_fiscal_rep,
        pagoIndex: r.pago_index,
        fechaPago: fechaIso(r.fecha_pago),
        flujo: r.flujo,
        numParcialidad: r.num_parcialidad,
        importePagadoCentavos: entero(r.importe_pagado_centavos),
        baseCentavos: entero(r.base_centavos),
        ivaCentavos: entero(r.iva_centavos),
        ivaRetenidoCentavos: entero(r.iva_retenido_centavos),
        folioFiscalCfdi: r.folio_fiscal,
        direccionCfdi: r.direccion,
        metodoPagoCfdi: r.metodo_pago,
        monedaCfdi: r.moneda,
        estadoSatCfdi: r.estado_sat,
        polizaVigente: r.poliza_id && r.poliza_folio !== null && r.poliza_tipo ? { id: r.poliza_id, folio: r.poliza_folio, tipo: r.poliza_tipo } : null,
      }));
    });
  }

  registrarPolizaRep(propertyId: string, pagoId: string, p: PolizaInput): Promise<RegistroPolizaResultado> {
    return this.escritura("poliza_rep", async () => {
      const partidas = p.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debe: m.debeCentavos, haber: m.haberCentavos }));
      const { rows } = await this.db.query<{ out_poliza_id: string; out_folio: number }>(
        "select out_poliza_id, out_folio from despachos.libro_poliza_registrar_rep($1, $2::uuid, $3, $4::date, $5, $6::jsonb);",
        [propertyId, pagoId, p.tipo, p.fecha, p.concepto, JSON.stringify(partidas)],
      );
      return { polizaId: rows[0]!.out_poliza_id, folio: rows[0]!.out_folio };
    });
  }

  polizasDelPeriodo(propertyId: string, ejercicio: number, mes: number, maxPolizas: number): Promise<LecturaLibro<readonly PolizaConMovimientos[]>> {
    return this.lectura<readonly PolizaConMovimientos[]>("periodo", [], async () => {
      const cab = await this.db.query<PolizaRaw>(
        `select ${POLIZA_COLUMNAS} from despachos.libro_poliza where property_id = $1 and ejercicio = $2 and mes = $3 order by fecha, tipo, folio limit $4;`,
        [propertyId, ejercicio, mes, maxPolizas + 1],
      );
      if (cab.rows.length > maxPolizas) throw new LibroTopeExcedidoError(`El periodo tiene más de ${maxPolizas} pólizas: no caben en un solo archivo.`);
      if (cab.rows.length === 0) return [];
      const mov = await this.db.query<{ poliza_id: string; linea: number; cuenta: string; concepto: string; debe_centavos: string | number; haber_centavos: string | number }>(
        `select m.poliza_id, m.linea, m.cuenta, m.concepto, m.debe_centavos, m.haber_centavos
         from despachos.libro_movimiento m join despachos.libro_poliza p on p.id = m.poliza_id
         where m.property_id = $1 and p.ejercicio = $2 and p.mes = $3 order by m.poliza_id, m.linea;`,
        [propertyId, ejercicio, mes],
      );
      const porPoliza = new Map<string, PolizaConMovimientos["movimientos"][number][]>();
      for (const m of mov.rows) {
        const lista = porPoliza.get(m.poliza_id) ?? [];
        lista.push({ linea: m.linea, cuenta: m.cuenta, concepto: m.concepto, debeCentavos: entero(m.debe_centavos), haberCentavos: entero(m.haber_centavos) });
        porPoliza.set(m.poliza_id, lista);
      }
      return cab.rows.map((r) => ({ ...mapPoliza(r), movimientos: porPoliza.get(r.id) ?? [] }));
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

  reversarPoliza(propertyId: string, polizaId: string, fecha: string, concepto: string): Promise<RegistroPolizaResultado> {
    return this.escritura("reversa", async () => {
      // La property viaja a la función: verifica el permiso sobre ELLA antes de bloquear la póliza y exige que la póliza sea de esa property.
      const { rows } = await this.db.query<{ out_poliza_id: string; out_folio: number }>("select out_poliza_id, out_folio from despachos.libro_poliza_reversar($1::uuid, $2::uuid, $3::date, $4);", [
        propertyId,
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
