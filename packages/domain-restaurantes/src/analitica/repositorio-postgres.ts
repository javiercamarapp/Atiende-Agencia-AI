// Analítica del dueño · adaptador Postgres: UNA llamada por función SQL de la 160-162, cada una en su SAVEPOINT (`runWithSavepointFallback`), porque corre en la
// transacción única del request. Base sin migrar (42883 / 42P01 / 42703) => `{ disponible: false }` en lecturas y `AnaliticaNoDisponibleError` en la escritura.
// 22023 => AnaliticaParametroInvalidoError; 42501 => AnaliticaSinAccesoError. Los bigint llegan como string desde node-postgres: todo número pasa por numericoSql.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { numericoSql } from "../cfo/util.ts";
import { AnaliticaNoDisponibleError, AnaliticaParametroInvalidoError, AnaliticaSinAccesoError, type AnaliticaRepository } from "./repositorio.ts";
import type { CeldaMatriz, DemandaCruda, FilaRatiosCruda, Lectura, ParamsAnalitica, ParCrudo, ProductoCrudo, ProductosCrudo, PromesaCruda, RatiosCrudo, VentanaRecompra, ZonaCruda } from "./tipos.ts";

type Obj = Record<string, unknown>;

const codigo = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e ? ((e as { code?: unknown }).code as string | undefined) : undefined);
export const baseSinMigrar = (e: unknown): boolean => ["42883", "42P01", "42703"].includes(codigo(e) ?? "");

function traducir(err: unknown): never {
  const c = codigo(err);
  if (c === "22023") throw new AnaliticaParametroInvalidoError(err instanceof Error ? err.message : "Solicitud inválida.");
  if (c === "42501") throw new AnaliticaSinAccesoError();
  throw err;
}

const n = (v: unknown): number => numericoSql(v as string | number | null | undefined) ?? 0;
const nn = (v: unknown): number | null => numericoSql(v as string | number | null | undefined);
const t = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

export function mapDemanda(j: Obj): DemandaCruda {
  return {
    matriz: arr(j["matriz"]).map((r): CeldaMatriz => ({ propertyId: t(r["property_id"]), dow: n(r["dow"]), hora: n(r["hora"]), canal: t(r["canal"]), source: t(r["source"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]) })),
    semanas: arr(j["semanas"]).map((r) => ({ propertyId: t(r["property_id"]), semana: t(r["semana"]), dias: n(r["dias"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]) })),
    ticket: arr(j["ticket"]).map((r) => ({ propertyId: t(r["property_id"]), canal: t(r["canal"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]), medianaCentavos: nn(r["mediana_centavos"]), p90Centavos: nn(r["p90_centavos"]) })),
    pago: arr(j["pago"]).map((r) => ({ propertyId: t(r["property_id"]), formaPago: t(r["forma_pago"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]) })),
    promesa: arr(j["promesa"]).map((r): PromesaCruda => ({
      propertyId: t(r["property_id"]), domicilios: n(r["domicilios"]), entregados: n(r["entregados"]), conPromesa: n(r["con_promesa"]), aTiempo: n(r["a_tiempo"]),
      sinPromesa: n(r["sin_promesa"]), sinCierre: n(r["sin_cierre"]), realMedianaMin: nn(r["real_mediana_min"]), prometidoMedianaMin: nn(r["prometido_mediana_min"]), desvioMedianaMin: nn(r["desvio_mediana_min"]),
    })),
    totales: arr(j["totales"]).map((r) => ({ propertyId: t(r["property_id"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]) })),
    diasConVenta: n(j["dias_con_venta"]),
  };
}

export function mapZona(r: Obj): ZonaCruda {
  return {
    propertyId: t(r["property_id"]), colonia: t(r["colonia"]), pedidos: n(r["pedidos"]), domicilios: n(r["domicilios"]), recogidas: n(r["recogidas"]), netaCentavos: n(r["neta_centavos"]),
    clientes: n(r["clientes"]), entregados: n(r["entregados"]), sinCierre: n(r["sin_cierre"]), medianaMin: nn(r["mediana_min"]), p90Min: nn(r["p90_min"]), masDe60: n(r["mas_de_60"]),
  };
}

export function mapProductos(j: Obj): ProductosCrudo {
  return {
    productos: arr(j["productos"]).map((r): ProductoCrudo => ({
      propertyId: t(r["property_id"]), productoRef: t(r["producto_ref"]), nombre: t(r["nombre"]), categoria: t(r["categoria"]), unidades: n(r["unidades"]), ingresoCentavos: n(r["ingreso_centavos"]),
      pedidos: n(r["pedidos"]), costoUnitarioCentavos: nn(r["costo_unitario_centavos"]), margenCentavos: nn(r["margen_centavos"]),
    })),
    pares: arr(j["pares"]).map((r): ParCrudo => ({
      propertyId: t(r["property_id"]), productoA: t(r["producto_a"]), productoB: t(r["producto_b"]), nombreA: t(r["nombre_a"]), nombreB: t(r["nombre_b"]), juntos: n(r["juntos"]),
      pedidosA: n(r["pedidos_a"]), pedidosB: n(r["pedidos_b"]), pedidosTotal: n(r["pedidos_total"]), enMenu: r["en_menu"] === true, promocionCodigo: r["promocion_codigo"] == null ? null : t(r["promocion_codigo"]),
    })),
    costosCargados: n(j["costos_cargados"]),
  };
}

