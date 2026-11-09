// CFO-07 · pestaña Ventas: tendencia con comparativa, canales, heatmap hora × día, cascada bruta → neta sin IVA, forma de pago, propinas y
// cancelaciones. Cada pieza lleva su drill-down a la lista de pedidos (sin PII) y su tabla «Ver datos». Cifras `null` = «—», nunca 0.
import { Ban, ClipboardList, HandCoins } from "lucide-react";
import type { CascadaVentas, FiltroPedidosDetalle, VentasColumna, VentasVista } from "@atiende/domain-restaurantes/cfo";
import {
  AreaChartSimple,
  BarrasAgrupadas,
  Button,
  Callout,
  Cascada,
  ChartCard,
  DataTable,
  Dona,
  Heatmap,
  PageContainer,
  RankingBarras,
  StatCard,
  TablaDatosGrafica,
  traductorActivo,
  useT,
} from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import { restaurantesCfoVentas } from "@atiende/ui/i18n/restaurantes/cfoVentas";
import type { CeldaHeatmapUi, PasoCascada } from "@atiende/ui";
import { fetchVentas } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { granularidadAuto } from "./filtros-url.ts";
import { SIN_DATO, entero, etiquetaCanal, etiquetaFormaPago, etiquetaSource, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { DIAS_CORTOS } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const tr = traductorActivo(restaurantesCfoVentas);

export function pasosCascada(c: CascadaVentas): PasoCascada[] {
  return [
    { etiqueta: tr("restaurantes.cfoVentas.bruta"), valor: c.brutaCentavos.valor, tipo: "total" },
    { etiqueta: tr("restaurantes.cfoVentas.descPromo"), valor: c.descuentoPromocionCentavos.valor, tipo: "resta" },
    { etiqueta: tr("restaurantes.cfoVentas.compensaciones"), valor: c.compensacionesCentavos.valor, tipo: "resta" },
    { etiqueta: tr("restaurantes.cfoVentas.netaConIva"), valor: c.netaCentavos.valor, tipo: "total" },
    { etiqueta: tr("restaurantes.cfoVentas.ivaEstimado"), valor: c.ivaEstimadoCentavos.valor, tipo: "resta" },
    { etiqueta: tr("restaurantes.cfoVentas.netaSinIva"), valor: c.netaSinIvaCentavos.valor, tipo: "total" },
  ];
}

function BotonPedidos({ etiqueta, onClick, ariaLabel }: { readonly etiqueta: string; readonly onClick: () => void; readonly ariaLabel?: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onClick} aria-label={ariaLabel ?? etiqueta}>
      <ClipboardList className="size-3.5" aria-hidden="true" />
      {etiqueta}
    </Button>
  );
}

