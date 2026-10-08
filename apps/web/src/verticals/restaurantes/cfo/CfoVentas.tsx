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
} from "@atiende/ui";
import type { CeldaHeatmapUi, PasoCascada } from "@atiende/ui";
import { fetchVentas } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { granularidadAuto } from "./filtros-url.ts";
import { SIN_DATO, entero, etiquetaCanal, etiquetaFormaPago, etiquetaSource, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const DIAS_ES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;
const NOTA_PROPINA = "Solo con tarjeta; la propina en efectivo no se registra.";

export function pasosCascada(c: CascadaVentas): PasoCascada[] {
  return [
    { etiqueta: "Ventas brutas", valor: c.brutaCentavos.valor, tipo: "total" },
    { etiqueta: "Descuentos de promoción", valor: c.descuentoPromocionCentavos.valor, tipo: "resta" },
    { etiqueta: "Compensaciones", valor: c.compensacionesCentavos.valor, tipo: "resta" },
    { etiqueta: "Ventas netas (con IVA)", valor: c.netaCentavos.valor, tipo: "total" },
    { etiqueta: "IVA estimado", valor: c.ivaEstimadoCentavos.valor, tipo: "resta" },
    { etiqueta: "Ventas netas sin IVA", valor: c.netaSinIvaCentavos.valor, tipo: "total" },
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
  const serie = d.ventas.total.serie;
  const datos = serie.map((p) => ({ dia: p.desde, valor: p.netaCentavos }));
  const comparativa = d.serieComparativo ? d.serieComparativo.map((p, i) => ({ dia: serie[i]?.desde ?? p.desde, valor: p.netaCentavos })) : undefined;
  return (
    <ChartCard titulo="Tendencia de ventas netas" subtitulo={comparativa ? "Línea punteada: periodo de comparación" : "Sin periodo de comparación para esta selección"} tamano="L" accion={<BotonPedidos etiqueta="Ver pedidos" ariaLabel="Ver los pedidos del periodo" onClick={() => abrir({})} />}>
      <AreaChartSimple datos={datos} etiquetaValor={pesos} {...(comparativa ? { comparativa } : {})} sinDatos="Sin ventas en este periodo" />
      <TablaDatosGrafica
        titulo="Ventas por periodo"
        encabezados={["Periodo", "Pedidos", "Ventas brutas", "Ventas netas", "Ticket"]}
        filas={serie.map((p) => [p.clave, entero(p.pedidos), pesosExactos(p.brutaCentavos), pesosExactos(p.netaCentavos), pesosExactos(p.ticketCentavos)])}
      />
    </ChartCard>
  );
}

function Canales({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const filas = d.porCanal.map((c) => ({ id: `${c.canal}-${c.source}`, etiqueta: `${etiquetaCanal(c.canal)} · ${etiquetaSource(c.source)}`, valor: c.netaCentavos, participacionPct: c.mixVentasPct, canal: c.canal, source: c.source }));
  return (
    <ChartCard titulo="Ventas por canal y origen" subtitulo="WhatsApp y voz × domicilio y para recoger" tamano="M">
      <RankingBarras filas={filas} formato={pesos} sinDatos="Sin ventas por canal en este periodo" />
      {filas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {filas.map((f) => (
            <BotonPedidos key={f.id} etiqueta={f.etiqueta} ariaLabel={`Ver pedidos de ${f.etiqueta}`} onClick={() => abrir({ canal: f.canal, source: f.source })} />
          ))}
        </div>
      )}
      <TablaDatosGrafica
        titulo="Ventas por canal y origen"
        encabezados={["Canal y origen", "Pedidos", "Ventas netas", "% de pedidos", "% de ventas"]}
        filas={d.porCanal.map((c) => [`${etiquetaCanal(c.canal)} · ${etiquetaSource(c.source)}`, entero(c.pedidos), pesosExactos(c.netaCentavos), porcentaje(c.mixPedidosPct), porcentaje(c.mixVentasPct)])}
      />
    </ChartCard>
  );
}

function MapaCalor({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const celdas: CeldaHeatmapUi[] = d.heatmap.map((c) => ({ fila: c.dow - 1, columna: c.hora, valor: c.netaCentavos }));
  const pico = d.heatmap.reduce<(typeof d.heatmap)[number] | null>((m, c) => (m === null || c.netaCentavos > m.netaCentavos ? c : m), null);
  return (
    <ChartCard
      titulo="Ventas por día y hora"
      subtitulo="Día de negocio de cada sucursal (el corte puede pasar de medianoche)"
      tamano="M"
      accion={pico ? <BotonPedidos etiqueta="Ver hora pico" ariaLabel={`Ver pedidos de la hora pico: ${DIAS_ES[pico.dow - 1]} a las ${pico.hora} h`} onClick={() => abrir({ dow_negocio: pico.dow, hora_local: pico.hora })} /> : undefined}
    >
      <Heatmap celdas={celdas} formato={pesos} metrica="ventas" sinDatos="Sin ventas por hora en este periodo" />
      <TablaDatosGrafica
        titulo="Ventas por día y hora"
        encabezados={["Día", "Hora", "Pedidos", "Ventas netas"]}
        filas={[...d.heatmap].sort((a, b) => a.dow - b.dow || a.hora - b.hora).map((c) => [DIAS_ES[c.dow - 1] ?? String(c.dow), `${c.hora} h`, entero(c.pedidos), pesosExactos(c.netaCentavos)])}
      />
    </ChartCard>
  );
}

function CascadaCard({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const c = d.ventas.total.cascada;
  const pasos = pasosCascada(c);
  const noMedidas = [c.descuentoPromocionCentavos, c.compensacionesCentavos, c.ivaEstimadoCentavos, c.netaSinIvaCentavos].filter((x) => x.confianza !== "medido");
  return (
    <ChartCard
      titulo="De ventas brutas a netas sin IVA"
      subtitulo="Cada resta sale de la venta bruta del periodo"
      tamano="M"
      accion={
        <div className="flex">
          <BotonPedidos etiqueta="Con descuento" ariaLabel="Ver pedidos con descuento" onClick={() => abrir({ con_descuento: true })} />
          <BotonPedidos etiqueta="Compensaciones" ariaLabel="Ver pedidos de compensación" onClick={() => abrir({ es_compensacion: true })} />
        </div>
      }
    >
      {c.descuadreCentavos !== 0 && (
        <Callout tone="danger" titulo="La cascada no cuadra" className="mb-2" data-testid="cascada-descuadre">
          Bruta − descuentos − neta da {pesosExactos(c.descuadreCentavos)} de diferencia. Revisa los pedidos del periodo antes de usar estas cifras.
        </Callout>
      )}
      <Cascada pasos={pasos} formato={pesos} sinDatos="Sin ventas en este periodo" />
      {noMedidas.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
          Confianza de las cifras derivadas:
          {noMedidas.map((x) => (
            <span key={x.fuente} className="inline-flex items-center gap-1">
              <ChipDeCifra cifra={x} />
            </span>
          ))}
        </p>
      )}
      {pasos.some((p) => p.valor !== null) && (
      <TablaDatosGrafica
        titulo="Cascada de ventas"
        encabezados={["Concepto", "Monto", "Confianza"]}
        filas={[
          ["Ventas brutas", pesosExactos(c.brutaCentavos.valor), c.brutaCentavos.confianza],
          ["Descuentos de promoción", pesosExactos(c.descuentoPromocionCentavos.valor), c.descuentoPromocionCentavos.confianza],
          ["Compensaciones", pesosExactos(c.compensacionesCentavos.valor), c.compensacionesCentavos.confianza],
          ["Ventas netas (con IVA)", pesosExactos(c.netaCentavos.valor), c.netaCentavos.confianza],
          ["IVA estimado", pesosExactos(c.ivaEstimadoCentavos.valor), c.ivaEstimadoCentavos.confianza],
          ["Ventas netas sin IVA", pesosExactos(c.netaSinIvaCentavos.valor), c.netaSinIvaCentavos.confianza],
        ]}
      />
      )}
    </ChartCard>
  );
}

function FormaPago({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const filas = d.formaPago;
  return (
    <ChartCard titulo="Forma de pago" subtitulo="Ventas netas por cómo pagó el cliente" tamano="M">
      <Dona segmentos={filas.map((f) => ({ etiqueta: etiquetaFormaPago(f.formaPago), valor: f.netaCentavos }))} sinDatos="Sin ventas en este periodo" />
      {filas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {filas
            .filter((f) => f.formaPago !== "sin_dato")
            .map((f) => (
              <BotonPedidos key={f.formaPago} etiqueta={etiquetaFormaPago(f.formaPago)} ariaLabel={`Ver pedidos pagados con ${etiquetaFormaPago(f.formaPago).toLowerCase()}`} onClick={() => abrir({ payment_method: f.formaPago })} />
            ))}
        </div>
      )}
      <TablaDatosGrafica titulo="Forma de pago" encabezados={["Forma de pago", "Pedidos", "Ventas netas"]} filas={filas.map((f) => [etiquetaFormaPago(f.formaPago), entero(f.pedidos), pesosExactos(f.netaCentavos)])} />
    </ChartCard>
  );
}

function PropinasYCancelaciones({ d, abrir }: { readonly d: VentasVista; readonly abrir: (f: FiltroPedidosDetalle) => void }) {
  const p = d.propinas;
  const c = d.cancelaciones;
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="ventas-estadisticas">
      <StatCard icon={HandCoins} label="Propinas con tarjeta" value={pesos(p.tarjetaCentavos.valor)} nota={p.nota || NOTA_PROPINA} {...(p.tarjetaCentavos.valor === null ? { sinDato: "Sin propinas con tarjeta registradas en el periodo." } : {})} />
      <StatCard icon={Ban} label="Cancelados" value={entero(c.cancelados)} nota={c.cancelacionPct.valor === null && c.cancelados === 0 ? "Sin cancelaciones en el periodo" : `${pesosExactos(c.canceladosCentavos)} · ${textoCifra(c.cancelacionPct, "pct")} de los pedidos`} />
      <StatCard icon={Ban} label="No recogidos" value={entero(c.noRecogidos)} nota={pesosExactos(c.noRecogidosCentavos)} />
      <div className="flex flex-wrap items-center gap-1 sm:col-span-2 xl:col-span-3">
        <BotonPedidos etiqueta="Ver cancelados" onClick={() => abrir({ status: "cancelado" })} />
        <BotonPedidos etiqueta="Ver no recogidos" onClick={() => abrir({ status: "no_recogido" })} />
      </div>
    </div>
  );
}

function PorSucursal({ d }: { readonly d: VentasVista }) {
  const cols = d.ventas.porSucursal;
  type Fila = { readonly id: string; readonly etiqueta: string; readonly valor: (c: VentasColumna) => string };
  const filas: Fila[] = [
    { id: "pedidos", etiqueta: "Pedidos", valor: (c) => entero(c.sumas.pedidos) },
    { id: "bruta", etiqueta: "Ventas brutas", valor: (c) => pesos(c.cascada.brutaCentavos.valor) },
    { id: "desc", etiqueta: "Descuentos de promoción", valor: (c) => pesos(c.cascada.descuentoPromocionCentavos.valor) },
    { id: "comp", etiqueta: "Compensaciones", valor: (c) => pesos(c.cascada.compensacionesCentavos.valor) },
    { id: "neta", etiqueta: "Ventas netas (con IVA)", valor: (c) => pesos(c.cascada.netaCentavos.valor) },
    { id: "iva", etiqueta: "IVA estimado", valor: (c) => pesos(c.cascada.ivaEstimadoCentavos.valor) },
    { id: "sin_iva", etiqueta: "Ventas netas sin IVA", valor: (c) => pesos(c.cascada.netaSinIvaCentavos.valor) },
    { id: "canc", etiqueta: "Cancelación", valor: (c) => textoCifra(c.cancelacionPct, "pct") },
    { id: "cortesias", etiqueta: "Cortesías (a precio de lista, estimado)", valor: (c) => pesos(c.cortesias.valor) },
  ];
  return (
    <>
      <ChartCard titulo="Ventas por sucursal" subtitulo="Netas y brutas, misma escala" tamano="M">
        <BarrasAgrupadas
          series={[
            { id: "neta", etiqueta: "Ventas netas" },
            { id: "bruta", etiqueta: "Ventas brutas" },
          ]}
          grupos={cols.map((s) => ({ etiqueta: s.nombre, valores: { neta: s.cascada.netaCentavos.valor, bruta: s.cascada.brutaCentavos.valor } }))}
          formato={pesos}
          sinDatos="Sin ventas por sucursal en este periodo"
        />
      </ChartCard>
      <ChartCard titulo="Cascada por sucursal" tamano="S">
        <DataTable<Fila>
          etiqueta="Cascada de ventas por sucursal"
          filas={filas}
          obtenerId={(f) => f.id}
          paginacion={false}
          vista="tabla"
          columnas={[
            { id: "concepto", encabezado: "Concepto", principal: true, celda: (f) => f.etiqueta },
            ...cols.map((s) => ({ id: s.propertyId, encabezado: s.nombre, alinear: "right" as const, className: "tabular-nums", celda: (f: Fila) => f.valor(s) })),
            { id: "total", encabezado: "Total", alinear: "right" as const, className: "tabular-nums font-medium", celda: (f: Fila) => f.valor(d.ventas.total) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">«{SIN_DATO}» en una celda = sin dato (no es cero).</p>
      </ChartCard>
    </>
  );
}

export function CfoVentas(props: CfoPaginaProps) {
  const { api, filtros, abrirPedidos } = props;
  const clave = `${filtros.desde}|${filtros.hasta}|${filtros.sucursales?.join(",") ?? ""}|${filtros.comparar}`;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchVentas(api, filtros, granularidadAuto(filtros)), [clave, api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-ventas">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando las ventas…">
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
            {props.filtros.vista === "sucursal" && <p className="text-xs text-muted-foreground">Canales, forma de pago, mapa de calor y cascada de arriba suman todas las sucursales elegidas; el desglose por sucursal está en las tablas de esta vista.</p>}
          </>
        )}
      </CargaCfoVista>
    </PageContainer>
  );
}
