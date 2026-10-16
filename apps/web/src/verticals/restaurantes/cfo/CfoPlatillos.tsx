// CFO-08 · pestaña Platillos: más y menos vendidos (unidades o ingreso), mix por categoría, ranking por sucursal, matriz popularidad × ingreso, canasta
// (pares con soporte y lift), ticket por número de productos, efecto de promociones (estimado) y agotados de hoy con su venta en riesgo.
// Sin margen por platillo hasta capturar su costo (fase 2). Cifras `null` = «—».
import { useMemo, useState } from "react";
import { PackageX } from "lucide-react";
import { agotadoAhora } from "@atiende/domain-restaurantes/cfo";
import type { ProductosVista, PuntoMatriz, RankingProductoApi } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Callout, ChartCard, DataTable, Dona, EstadoVacio, PageContainer, RadioSegmentado, StatCard, TablaDatosGrafica } from "@atiende/ui";
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
  return (
    <DataTable<RankingProductoApi>
      etiqueta={etiqueta}
      filas={filas}
      obtenerId={(f) => f.productoRef}
      paginacion={false}
      vista="tabla"
      vacio={{ mensaje: "Sin ventas de platillos en este periodo." }}
      columnas={[
        { id: "n", encabezado: "Platillo", principal: true, celda: (f) => f.nombre },
        { id: "u", encabezado: "Unidades", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.unidades) },
        { id: "i", encabezado: "Ingreso", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ingresoCentavos) },
        { id: "p", encabezado: "% del ingreso", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.participacionIngresoPct) },
      ]}
    />
  );
}