function Tendencia({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfoVentas);
  const serie = d.ventas.total.serie;
  const datos = serie.map((p) => ({ dia: p.desde, valor: p.netaCentavos }));
  const comparativa = d.serieComparativo ? d.serieComparativo.map((p, i) => ({ dia: serie[i]?.desde ?? p.desde, valor: p.netaCentavos })) : undefined;
  return (
    <ChartCard titulo={t("restaurantes.cfoVentas.tendencia")} subtitulo={t(comparativa ? "restaurantes.cfoVentas.conComparativa" : "restaurantes.cfoVentas.sinComparativa")} tamano="L" accion={<BotonPedidos etiqueta={t("restaurantes.cfoVentas.verPedidos")} ariaLabel={t("restaurantes.cfoVentas.verPedidosPeriodo")} onClick={() => abrir({})} />}>
      <AreaChartSimple datos={datos} etiquetaValor={pesos} {...(comparativa ? { comparativa } : {})} sinDatos={t("restaurantes.cfoVentas.sinVentas")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoVentas.porPeriodo")}
        encabezados={[t("restaurantes.cfoVentas.col.periodo"), t("restaurantes.cfoVentas.col.pedidos"), t("restaurantes.cfoVentas.bruta"), t("restaurantes.cfoVentas.col.neta"), t("restaurantes.cfoVentas.col.ticket")]}
        filas={serie.map((p) => [p.clave, entero(p.pedidos), pesosExactos(p.brutaCentavos), pesosExactos(p.netaCentavos), pesosExactos(p.ticketCentavos)])}
      />
    </ChartCard>
  );
}

function Canales({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfoVentas);
  const filas = d.porCanal.map((c) => ({ id: `${c.canal}-${c.source}`, etiqueta: `${etiquetaCanal(c.canal)} · ${etiquetaSource(c.source)}`, valor: c.netaCentavos, participacionPct: c.mixVentasPct, canal: c.canal, source: c.source }));
  return (
    <ChartCard titulo={t("restaurantes.cfoVentas.canalOrigen")} subtitulo={t("restaurantes.cfoVentas.canalOrigenSub")} tamano="M">
      <RankingBarras filas={filas} formato={pesos} sinDatos={t("restaurantes.cfoVentas.sinVentasCanal")} />
      {filas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {filas.map((f) => (
            <BotonPedidos key={f.id} etiqueta={f.etiqueta} ariaLabel={t("restaurantes.cfoVentas.verPedidosDe", { etiqueta: f.etiqueta })} onClick={() => abrir({ canal: f.canal, source: f.source })} />
          ))}
        </div>
      )}
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoVentas.canalOrigen")}
        encabezados={[t("restaurantes.cfoVentas.col.canalOrigen"), t("restaurantes.cfoVentas.col.pedidos"), t("restaurantes.cfoVentas.col.neta"), t("restaurantes.cfoVentas.col.pctPedidos"), t("restaurantes.cfoVentas.col.pctVentas")]}
        filas={d.porCanal.map((c) => [`${etiquetaCanal(c.canal)} · ${etiquetaSource(c.source)}`, entero(c.pedidos), pesosExactos(c.netaCentavos), porcentaje(c.mixPedidosPct), porcentaje(c.mixVentasPct)])}
      />
    </ChartCard>
  );
}