const ventana = (v: unknown): VentanaRecompra => ({ elegibles: n(obj(v)["elegibles"]), recompraron: n(obj(v)["recompraron"]) });

export function mapRatios(j: Obj): RatiosCrudo {
  return {
    grandeCentavos: n(obj(j["parametros"])["grande_centavos"]),
    filas: arr(j["filas"]).map((r): FilaRatiosCruda => {
      const rc = obj(r["recompra"]);
      return {
        propertyId: r["property_id"] == null ? null : t(r["property_id"]), pedidos: n(r["pedidos"]), netaCentavos: n(r["neta_centavos"]), ticketCentavos: nn(r["ticket_centavos"]),
        clientes: n(r["clientes"]), pedidosConCliente: n(r["pedidos_con_cliente"]), clientesNuevos: n(r["clientes_nuevos"]),
        recompra: { d14: ventana(rc["d14"]), d30: ventana(rc["d30"]), d60: ventana(rc["d60"]) },
        cancelados: n(r["cancelados"]), grandes: n(r["grandes"]), convChats: n(r["conv_chats"]), convConPedido: n(r["conv_con_pedido"]), convEscaladas: n(r["conv_escaladas"]),
        vozLlamadas: n(r["voz_llamadas"]), vozConPedido: n(r["voz_con_pedido"]), vozEscaladas: n(r["voz_escaladas"]), respN: n(r["resp_n"]), respMedianaSeg: nn(r["resp_mediana_seg"]),
        respP90Seg: nn(r["resp_p90_seg"]), respHasta5min: n(r["resp_hasta_5min"]), respAgenteN: n(r["resp_agente_n"]), respHumanoN: n(r["resp_humano_n"]),
        conversacionesAgente: n(r["conversaciones_agente"]), costoTotalCentavos: nn(r["costo_total_centavos"]), costoPorConversacionCentavos: nn(r["costo_por_conversacion_centavos"]),
      };
    }),
  };
}

export class PostgresAnaliticaRepository implements AnaliticaRepository {
  constructor(private readonly session: TenantDbSession) {}

  private async lee<T>(sql: string, valores: readonly unknown[], mapa: (filas: Obj[]) => T): Promise<Lectura<T>> {
    try {
      return await runWithSavepointFallback<Lectura<T>>({
        session: this.session,
        primary: async () => {
          const { rows } = await this.session.query<Obj>(sql, [...valores]);
          return { disponible: true, datos: mapa(rows) };
        },
        isRecoverable: baseSinMigrar,
        fallback: async () => ({ disponible: false }),
      });
    } catch (err) {
      return traducir(err);
    }
  }

  private props(p: ParamsAnalitica): string[] | null {
    return p.propertyIds === null ? null : [...p.propertyIds];
  }

  demanda(p: ParamsAnalitica): Promise<Lectura<DemandaCruda>> {
    return this.lee(`select restaurantes.analitica_demanda($1::uuid, $2::uuid[], $3::date, $4::date) as j;`, [p.organizationId, this.props(p), p.desde, p.hasta], (f) => mapDemanda(obj(f[0]?.["j"])));
  }
  zonas(p: ParamsAnalitica, k: number): Promise<Lectura<readonly ZonaCruda[]>> {
    return this.lee(
      `select property_id, colonia, pedidos, domicilios, recogidas, neta_centavos, clientes, entregados, sin_cierre, mediana_min, p90_min, mas_de_60
         from restaurantes.analitica_zonas($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer);`,
      [p.organizationId, this.props(p), p.desde, p.hasta, k],
      (f) => f.map(mapZona),
    );
  }
  productos(p: ParamsAnalitica, limite: number): Promise<Lectura<ProductosCrudo>> {
    return this.lee(`select restaurantes.analitica_productos($1::uuid, $2::uuid[], $3::date, $4::date, $5::integer, 5) as j;`, [p.organizationId, this.props(p), p.desde, p.hasta, limite], (f) => mapProductos(obj(f[0]?.["j"])));
  }
  ratios(p: ParamsAnalitica, grandeCentavos: number): Promise<Lectura<RatiosCrudo>> {
    return this.lee(`select restaurantes.analitica_ratios($1::uuid, $2::uuid[], $3::date, $4::date, $5::bigint) as j;`, [p.organizationId, this.props(p), p.desde, p.hasta, grandeCentavos], (f) => mapRatios(obj(f[0]?.["j"])));
  }
  async guardarCostoProducto(organizationId: string, productId: string, costoPesos: number | null): Promise<void> {
    try {
      await runWithSavepointFallback<void>({
        session: this.session,
        primary: async () => {
          await this.session.query(`select restaurantes.analitica_costo_producto_guardar($1::uuid, $2::uuid, $3::numeric);`, [organizationId, productId, costoPesos]);
        },
        isRecoverable: baseSinMigrar,
        fallback: async () => {
          throw new AnaliticaNoDisponibleError();
        },
      });
    } catch (err) {
      if (err instanceof AnaliticaNoDisponibleError) throw err;
      traducir(err);
    }
  }
}
