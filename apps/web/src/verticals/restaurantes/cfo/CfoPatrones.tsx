// CFO-08 · pestaña Patrones: estacionalidad semanal y mensual, días pico, colonias (k ≥ 5: lo demás es «(otras)»), canal × hora y días entre pedidos.
// Privacidad: las colonias con menos de 5 pedidos o 5 clientes ya llegan agrupadas en «(otras)»; la pantalla las agrupa de nuevo si alguna llegara chica.
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import type { ColoniaApi, PatronesVista } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Callout, ChartCard, DataTable, EstadoVacio, Heatmap, PageContainer, RankingBarras, StatCard, TablaDatosGrafica, useT } from "@atiende/ui";
import { restaurantesCfoPatrones } from "@atiende/ui/i18n/restaurantes/cfoPatrones";
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
  const t = useT(restaurantesCfoPatrones);
  return (
    <ChartCard titulo={t("restaurantes.cfoPatrones.semanal")} subtitulo={t("restaurantes.cfoPatrones.semanalSub")} tamano="M">
      <BarChartSimple datos={filas.map((f) => ({ dia: DIAS_CORTOS[f.dow - 1] ?? f.etiqueta, valor: f.promedioDiaCentavos ?? 0 }))} etiquetaValor={pesos} sinDatos={t("restaurantes.cfoPatrones.sinVentas")} />
      {picos.length > 0 && (
        <p className="mt-2 text-xs" data-testid="dias-pico">
          <span className="font-medium">{t("restaurantes.cfoPatrones.diasPico")}</span>
          {t("restaurantes.cfoPatrones.diasPicoNota", { dias: picos.map((p) => p.etiqueta).join(", "), pct: Math.round((UMBRAL_PICO - 1) * 100) })}
        </p>
      )}
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoPatrones.semanal")}
        encabezados={[t("restaurantes.cfoPatrones.col.dia"), t("restaurantes.cfoPatrones.col.pedidos"), t("restaurantes.cfoPatrones.col.neta"), t("restaurantes.cfoPatrones.col.promedioDia")]}
        filas={filas.map((f) => [f.etiqueta, entero(f.pedidos), pesosExactos(f.netaCentavos), pesosExactos(f.promedioDiaCentavos)])}
      />
    </ChartCard>
  );
}

function Mensual({ d }: { readonly d: PatronesVista }) {
  const filas = d.estacionalidadMensual;
  const t = useT(restaurantesCfoPatrones);
  return (
    <ChartCard titulo={t("restaurantes.cfoPatrones.mensual")} subtitulo={t("restaurantes.cfoPatrones.mensualSub")} tamano="M">
      <BarChartSimple datos={filas.map((m) => ({ dia: etiquetaMes(m.mes).slice(0, 3), valor: m.netaCentavos }))} etiquetaValor={pesos} sinDatos={t("restaurantes.cfoPatrones.sinVentas")} />
      <TablaDatosGrafica titulo={t("restaurantes.cfoPatrones.mensual")} encabezados={[t("restaurantes.cfoPatrones.col.mes"), t("restaurantes.cfoPatrones.col.diasPeriodo"), t("restaurantes.cfoPatrones.col.pedidos"), t("restaurantes.cfoPatrones.col.neta")]} filas={filas.map((m) => [etiquetaMes(m.mes), entero(m.dias), entero(m.pedidos), pesosExactos(m.netaCentavos)])} />
    </ChartCard>
  );
}

