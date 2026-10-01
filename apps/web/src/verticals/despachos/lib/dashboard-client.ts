// Cliente HTTP del dashboard gerencial de despachos (D-01). Llama a
// `GET /v1/despachos/:orgSlug/dashboard` (consolidado + ranking de clientes) y
// `GET /despachos/:propertyId/dashboard` (un cliente) de apps/api/.../despachos/dashboard.ts.
// Los tipos reflejan EXACTAMENTE lo que serializa la API (motor en
// `@atiende/domain-despachos::dashboard/kpis.ts`); un bloque `null` significa "no disponible
// aún" (fuente ausente en la base) o "sin datos", nunca cero.
import { fetchJson } from "./admin-client.ts";

export type NivelAtencion = "critico" | "atencion" | "al_corriente" | "sin_datos";
export type SeveridadAnomalia = "alta" | "media" | "baja";
export type FuenteDashboard = "cartera" | "revisiones" | "vencimientos" | "cierre" | "cfdi";
export type BucketCartera = "0-30" | "31-60" | "61-90" | "90+";

export interface AnomaliaDashboard {
  readonly codigo: string;
  readonly severidad: SeveridadAnomalia;
  readonly mensaje: string;
  readonly cantidad: number;
  readonly monto: number | null;
}

export interface KpisCartera {
  readonly cuentasPendientes: number;
  readonly montoPendiente: number;
  readonly cuentasVencidas: number;
  readonly montoVencido: number;
  readonly cuentas90Mas: number;
  readonly monto90Mas: number;
  readonly porAntiguedad: Readonly<Record<BucketCartera, { readonly count: number; readonly monto: number }>>;
  readonly scorePromedio: number | null;
  readonly cuentasSinCorreo: number;
  readonly cuentasSinMonto: number;
  readonly cuentasCobradas: number;
  readonly montoCobrado: number;
  readonly tasaCobranzaPct: number | null;
}

export interface KpisCargaTrabajo {
  readonly revisionesPendientes: number | null;
  readonly revisionesAntiguas: number | null;
  readonly vencimientosAbiertos: number | null;
  readonly vencimientosVencidos: number | null;
  readonly vencimientosProximos: number | null;
  readonly tareasCierrePendientes: number | null;
  readonly tareasCierreVencidas: number | null;
  readonly totalPendientes: number;
}

export interface KpisCierres {
  readonly periodosSinCerrar: number;
  readonly periodosVencidos: number;
  readonly mesAnterior: { readonly year: number; readonly month: number; readonly estado: "cerrado" | "abierto" | "vencido" | "sin_periodo" };
  readonly periodoReciente: { readonly year: number; readonly month: number; readonly estado: "cerrado" | "abierto" | "vencido"; readonly avancePct: number } | null;
}

export interface KpisCliente {
  readonly propertyId: string;
  readonly nombre: string;
  readonly hoy: string;
  readonly fuentesNoDisponibles: readonly FuenteDashboard[];
  readonly cartera: KpisCartera | null;
  readonly cargaTrabajo: KpisCargaTrabajo | null;
  readonly cierres: KpisCierres | null;
  readonly cfdiMes: { readonly periodo: string; readonly total: number; readonly invalidos: number; readonly requierenRevision: number } | null;
  readonly anomalias: readonly AnomaliaDashboard[];
  readonly nivelAtencion: NivelAtencion;
}

export interface DashboardDespacho {
  readonly organizacion: { readonly slug: string; readonly nombre: string };
  readonly totalClientesVisibles: number;
  readonly truncado: boolean;
  readonly totalClientes: number;
  readonly clientesPorNivel: Readonly<Record<NivelAtencion, number>>;
  readonly cartera: {
    readonly cuentasPendientes: number;
    readonly montoPendiente: number;
    readonly montoVencido: number;
    readonly monto90Mas: number;
    readonly montoCobrado: number;
    readonly tasaCobranzaPct: number | null;
    readonly clientesConDato: number;
  } | null;
  readonly cargaTrabajo: {
    readonly revisionesPendientes: number;
    readonly vencimientosAbiertos: number;
    readonly vencimientosVencidos: number;
    readonly tareasCierrePendientes: number;
    readonly totalPendientes: number;
  } | null;
  readonly cierres: { readonly periodosSinCerrar: number; readonly periodosVencidos: number; readonly clientesMesAnteriorSinCerrar: number } | null;
  readonly anomaliasPorSeveridad: Readonly<Record<SeveridadAnomalia, number>>;
  readonly fuentesNoDisponibles: readonly FuenteDashboard[];
  readonly ranking: readonly KpisCliente[];
}

export async function fetchDashboardDespacho(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<DashboardDespacho> {
  return fetchJson<DashboardDespacho>(fetchImpl, `${apiBaseUrl}/v1/despachos/${encodeURIComponent(orgSlug)}/dashboard`, token);
}

export async function fetchDashboardCliente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<KpisCliente> {
  return fetchJson<KpisCliente>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/dashboard`, token);
}