function MapaCalor({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfo, restaurantesCfoVentas);
  const celdas: CeldaHeatmapUi[] = d.heatmap.map((c) => ({ fila: c.dow - 1, columna: c.hora, valor: c.netaCentavos }));
  const pico = d.heatmap.reduce<(typeof d.heatmap)[number] | null>((m, c) => (m === null || c.netaCentavos > m.netaCentavos ? c : m), null);
  return (
    <ChartCard
      titulo={t("restaurantes.cfoVentas.diaHora")}
      subtitulo={t("restaurantes.cfoVentas.diaHoraSub")}
      tamano="M"
      accion={pico ? <BotonPedidos etiqueta={t("restaurantes.cfoVentas.verHoraPico")} ariaLabel={t("restaurantes.cfoVentas.verHoraPicoAria", { dia: String(DIAS_CORTOS[pico.dow - 1]), hora: pico.hora })} onClick={() => abrir({ dow_negocio: pico.dow, hora_local: pico.hora })} /> : undefined}
    >
      <Heatmap celdas={celdas} formato={pesos} metrica="ventas" sinDatos={t("restaurantes.cfoVentas.sinVentasHora")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoVentas.diaHora")}
        encabezados={[t("restaurantes.cfoVentas.col.dia"), t("restaurantes.cfoVentas.col.hora"), t("restaurantes.cfoVentas.col.pedidos"), t("restaurantes.cfoVentas.col.neta")]}
        filas={[...d.heatmap].sort((a, b) => a.dow - b.dow || a.hora - b.hora).map((c) => [DIAS_CORTOS[c.dow - 1] ?? String(c.dow), t("restaurantes.cfoVentas.hora", { hora: c.hora }), entero(c.pedidos), pesosExactos(c.netaCentavos)])}
      />
    </ChartCard>
  );
}

function CascadaCard({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfoVentas);
  const c = d.ventas.total.cascada;
  const pasos = pasosCascada(c);
  const noMedidas = ([[t("restaurantes.cfoVentas.descuentos"), c.descuentoPromocionCentavos], [t("restaurantes.cfoVentas.compensaciones"), c.compensacionesCentavos], [t("restaurantes.cfoVentas.ivaEstimado"), c.ivaEstimadoCentavos], [t("restaurantes.cfoVentas.ventasSinIva"), c.netaSinIvaCentavos]] as const).filter(([, x]) => x.confianza !== "medido");
  return (
    <ChartCard
      titulo={t("restaurantes.cfoVentas.cascadaTitulo")}
      subtitulo={t("restaurantes.cfoVentas.cascadaSub")}
      tamano="M"
      accion={
        <div className="flex">
          <BotonPedidos etiqueta={t("restaurantes.cfoVentas.conDescuento")} ariaLabel={t("restaurantes.cfoVentas.conDescuentoAria")} onClick={() => abrir({ con_descuento: true })} />
          <BotonPedidos etiqueta={t("restaurantes.cfoVentas.compensaciones")} ariaLabel={t("restaurantes.cfoVentas.compensacionesAria")} onClick={() => abrir({ es_compensacion: true })} />
        </div>
      }
    >
      {c.descuadreCentavos !== 0 && (
        <Callout tone="danger" titulo={t("restaurantes.cfoVentas.noCuadra")} className="mb-2" data-testid="cascada-descuadre">
          {t("restaurantes.cfoVentas.noCuadraMensaje", { monto: pesosExactos(c.descuadreCentavos) })}
        </Callout>
      )}
      <Cascada pasos={pasos} formato={pesos} sinDatos={t("restaurantes.cfoVentas.sinVentas")} />
      {noMedidas.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
          {t("restaurantes.cfoVentas.confianzaDerivadas")}
          {noMedidas.map(([nombre, x]) => (
            <span key={nombre} className="inline-flex items-center gap-1" data-testid="cascada-confianza">
              {nombre}:
              <ChipDeCifra cifra={x} />
            </span>
          ))}
        </p>
      )}
      {pasos.some((p) => p.valor !== null) && (
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoVentas.cascada")}
        encabezados={[t("restaurantes.cfoVentas.col.concepto"), t("restaurantes.cfoVentas.col.monto"), t("restaurantes.cfoVentas.col.confianza")]}
        filas={[
          [t("restaurantes.cfoVentas.bruta"), pesosExactos(c.brutaCentavos.valor), c.brutaCentavos.confianza],
          [t("restaurantes.cfoVentas.descPromo"), pesosExactos(c.descuentoPromocionCentavos.valor), c.descuentoPromocionCentavos.confianza],
          [t("restaurantes.cfoVentas.compensaciones"), pesosExactos(c.compensacionesCentavos.valor), c.compensacionesCentavos.confianza],
          [t("restaurantes.cfoVentas.netaConIva"), pesosExactos(c.netaCentavos.valor), c.netaCentavos.confianza],
          [t("restaurantes.cfoVentas.ivaEstimado"), pesosExactos(c.ivaEstimadoCentavos.valor), c.ivaEstimadoCentavos.confianza],
          [t("restaurantes.cfoVentas.netaSinIva"), pesosExactos(c.netaSinIvaCentavos.valor), c.netaSinIvaCentavos.confianza],
        ]}
      />
      )}
    </ChartCard>
  );
}

