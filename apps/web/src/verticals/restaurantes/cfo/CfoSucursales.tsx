// CFO-07 · pestaña Sucursales: ranking, tabla lado a lado con las mismas métricas por sucursal (+ «No asignado» solo con organización completa y
// fila «Total»), atípicos marcados con texto, mini tendencias y selección múltiple que filtra la tabla. «—» = sin dato, nunca 0.
import { useMemo, useState } from "react";
import { Store } from "lucide-react";
import type { Cifra, FilaSucursalApi, OutlierApi, SucursalesVista } from "@atiende/domain-restaurantes/cfo";
import { Callout, Card, Checkbox, ChartCard, DataTable, EstadoVacio, PageContainer, RankingBarras, SparklineConsola, TablaDatosGrafica } from "@atiende/ui";
import { fetchSucursales } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type MetricaOutlier = OutlierApi["metrica"];
const ETIQUETA_METRICA: Readonly<Record<MetricaOutlier, string>> = { netaCentavos: "Ventas netas", ticket: "Ticket", cancelacionPct: "Cancelación", descuentoPct: "Descuento" };

interface FilaTabla {
  readonly id: string;
  readonly tipo: "sucursal" | "no_asignado" | "total";
  readonly nombre: string;
  readonly pedidos: number | null;
  readonly netaCentavos: number | null;
  readonly participacion: Cifra | null;
  readonly ticket: Cifra | null;
  readonly descuento: Cifra | null;
  readonly cancelacion: Cifra | null;
  readonly entregaProm: Cifra | null;
  readonly entregaP90: Cifra | null;
  readonly costoPedido: Cifra | null;
  readonly tendencia: readonly number[];
  readonly atipicas: ReadonlySet<MetricaOutlier>;
}

function filasDe(d: SucursalesVista): FilaTabla[] {
  const atipicasDe = (id: string): ReadonlySet<MetricaOutlier> => new Set(d.outliers.filter((o) => o.propertyId === id).map((o) => o.metrica));
  const filas: FilaTabla[] = d.tabla.map((s: FilaSucursalApi) => ({
    id: s.propertyId, tipo: "sucursal", nombre: s.nombre, pedidos: s.pedidos, netaCentavos: s.netaCentavos, participacion: s.participacionPct, ticket: s.ticket, descuento: s.descuentoPct,
    cancelacion: s.cancelacionPct, entregaProm: s.entregaPromedioMin, entregaP90: s.entregaP90Min, costoPedido: s.costoPorPedidoAgente, tendencia: s.miniTendencia, atipicas: atipicasDe(s.propertyId),
  }));
  if (d.noAsignado) {
    filas.push({
      id: "no-asignado", tipo: "no_asignado", nombre: `No asignado (costo del agente de la organización: ${textoCifra(d.noAsignado.costoAgenteCentavos, "centavos")})`, pedidos: null, netaCentavos: null, participacion: null, ticket: null, descuento: null, cancelacion: null, entregaProm: null,
      entregaP90: null, costoPedido: null, tendencia: [], atipicas: new Set(),
    });
  }
  filas.push({
    id: "total", tipo: "total", nombre: "Total", pedidos: d.total.pedidos, netaCentavos: d.total.netaCentavos, participacion: null, ticket: d.total.ticket, descuento: d.total.descuentoPct, cancelacion: d.total.cancelacionPct,
    entregaProm: null, entregaP90: null, costoPedido: null, tendencia: [], atipicas: new Set(),
  });
  return filas;
}

function Atipica({ visible }: { readonly visible: boolean }) {
  return visible ? (
    <span data-testid="celda-atipica" className="ml-1 rounded-full border border-warning/30 bg-warning-tint px-1.5 py-0.5 text-2xs font-medium text-warning">
      Atípica
    </span>
  ) : null;
}

export function CfoSucursales(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const clave = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchSucursales(api, filtros), [clave, api.propertyId, api.token]);
  // Ocultas = ids que la persona quitó de la tabla (por defecto se ven todas). Solo filtra la vista; el Total siempre es el del alcance.
  const [ocultas, setOcultas] = useState<ReadonlySet<string>>(new Set());
  const alternar = (id: string) =>
    setOcultas((prev) => {
      const sig = new Set(prev);
      if (sig.has(id)) sig.delete(id);
      else sig.add(id);
      return sig;
    });

  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-sucursales">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando las sucursales…">
        {(d) => <Contenido d={d} ocultas={ocultas} onAlternar={alternar} />}
      </CargaCfoVista>
    </PageContainer>
  );
}

