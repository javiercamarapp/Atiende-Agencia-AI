// CFO-08 · pestaña Patrones: estacionalidad semanal y mensual, días pico, colonias (k ≥ 5: lo demás es «(otras)»), canal × hora y días entre pedidos.
// Privacidad: las colonias con menos de 5 pedidos o 5 clientes ya llegan agrupadas en «(otras)»; la pantalla las agrupa de nuevo si alguna llegara chica.
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import type { ColoniaApi, PatronesVista } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Callout, ChartCard, DataTable, EstadoVacio, Heatmap, PageContainer, RankingBarras, StatCard, TablaDatosGrafica } from "@atiende/ui";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { fetchPatrones } from "./cfo-client.ts";
import { enlaceDeAccion, type CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, etiquetaMes, etiquetaSource, minutos, pesos, pesosExactos, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { DIAS_CORTOS, claveCarga } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export const K_COLONIAS = 5;
export const NOMBRE_OTRAS = "(otras)";
const UMBRAL_PICO = 1.2;

/** Agrupa en «(otras)» (por sucursal) toda colonia con menos de k pedidos. Defensa en profundidad: la base ya lo hace. */
export function agruparColoniasChicas(colonias: readonly ColoniaApi[], k = K_COLONIAS): ColoniaApi[] {
  const grandes: ColoniaApi[] = [];
  const otras = new Map<string, ColoniaApi>();
  for (const c of colonias) {
    if (c.colonia !== NOMBRE_OTRAS && c.pedidos >= k) {
      grandes.push(c);
      continue;
    }
    const a = otras.get(c.propertyId);
    const pedidos = (a?.pedidos ?? 0) + c.pedidos;
    const neta = (a?.netaCentavos ?? 0) + c.netaCentavos;
    // El tiempo de entrega de lo agrupado es el promedio ponderado por pedidos (si alguna parte no lo trae, no se inventa).
    const prev = a?.entregaPromedioMin.valor;
    const entrega = c.entregaPromedioMin.valor;
    const valorEntrega = a === undefined ? entrega : prev != null && entrega != null ? Math.round(((prev * a.pedidos + entrega * c.pedidos) / pedidos) * 10) / 10 : null;
    otras.set(c.propertyId, {
      propertyId: c.propertyId, colonia: NOMBRE_OTRAS, pedidos, netaCentavos: neta,
      ticket: { valor: pedidos > 0 ? Math.round(neta / pedidos) : null, confianza: "medido", fuente: "cfo_colonias" },
      entregaPromedioMin: { valor: valorEntrega, confianza: valorEntrega === null ? "sin_dato" : "medido", fuente: "cfo_colonias" },
      sucursalCercanaId: null, distanciaKm: null,
    });
  }
  return [...grandes, ...otras.values()];
}

function Semanal({ d }: { readonly d: PatronesVista }) {
  const filas = d.estacionalidadSemanal;
  const conDato = filas.filter((f) => f.promedioDiaCentavos !== null);
  const media = conDato.length > 0 ? conDato.reduce((s, f) => s + (f.promedioDiaCentavos ?? 0), 0) / conDato.length : 0;
  const picos = conDato.filter((f) => media > 0 && (f.promedioDiaCentavos ?? 0) >= media * UMBRAL_PICO);
  return (
    <ChartCard titulo="Venta por día de la semana" subtitulo="Promedio de ventas netas de cada día (día de negocio)" tamano="M">
      <BarChartSimple datos={filas.map((f) => ({ dia: DIAS_CORTOS[f.dow - 1] ?? f.etiqueta, valor: f.promedioDiaCentavos ?? 0 }))} etiquetaValor={pesos} sinDatos="Sin ventas en este periodo" />
      {picos.length > 0 && (
        <p className="mt-2 text-xs" data-testid="dias-pico">
          <span className="font-medium">Días pico: </span>
          {picos.map((p) => p.etiqueta).join(", ")} (venta {Math.round((UMBRAL_PICO - 1) * 100)} % o más por encima del promedio de la semana).
        </p>
      )}
      <TablaDatosGrafica
        titulo="Venta por día de la semana"
        encabezados={["Día", "Pedidos", "Ventas netas", "Promedio por día"]}
        filas={filas.map((f) => [f.etiqueta, entero(f.pedidos), pesosExactos(f.netaCentavos), pesosExactos(f.promedioDiaCentavos)])}
      />
    </ChartCard>
  );
}

function Mensual({ d }: { readonly d: PatronesVista }) {
  const filas = d.estacionalidadMensual;
  return (
    <ChartCard titulo="Venta por mes" subtitulo="Ventas netas de cada mes; un mes incompleto trae menos días" tamano="M">
      <BarChartSimple datos={filas.map((m) => ({ dia: etiquetaMes(m.mes).slice(0, 3), valor: m.netaCentavos }))} etiquetaValor={pesos} sinDatos="Sin ventas en este periodo" />
      <TablaDatosGrafica titulo="Venta por mes" encabezados={["Mes", "Días del periodo", "Pedidos", "Ventas netas"]} filas={filas.map((m) => [etiquetaMes(m.mes), entero(m.dias), entero(m.pedidos), pesosExactos(m.netaCentavos)])} />
    </ChartCard>
  );
}

function Colonias({ d }: { readonly d: PatronesVista }) {
  const nombres = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const filas = useMemo(() => agruparColoniasChicas(d.colonias).sort((a, b) => b.pedidos - a.pedidos || (a.colonia < b.colonia ? -1 : 1)), [d.colonias]);
  const { ranking, otras, totalPedidos } = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of filas) m.set(c.colonia, (m.get(c.colonia) ?? 0) + c.pedidos);
    const otras = m.get(NOMBRE_OTRAS) ?? 0;
    m.delete(NOMBRE_OTRAS);
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
    // «(otras)» siempre cierra el ranking: es lo que protege la privacidad y tiene que verse.
    const lista = [...top, ...(otras > 0 ? ([[NOMBRE_OTRAS, otras]] as Array<[string, number]>) : [])];
    return { ranking: lista.map(([colonia, pedidos]) => ({ id: colonia, etiqueta: colonia, valor: pedidos })), otras, totalPedidos: filas.reduce((s, c) => s + c.pedidos, 0) };
  }, [filas]);
  return (
    <ChartCard titulo="Colonias" subtitulo="Pedidos a domicilio por colonia, con la sucursal de despacho más cercana" tamano="L">
      <Callout tone="info" className="mb-2" data-testid="colonias-privacidad" icon={<ShieldCheck className="size-4" aria-hidden="true" />}>
        Por privacidad, las colonias con menos de {K_COLONIAS} pedidos o {K_COLONIAS} clientes se agrupan en «{NOMBRE_OTRAS}». Nunca se muestran direcciones.
      </Callout>
      {filas.length === 0 ? (
        <p role="status" className="py-6 text-center text-xs text-faint">
          Sin pedidos a domicilio por colonia en este periodo.
        </p>
      ) : (
        <>
          <RankingBarras filas={ranking} formato={entero} sinDatos="Sin pedidos a domicilio en este periodo" />
          {otras > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="colonias-otras">
              «{NOMBRE_OTRAS}» junta {entero(otras)} pedidos ({totalPedidos > 0 ? `${Math.round((otras / totalPedidos) * 100)} %` : SIN_DATO} de los domicilios) de colonias con muy pocos pedidos.
            </p>
          )}
          <div className="mt-3">
            <DataTable<ColoniaApi>
              etiqueta="Colonias con pedidos a domicilio"
              filas={filas}
              obtenerId={(f) => `${f.propertyId}-${f.colonia}`}
              paginacion={{ tamano: 10 }}
              vista="tabla"
              atributosFila={(f) => ({ "data-colonia": f.colonia })}
              columnas={[
                { id: "c", encabezado: "Colonia", principal: true, celda: (f) => f.colonia },
                { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                { id: "t", encabezado: "Ticket", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.ticket, "centavos") },
                { id: "e", encabezado: "Entrega prom.", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.entregaPromedioMin.valor) },
                {
                  id: "d",
                  encabezado: "Despacho más cercano",
                  celda: (f) => (f.sucursalCercanaId === null ? SIN_DATO : `${nombres.get(f.sucursalCercanaId) ?? "Otra sucursal"}${f.distanciaKm === null ? "" : ` · ${f.distanciaKm.toFixed(1)} km`}`),
                },
              ]}
            />
          </div>
        </>
      )}
    </ChartCard>
  );
}

