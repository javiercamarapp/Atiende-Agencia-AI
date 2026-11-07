// Analítica del dueño · pestaña Ratios: indicadores de restaurante con su definición exacta (tooltip y tabla de definiciones). Datos de `analitica_ratios`
// (migración 162) y razones calculadas en `calcularRatios`. Sin dato = «—», nunca 0.
import { useState } from "react";
import { Gauge, MessageSquareReply, Repeat, Wallet } from "lucide-react";
import type { RatiosCalculados } from "@atiende/domain-restaurantes/analitica";
import { ChartCard, DataTable, EstadoVacio, PageContainer, StatCard } from "@atiende/ui";
import { fetchRatios } from "./analitica-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, pesosExactos, porcentaje } from "./formato.ts";
import { CargaCfoVista } from "./piezas.tsx";
import { claveCarga } from "./piezas-b.tsx";
import { SelectorSucursalAnalitica, TODAS } from "./piezas-analitica.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export const segundos = (s: number | null): string => {
  if (s === null || !Number.isFinite(s)) return SIN_DATO;
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.round((s / 60) * 10) / 10} min`;
};
const razon = (n: number | null): string => (n === null ? SIN_DATO : n.toFixed(2));

export function CfoRatios({ api, filtros }: CfoPaginaProps) {
  const { carga, recargando, recargar } = useCargaCfo(() => fetchRatios(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [sel, setSel] = useState<string>(TODAS);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-ratios">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando los ratios…">
        {(v) => {
          const hayTotal = v.filas.some((f) => f.propertyId === null);
          const clave = sel === TODAS ? (hayTotal ? null : (v.filas[0]?.propertyId ?? null)) : sel;
          const f: RatiosCalculados | undefined = v.filas.find((x) => x.propertyId === clave);
          if (!f || (f.pedidos === 0 && f.convChats === 0 && f.vozLlamadas === 0)) {
            return <EstadoVacio icon={Gauge} titulo="Sin actividad en el periodo" mensaje="Cuando haya pedidos y conversaciones verás aquí los ratios de tu restaurante." />;
          }
          const def = (id: string): string => v.definiciones.find((d) => d.id === id)?.definicion ?? "";
          return (
            <>
              <SelectorSucursalAnalitica nombre="analitica-ratios-sucursal" sucursales={v.sucursales} valor={sel} onChange={setSel} hayTotal={hayTotal} />
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="ratios-tarjetas">
                <StatCard icon={Wallet} label="Ticket promedio" value={pesosExactos(f.ticketCentavos)} nota={def("ticket")} />
                <StatCard icon={Repeat} label="Frecuencia" value={razon(f.frecuencia)} nota="Pedidos por cliente en el periodo" />
                <StatCard icon={Gauge} label="Tasa de cancelación" value={porcentaje(f.tasaCancelacionPct)} nota={`${entero(f.cancelados)} cancelados`} />
                <StatCard icon={Gauge} label="Pedidos grandes" value={porcentaje(f.pctGrandes)} nota={`${entero(f.grandes)} de más de $4,000`} />
                <StatCard icon={MessageSquareReply} label="Conversión chat → pedido" value={porcentaje(f.conversionChatPedidoPct)} nota={`${entero(f.convChats)} conversaciones nuevas`} />
                <StatCard icon={MessageSquareReply} label="Primera respuesta (mediana)" value={segundos(f.primeraRespuestaMedianaSeg)} nota={`${porcentaje(f.respondidoEn5minPct)} en 5 min o menos · ${entero(f.respuestasMedidas)} medidas`} />
                <StatCard icon={MessageSquareReply} label="Resuelto por el agente" value={porcentaje(f.resueltoPorAgentePct)} nota={`${porcentaje(f.escaladoPct)} escalado a una persona`} />
                <StatCard icon={Wallet} label="Costo por conversación" value={pesosExactos(f.costoPorConversacionCentavos)} nota={f.costoTotalCentavos === null ? "Sin tipo de cambio o sin costos" : `${pesos(f.costoTotalCentavos)} en total`} />
              </div>
              <ChartCard titulo="Recompra de clientes nuevos" subtitulo="De los clientes nuevos que ya tuvieron tiempo de volver, cuántos volvieron" tamano="M">
                <DataTable<{ readonly id: string; readonly r: RatiosCalculados["recompra14"] }>
                  etiqueta="Recompra a 14, 30 y 60 días"
                  filas={[{ id: "14 días", r: f.recompra14 }, { id: "30 días", r: f.recompra30 }, { id: "60 días", r: f.recompra60 }]}
                  obtenerId={(x) => x.id}
                  paginacion={false}
                  vista="tabla"
                  columnas={[
                    { id: "v", encabezado: "Ventana", principal: true, celda: (x) => x.id },
                    { id: "e", encabezado: "Clientes que podían volver", alinear: "right", className: "tabular-nums", celda: (x) => entero(x.r.elegibles) },
                    { id: "r", encabezado: "Volvieron", alinear: "right", className: "tabular-nums", celda: (x) => entero(x.r.recompraron) },
                    { id: "p", encabezado: "Recompra", alinear: "right", className: "tabular-nums", celda: (x) => porcentaje(x.r.pct) },
                  ]}
                />
                <p className="mt-2 text-xs text-muted-foreground">{def("recompra14")}</p>
              </ChartCard>
              <ChartCard titulo="Definiciones" subtitulo="Cómo se calcula cada ratio" tamano="L">
                <DataTable<(typeof v.definiciones)[number]>
                  etiqueta="Definición exacta de cada ratio"
                  filas={v.definiciones}
                  obtenerId={(d) => d.id}
                  paginacion={false}
                  vista="tabla"
                  columnas={[
                    { id: "n", encabezado: "Ratio", principal: true, celda: (d) => d.etiqueta },
                    { id: "d", encabezado: "Definición", celda: (d) => d.definicion },
                  ]}
                />
              </ChartCard>
            </>
          );
        }}
      </CargaCfoVista>
    </PageContainer>
  );
}