function FormaPago({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfoVentas);
  const filas = d.formaPago;
  return (
    <ChartCard titulo={t("restaurantes.cfoVentas.formaPago")} subtitulo={t("restaurantes.cfoVentas.formaPagoSub")} tamano="M">
      <Dona segmentos={filas.map((f) => ({ etiqueta: etiquetaFormaPago(f.formaPago), valor: f.netaCentavos }))} sinDatos={t("restaurantes.cfoVentas.sinVentas")} />
      {filas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {filas
            .filter((f) => f.formaPago !== "sin_dato")
            .map((f) => (
              <BotonPedidos key={f.formaPago} etiqueta={etiquetaFormaPago(f.formaPago)} ariaLabel={t("restaurantes.cfoVentas.pagadosCon", { forma: etiquetaFormaPago(f.formaPago).toLowerCase() })} onClick={() => abrir({ payment_method: f.formaPago })} />
            ))}
        </div>
      )}
      <TablaDatosGrafica titulo={t("restaurantes.cfoVentas.formaPago")} encabezados={[t("restaurantes.cfoVentas.formaPago"), t("restaurantes.cfoVentas.col.pedidos"), t("restaurantes.cfoVentas.col.neta")]} filas={filas.map((f) => [etiquetaFormaPago(f.formaPago), entero(f.pedidos), pesosExactos(f.netaCentavos)])} />
    </ChartCard>
  );
}

function PropinasYCancelaciones({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const t = useT(restaurantesCfoVentas);
  const p = d.propinas;
  const c = d.cancelaciones;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="ventas-estadisticas">
      <StatCard icon={HandCoins} label={t("restaurantes.cfoVentas.propinas")} value={pesos(p.tarjetaCentavos.valor)} nota={p.nota || t("restaurantes.cfoVentas.notaPropina")} {...(p.tarjetaCentavos.valor === null ? { sinDato: t("restaurantes.cfoVentas.sinPropinas") } : {})} />
      <StatCard icon={Ban} label={t("restaurantes.cfoVentas.cancelados")} value={entero(c.cancelados)} nota={c.cancelacionPct.valor === null && c.cancelados === 0 ? t("restaurantes.cfoVentas.sinCancelaciones") : t("restaurantes.cfoVentas.canceladosNota", { monto: pesosExactos(c.canceladosCentavos), pct: textoCifra(c.cancelacionPct, "pct") })} />
      <StatCard icon={Ban} label={t("restaurantes.cfoVentas.noRecogidos")} value={entero(c.noRecogidos)} nota={pesosExactos(c.noRecogidosCentavos)} />
      <div className="flex flex-wrap items-center gap-1 sm:col-span-2 xl:col-span-3">
        <BotonPedidos etiqueta={t("restaurantes.cfoVentas.verCancelados")} onClick={() => abrir({ status: "cancelado" })} />
        <BotonPedidos etiqueta={t("restaurantes.cfoVentas.verNoRecogidos")} onClick={() => abrir({ status: "no_recogido" })} />
      </div>
    </div>
  );
}

