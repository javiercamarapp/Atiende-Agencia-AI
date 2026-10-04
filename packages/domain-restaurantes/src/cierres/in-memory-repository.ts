// Repositorio en memoria de cierres para pruebas y la API simulada de e2e. Reproduce el contrato idempotente de la base: una llave
// (sucursal, tipo, fecha de inicio) = un solo cierre; repetir devuelve el existente. El calculo de agregados NO se reimplementa aqui:
// la prueba entrega los `datos` ya calculados (el calculo real vive en SQL y lo prueba scripts/verify-restaurantes-cierre-dia).
import { fechaNegocioValida, sumarDiasFecha } from "./cierre.ts";
import type { CierreDatos, CierreLectura, CierreReporte, CierreRepository, CierreSucursal, CierreTipo, GenerarCierreResultado } from "./cierre.ts";

export class InMemoryCierreRepository implements CierreRepository {
  private readonly filas = new Map<string, CierreReporte & { organizationId: string; propertyId: string }>();
  private n = 0;
  /** Cuantas veces se pidio generar (para probar que repetir no duplica). */
  generaciones = 0;

  constructor(
    private readonly opciones: {
      readonly sucursales?: readonly CierreSucursal[];
      /** Agregados que devolveria la base para un periodo; null = sin pedidos ese periodo. */
      readonly calcular?: (propertyId: string, tipo: CierreTipo, fechaInicio: string) => CierreDatos | null;
      readonly disponible?: boolean;
    } = {},
  ) {}

  private clave(propertyId: string, tipo: CierreTipo, fechaInicio: string): string {
    return `${propertyId}|${tipo}|${fechaInicio}`;
  }

  async listar(organizationId: string, propertyId: string, tipo: CierreTipo, limite: number): Promise<CierreLectura<readonly CierreReporte[]>> {
    if (this.opciones.disponible === false) return { disponible: false, valor: [] };
    const valor = [...this.filas.values()]
      .filter((f) => f.organizationId === organizationId && f.propertyId === propertyId && f.tipo === tipo)
      .sort((a, b) => (a.fechaInicio < b.fechaInicio ? 1 : -1))
      .slice(0, limite)
      .map(({ organizationId: _o, propertyId: _p, ...r }) => r);
    return { disponible: true, valor };
  }

  async generar(
    organizationId: string,
    propertyId: string,
    tipo: CierreTipo,
    fechaInicio: string,
    opciones: { readonly omitirSinActividad?: boolean } = {},
  ): Promise<GenerarCierreResultado> {
    if (this.opciones.disponible === false) return { estado: "no_disponible" };
    if (!fechaNegocioValida(fechaInicio)) throw new Error("fecha invalida");
    this.generaciones++;
    const k = this.clave(propertyId, tipo, fechaInicio);
    const previo = this.filas.get(k);
    if (previo) {
      const { organizationId: _o, propertyId: _p, ...r } = previo;
      return { estado: "existente", reporte: r };
    }
    const datos = this.opciones.calcular?.(propertyId, tipo, fechaInicio) ?? null;
    if (datos === null && opciones.omitirSinActividad) return { estado: "sin_actividad" };
    const reporte: CierreReporte = {
      id: `cierre-${++this.n}`,
      tipo,
      fechaInicio,
      fechaFin: tipo === "dia" ? fechaInicio : sumarDiasFecha(fechaInicio, 6),
      zonaHoraria: "America/Mexico_City",
      generadoPor: "sistema",
      generadoAt: new Date(0).toISOString(),
      datos: datos ?? DATOS_VACIOS,
    };
    this.filas.set(k, { ...reporte, organizationId, propertyId });
    return { estado: "creado", reporte };
  }

  async sucursalesParaBarrido(): Promise<CierreLectura<readonly CierreSucursal[]>> {
    if (this.opciones.disponible === false) return { disponible: false, valor: [] };
    return { disponible: true, valor: this.opciones.sucursales ?? [] };
  }
}

export const DATOS_VACIOS: CierreDatos = {
  pedidos: 0,
  ventasCentavos: 0,
  ticketPromedioCentavos: null,
  conProblema: 0,
  cancelados: 0,
  canceladosCentavos: 0,
  noRecogidos: 0,
  cancelacionPct: null,
  porCanal: [
    { canal: "web", pedidos: 0, ventasCentavos: 0, cancelados: 0 },
    { canal: "whatsapp", pedidos: 0, ventasCentavos: 0, cancelados: 0 },
    { canal: "voice", pedidos: 0, ventasCentavos: 0, cancelados: 0 },
    { canal: "admin", pedidos: 0, ventasCentavos: 0, cancelados: 0 },
  ],
  tiempos: { entregados: 0, promedioMin: null, medianaMin: null, p90Min: null },
  comparativo: null,
  porDia: null,
};
