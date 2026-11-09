// CFO-07 · pestaña Sucursales: ranking, tabla lado a lado con las mismas métricas por sucursal (+ «No asignado» solo con organización completa y
// fila «Total»), atípicos marcados con texto, mini tendencias y selección múltiple que filtra la tabla. «—» = sin dato, nunca 0.
import { useMemo, useState } from "react";
import { Store } from "lucide-react";
import type { Cifra, FilaSucursalApi, OutlierApi, SucursalesVista } from "@atiende/domain-restaurantes/cfo";
import { Callout, Card, Checkbox, ChartCard, DataTable, EstadoVacio, PageContainer, RankingBarras, SparklineConsola, TablaDatosGrafica, etiquetasTraducidas, traductorActivo, useI18n, useT } from "@atiende/ui";
import { restaurantesCfoSucursales } from "@atiende/ui/i18n/restaurantes/cfoSucursales";
import { fetchSucursales } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type MetricaOutlier = OutlierApi["metrica"];
const tr = traductorActivo(restaurantesCfoSucursales);
const ETIQUETA_METRICA: Readonly<Record<MetricaOutlier, string>> = etiquetasTraducidas<MetricaOutlier>(["netaCentavos", "ticket", "cancelacionPct", "descuentoPct"], (m) => `restaurantes.cfoSucursales.metrica.${m}` as const, restaurantesCfoSucursales);

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
      id: "no-asignado", tipo: "no_asignado", nombre: tr("restaurantes.cfoSucursales.noAsignado", { monto: textoCifra(d.noAsignado.costoAgenteCentavos, "centavos") }), pedidos: null, netaCentavos: null, participacion: null, ticket: null, descuento: null, cancelacion: null, entregaProm: null,
      entregaP90: null, costoPedido: null, tendencia: [], atipicas: new Set(),
    });
  }
  filas.push({
    id: "total", tipo: "total", nombre: tr("restaurantes.cfoSucursales.total"), pedidos: d.total.pedidos, netaCentavos: d.total.netaCentavos, participacion: null, ticket: d.total.ticket, descuento: d.total.descuentoPct, cancelacion: d.total.cancelacionPct,
    entregaProm: null, entregaP90: null, costoPedido: null, tendencia: [], atipicas: new Set(),
  });
  return filas;
}

function Atipica({ visible }: { readonly visible: boolean }) {
  const t = useT(restaurantesCfoSucursales);
  return visible ? (
    <span data-testid="celda-atipica" className="ml-1 rounded-full border border-warning/30 bg-warning-tint px-1.5 py-0.5 text-2xs font-medium text-warning">
      {t("restaurantes.cfoSucursales.atipica")}
    </span>
  ) : null;
}

export function CfoSucursales(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoSucursales);
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
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoSucursales.cargando")}>
        {(d) => <Contenido d={d} ocultas={ocultas} onAlternar={alternar} />}
      </CargaCfoVista>
    </PageContainer>
  );
}

