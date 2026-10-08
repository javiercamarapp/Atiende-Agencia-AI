// CFO-06 · fixtures de las pruebas de exportación: vistas del CFO armadas con el repositorio en memoria y el dataset SINTÉTICO de CFO-04
// (nunca datos reales). Todo parametrizable: número de sucursales, un platillo con nombre hostil, costos capturados.
import { InMemoryCfoRepository, ServicioCfo } from "@atiende/domain-restaurantes/cfo";
import type { AlcanceApi, ConsultaCfo, SucursalApi } from "@atiende/domain-restaurantes/cfo";
import { SUCURSALES_PM_SINTETICAS, costosCapturadosSinteticos, generarDatasetSintetico, resumirClientes } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { cargarVistasCfo } from "../src/routes/verticals/restaurantes/cfo-exportar.ts";
import type { AlcanceExportacion, VistaExportarCfo, VistasCfo } from "../src/routes/verticals/restaurantes/cfo-exportar-xlsx.ts";

export const D = generarDatasetSintetico({ diasRango: 120 });
export const Q: ConsultaCfo = { desde: "2026-08-31", hasta: "2026-09-27", comparar: "periodo_anterior", granularidad: "dia" };
export const GENERADO = new Date("2026-09-28T15:00:00Z");

export interface OpcionesVistas {
  /** Cuántas de las 7 sucursales sintéticas entran (por omisión 3). */
  readonly n?: number;
  /** Nombre de un platillo hostil (inyección de fórmulas). */
  readonly platillo?: string;
  /** Nombre hostil para la primera sucursal. */
  readonly nombreSucursal?: string;
  readonly capturarCostos?: boolean;
  readonly organizacionCompleta?: boolean;
  readonly vista?: VistaExportarCfo;
  readonly formato?: "xlsx" | "pdf";
  /** Quita todas las ventas de la primera sucursal (cifras null). */
  readonly sinVentasPrimera?: boolean;
  readonly avisosExtra?: number;
}

export async function armarVistas(op: OpcionesVistas = {}): Promise<{ vistas: VistasCfo; alcance: AlcanceExportacion; sucursales: readonly SucursalApi[]; servicio: ServicioCfo }> {
  const n = op.n ?? 3;
  const sel = SUCURSALES_PM_SINTETICAS.slice(0, n);
  const ids = new Set(sel.map((s) => s.propertyId));
  const primera = sel[0]!.propertyId;
  const f = <T extends { propertyId: string | null }>(xs: readonly T[]): T[] => xs.filter((x) => x.propertyId === null || ids.has(x.propertyId));
  const sucursales: SucursalApi[] = sel.map((s, i) => ({ propertyId: s.propertyId, nombre: i === 0 && op.nombreSucursal ? op.nombreSucursal : s.nombre, slug: s.codigo.toLowerCase() }));
  const refHostil = f(D.productos)[0]?.productoRef;
  const productos = f(D.productos).map((p) => (op.platillo && p.productoRef === refHostil ? { ...p, nombreActual: op.platillo } : p));
  const ventasDiarias = f(D.ventasDiarias).filter((v) => !(op.sinVentasPrimera && v.propertyId === primera));
  const pedidosSel = D.pedidos.filter((p) => ids.has(p.propertyId));
  const repo = new InMemoryCfoRepository({
    sucursales: sel.map((s) => s.propertyId),
    organizacionCompleta: op.organizacionCompleta ?? true,
    dataset: {
      ventasDiarias,
      cortesias: f(D.cortesias),
      ventasHora: f(D.ventasHora),
      productos,
      agenteDiario: f(D.agenteDiario),
      comandasPos: f(D.comandasPos),
      clientesResumen: f(resumirClientes(pedidosSel, D.desde, D.hasta)),
      agotados: f(D.agotados),
      srResumen: f(D.srResumen),
      cobertura: sel.map((s) => ({ propertyId: s.propertyId, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" })),
      entregasPercentiles: [
        ...sel.map((s, i) => ({ propertyId: s.propertyId, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 50 + i * 3 })),
        { propertyId: null, alcance: "conjunto" as const, entregados: 100 * n, p50Min: 37, p90Min: 58 },
      ],
    },
  });
  if (op.capturarCostos ?? true) {
    // Agosto y septiembre: el rango de prueba (31-ago a 27-sep) toca los dos meses, así que con ambos capturados el EBITDA sale completo.
    for (const mes of ["2026-08-01", "2026-09-01"]) {
      for (const c of costosCapturadosSinteticos(mes)) {
        if (!ids.has(c.propertyId as string)) continue;
        await repo.costoGuardar({ organizationId: "org", propertyId: c.propertyId, mes: c.mes, concepto: c.concepto, montoCentavos: c.montoCentavos, pct: c.pct, nota: null });
      }
    }
  }
  const org = op.organizacionCompleta ?? true;
  const servicio = new ServicioCfo({
    repo, organizationId: "org", alcance: { propertyIds: [...ids], todas: true, organizacionCompleta: org }, propertyIdsSql: org ? null : [...ids], sucursales, ahora: new Date("2026-09-28T15:00:00Z"),
  });
  const vista = op.vista ?? "completo";
  const vistas = await cargarVistasCfo(servicio, vista, op.formato ?? "xlsx", Q);
  const base = vistas.resumen ?? vistas.estadoResultados;
  const alcanceApi: AlcanceApi = base ? { ...base.alcance } : { propertyIds: [...ids], todas: true, organizacionCompleta: org, etiqueta: "Todas sus sucursales" };
  const avisos = Array.from({ length: op.avisosExtra ?? 0 }, (_, i) => `Aviso de prueba número ${i + 1}: texto largo para ocupar espacio en las notas del reporte y comprobar el tope de páginas del PDF.`);
  const conAvisos: VistasCfo = op.avisosExtra && vistas.resumen ? { ...vistas, resumen: { ...vistas.resumen, avisos: [...vistas.resumen.avisos, ...avisos] } } : vistas;
  return { vistas: conAvisos, alcance: { organizacion: "Organización de prueba", vista, desde: Q.desde, hasta: Q.hasta, alcance: alcanceApi }, sucursales, servicio };
}
