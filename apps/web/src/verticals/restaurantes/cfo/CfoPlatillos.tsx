// CFO-08 · pestaña Platillos: más y menos vendidos (unidades o ingreso), mix por categoría, ranking por sucursal, matriz popularidad × ingreso, canasta
// (pares con soporte y lift), ticket por número de productos, efecto de promociones (estimado) y agotados de hoy con su venta en riesgo.
// Sin margen por platillo hasta capturar su costo (fase 2). Cifras `null` = «—».
import { useMemo, useState } from "react";
import { PackageX } from "lucide-react";
import { agotadoAhora } from "@atiende/domain-restaurantes/cfo";
import type { ProductosVista, PuntoMatriz, RankingProductoApi } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Callout, ChartCard, DataTable, Dona, EstadoVacio, PageContainer, RadioSegmentado, StatCard, TablaDatosGrafica, useT } from "@atiende/ui";
import { restaurantesCfoPlatillos } from "@atiende/ui/i18n/restaurantes/cfoPlatillos";
import { fetchProductos } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { MatrizDispersion, ETIQUETA_CUADRANTE } from "./MatrizDispersion.tsx";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, claveCarga, diaCorto } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type Metrica = "unidades" | "ingreso";
const TOPE = 10;

/** Rankings completos a partir de la matriz (todos los platillos con venta), por unidades o por ingreso. */
export function rankingsDe(matriz: readonly PuntoMatriz[], metrica: Metrica): { readonly top: RankingProductoApi[]; readonly bottom: RankingProductoApi[] } {
  const total = matriz.reduce((s, p) => s + p.ingresoCentavos, 0);
  const valor = (p: PuntoMatriz): number => (metrica === "unidades" ? p.unidades : p.ingresoCentavos);
  const desempate = (a: PuntoMatriz, b: PuntoMatriz): number => (a.productoRef < b.productoRef ? -1 : a.productoRef > b.productoRef ? 1 : 0);
  const fila = (p: PuntoMatriz): RankingProductoApi => ({
    productoRef: p.productoRef, nombre: p.nombre, categoria: "", unidades: p.unidades, ingresoCentavos: p.ingresoCentavos, pedidos: 0,
    participacionIngresoPct: total > 0 ? Math.round((p.ingresoCentavos / total) * 1000) / 10 : null,
  });
  const orden = [...matriz].filter((p) => p.unidades > 0).sort((a, b) => valor(b) - valor(a) || desempate(a, b));
  return { top: orden.slice(0, TOPE).map(fila), bottom: [...orden].reverse().slice(0, TOPE).map(fila) };
}

function TablaRanking({ etiqueta, filas }: { readonly etiqueta: string; readonly filas: readonly RankingProductoApi[] }) {
  const t = useT(restaurantesCfoPlatillos);
  return (
    <DataTable<RankingProductoApi>
      etiqueta={etiqueta}
      filas={filas}
      obtenerId={(f) => f.productoRef}
      paginacion={false}
      vista="tabla"
      vacio={{ mensaje: t("restaurantes.cfoPlatillos.sinVentasPlatillos") }}
      columnas={[
        { id: "n", encabezado: t("restaurantes.cfoPlatillos.col.platillo"), principal: true, celda: (f) => f.nombre },
        { id: "u", encabezado: t("restaurantes.cfoPlatillos.col.unidades"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.unidades) },
        { id: "i", encabezado: t("restaurantes.cfoPlatillos.col.ingreso"), alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ingresoCentavos) },
        { id: "p", encabezado: t("restaurantes.cfoPlatillos.col.pctIngreso"), alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.participacionIngresoPct) },
      ]}
    />
  );
}