function CanalPorHora({ d }: { readonly d: PatronesVista }) {
  const fuentes = [...new Set(d.canalPorHora.map((c) => c.source))].sort();
  const celdas: CeldaHeatmapUi[] = d.canalPorHora.map((c) => ({ fila: fuentes.indexOf(c.source), columna: c.hora, valor: c.pedidos }));
  return (
    <ChartCard titulo="Canal por hora" subtitulo="Pedidos de WhatsApp y de voz en cada hora del día" tamano="M">
      <Heatmap celdas={celdas} filas={Math.max(1, fuentes.length)} etiquetasFilas={fuentes.map(etiquetaSource)} formato={entero} metrica="pedidos" sinDatos="Sin pedidos por canal en este periodo" />
      <TablaDatosGrafica
        titulo="Pedidos por canal y hora"
        encabezados={["Canal", "Hora", "Pedidos", "Ventas netas"]}
        filas={[...d.canalPorHora].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.hora - b.hora)).map((c) => [etiquetaSource(c.source), `${c.hora} h`, entero(c.pedidos), pesosExactos(c.netaCentavos)])}
      />
    </ChartCard>
  );
}

export function CfoPatrones(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchPatrones(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const promos = enlaceDeAccion("/cfo/platillos", props.base, filtros, props.pestanasDisponibles);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-patrones">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando los patrones…">
        {(d) =>
          d.estacionalidadSemanal.every((f) => f.pedidos === 0) && d.colonias.length === 0 && d.canalPorHora.length === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={ShieldCheck} titulo="Sin patrones todavía" mensaje="No hay pedidos en el periodo elegido. Cuando los haya verás aquí qué días, horas y colonias pesan más." />
            </>
          ) : (
            <>
              <AvisosCfo vista={d} />
              <div className="grid gap-2.5 lg:grid-cols-2">
                <Semanal d={d} />
                <Mensual d={d} />
              </div>
              {promos && (
                <p className="text-xs text-muted-foreground" data-testid="patrones-promos">
                  ¿Un pico viene de una promoción?{" "}
                  <Link to={promos} className="font-medium text-primary underline-offset-4 hover:underline">
                    Revisa el efecto de las promociones por platillo
                  </Link>
                  .
                </p>
              )}
              <Colonias d={d} />
              <CanalPorHora d={d} />
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="patrones-frecuencia">
                <StatCard
                  icon={ShieldCheck}
                  label="Días entre pedidos (mediana)"
                  value={d.diasEntrePedidos.valor === null ? SIN_DATO : `${entero(d.diasEntrePedidos.valor)} días`}
                  nota="La mitad de los clientes vuelve a pedir antes de este plazo"
                  {...(d.diasEntrePedidos.valor === null ? { sinDato: "Aún no hay clientes con dos pedidos para medirlo." } : {})}
                />
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Cifra del conjunto de tus clientes <ChipDeCifra cifra={d.diasEntrePedidos} mostrarMedido />. La distribución completa (histograma) aún no la entrega el servicio del CFO: aquí va la mediana.
              </p>
            </>
          )
        }
      </CargaCfoVista>
    </PageContainer>
  );
}
