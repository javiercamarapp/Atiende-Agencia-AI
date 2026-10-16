// CFO-07 · genera las respuestas SINTÉTICAS de `/admin/cfo/*` que sirve la API simulada de e2e (`e2e/mock-api/fixtures/restaurantes-cfo.ts`).
// Sale del generador SINTÉTICO de CFO-04 (PM, 7 sucursales, semilla fija) pasando por el servicio REAL de CFO-05 (`ServicioCfo` + repositorio en
// memoria): las formas y las cifras son las del contrato, no inventadas a mano. La API simulada corre en Node con `--experimental-strip-types`, que no
// puede cargar `ServicioCfo` (propiedades de parámetro), por eso el resultado se guarda como JSON y `restaurantes-cfo-fixture-sintetica.spec.ts` falla
// si el JSON versionado deja de coincidir con lo que genera este módulo (`ACTUALIZAR_FIXTURE_CFO=1` lo reescribe).
// Nada de esto toca una base real: son datos «SINTÉTICO», con alias de cliente y sin nombres, teléfonos ni direcciones.
import { InMemoryCfoRepository, ServicioCfo, type ConsultaCfo, type FilaPedidoDetalle } from "@atiende/domain-restaurantes/cfo";
import { SUCURSALES_PM_SINTETICAS, costosCapturadosSinteticos, generarDatasetSintetico, type PedidoSintetico } from "../../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";

export const ORG_SINTETICA = "org-sintetica";
export const RANGO_ACTUAL = { desde: "2026-09-21", hasta: "2026-09-27" } as const;
export const RANGO_ANTERIOR = { desde: "2026-09-14", hasta: "2026-09-20" } as const;
export const MES = "2026-09-01";
export const AHORA = new Date("2026-09-28T15:00:00Z");

const SUC = SUCURSALES_PM_SINTETICAS;
const IDS = SUC.map((s) => s.propertyId);
export const ID_T1 = SUC.find((s) => s.codigo === "T1")!.propertyId;
export const ID_T2 = SUC.find((s) => s.codigo === "T2")!.propertyId;
export const ID_T3 = SUC.find((s) => s.codigo === "T3")!.propertyId;
export const ID_T4 = SUC.find((s) => s.codigo === "T4")!.propertyId;

/** Selecciones que cubre la API simulada (clave estable = ids ordenados). */
export const SELECCIONES: Readonly<Record<string, readonly string[] | null>> = { todas: null, t1: [ID_T1], t3: [ID_T3], t4: [ID_T4], t1t2: [ID_T1, ID_T2] };

const D = generarDatasetSintetico({ diasRango: 120 });
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" }));
const PERCENTILES = [
  ...IDS.map((id, i) => ({ propertyId: id, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 50 + i * 3 })),
  { propertyId: null, alcance: "conjunto" as const, entregados: 700, p50Min: 37, p90Min: 58 },
];

