// Consumo de IA (SA-L-22): GastoApi (gasto, topes, organizaciones, desglose, por rol y topes por rol) MAS tres bloques nuevos:
//   - Insights deterministas (rol sin techo, rol con fallbacks > 10 %, organizacion > 80 % de su tope mensual),
//   - Costo diario (area, 14 dias, del Resumen de la consola),
//   - Tabla por rol/agente: gasto de HOY contra su techo diario de turnos por organizacion ("sin techo" si el rol no tiene).
// Backend real: GET /superadmin/gasto-api/consumo-ia (step-up) y GET /superadmin/consola/resumen. Cada bloque carga y falla POR
// SEPARADO; un campo sin dato se pinta "—" con su motivo, nunca un cero inventado. Base sin la migracion 0047: "no disponible aun".
import { AreaChartSimple, Callout, ChartCard, DataTable, EstadoCargando, EstadoError, PageContainer, PageHeader, StatusBadge } from "@atiende/ui";
import type { CalloutTone, DataTableColumna } from "@atiende/ui";
import { BarraProgreso } from "../../components/BarraProgreso.tsx";
import { fetchConsolaResumen, usd as usdResumen } from "../lib/consola-client.ts";
import type { ConsolaResumen } from "../lib/consola-client.ts";
import { fetchJson } from "../lib/fetch-json.ts";
import { fmtEntero, fmtPct } from "../lib/fichas-client.ts";
import { useCarga } from "../lib/use-carga.ts";
import { SuperAdminGastoApiPage } from "./GastoApi.tsx";

export interface InsightConsumo {
  readonly codigo: "rol_sin_techo" | "rol_con_fallbacks" | "organizacion_cerca_del_tope";
  readonly severidad: "info" | "atencion" | "alta";
  readonly titulo: string;
  readonly detalle: string;
  readonly role?: string;
  readonly organizationId?: string;
}

export interface RolConsumo {
  readonly role: string;
  readonly grupo: string;
  readonly hoy: { readonly costMicroUsd: number; readonly callCount: number; readonly fallbackCallCount: number };
  readonly ventana: { readonly costMicroUsd: number; readonly callCount: number; readonly fallbackCallCount: number };
  readonly techoTurnosDia: number | null;
  readonly maxTurnosOrganizacionHoy: number;
  readonly pctTecho: number | null;
}

export interface RespuestaConsumoIa {
  readonly hoy: string;
  readonly desde: string;
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly roles: readonly RolConsumo[];
  readonly insights: readonly InsightConsumo[];
}

const TONO_INSIGHT: Readonly<Record<InsightConsumo["severidad"], CalloutTone>> = { alta: "danger", atencion: "warning", info: "info" };

/** Micro-USD a "US$0.0012": un rol que gasta centavos por dia no puede verse como "US$0.00". */
const usdMicro = (micro: number): string => `US$${(micro / 1_000_000).toFixed(4)}`;

function BloqueInsights({ consumo }: { readonly consumo: RespuestaConsumoIa }) {
  if (!consumo.disponible) {
    return (
      <Callout tone="warning" titulo="Corte por rol no disponible en esta base">
        No disponible aún: {consumo.mensaje ?? "falta aplicar la migración 0047."} Las alertas por organización sí se muestran.
      </Callout>
    );
  }
  return null;
}

const COLUMNAS: readonly DataTableColumna<RolConsumo>[] = [
  { id: "rol", encabezado: "Rol / agente", principal: true, valorOrden: (r) => r.role, celda: (r) => <span className="font-medium text-foreground">{r.role}</span> },
  { id: "costo", encabezado: "Gasto hoy", alinear: "right", valorOrden: (r) => r.hoy.costMicroUsd, celda: (r) => usdMicro(r.hoy.costMicroUsd) },
  { id: "llamadas", encabezado: "Llamadas hoy", alinear: "right", valorOrden: (r) => r.hoy.callCount, celda: (r) => fmtEntero(r.hoy.callCount) },
  {
    id: "techo",
    encabezado: "Techo diario (turnos por organización)",
    valorOrden: (r) => r.techoTurnosDia,
    celda: (r) =>
      r.techoTurnosDia === null || r.pctTecho === null ? (
        <StatusBadge tone="warning">sin techo</StatusBadge>
      ) : (
        <div className="grid min-w-[140px] gap-1">
          <BarraProgreso valor={r.pctTecho} tono={r.pctTecho >= 100 ? "danger" : r.pctTecho >= 80 ? "warning" : "primary"} aria-label={`Uso del techo de ${r.role}`} />
          <span className="text-xs text-muted-foreground">
            {fmtEntero(r.maxTurnosOrganizacionHoy)} de {fmtEntero(r.techoTurnosDia)} · {fmtPct(r.pctTecho)}
          </span>
        </div>
      ),
  },
  {
    id: "fallback",
    encabezado: "Con respaldo (30 d)",
    alinear: "right",
    valorOrden: (r) => (r.ventana.callCount > 0 ? r.ventana.fallbackCallCount / r.ventana.callCount : null),
    celda: (r) => (r.ventana.callCount > 0 ? fmtPct(Math.round((r.ventana.fallbackCallCount / r.ventana.callCount) * 1000) / 10) : "—"),
  },
];

