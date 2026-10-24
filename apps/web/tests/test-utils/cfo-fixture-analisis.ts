// Generador de la fixture SINTÉTICA de «Análisis de clientes» para la API simulada (e2e y pruebas de componente): arma la vista con el servicio REAL de CFO-05
// (`ServicioCfo.analisisClientesVista`) sobre el repositorio en memoria y datos 100 % sintéticos. El guard `restaurantes-cfo-analisis-fixture-sintetica.spec.ts`
// falla si `e2e/mock-api/fixtures/restaurantes-cfo-analisis.datos.json` se desfasa; `ACTUALIZAR_FIXTURE_CFO=1` lo reescribe.
import { InMemoryCfoRepository, ServicioCfo } from "@atiende/domain-restaurantes/cfo";
import type { AnalisisClientesVista, DatasetCfoMemoria } from "@atiende/domain-restaurantes/cfo";
import { AVISO_SINTETICO } from "./cfo-fixture-sintetica.ts";

const A = "00000000-0000-4000-8000-0000000000";
const T1 = `${A}a1`;
const T2 = `${A}a2`;
const ORG = `${A}b1`;
export const RANGO_FIXTURE_ANALISIS = { desde: "2026-09-21", hasta: "2026-09-27" } as const;

const producto = (propertyId: string, ref: string, nombre: string) => ({
  propertyId, productoRef: ref, nombreActual: nombre, categoria: "Tacos", diaNegocio: "2026-09-22", dowNegocio: 2, unidades: 10, ingresoCentavos: 50_000, pedidos: 10,
});