function aliasDe(clienteId: string): string {
  let h = 2166136261;
  for (const c of clienteId) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Pedidos del último día + todas las compensaciones de la semana (las que respaldan el drill-down de «Lo más importante»). */
export function pedidosDetalleSinteticos(dias: number): FilaPedidoDetalle[] {
  const hasta = RANGO_ACTUAL.hasta;
  const desde = new Date(Date.parse(`${hasta}T00:00:00Z`) - (dias - 1) * 86_400_000).toISOString().slice(0, 10);
  return D.pedidos
    .filter((p) => p.diaNegocio <= hasta && (p.diaNegocio >= desde || (p.esCompensacion && p.diaNegocio >= RANGO_ACTUAL.desde)))
    .map((p: PedidoSintetico, i): FilaPedidoDetalle => ({
      orderId: p.id,
      orderNumber: String(1000 + i),
      propertyId: p.propertyId,
      diaNegocio: p.diaNegocio,
      horaLocal: p.horaLocal,
      canal: p.canal,
      source: p.source,
      status: p.estado,
      paymentMethod: p.pago,
      brutaCentavos: p.brutaCentavos,
      descCentavos: p.descCentavos,
      netaCentavos: p.netaCentavos,
      propinaCentavos: p.propinaCentavos,
      entregadoMin: p.entregaMin,
      esCompensacion: p.esCompensacion,
      esReposicion: p.esReposicion,
      clienteAlias: aliasDe(p.clienteId),
      comandaEstado: null,
    }));
}

async function servicioPara(ids: readonly string[] | null, conNominaT3: boolean): Promise<ServicioCfo> {
  const repo = new InMemoryCfoRepository({
    sucursales: IDS,
    ahora: () => AHORA,
    dataset: {
      ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos,
      clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, entregasPercentiles: PERCENTILES,
    },
  });
  for (const c of costosCapturadosSinteticos(MES)) {
    await repo.costoGuardar({ organizationId: ORG_SINTETICA, propertyId: c.propertyId, mes: c.mes, concepto: c.concepto, montoCentavos: c.montoCentavos, pct: c.pct, nota: null });
  }
  if (conNominaT3) await repo.costoGuardar({ organizationId: ORG_SINTETICA, propertyId: ID_T3, mes: MES, concepto: "nomina", montoCentavos: 25_000_000, pct: null, nota: "Capturado desde el CFO" });
  const propertyIds = ids ?? IDS;
  return new ServicioCfo({
    repo,
    organizationId: ORG_SINTETICA,
    alcance: { propertyIds, todas: ids === null, organizacionCompleta: true },
    propertyIdsSql: ids,
    sucursales: SUC.filter((s) => propertyIds.includes(s.propertyId)).map((s) => ({ propertyId: s.propertyId, nombre: s.nombre, slug: s.codigo.toLowerCase() })),
    ahora: AHORA,
  });
}

const consulta = (rango: { desde: string; hasta: string }, granularidad: ConsultaCfo["granularidad"]): ConsultaCfo => ({ ...rango, comparar: "periodo_anterior", granularidad });

export const AVISO_SINTETICO = "SINTÉTICO: datos de demostración generados por computadora; no son cifras reales de ningún negocio.";

/** Con el aviso SINTÉTICO al frente de `avisos` (así la pantalla de prueba lo dice siempre). */
function rotular<T extends { readonly avisos: readonly string[] }>(v: T): T {
  return { ...v, avisos: [AVISO_SINTETICO, ...v.avisos] };
}

export interface FixtureCfoSintetica {
  readonly alcance: unknown;
  readonly resumen: Record<string, unknown>;
  readonly ventas: Record<string, unknown>;
  readonly sucursales: Record<string, unknown>;
  /** `<seleccion>|<desde>|<0|1 nómina de T3 capturada>` */
  readonly estadoResultados: Record<string, unknown>;
  readonly pedidos: readonly FilaPedidoDetalle[];
  readonly config: unknown;
}

export async function construirFixtureCfo(): Promise<FixtureCfoSintetica> {
  const resumen: Record<string, unknown> = {};
  const ventas: Record<string, unknown> = {};
  const sucursales: Record<string, unknown> = {};
  const estadoResultados: Record<string, unknown> = {};
  for (const [clave, ids] of Object.entries(SELECCIONES)) {
    const s = await servicioPara(ids, false);
    resumen[`${clave}|impacto`] = rotular(await s.resumen(consulta(RANGO_ACTUAL, "dia"), "impacto"));
    ventas[clave] = rotular(await (await servicioPara(ids, false)).ventasVista(consulta(RANGO_ACTUAL, "dia")));
    sucursales[clave] = rotular(await (await servicioPara(ids, false)).sucursalesVista(consulta(RANGO_ACTUAL, "dia")));
    // Estado de resultados: lo que cubren los recorridos (todas, y T3 antes/después de capturar su nómina); el rango anterior es el que pide la variación.
    const variantes: Array<[boolean, typeof RANGO_ACTUAL | typeof RANGO_ANTERIOR]> =
      clave === "t3" ? [[false, RANGO_ACTUAL], [true, RANGO_ACTUAL], [false, RANGO_ANTERIOR], [true, RANGO_ANTERIOR]] : clave === "todas" ? [[false, RANGO_ACTUAL], [false, RANGO_ANTERIOR]] : [[false, RANGO_ACTUAL]];
    for (const [conNomina, rango] of variantes) {
      estadoResultados[`${clave}|${rango.desde}|${conNomina ? 1 : 0}`] = rotular(await (await servicioPara(ids, conNomina)).estadoResultados(consulta(rango, "mes")));
    }
  }
  const base = await servicioPara(null, false);
  return {
    alcance: rotular(await base.alcanceVista()),
    resumen,
    ventas,
    sucursales,
    estadoResultados,
    pedidos: pedidosDetalleSinteticos(1),
    config: await base.configVista(),
  };
}