export function SuperAdminConsumoIaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const dep = [apiBaseUrl, token] as const;
  const { carga: consumo, recargar: recargarConsumo } = useCarga<RespuestaConsumoIa>(() => fetchJson<RespuestaConsumoIa>(apiBaseUrl, token, "/superadmin/gasto-api/consumo-ia"), dep, "No se pudo cargar el consumo por rol.");
  const { carga: resumen, recargar: recargarResumen } = useCarga<ConsolaResumen>(() => fetchConsolaResumen(apiBaseUrl, token), dep, "No se pudo cargar el costo diario.");

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader titulo="Consumo de IA" descripcion="Cuánto gasta cada rol y agente hoy contra su techo, el costo diario y las alertas que piden atención. Cifras reales de los modelos; lo que no tiene dato se muestra como «—»." />

      {consumo.estado === "cargando" && <EstadoCargando etiqueta="Cargando consumo por rol…" />}
      {consumo.estado === "error" && <EstadoError mensaje={`No se pudo cargar: ${consumo.mensaje}`} onReintentar={recargarConsumo} />}
      {consumo.estado === "ok" && (
        <>
          <BloqueInsights consumo={consumo.data} />
          {consumo.data.insights.length > 0 && (
            <section aria-label="Alertas de consumo de IA" className="grid gap-2.5">
              {consumo.data.insights.map((i) => (
                <Callout key={`${i.codigo}|${i.role ?? ""}|${i.organizationId ?? ""}`} tone={TONO_INSIGHT[i.severidad]} titulo={i.titulo}>
                  {i.detalle}
                </Callout>
              ))}
            </section>
          )}
        </>
      )}

      <ChartCard titulo="Costo de IA por día" subtitulo="US$ · últimos 14 días" tamano="S">
        {resumen.estado === "cargando" && <p className="text-xs text-muted-foreground">Cargando costo…</p>}
        {resumen.estado === "error" && <EstadoError compacto mensaje={`No se pudo cargar: ${resumen.mensaje}`} onReintentar={recargarResumen} />}
        {resumen.estado === "ok" &&
          (resumen.data.gastoIa.valor?.serie14d.valor ? (
            <AreaChartSimple datos={resumen.data.gastoIa.valor.serie14d.valor.map((p) => ({ dia: p.dia, valor: p.usd }))} etiquetaValor={usdResumen} />
          ) : (
            <p className="text-xs text-muted-foreground">{resumen.data.gastoIa.valor?.serie14d.razon ?? resumen.data.gastoIa.razon ?? "Sin dato de costo diario."}</p>
          ))}
      </ChartCard>

      {consumo.estado === "ok" && consumo.data.disponible && (
        <ChartCard titulo="Gasto de hoy por rol / agente" subtitulo={`${consumo.data.hoy} · techo = tope diario de turnos por organización (el del sistema; los topes propios no se suman aquí)`} tamano="S">
          <DataTable
            etiqueta="Gasto de hoy por rol o agente"
            columnas={COLUMNAS}
            filas={consumo.data.roles}
            obtenerId={(r) => r.role}
            paginacion={{ tamano: 15 }}
            vacio={{ titulo: "Sin consumo", mensaje: "Ningún rol ha registrado llamadas al modelo en los últimos 30 días." }}
          />
        </ChartCard>
      )}

      <SuperAdminGastoApiPage apiBaseUrl={apiBaseUrl} token={token} incrustada />
    </PageContainer>
  );
}