function PorSucursal({ d }: { readonly d: VentasVista }) {
  const t = useT(restaurantesCfo, restaurantesCfoVentas);
  const cols = d.ventas.porSucursal;
  type Fila = { readonly id: string; readonly etiqueta: string; readonly valor: (c: VentasColumna) => string };
  const filas: Fila[] = [
    { id: "pedidos", etiqueta: t("restaurantes.cfoVentas.col.pedidos"), valor: (c) => entero(c.sumas.pedidos) },
    { id: "bruta", etiqueta: t("restaurantes.cfoVentas.bruta"), valor: (c) => pesos(c.cascada.brutaCentavos.valor) },
    { id: "desc", etiqueta: t("restaurantes.cfoVentas.descPromo"), valor: (c) => pesos(c.cascada.descuentoPromocionCentavos.valor) },
    { id: "comp", etiqueta: t("restaurantes.cfoVentas.compensaciones"), valor: (c) => pesos(c.cascada.compensacionesCentavos.valor) },
    { id: "neta", etiqueta: t("restaurantes.cfoVentas.netaConIva"), valor: (c) => pesos(c.cascada.netaCentavos.valor) },
    { id: "iva", etiqueta: t("restaurantes.cfoVentas.ivaEstimado"), valor: (c) => pesos(c.cascada.ivaEstimadoCentavos.valor) },
    { id: "sin_iva", etiqueta: t("restaurantes.cfoVentas.netaSinIva"), valor: (c) => pesos(c.cascada.netaSinIvaCentavos.valor) },
    { id: "canc", etiqueta: t("restaurantes.cfoVentas.cancelacion"), valor: (c) => textoCifra(c.cancelacionPct, "pct") },
    { id: "cortesias", etiqueta: t("restaurantes.cfoVentas.cortesias"), valor: (c) => pesos(c.cortesias.valor) },
  ];
  return (
    <>
      <ChartCard titulo={t("restaurantes.cfoVentas.porSucursal")} subtitulo={t("restaurantes.cfoVentas.porSucursalSub")} tamano="M">
        <BarrasAgrupadas
          series={[
            { id: "neta", etiqueta: t("restaurantes.cfoVentas.col.neta") },
            { id: "bruta", etiqueta: t("restaurantes.cfoVentas.bruta") },
          ]}
          grupos={cols.map((s) => ({ etiqueta: s.nombre, valores: { neta: s.cascada.netaCentavos.valor, bruta: s.cascada.brutaCentavos.valor } }))}
          formato={pesos}
          sinDatos={t("restaurantes.cfoVentas.sinVentasSucursal")}
        />
      </ChartCard>
      <ChartCard titulo={t("restaurantes.cfoVentas.cascadaSucursal")} tamano="S">
        <DataTable<Fila>
          etiqueta={t("restaurantes.cfoVentas.cascadaSucursalTabla")}
          filas={filas}
          obtenerId={(f) => f.id}
          paginacion={false}
          vista="tabla"
          columnas={[
            { id: "concepto", encabezado: t("restaurantes.cfoVentas.col.concepto"), principal: true, celda: (f) => f.etiqueta },
            ...cols.map((s) => ({ id: s.propertyId, encabezado: s.nombre, alinear: "right" as const, className: "tabular-nums", celda: (f: Fila) => f.valor(s) })),
            { id: "total", encabezado: t("restaurantes.cfo.filtros.total"), alinear: "right" as const, className: "tabular-nums font-medium", celda: (f: Fila) => f.valor(d.ventas.total) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">{t("restaurantes.cfoVentas.sinDatoNoCero", { sinDato: SIN_DATO })}</p>
      </ChartCard>
    </>
  );
}

export function CfoVentas(props: CfoPaginaProps) {
  const { api, filtros, abrirPedidos } = props;
  const t = useT(restaurantesCfoVentas);
  const clave = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchVentas(api, filtros, granularidadAuto(filtros)), [clave, api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-ventas">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoVentas.cargando")}>
        {(d) => (
          <>
            <AvisosCfo vista={d} />
            <p className="text-xs text-muted-foreground" data-testid="ventas-titular">
              {d.titular.etiqueta}: <strong className="font-semibold text-foreground tabular-nums">{pesos(d.titular.cifra.valor)}</strong> <ChipDeCifra cifra={d.titular.cifra} mostrarMedido={d.titular.origen === "softrestaurant"} />
            </p>
            <Tendencia d={d} abrir={abrirPedidos} />
            {props.filtros.vista === "sucursal" && <PorSucursal d={d} />}
            <div className="grid gap-2.5 lg:grid-cols-2">
              <Canales d={d} abrir={abrirPedidos} />
              <FormaPago d={d} abrir={abrirPedidos} />
            </div>
            <MapaCalor d={d} abrir={abrirPedidos} />
            <CascadaCard d={d} abrir={abrirPedidos} />
            <PropinasYCancelaciones d={d} abrir={abrirPedidos} />
            {props.filtros.vista === "sucursal" && <p className="text-xs text-muted-foreground">{t("restaurantes.cfoVentas.sumanTodas")}</p>}

          </>
        )}
      </CargaCfoVista>
    </PageContainer>
  );
}