function Contenido({ d, ocultas, onAlternar }: { readonly d: SucursalesVista; readonly ocultas: ReadonlySet<string>; readonly onAlternar: (id: string) => void }) {
  const todas = useMemo(() => filasDe(d), [d]);
  const visibles = todas.filter((f) => f.tipo !== "sucursal" || !ocultas.has(f.id));
  if (d.tabla.length === 0) {
    return (
      <>
        <AvisosCfo vista={d} />
        <EstadoVacio icon={Store} titulo="Sin sucursales en esta selección" mensaje="No hay sucursales con datos para el rango elegido." />
      </>
    );
  }
  const ranking = d.ranking.map((r) => {
    const fila = d.tabla.find((t) => t.propertyId === r.propertyId);
    return { id: r.propertyId, etiqueta: r.nombre, valor: r.netaCentavos, posicion: r.posicion, participacionPct: fila?.participacionPct.valor ?? null, outlier: d.outliers.some((o) => o.propertyId === r.propertyId && o.metrica === "netaCentavos") };
  });
  return (
    <>
      <AvisosCfo vista={d} />
      {d.outliers.length > 0 && (
        <Callout tone="warning" titulo="Sucursales fuera de lo normal" data-testid="cfo-outliers">
          <ul className="list-disc space-y-0.5 pl-4">
            {d.outliers.map((o) => (
              <li key={`${o.propertyId}-${o.metrica}`}>
                {o.nombre}: {ETIQUETA_METRICA[o.metrica].toLowerCase()} {valorMetrica(o.metrica, o.valor)} contra una mediana de {valorMetrica(o.metrica, o.mediana)}
                {o.z !== null ? ` (z = ${Math.round(o.z * 10) / 10})` : ""}.
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <ChartCard titulo="Ranking de ventas netas" subtitulo="De mayor a menor, con su participación en el total" tamano="M">
        <RankingBarras filas={ranking} formato={pesos} sinDatos="Sin ventas en este periodo" />
        <TablaDatosGrafica titulo="Ranking de sucursales" encabezados={["Posición", "Sucursal", "Ventas netas"]} filas={d.ranking.map((r) => [r.posicion, r.nombre, pesosExactos(r.netaCentavos)])} />
      </ChartCard>

      <Card className="space-y-3 p-3" data-testid="cfo-tabla-sucursales">
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Mostrar en la tabla</legend>
          {d.tabla.map((s) => (
            <Checkbox key={s.propertyId} label={s.nombre} checked={!ocultas.has(s.propertyId)} onChange={() => onAlternar(s.propertyId)} data-testid={`mostrar-${s.propertyId}`} />
          ))}
        </fieldset>
        <DataTable<FilaTabla>
          etiqueta="Sucursales lado a lado"
          filas={visibles}
          obtenerId={(f) => f.id}
          paginacion={false}
          vista="tabla"
          atributosFila={(f) => ({ "data-fila": f.id, "data-tipo": f.tipo })}
          vacio={{ titulo: "Sin sucursales visibles", mensaje: "Marca al menos una sucursal para verla en la tabla." }}
          columnas={[
            { id: "nombre", encabezado: "Sucursal", principal: true, celda: (f) => <span className={f.tipo === "total" ? "font-semibold" : undefined}>{f.nombre}</span> },
            { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
            { id: "neta", encabezado: "Ventas netas", alinear: "right", className: "tabular-nums", celda: (f) => <>{pesos(f.netaCentavos)}<Atipica visible={f.atipicas.has("netaCentavos")} /></> },
            { id: "part", encabezado: "Participación", alinear: "right", className: "tabular-nums", celda: (f) => (f.participacion ? textoCifra(f.participacion, "pct") : SIN_DATO) },
            { id: "ticket", encabezado: "Ticket", alinear: "right", className: "tabular-nums", celda: (f) => <>{f.ticket ? textoCifra(f.ticket, "centavos") : SIN_DATO}<Atipica visible={f.atipicas.has("ticket")} /></> },
            { id: "desc", encabezado: "Descuento", alinear: "right", className: "tabular-nums", celda: (f) => <>{f.descuento ? textoCifra(f.descuento, "pct") : SIN_DATO}<Atipica visible={f.atipicas.has("descuentoPct")} /></> },
            { id: "canc", encabezado: "Cancelación", alinear: "right", className: "tabular-nums", celda: (f) => <>{f.cancelacion ? textoCifra(f.cancelacion, "pct") : SIN_DATO}<Atipica visible={f.atipicas.has("cancelacionPct")} /></> },
            { id: "entrega", encabezado: "Entrega prom.", alinear: "right", className: "tabular-nums", celda: (f) => (f.entregaProm ? minutos(f.entregaProm.valor) : SIN_DATO) },
            { id: "p90", encabezado: "Entrega p90", alinear: "right", className: "tabular-nums", celda: (f) => (f.entregaP90 ? minutos(f.entregaP90.valor) : SIN_DATO) },
            {
              id: "costo",
              encabezado: "Costo agente / pedido",
              alinear: "right",
              className: "tabular-nums",
              celda: (f) => (f.costoPedido ? <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.costoPedido, "centavos")}<ChipDeCifra cifra={f.costoPedido} /></span> : SIN_DATO),
            },
            {
              id: "tendencia",
              encabezado: "Tendencia",
              ocultarEnTarjeta: true,
              celda: (f) =>
                f.tendencia.length > 1 ? (
                  <span className="block w-20" role="img" aria-label={`Tendencia de ventas de ${f.nombre}: ${f.tendencia.length} puntos`}>
                    <SparklineConsola valores={f.tendencia} />
                  </span>
                ) : (
                  SIN_DATO
                ),
            },
          ]}
        />
        <p className="text-xs text-muted-foreground" data-testid="leyenda-total">
          {d.noAsignado ? "Total = suma de sucursales + no asignado." : "Total = suma de las sucursales del alcance."} Un guion (—) significa sin dato, no cero.
          {ocultas.size > 0 ? " La fila Total incluye todas las sucursales aunque algunas estén ocultas en la tabla." : ""}
        </p>
      </Card>
    </>
  );
}

function valorMetrica(m: MetricaOutlier, v: number): string {
  return m === "cancelacionPct" || m === "descuentoPct" ? porcentaje(v) : pesos(v);
}