function Contenido({ d, ocultas, onAlternar }: { readonly d: SucursalesVista; readonly ocultas: ReadonlySet<string>; readonly onAlternar: (id: string) => void }) {
  const { t, idioma } = useI18n(restaurantesCfoSucursales);
  // `idioma` en las dependencias: los nombres de las filas «No asignado» y «Total» se traducen al construirlas.
  const todas = useMemo(() => filasDe(d), [d, idioma]);
  const visibles = todas.filter((f) => f.tipo !== "sucursal" || !ocultas.has(f.id));
  if (d.tabla.length === 0) {
    return (
      <>
        <AvisosCfo vista={d} />
        <EstadoVacio icon={Store} titulo={t("restaurantes.cfoSucursales.sinSucursales")} mensaje={t("restaurantes.cfoSucursales.sinSucursalesMensaje")} />
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
        <Callout tone="warning" titulo={t("restaurantes.cfoSucursales.fueraDeLoNormal")} data-testid="cfo-outliers">
          <ul className="list-disc space-y-0.5 pl-4">
            {d.outliers.map((o) => (
              <li key={`${o.propertyId}-${o.metrica}`}>
                {t("restaurantes.cfoSucursales.outlier", { nombre: o.nombre, metrica: ETIQUETA_METRICA[o.metrica].toLowerCase(), valor: valorMetrica(o.metrica, o.valor), mediana: valorMetrica(o.metrica, o.mediana) })}
                {o.z !== null ? ` (z = ${Math.round(o.z * 10) / 10})` : ""}.
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <ChartCard titulo={t("restaurantes.cfoSucursales.ranking")} subtitulo={t("restaurantes.cfoSucursales.rankingSub")} tamano="M">
        <RankingBarras filas={ranking} formato={pesos} sinDatos={t("restaurantes.cfoSucursales.sinVentas")} />
        <TablaDatosGrafica titulo={t("restaurantes.cfoSucursales.rankingTabla")} encabezados={[t("restaurantes.cfoSucursales.col.posicion"), t("restaurantes.cfoSucursales.col.sucursal"), t("restaurantes.cfoSucursales.col.neta")]} filas={d.ranking.map((r) => [r.posicion, r.nombre, pesosExactos(r.netaCentavos)])} />
      </ChartCard>

      <Card className="space-y-3 p-3" data-testid="cfo-tabla-sucursales">
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("restaurantes.cfoSucursales.mostrar")}</legend>
          {d.tabla.map((s) => (
            <Checkbox key={s.propertyId} label={s.nombre} checked={!ocultas.has(s.propertyId)} onChange={() => onAlternar(s.propertyId)} data-testid={`mostrar-${s.propertyId}`} />
          ))}
        </fieldset>
        <DataTable<FilaTabla>
          etiqueta={t("restaurantes.cfoSucursales.ladoALado")}
          filas={visibles}
          obtenerId={(f) => f.id}
          paginacion={false}
          vista="tabla"
          atributosFila={(f) => ({ "data-fila": f.id, "data-tipo": f.tipo })}
          vacio={{ titulo: t("restaurantes.cfoSucursales.sinVisibles"), mensaje: t("restaurantes.cfoSucursales.sinVisiblesMensaje") }}
          columnas={[
            { id: "nombre", encabezado: t("restaurantes.cfoSucursales.col.sucursal"), principal: true, celda: (f) => <span className={f.tipo === "total" ? "font-semibold" : undefined}>{f.nombre}</span> },
            { id: "pedidos", encabezado: t("restaurantes.cfoSucursales.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
            { id: "neta", encabezado: t("restaurantes.cfoSucursales.col.neta"), alinear: "right", className: "tabular-nums", celda: (f) => <>{pesos(f.netaCentavos)}<Atipica visible={f.atipicas.has("netaCentavos")} /></> },
            { id: "part", encabezado: t("restaurantes.cfoSucursales.col.participacion"), alinear: "right", className: "tabular-nums", celda: (f) => (f.participacion ? textoCifra(f.participacion, "pct") : SIN_DATO) },
            { id: "ticket", encabezado: t("restaurantes.cfoSucursales.col.ticket"), alinear: "right", className: "tabular-nums", celda: (f) => <>{f.ticket ? textoCifra(f.ticket, "centavos") : SIN_DATO}<Atipica visible={f.atipicas.has("ticket")} /></> },
            { id: "desc", encabezado: t("restaurantes.cfoSucursales.col.descuento"), alinear: "right", className: "tabular-nums", celda: (f) => <>{f.descuento ? textoCifra(f.descuento, "pct") : SIN_DATO}<Atipica visible={f.atipicas.has("descuentoPct")} /></> },
            { id: "canc", encabezado: t("restaurantes.cfoSucursales.col.cancelacion"), alinear: "right", className: "tabular-nums", celda: (f) => <>{f.cancelacion ? textoCifra(f.cancelacion, "pct") : SIN_DATO}<Atipica visible={f.atipicas.has("cancelacionPct")} /></> },
            { id: "entrega", encabezado: t("restaurantes.cfoSucursales.col.entregaProm"), alinear: "right", className: "tabular-nums", celda: (f) => (f.entregaProm ? minutos(f.entregaProm.valor) : SIN_DATO) },
            { id: "p90", encabezado: t("restaurantes.cfoSucursales.col.entregaP90"), alinear: "right", className: "tabular-nums", celda: (f) => (f.entregaP90 ? minutos(f.entregaP90.valor) : SIN_DATO) },
            {
              id: "costo",
              encabezado: t("restaurantes.cfoSucursales.col.costoAgente"),
              alinear: "right",
              className: "tabular-nums",
              celda: (f) => (f.costoPedido ? <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.costoPedido, "centavos")}<ChipDeCifra cifra={f.costoPedido} /></span> : SIN_DATO),
            },
            {
              id: "tendencia",
              encabezado: t("restaurantes.cfoSucursales.col.tendencia"),
              ocultarEnTarjeta: true,
              celda: (f) =>
                f.tendencia.length > 1 ? (
                  <span className="block w-20" role="img" aria-label={t("restaurantes.cfoSucursales.tendenciaAria", { nombre: f.nombre, n: f.tendencia.length })}>
                    <SparklineConsola valores={f.tendencia} />
                  </span>
                ) : (
                  SIN_DATO
                ),
            },
          ]}
        />
        <p className="text-xs text-muted-foreground" data-testid="leyenda-total">
          {t(d.noAsignado ? "restaurantes.cfoSucursales.totalConNoAsignado" : "restaurantes.cfoSucursales.totalSuma")}
          {t("restaurantes.cfoSucursales.guion")}
          {ocultas.size > 0 ? t("restaurantes.cfoSucursales.ocultas") : ""}
        </p>
      </Card>
    </>
  );
}

function valorMetrica(m: MetricaOutlier, v: number): string {
  return m === "cancelacionPct" || m === "descuentoPct" ? porcentaje(v) : pesos(v);
}