function Rankings({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  const [metrica, setMetrica] = useState<Metrica>("unidades");
  const { top, bottom } = useMemo(() => rankingsDe(d.matriz, metrica), [d.matriz, metrica]);
  return (
    <ChartCard
      titulo={t("restaurantes.cfoPlatillos.masMenos")}
      subtitulo={t("restaurantes.cfoPlatillos.masMenosSub", { tope: TOPE, metrica: t(metrica === "unidades" ? "restaurantes.cfoPlatillos.metricaUnidades" : "restaurantes.cfoPlatillos.metricaIngreso") })}
      tamano="M"
      accion={
        <RadioSegmentado<Metrica>
          name="cfo-platillos-metrica"
          label={t("restaurantes.cfoPlatillos.ordenarPor")}
          opciones={[
            { id: "unidades", rotulo: t("restaurantes.cfoPlatillos.col.unidades") },
            { id: "ingreso", rotulo: t("restaurantes.cfoPlatillos.col.ingreso") },
          ]}
          value={metrica}
          onChange={setMetrica}
          className="gap-1"
        />
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <div data-testid="ranking-top">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{t("restaurantes.cfoPlatillos.masVendidos")}</h4>
          <TablaRanking etiqueta={t("restaurantes.cfoPlatillos.masVendidosTabla")} filas={top} />
        </div>
        <div data-testid="ranking-bottom">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{t("restaurantes.cfoPlatillos.menosVendidos")}</h4>
          <TablaRanking etiqueta={t("restaurantes.cfoPlatillos.menosVendidosTabla")} filas={bottom} />
        </div>
      </div>
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoPlatillos.porUnidadesIngreso")}
        encabezados={[t("restaurantes.cfoPlatillos.col.platillo"), t("restaurantes.cfoPlatillos.col.unidades"), t("restaurantes.cfoPlatillos.col.ingreso")]}
        filas={[...d.matriz].sort((a, b) => b.unidades - a.unidades).map((p) => [p.nombre, entero(p.unidades), pesosExactos(p.ingresoCentavos)])}
      />
    </ChartCard>
  );
}

function Categorias({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  return (
    <ChartCard titulo={t("restaurantes.cfoPlatillos.mixCategoria")} subtitulo={t("restaurantes.cfoPlatillos.mixCategoriaSub")} tamano="M">
      <Dona segmentos={d.mixCategoria.map((c) => ({ etiqueta: c.categoria, valor: c.ingresoCentavos }))} sinDatos={t("restaurantes.cfoPlatillos.sinVentasCategoria")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoPlatillos.mixCategoria")}
        encabezados={[t("restaurantes.cfoPlatillos.col.categoria"), t("restaurantes.cfoPlatillos.col.unidades"), t("restaurantes.cfoPlatillos.col.ingreso"), t("restaurantes.cfoPlatillos.col.pctIngreso")]}
        filas={d.mixCategoria.map((c) => [c.categoria, entero(c.unidades), pesosExactos(c.ingresoCentavos), porcentaje(c.participacionPct)])}
      />
    </ChartCard>
  );
}

function PorSucursal({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  return (
    <ChartCard titulo={t("restaurantes.cfoPlatillos.rankingSucursal")} subtitulo={t("restaurantes.cfoPlatillos.rankingSucursalSub")} tamano="S">
      <div className="space-y-3" data-testid="platillos-por-sucursal">
        {d.ranking.porSucursal.map((s) => (
          <div key={s.propertyId}>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{s.nombre}</h4>
            <TablaRanking etiqueta={t("restaurantes.cfoPlatillos.masVendidosDe", { sucursal: s.nombre })} filas={s.masVendidos.slice(0, 5)} />
          </div>
        ))}
        {d.ranking.porSucursal.length === 0 && <p className="text-xs text-faint">{t("restaurantes.cfoPlatillos.sinSucursales")}</p>}
      </div>
    </ChartCard>
  );
}

function Matriz({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  const cuenta = (c: PuntoMatriz["cuadrante"]) => d.matriz.filter((p) => p.cuadrante === c).length;
  return (
    <ChartCard titulo={t("restaurantes.cfoPlatillos.matriz")} subtitulo={t("restaurantes.cfoPlatillos.matrizSub")} tamano="L">
      <MatrizDispersion puntos={d.matriz} formatoIngreso={pesos} formatoUnidades={entero} />
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-testid="matriz-conteo">
        {(["estrella", "popular", "rentable", "revisar"] as const).map((c) => (
          <span key={c}>
            {ETIQUETA_CUADRANTE[c]}: {entero(cuenta(c))}
          </span>
        ))}
      </p>
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoPlatillos.matrizTabla")}
        encabezados={[t("restaurantes.cfoPlatillos.col.platillo"), t("restaurantes.cfoPlatillos.col.unidades"), t("restaurantes.cfoPlatillos.col.ingreso"), t("restaurantes.cfoPlatillos.col.cuadrante")]}
        filas={d.matriz.map((p) => [p.nombre, entero(p.unidades), pesosExactos(p.ingresoCentavos), ETIQUETA_CUADRANTE[p.cuadrante]])}
      />
    </ChartCard>
  );
}

function Canasta({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  const nombreSucursal = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const pares = [...d.canasta].sort((a, b) => b.pedidosJuntos - a.pedidosJuntos).slice(0, 10);
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      <ChartCard titulo={t("restaurantes.cfoPlatillos.canasta")} subtitulo={t("restaurantes.cfoPlatillos.canastaSub")} tamano="M">
        <DataTable<(typeof pares)[number]>
          etiqueta={t("restaurantes.cfoPlatillos.paresTabla")}
          filas={pares}
          obtenerId={(f) => `${f.propertyId}-${f.productoA}-${f.productoB}`}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: t("restaurantes.cfoPlatillos.sinPares") }}
          columnas={[
            { id: "par", encabezado: t("restaurantes.cfoPlatillos.col.par"), principal: true, celda: (f) => `${f.nombreA} + ${f.nombreB}` },
            { id: "suc", encabezado: t("restaurantes.cfoPlatillos.col.sucursal"), celda: (f) => nombreSucursal.get(f.propertyId) ?? SIN_DATO },
            { id: "j", encabezado: t("restaurantes.cfoPlatillos.col.juntos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidosJuntos) },
            { id: "s", encabezado: t("restaurantes.cfoPlatillos.col.soporte"), alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.soportePct) },
            { id: "l", encabezado: t("restaurantes.cfoPlatillos.col.lift"), alinear: "right", className: "tabular-nums", celda: (f) => (f.lift === null ? SIN_DATO : f.lift.toFixed(2)) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">{t("restaurantes.cfoPlatillos.canastaNota")}</p>
      </ChartCard>
      <ChartCard titulo={t("restaurantes.cfoPlatillos.ticketProductos")} subtitulo={t("restaurantes.cfoPlatillos.ticketProductosSub")} tamano="M">
        <BarChartSimple datos={d.ticketPorNumeroProductos.map((x) => ({ dia: x.nProductos >= 5 ? t("restaurantes.cfoPlatillos.cincoOMas") : `${x.nProductos}`, valor: x.ticketCentavos ?? 0 }))} etiquetaValor={pesos} sinDatos={t("restaurantes.cfoPlatillos.sinPedidos")} />
        <TablaDatosGrafica
          titulo={t("restaurantes.cfoPlatillos.ticketProductos")}
          encabezados={[t("restaurantes.cfoPlatillos.col.productosDistintos"), t("restaurantes.cfoPlatillos.col.pedidos"), t("restaurantes.cfoPlatillos.col.ticket")]}
          filas={d.ticketPorNumeroProductos.map((x) => [x.nProductos >= 5 ? t("restaurantes.cfoPlatillos.cincoOMas") : x.nProductos, entero(x.pedidos), pesosExactos(x.ticketCentavos)])}
        />
      </ChartCard>
    </div>
  );
}

function Promociones({ d }: { readonly d: ProductosVista }) {
  const t = useT(restaurantesCfoPlatillos);
  return (
    <ChartCard titulo={t("restaurantes.cfoPlatillos.promos")} subtitulo={t("restaurantes.cfoPlatillos.promosSub")} tamano="S">
      <DataTable<(typeof d.efectoPromocion)[number]>
        etiqueta={t("restaurantes.cfoPlatillos.promosTabla")}
        filas={d.efectoPromocion}
        obtenerId={(f) => f.productoRef}
        paginacion={false}
        vista="tabla"
        vacio={{ mensaje: t("restaurantes.cfoPlatillos.sinPromos") }}
        columnas={[
          { id: "n", encabezado: t("restaurantes.cfoPlatillos.col.platillo"), principal: true, celda: (f) => f.nombre },
          {
            id: "e",
            encabezado: t("restaurantes.cfoPlatillos.col.efecto"),
            alinear: "right",
            className: "tabular-nums",
            celda: (f) => (
              <span className="inline-flex items-center justify-end gap-1">
                {f.efecto.valor === null ? SIN_DATO : `${f.efecto.valor > 0 ? "+" : f.efecto.valor < 0 ? "−" : ""}${porcentaje(Math.abs(f.efecto.valor))}`}
                <ChipDeCifra cifra={f.efecto} />
              </span>
            ),
          },
        ]}
      />
      <p className="mt-2 text-2xs text-muted-foreground">{t("restaurantes.cfoPlatillos.promosNota")}</p>
    </ChartCard>
  );
}

function Agotados({ d, abrir }: { readonly d: ProductosVista; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  const t = useT(restaurantesCfoPlatillos);
  const ahora = Date.now();
  const nombreSucursal = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const hoy = d.agotados.filter((a) => agotadoAhora(a, ahora));
  const riesgo = hoy.reduce((s, a) => s + (a.ventaEnRiesgoPorDia.valor ?? 0), 0);
  return (
    <ChartCard titulo={t("restaurantes.cfoPlatillos.agotados")} subtitulo={t("restaurantes.cfoPlatillos.agotadosSub")} tamano="S">
      {hoy.length === 0 ? (
        <EstadoVacio icon={PackageX} titulo={t("restaurantes.cfoPlatillos.nadaAgotado")} mensaje={t("restaurantes.cfoPlatillos.nadaAgotadoMensaje")} />
      ) : (
        <>
          <div className="mb-2 grid gap-2.5 sm:grid-cols-2">
            <StatCard icon={PackageX} label={t("restaurantes.cfoPlatillos.platillosAgotados")} value={entero(hoy.length)} nota={t("restaurantes.cfoPlatillos.enSucursalesVista")} />
            <StatCard icon={PackageX} label={t("restaurantes.cfoPlatillos.ventaRiesgo")} value={pesos(riesgo)} nota={t("restaurantes.cfoPlatillos.ventaRiesgoNota")} />
          </div>
          <DataTable<(typeof hoy)[number]>
            etiqueta={t("restaurantes.cfoPlatillos.agotadosTabla")}
            filas={hoy}
            obtenerId={(f) => `${f.propertyId}-${f.productId}`}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "n", encabezado: t("restaurantes.cfoPlatillos.col.platillo"), principal: true, celda: (f) => f.nombre },
              { id: "s", encabezado: t("restaurantes.cfoPlatillos.col.sucursal"), celda: (f) => nombreSucursal.get(f.propertyId) ?? SIN_DATO },
              { id: "h", encabezado: t("restaurantes.cfoPlatillos.col.vuelve"), celda: (f) => (f.agotadoHasta === null ? t("restaurantes.cfoPlatillos.sinFechaRegreso") : diaCorto(f.agotadoHasta)) },
              { id: "r", encabezado: t("restaurantes.cfoPlatillos.col.lugar"), alinear: "right", className: "tabular-nums", celda: (f) => (f.rankingUnidades === null ? SIN_DATO : `#${f.rankingUnidades}`) },
              { id: "v", encabezado: t("restaurantes.cfoPlatillos.col.riesgoDia"), alinear: "right", className: "tabular-nums", celda: (f) => <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.ventaEnRiesgoPorDia, "centavos")}<ChipDeCifra cifra={f.ventaEnRiesgoPorDia} /></span> },
            ]}
          />
        </>
      )}
      <div className="mt-2">
        <BotonPedidos etiqueta={t("restaurantes.cfoPlatillos.verPedidosPeriodo")} onClick={() => abrir({})} />
      </div>
    </ChartCard>
  );
}

export function CfoPlatillos(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoPlatillos);
  const { carga, recargando, recargar } = useCargaCfo(() => fetchProductos(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-platillos">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoPlatillos.cargando")}>
        {(d) =>
          d.matriz.length === 0 && d.agotados.length === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={PackageX} titulo={t("restaurantes.cfoPlatillos.sinVentasTitulo")} mensaje={t("restaurantes.cfoPlatillos.sinVentasMensaje")} />
            </>
          ) : (
            <>
              <AvisosCfo vista={d} />
              <Callout tone="neutral" data-testid="platillos-sin-margen">
                {t("restaurantes.cfoPlatillos.sinMargen")}

              </Callout>
              <Rankings d={d} />
              <div className="grid gap-2.5 lg:grid-cols-2">
                <Categorias d={d} />
                <Matriz d={d} />
              </div>
              {props.filtros.vista === "sucursal" && <PorSucursal d={d} />}
              <Canasta d={d} />
              <Promociones d={d} />
              <Agotados d={d} abrir={props.abrirPedidos} />
            </>
          )
        }
      </CargaCfoVista>
    </PageContainer>
  );
}
