// Model Ops (SA-L-10): una ficha por rol del gateway de modelos con el modelo y los proveedores configurados, el carril real, las
// llamadas y el costo de 30 dias, la tasa de fallback y el estado del circuit breaker. Backend real: GET /superadmin/model-ops
// (apps/api/src/routes/superadmin-agentes-fichas.ts). SOLO LECTURA: no versiona prompts ni cambia modelos (el modelo de cada rol se
// cambia con LLM_MODELS_JSON y un despliegue de configuracion; ver docs/LLM-GATEWAY.md). Ningun secreto sale del endpoint.
// Un campo `null` se pinta "—" con su razon, nunca 0; el circuit breaker se muestra "no legible" porque este endpoint no lo consulta.
import { Cpu } from "lucide-react";
import { Callout, ChartCard, DataTable, Dona, EstadoCargando, EstadoError, HBars, PageContainer, PageHeader, StatCard } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchModelOps, fmtEntero, fmtPct, fmtUsd } from "../lib/fichas-client.ts";
import type { ModelOps, ModelOpsFicha } from "../lib/fichas-client.ts";
import { useCarga } from "../lib/use-carga.ts";

const guion = (razon: string | undefined) => (
  <span className="text-muted-foreground" title={razon}>
    —
  </span>
);

const COLUMNAS: readonly DataTableColumna<ModelOpsFicha>[] = [
  { id: "rol", encabezado: "Rol", principal: true, valorOrden: (f) => f.role, celda: (f) => <span className="font-medium text-foreground">{f.role}</span> },
  {
    id: "modelo",
    encabezado: "Modelo",
    valorOrden: (f) => f.modelo,
    celda: (f) => (
      <div className="grid gap-0.5">
        <span className="font-mono text-xs">{f.modelo ?? "—"}</span>
        {f.escalera.length > 1 && <span className="text-xs text-faint">respaldo: {f.escalera.slice(1).map((e) => e.modelo).join(" → ")}</span>}
      </div>
    ),
  },
  { id: "proveedores", encabezado: "Proveedores", celda: (f) => (f.proveedores.length > 0 ? <span className="text-xs text-muted-foreground">{f.proveedores.join(", ")}</span> : guion(undefined)) },
  { id: "carril", encabezado: "Carril", celda: (f) => (f.carril.valor && f.carril.valor.length > 0 ? f.carril.valor.join(", ") : guion(f.carril.razon ?? "Sin consumo en 30 días.")) },
  { id: "llamadas", encabezado: "Llamadas 30d", alinear: "right", valorOrden: (f) => f.llamadas30d.valor, celda: (f) => (f.llamadas30d.valor === null ? guion(f.llamadas30d.razon) : fmtEntero(f.llamadas30d.valor)) },
  { id: "costo", encabezado: "Costo 30d", alinear: "right", valorOrden: (f) => f.costo30dUsd.valor, celda: (f) => (f.costo30dUsd.valor === null ? guion(f.costo30dUsd.razon) : fmtUsd(f.costo30dUsd.valor)) },
  { id: "fallback", encabezado: "Fallback", alinear: "right", valorOrden: (f) => f.tasaFallbackPct.valor, celda: (f) => (f.tasaFallbackPct.valor === null ? guion(f.tasaFallbackPct.razon) : fmtPct(f.tasaFallbackPct.valor)) },
  { id: "breaker", encabezado: "Circuit breaker", celda: (f) => <span className="text-xs text-muted-foreground" title={f.circuitBreaker.razon}>no legible</span> },
];

export function SuperAdminModelOpsPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const { carga, recargar } = useCarga<ModelOps>(() => fetchModelOps(apiBaseUrl, token), [apiBaseUrl, token], "No se pudo cargar Model Ops.");
  return (
    <PageContainer>
      <PageHeader titulo="Model Ops" descripcion="Qué modelo y qué proveedores usa cada rol del gateway, cuánto consume y con qué tasa de fallback, en los últimos 30 días." />
      {carga.estado === "cargando" && <EstadoCargando etiqueta="Cargando Model Ops…" />}
      {carga.estado === "error" && <EstadoError mensaje={`No se pudo cargar: ${carga.mensaje}`} onReintentar={recargar} />}
      {carga.estado === "ok" && <Contenido d={carga.data} />}
    </PageContainer>
  );
}

function Contenido({ d }: { readonly d: ModelOps }) {
  const conConsumo = d.fichas.filter((f) => (f.llamadas30d.valor ?? 0) > 0).length;
  return (
    <>
      {!d.disponible && (
        <Callout tone="warning" titulo="Consumo no disponible en esta base">
          {d.mensaje ?? "Falta aplicar la migración 0049_superadmin_fichas_agente."} La configuración de modelos de cada rol sí se muestra: sale del código y de LLM_MODELS_JSON.
        </Callout>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard variante="neutra" icon={Cpu} label="Roles del gateway" value={fmtEntero(d.fichas.length)} nota="configurados en el repo y en LLM_MODELS_JSON" />
        <StatCard
          variante="neutra"
          icon={Cpu}
          label="Roles con consumo"
          value={d.disponible ? fmtEntero(conConsumo) : "—"}
          sinDato={d.disponible ? undefined : (d.mensaje ?? "Sin dato de consumo.")}
          nota={d.disponible ? `desde ${d.desde} hasta ${d.hoy}` : undefined}
        />
      </div>
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        <ChartCard titulo="Costo por agente / rol" subtitulo="últimos 30 días, US$" tamano="S">
          {d.porAgente.valor ? (
            <Dona segmentos={d.porAgente.valor.map((a) => ({ etiqueta: a.role, valor: a.costoUsd }))} sinDatos="Ningún rol registró costo en los últimos 30 días." />
          ) : (
            <p className="text-xs text-muted-foreground">{d.porAgente.razon ?? "Sin dato de costo por agente."}</p>
          )}
        </ChartCard>
        <ChartCard titulo="Costo por modelo" subtitulo="últimos 30 días, US$" tamano="S">
          {d.porModelo.valor ? (
            <HBars datos={d.porModelo.valor.map((m) => ({ etiqueta: m.modelo, valor: m.costoUsd }))} formato="usd" sinDatos="Ningún modelo registró costo en los últimos 30 días." />
          ) : (
            <p className="text-xs text-muted-foreground">{d.porModelo.razon ?? "Sin dato de costo por modelo."}</p>
          )}
        </ChartCard>
      </div>
      <ChartCard titulo="Ficha por rol" subtitulo="modelo, proveedores y consumo de 30 días" tamano="S">
        <DataTable etiqueta="Ficha por rol del gateway" columnas={COLUMNAS} filas={d.fichas} obtenerId={(f) => f.role} paginacion={{ tamano: 15 }} vacio={{ titulo: "Sin roles", mensaje: "El gateway no tiene roles configurados." }} />
      </ChartCard>
      <p className="text-xs text-faint">
        {d.notas.join(" ")} El estado del circuit breaker figura como «no legible»: vive en la memoria de cada instancia (o en Upstash) y este endpoint no lo consulta.
      </p>
    </>
  );
}