function Rankings({ d }: { readonly d: ProductosVista }) {
  const [metrica, setMetrica] = useState<Metrica>("unidades");
  const { top, bottom } = useMemo(() => rankingsDe(d.matriz, metrica), [d.matriz, metrica]);
  return (
    <ChartCard
      titulo="Más y menos vendidos"
      subtitulo={`Los ${TOPE} de arriba y de abajo, por ${metrica === "unidades" ? "unidades" : "ingreso"}`}
      tamano="M"
      accion={
        <RadioSegmentado<Metrica>
          name="cfo-platillos-metrica"
          label="Ordenar por"
          opciones={[
            { id: "unidades", rotulo: "Unidades" },
            { id: "ingreso", rotulo: "Ingreso" },
          ]}
          value={metrica}
          onChange={setMetrica}
          className="gap-1"
        />
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <div data-testid="ranking-top">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Más vendidos</h4>
          <TablaRanking etiqueta="Platillos más vendidos" filas={top} />
        </div>
        <div data-testid="ranking-bottom">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Menos vendidos</h4>
          <TablaRanking etiqueta="Platillos menos vendidos" filas={bottom} />
        </div>
      </div>
      <TablaDatosGrafica
        titulo="Platillos por unidades e ingreso"
        encabezados={["Platillo", "Unidades", "Ingreso"]}
        filas={[...d.matriz].sort((a, b) => b.unidades - a.unidades).map((p) => [p.nombre, entero(p.unidades), pesosExactos(p.ingresoCentavos)])}
      />
    </ChartCard>
  );
}

function Categorias({ d }: { readonly d: ProductosVista }) {
  return (
    <ChartCard titulo="Mix por categoría" subtitulo="Participación en el ingreso de cada categoría del menú" tamano="M">
      <Dona segmentos={d.mixCategoria.map((c) => ({ etiqueta: c.categoria, valor: c.ingresoCentavos }))} sinDatos="Sin ventas por categoría en este periodo" />
      <TablaDatosGrafica
        titulo="Mix por categoría"
        encabezados={["Categoría", "Unidades", "Ingreso", "% del ingreso"]}
        filas={d.mixCategoria.map((c) => [c.categoria, entero(c.unidades), pesosExactos(c.ingresoCentavos), porcentaje(c.participacionPct)])}
      />
    </ChartCard>
  );
}

function PorSucursal({ d }: { readonly d: ProductosVista }) {
  return (
    <ChartCard titulo="Ranking por sucursal" subtitulo="Los más vendidos de cada sucursal, por unidades" tamano="S">
      <div className="space-y-3" data-testid="platillos-por-sucursal">
        {d.ranking.porSucursal.map((s) => (
          <div key={s.propertyId}>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{s.nombre}</h4>
            <TablaRanking etiqueta={`Más vendidos de ${s.nombre}`} filas={s.masVendidos.slice(0, 5)} />
          </div>
        ))}
        {d.ranking.porSucursal.length === 0 && <p className="text-xs text-faint">Sin sucursales en esta selección.</p>}
      </div>
    </ChartCard>
  );
}

function Matriz({ d }: { readonly d: ProductosVista }) {
  const cuenta = (c: PuntoMatriz["cuadrante"]) => d.matriz.filter((p) => p.cuadrante === c).length;
  return (
    <ChartCard titulo="Popularidad × ingreso" subtitulo="Estrella, Caballo, Puzzle y Perro, sin margen hasta capturar costo por platillo" tamano="L">
      <MatrizDispersion puntos={d.matriz} formatoIngreso={pesos} formatoUnidades={entero} />
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-testid="matriz-conteo">
        {(["estrella", "popular", "rentable", "revisar"] as const).map((c) => (
          <span key={c}>
            {ETIQUETA_CUADRANTE[c]}: {entero(cuenta(c))}
          </span>
        ))}
      </p>
      <TablaDatosGrafica
        titulo="Matriz popularidad por ingreso"
        encabezados={["Platillo", "Unidades", "Ingreso", "Cuadrante"]}
        filas={d.matriz.map((p) => [p.nombre, entero(p.unidades), pesosExactos(p.ingresoCentavos), ETIQUETA_CUADRANTE[p.cuadrante]])}
      />
    </ChartCard>
  );
}

function Canasta({ d }: { readonly d: ProductosVista }) {
  const nombreSucursal = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const pares = [...d.canasta].sort((a, b) => b.pedidosJuntos - a.pedidosJuntos).slice(0, 10);
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      <ChartCard titulo="Canasta: lo que se pide junto" subtitulo="Pares más frecuentes por sucursal, con soporte y lift" tamano="M">
        <DataTable<(typeof pares)[number]>
          etiqueta="Pares de platillos más frecuentes"
          filas={pares}
          obtenerId={(f) => `${f.propertyId}-${f.productoA}-${f.productoB}`}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: "Sin pedidos con dos o más platillos en este periodo." }}
          columnas={[
            { id: "par", encabezado: "Par", principal: true, celda: (f) => `${f.nombreA} + ${f.nombreB}` },
            { id: "suc", encabezado: "Sucursal", celda: (f) => nombreSucursal.get(f.propertyId) ?? SIN_DATO },
            { id: "j", encabezado: "Pedidos juntos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidosJuntos) },
            { id: "s", encabezado: "Soporte", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.soportePct) },
            { id: "l", encabezado: "Lift", alinear: "right", className: "tabular-nums", celda: (f) => (f.lift === null ? SIN_DATO : f.lift.toFixed(2)) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">Soporte = % de los pedidos de la sucursal que llevan los dos. Lift mayor que 1 = se piden juntos más de lo esperado; «—» = sin base para calcularlo.</p>
      </ChartCard>
      <ChartCard titulo="Ticket por número de productos" subtitulo="Cuánto vale un pedido según cuántos platillos distintos lleva" tamano="M">
        <BarChartSimple datos={d.ticketPorNumeroProductos.map((t) => ({ dia: t.nProductos >= 5 ? "5 o más" : `${t.nProductos}`, valor: t.ticketCentavos ?? 0 }))} etiquetaValor={pesos} sinDatos="Sin pedidos en este periodo" />
        <TablaDatosGrafica
          titulo="Ticket por número de productos"
          encabezados={["Productos distintos", "Pedidos", "Ticket"]}
          filas={d.ticketPorNumeroProductos.map((t) => [t.nProductos >= 5 ? "5 o más" : t.nProductos, entero(t.pedidos), pesosExactos(t.ticketCentavos)])}
        />
      </ChartCard>
    </div>
  );
}

function Promociones({ d }: { readonly d: ProductosVista }) {
  return (
    <ChartCard titulo="Efecto de las promociones" subtitulo="Unidades por día en los días con promoción contra los mismos días de la semana sin promoción · estimado" tamano="S">
      <DataTable<(typeof d.efectoPromocion)[number]>
        etiqueta="Efecto de las promociones por platillo"
        filas={d.efectoPromocion}
        obtenerId={(f) => f.productoRef}
        paginacion={false}
        vista="tabla"
        vacio={{ mensaje: "Sin promociones en el periodo para comparar." }}
        columnas={[
          { id: "n", encabezado: "Platillo", principal: true, celda: (f) => f.nombre },
          {
            id: "e",
            encabezado: "Efecto en unidades",
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
      <p className="mt-2 text-2xs text-muted-foreground">Estimado: no prueba que la promoción causó el cambio. «—» = no hubo días comparables con y sin promoción.</p>
    </ChartCard>
  );
}

function Agotados({ d, abrir }: { readonly d: ProductosVista; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  const ahora = Date.now();
  const nombreSucursal = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const hoy = d.agotados.filter((a) => agotadoAhora(a, ahora));
  const riesgo = hoy.reduce((s, a) => s + (a.ventaEnRiesgoPorDia.valor ?? 0), 0);
  return (
    <ChartCard titulo="Agotados hoy" subtitulo="Platillos que el menú del agente ya no ofrece, con la venta que se pierde por día · estimado" tamano="S">
      {hoy.length === 0 ? (
        <EstadoVacio icon={PackageX} titulo="Nada agotado hoy" mensaje="Todos los platillos del menú están disponibles." />
      ) : (
        <>
          <div className="mb-2 grid gap-2.5 sm:grid-cols-2">
            <StatCard icon={PackageX} label="Platillos agotados" value={entero(hoy.length)} nota="En las sucursales de esta vista" />
            <StatCard icon={PackageX} label="Venta en riesgo por día" value={pesos(riesgo)} nota="Estimado con las unidades de las últimas 4 semanas" />
          </div>
          <DataTable<(typeof hoy)[number]>
            etiqueta="Platillos agotados hoy"
            filas={hoy}
            obtenerId={(f) => `${f.propertyId}-${f.productId}`}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "n", encabezado: "Platillo", principal: true, celda: (f) => f.nombre },
              { id: "s", encabezado: "Sucursal", celda: (f) => nombreSucursal.get(f.propertyId) ?? SIN_DATO },
              { id: "h", encabezado: "Vuelve", celda: (f) => (f.agotadoHasta === null ? "Sin fecha de regreso" : diaCorto(f.agotadoHasta)) },
              { id: "r", encabezado: "Lugar en ventas", alinear: "right", className: "tabular-nums", celda: (f) => (f.rankingUnidades === null ? SIN_DATO : `#${f.rankingUnidades}`) },
              { id: "v", encabezado: "Venta en riesgo / día", alinear: "right", className: "tabular-nums", celda: (f) => <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.ventaEnRiesgoPorDia, "centavos")}<ChipDeCifra cifra={f.ventaEnRiesgoPorDia} /></span> },
            ]}
          />
        </>
      )}
      <div className="mt-2">
        <BotonPedidos etiqueta="Ver pedidos del periodo" onClick={() => abrir({})} />
      </div>
    </ChartCard>
  );
}

export function CfoPlatillos(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchProductos(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-platillos">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando los platillos…">
        {(d) =>
          d.matriz.length === 0 && d.agotados.length === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={PackageX} titulo="Sin ventas de platillos" mensaje="No hay platillos vendidos en el periodo elegido. Cuando haya pedidos verás aquí qué se vende y qué se pide junto." />
            </>
          ) : (
            <>
              <AvisosCfo vista={d} />
              <Callout tone="neutral" data-testid="platillos-sin-margen">
                Aún no hay margen por platillo: se calculará cuando captures el costo de cada uno. Mientras tanto, la clasificación usa solo unidades e ingreso.
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