function datasetSintetico(): Partial<DatasetCfoMemoria> {
  return {
    canastaPares: [
      { propertyId: T1, productoA: "refresco", productoB: "taco", pedidosJuntos: 30 },
      { propertyId: T1, productoA: "flan", productoB: "refresco", pedidosJuntos: 8 },
      { propertyId: T1, productoA: "flan", productoB: "taco", pedidosJuntos: 4 },
    ],
    canastaTotales: [{ propertyId: T1, pedidosTotales: 100, pedidosConProducto: { taco: 40, refresco: 50, flan: 10 } }],
    productos: [producto(T1, "taco", "Tacos al pastor"), producto(T1, "refresco", "Refresco"), producto(T1, "flan", "Flan")],
    analisisRfm: {
      segmentos: [
        { segmento: "campeon", orden: 1, clientes: 2, pedidos: 9, ventaCentavos: 140_000, ticketCentavos: 15_556, recenciaMedianaDias: 3.5 },
        { segmento: "leal", orden: 2, clientes: 0, pedidos: 0, ventaCentavos: 0, ticketCentavos: null, recenciaMedianaDias: null },
        { segmento: "en_riesgo_alto_valor", orden: 3, clientes: 2, pedidos: 5, ventaCentavos: 190_000, ticketCentavos: 38_000, recenciaMedianaDias: 64 },
        { segmento: "nuevo_prometedor", orden: 4, clientes: 1, pedidos: 1, ventaCentavos: 15_000, ticketCentavos: 15_000, recenciaMedianaDias: 3 },
        { segmento: "dormido", orden: 5, clientes: 1, pedidos: 2, ventaCentavos: 4_000, ticketCentavos: 2_000, recenciaMedianaDias: 77 },
        { segmento: "ocasional", orden: 6, clientes: 4, pedidos: 7, ventaCentavos: 92_000, ticketCentavos: 13_143, recenciaMedianaDias: 18.5 },
      ],
      resumen: { clientesConVenta: 10, clientesRecompra: 7, activos30: 6, dormidos: 3, ventaTotalCentavos: 441_000, ventaEnRiesgoCentavos: 194_000 },
      pareto: {
        puntos: [22.7, 45.4, 65.8, 77.1, 86.2, 90.7, 94.3, 97.7, 99.1, 100].map((v, i) => ({ clientesPct: (i + 1) * 10, clientes: i + 1, ventaPct: v })),
        clientesPara50Pct: 30,
        clientesPara80Pct: 50,
      },
    },
    analisisIntervalo: [
      { segmento: "global", clientes: 10, intervalos: 13, p25: 10, p50: 10, p75: 14, p90: 16.6 },
      { segmento: "campeon", clientes: 2, intervalos: 7, p25: 10, p50: 10, p75: 10, p90: 11.2 },
      { segmento: "en_riesgo_alto_valor", clientes: 2, intervalos: 3, p25: null, p50: null, p75: null, p90: null },
    ],
    analisisReactivacion: {
      totalElegibles: 4, mostrados: 4, ventaEnJuegoCentavos: 214_000, dormidos: 3, consentimiento: { otorgado: 2, revocado: 1, sinRegistro: 1 },
      filas: [
        { alias: "a1b2c3d4", ventas: 3, ultimaVenta: "2026-08-01", diasSinPedir: 58, intervaloMedianoDias: 15.5, umbralDias: 23.3, ventaCentavos: 90_000, ticketCentavos: 30_000, canalFrecuente: "recoger", dormido: true, consentimiento: "otorgado", prioridadCentavos: 36_078 },
        { alias: "e5f6a7b8", ventas: 2, ultimaVenta: "2026-07-20", diasSinPedir: 70, intervaloMedianoDias: 15, umbralDias: 22.5, ventaCentavos: 100_000, ticketCentavos: 50_000, canalFrecuente: "domicilio", dormido: true, consentimiento: "revocado", prioridadCentavos: 32_143 },
        { alias: "c9d0e1f2", ventas: 2, ultimaVenta: "2026-09-11", diasSinPedir: 16, intervaloMedianoDias: null, umbralDias: 14, ventaCentavos: 20_000, ticketCentavos: 10_000, canalFrecuente: "recoger", dormido: false, consentimiento: "sin_registro", prioridadCentavos: 17_500 },
        { alias: "0a1b2c3d", ventas: 2, ultimaVenta: "2026-07-13", diasSinPedir: 77, intervaloMedianoDias: 10, umbralDias: 15, ventaCentavos: 4_000, ticketCentavos: 2_000, canalFrecuente: "recoger", dormido: true, consentimiento: "otorgado", prioridadCentavos: 779 },
      ],
    },
    analisisTortilla: {
      pedidosConItems: 40,
      tortilla: [{ tipo: "maiz", renglones: 20, unidades: 30, pedidos: 18 }, { tipo: "harina", renglones: 6, unidades: 8, pedidos: 6 }, { tipo: "mixta", renglones: 1, unidades: 1, pedidos: 1 }],
    },
  };
}


export type FixtureAnalisis = Readonly<Record<"normal" | "sin095" | "vacio", AnalisisClientesVista>>;

async function vista(modo: "normal" | "sin095" | "vacio"): Promise<AnalisisClientesVista> {
  const repo = new InMemoryCfoRepository({
    sucursales: [T1, T2],
    dataset: modo === "vacio" ? {} : datasetSintetico(),
    ...(modo === "sin095" ? { migraciones: { m095: false } } : {}),
  });
  const servicio = new ServicioCfo({
    repo,
    organizationId: ORG,
    alcance: { propertyIds: [T1, T2], todas: true, organizacionCompleta: true },
    propertyIdsSql: null,
    sucursales: [{ propertyId: T1, nombre: "Prolongación Montejo", slug: "montejo", activa: true }, { propertyId: T2, nombre: "Francisco de Montejo", slug: "fco-montejo", activa: true }],
    ahora: new Date(`${RANGO_FIXTURE_ANALISIS.hasta}T12:00:00Z`),
  });
  const v = await servicio.analisisClientesVista({ ...RANGO_FIXTURE_ANALISIS, comparar: "periodo_anterior", granularidad: "dia" }, 50);
  return { ...v, avisos: [AVISO_SINTETICO, ...v.avisos] };
}

export async function construirFixtureAnalisis(): Promise<FixtureAnalisis> {
  return { normal: await vista("normal"), sin095: await vista("sin095"), vacio: await vista("vacio") };
}