function Colonias({ d }: { readonly d: PatronesVista }) {
  const t = useT(restaurantesCfoPatrones);
  // «(otras)» es un marcador de los datos: se pinta en el idioma activo.
  const mostrar = (colonia: string): string => (colonia === NOMBRE_OTRAS ? t("restaurantes.cfoPatrones.otras") : colonia);
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
    return { ranking: lista.map(([colonia, pedidos]) => ({ id: colonia, etiqueta: mostrar(colonia), valor: pedidos })), otras, totalPedidos: filas.reduce((s, c) => s + c.pedidos, 0) };
  }, [filas, t]);
  return (
    <ChartCard titulo={t("restaurantes.cfoPatrones.colonias")} subtitulo={t("restaurantes.cfoPatrones.coloniasSub")} tamano="L">
      <Callout tone="info" className="mb-2" data-testid="colonias-privacidad" icon={<ShieldCheck className="size-4" aria-hidden="true" />}>
        {t("restaurantes.cfoPatrones.privacidad", { k: K_COLONIAS, otras: t("restaurantes.cfoPatrones.otras") })}
      </Callout>
      {filas.length === 0 ? (
        <p role="status" className="py-6 text-center text-xs text-faint">
          {t("restaurantes.cfoPatrones.sinColonias")}
        </p>
      ) : (
        <>
          <RankingBarras filas={ranking} formato={entero} sinDatos={t("restaurantes.cfoPatrones.sinDomicilio")} />
          {otras > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="colonias-otras">
              {t("restaurantes.cfoPatrones.otrasJunta", { otras: t("restaurantes.cfoPatrones.otras"), n: entero(otras), pct: totalPedidos > 0 ? t("restaurantes.cfoPatrones.pct", { n: Math.round((otras / totalPedidos) * 100) }) : SIN_DATO })}
            </p>
          )}
          <div className="mt-3">
            <DataTable<ColoniaApi>
              etiqueta={t("restaurantes.cfoPatrones.coloniasTabla")}
              filas={filas}
              obtenerId={(f) => `${f.propertyId}-${f.colonia}`}
              paginacion={{ tamano: 10 }}
              vista="tabla"
              atributosFila={(f) => ({ "data-colonia": f.colonia })}
              columnas={[
                { id: "c", encabezado: t("restaurantes.cfoPatrones.col.colonia"), principal: true, celda: (f) => mostrar(f.colonia) },
                { id: "s", encabezado: t("restaurantes.cfoPatrones.col.sucursal"), celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                { id: "p", encabezado: t("restaurantes.cfoPatrones.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                { id: "t", encabezado: t("restaurantes.cfoPatrones.col.ticket"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.ticket, "centavos") },
                { id: "e", encabezado: t("restaurantes.cfoPatrones.col.entregaProm"), alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.entregaPromedioMin.valor) },
                {
                  id: "d",
                  encabezado: t("restaurantes.cfoPatrones.col.despacho"),
                  celda: (f) => (f.sucursalCercanaId === null ? SIN_DATO : `${nombres.get(f.sucursalCercanaId) ?? t("restaurantes.cfoPatrones.otraSucursal")}${f.distanciaKm === null ? "" : ` · ${f.distanciaKm.toFixed(1)} km`}`),
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
  const t = useT(restaurantesCfoPatrones);
  return (
    <ChartCard titulo={t("restaurantes.cfoPatrones.canalHora")} subtitulo={t("restaurantes.cfoPatrones.canalHoraSub")} tamano="M">
      <Heatmap celdas={celdas} filas={Math.max(1, fuentes.length)} etiquetasFilas={fuentes.map(etiquetaSource)} formato={entero} metrica="pedidos" sinDatos={t("restaurantes.cfoPatrones.sinCanal")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoPatrones.canalHoraTabla")}
        encabezados={[t("restaurantes.cfoPatrones.col.canal"), t("restaurantes.cfoPatrones.col.hora"), t("restaurantes.cfoPatrones.col.pedidos"), t("restaurantes.cfoPatrones.col.neta")]}
        filas={[...d.canalPorHora].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.hora - b.hora)).map((c) => [etiquetaSource(c.source), t("restaurantes.cfoPatrones.hora", { hora: c.hora }), entero(c.pedidos), pesosExactos(c.netaCentavos)])}
      />
    </ChartCard>
  );
}

export function CfoPatrones(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoPatrones);
  const { carga, recargando, recargar } = useCargaCfo(() => fetchPatrones(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const promos = enlaceDeAccion("/cfo/platillos", props.base, filtros, props.pestanasDisponibles);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-patrones">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoPatrones.cargando")}>
        {(d) =>
          d.estacionalidadSemanal.every((f) => f.pedidos === 0) && d.colonias.length === 0 && d.canalPorHora.length === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={ShieldCheck} titulo={t("restaurantes.cfoPatrones.sinPatrones")} mensaje={t("restaurantes.cfoPatrones.sinPatronesMensaje")} />
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
                  {t("restaurantes.cfoPatrones.picoPromo")}{" "}
                  <Link to={promos} className="font-medium text-primary underline-offset-4 hover:underline">
                    {t("restaurantes.cfoPatrones.revisaPromos")}
                  </Link>
                  .
                </p>
              )}
              <Colonias d={d} />
              <CanalPorHora d={d} />
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="patrones-frecuencia">
                <StatCard
                  icon={ShieldCheck}
                  label={t("restaurantes.cfoPatrones.diasEntre")}
                  value={d.diasEntrePedidos.valor === null ? SIN_DATO : t("restaurantes.cfoPatrones.nDias", { n: entero(d.diasEntrePedidos.valor) })}
                  nota={t("restaurantes.cfoPatrones.diasEntreNota")}
                  {...(d.diasEntrePedidos.valor === null ? { sinDato: t("restaurantes.cfoPatrones.diasEntreSinDato") } : {})}
                />
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t("restaurantes.cfoPatrones.cifraConjunto")}{" "}<ChipDeCifra cifra={d.diasEntrePedidos} mostrarMedido />{t("restaurantes.cfoPatrones.histograma")}
              </p>
            </>
          )
        }
      </CargaCfoVista>
    </PageContainer>
  );
}
