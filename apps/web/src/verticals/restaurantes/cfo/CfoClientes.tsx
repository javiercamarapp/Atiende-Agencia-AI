// CFO-08 · pestaña Clientes: base y su evolución, activa / dormida / perdida, nuevos / recurrentes / frecuentes, cohortes 30/60/90 con mapa de calor por celda,
// churn y recuperados, recompra, concentración, horario preferido por segmento y la nota «el total no es la suma». Sin nombres, teléfonos ni direcciones:
// el drill-down lleva a pedidos con alias. Cifras `null` = «—».
import { useMemo, useState } from "react";
import { Repeat2, Settings2, UserPlus, Users } from "lucide-react";
import type { ClientesColumna, ClientesVista, CohorteApi } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Button, Callout, ChartCard, DataTable, Dona, EstadoVacio, FormField, Heatmap, Selector, PageContainer, StatCard, TablaDatosGrafica, cn, etiquetasTraducidas, useT } from "@atiende/ui";
import { restaurantesCfoClientes } from "@atiende/ui/i18n/restaurantes/cfoClientes";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { AjustesCfoDialogo } from "./AjustesCfoDialogo.tsx";
import { fetchClientes } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, DIAS_CORTOS, claveCarga, diaCorto, rellenoCelda } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type Segmento = "nuevo" | "recurrente" | "frecuente";
const ETIQUETA_SEGMENTO: Readonly<Record<Segmento, string>> = etiquetasTraducidas<Segmento>(["nuevo", "recurrente", "frecuente"], (s) => `restaurantes.cfoClientes.seg.${s}` as const, restaurantesCfoClientes);

const pct = (parte: number, total: number): number | null => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

/** El renglón del conjunto; con una sola sucursal ese renglón es el total (un cliente no se cuenta dos veces). Con varias y sin conjunto: null. */
function totalDe(d: ClientesVista): ClientesColumna | null {
  if (d.total) return d.total;
  return d.porSucursal.length === 1 ? d.porSucursal[0]! : null;
}

function altasSemanales(d: ClientesVista): ReadonlyArray<{ readonly semana: string; readonly altas: number }> | null {
  const conjunto = d.altas.porSemana.filter((a) => a.propertyId === null);
  if (conjunto.length > 0) return conjunto;
  if (d.porSucursal.length === 1) return d.altas.porSemana.filter((a) => a.propertyId === d.porSucursal[0]!.propertyId);
  return null;
}

function cohortesDelAlcance(d: ClientesVista): CohorteApi[] {
  const conjunto = d.cohortes.filter((c) => c.propertyId === null);
  if (conjunto.length > 0) return conjunto;
  return d.porSucursal.length === 1 ? d.cohortes.filter((c) => c.propertyId === d.porSucursal[0]!.propertyId) : [];
}

function Resumen({ total, leyenda, onAjustes }: { readonly total: ClientesColumna; readonly leyenda: string; readonly onAjustes: () => void }) {
  const t = useT(restaurantesCfoClientes);
  const r = total.resumen;
  const base = r.clientesConPedido;
  const nota = (n: number) => (pct(n, base) === null ? t("restaurantes.cfoClientes.sinClientesConPedido") : t("restaurantes.cfoClientes.pctClientesConPedido", { pct: porcentaje(pct(n, base)) }));
  return (
    <div className="space-y-2" data-testid="clientes-resumen">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label={t("restaurantes.cfoClientes.conPedidoPeriodo")} value={entero(base)} nota={t("restaurantes.cfoClientes.unicosConjunto")} />
        <StatCard icon={UserPlus} label={ETIQUETA_SEGMENTO.nuevo} value={entero(r.nuevos)} nota={nota(r.nuevos)} />
        <StatCard icon={Repeat2} label={ETIQUETA_SEGMENTO.recurrente} value={entero(r.recurrentes)} nota={nota(r.recurrentes)} />
        <StatCard icon={Users} label={ETIQUETA_SEGMENTO.frecuente} value={entero(total.segmentos.frecuentes)} nota={total.segmentos.frecuentesPct.valor === null ? t("restaurantes.cfoClientes.sinClasificados") : t("restaurantes.cfoClientes.pctBase", { pct: textoCifra(total.segmentos.frecuentesPct, "pct") })} />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="clientes-leyenda-frecuente">
        <span>{leyenda}</span>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onAjustes}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          {t("restaurantes.cfoClientes.editarAjustes")}
        </Button>
      </p>
    </div>
  );
}

function Altas({ d }: { readonly d: ClientesVista }) {
  const t = useT(restaurantesCfoClientes);
  const filas = altasSemanales(d);
  return (
    <ChartCard titulo={t("restaurantes.cfoClientes.altas")} subtitulo={t("restaurantes.cfoClientes.altasSub")} tamano="M">
      {filas === null ? (
        <p role="status" className="py-6 text-center text-xs text-faint">
          {t("restaurantes.cfoClientes.altasVarias")}
        </p>
      ) : (
        <BarChartSimple datos={filas.map((a) => ({ dia: diaCorto(a.semana), valor: a.altas }))} etiquetaValor={entero} sinDatos={t("restaurantes.cfoClientes.sinAltas")} />
      )}
      {filas !== null && <TablaDatosGrafica titulo={t("restaurantes.cfoClientes.altas")} encabezados={[t("restaurantes.cfoClientes.col.semanaDel"), t("restaurantes.cfoClientes.col.clientesNuevos")]} filas={filas.map((a) => [diaCorto(a.semana), entero(a.altas)])} />}
    </ChartCard>
  );
}

function Base({ total }: { readonly total: ClientesColumna }) {
  const t = useT(restaurantesCfoClientes);
  const s = total.segmentos;
  const suma = s.activos + s.dormidos + s.perdidos;
  const filas = [
    { etiqueta: t("restaurantes.cfoClientes.activos"), n: s.activos },
    { etiqueta: t("restaurantes.cfoClientes.dormidos"), n: s.dormidos },
    { etiqueta: t("restaurantes.cfoClientes.perdidos"), n: s.perdidos },
  ];
  return (
    <ChartCard titulo={t("restaurantes.cfoClientes.base")} subtitulo={t("restaurantes.cfoClientes.baseSub", { n: entero(suma) })} tamano="M">
      <Dona segmentos={filas.map((f) => ({ etiqueta: `${f.etiqueta} · ${entero(f.n)}`, valor: f.n }))} sinDatos={t("restaurantes.cfoClientes.sinBase")} />
      <TablaDatosGrafica titulo={t("restaurantes.cfoClientes.base")} encabezados={[t("restaurantes.cfoClientes.col.segmento"), t("restaurantes.cfoClientes.col.clientes"), t("restaurantes.cfoClientes.col.pctBase")]} filas={filas.map((f) => [f.etiqueta, entero(f.n), porcentaje(pct(f.n, suma))])} />
    </ChartCard>
  );
}

type VentanaRecompra = "recompra30" | "recompra60" | "recompra90";

/** Celda del mapa de calor de cohortes: un bloque con relleno de un solo tono según el % de recompra; «—» si la ventana aún no se cumple. */
function CeldaCohorte({ c, ventana }: { readonly c: CohorteApi; readonly ventana: VentanaRecompra }) {
  const t = useT(restaurantesCfoClientes);
  const v = c[ventana];
  const valor = v.pct.valor;
  const { clase, fuerte } = rellenoCelda(valor, 100);
  return (
    <div className={cn("rounded-md px-2 py-1 text-right tabular-nums", clase, fuerte && "text-primary-foreground")} data-testid="cohorte-celda" data-valor={valor ?? ""}>
      {valor === null ? SIN_DATO : porcentaje(valor)}
      <span className="block text-2xs opacity-80">{valor === null ? t("restaurantes.cfoClientes.aunNoObservable") : t("restaurantes.cfoClientes.deObservables", { con: entero(v.con), observables: entero(v.observables) })}</span>
    </div>
  );
}

function Cohortes({ d }: { readonly d: ClientesVista }) {
  const t = useT(restaurantesCfoClientes);
  const cs = cohortesDelAlcance(d);
  const acum = (ventana: VentanaRecompra) => {
    const con = cs.reduce((s, c) => s + c[ventana].con, 0);
    const obs = cs.reduce((s, c) => s + c[ventana].observables, 0);
    return { con, obs, pct: pct(con, obs) };
  };
  const ventana = (id: VentanaRecompra, encabezado: string) => ({ id, encabezado, alinear: "right" as const, celda: (c: CohorteApi) => <CeldaCohorte c={c} ventana={id} /> });
  return (
    <ChartCard titulo={t("restaurantes.cfoClientes.cohortes")} subtitulo={t("restaurantes.cfoClientes.cohortesSub")} tamano="M">
      <div data-testid="cohortes-tabla">
        <DataTable<CohorteApi>
          etiqueta={t("restaurantes.cfoClientes.cohortesTabla")}
          filas={cs}
          obtenerId={(c) => c.mesCohorte}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: t("restaurantes.cfoClientes.sinCohortes") }}
          columnas={[
            { id: "mes", encabezado: t("restaurantes.cfoClientes.col.mesPrimer"), principal: true, celda: (c) => c.mesCohorte },
            { id: "clientes", encabezado: t("restaurantes.cfoClientes.col.clientes"), alinear: "right", className: "tabular-nums", celda: (c) => entero(c.clientes) },
            ventana("recompra30", t("restaurantes.cfoClientes.a30")),
            ventana("recompra60", t("restaurantes.cfoClientes.a60")),
            ventana("recompra90", t("restaurantes.cfoClientes.a90")),
          ]}
        />
      </div>
      {cs.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="recompra-acumulada">
          {t("restaurantes.cfoClientes.recompraAcumulada", { p30: porcentaje(acum("recompra30").pct), p60: porcentaje(acum("recompra60").pct), p90: porcentaje(acum("recompra90").pct) })}
        </p>
      )}
    </ChartCard>
  );
}

function ChurnYRecuperados({ total }: { readonly total: ClientesColumna }) {
  const t = useT(restaurantesCfoClientes);
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="clientes-churn">
      <StatCard
        icon={Users}
        label={t("restaurantes.cfoClientes.churn")}
        value={textoCifra(total.churn, "pct")}
        nota={t("restaurantes.cfoClientes.churnNota")}
        {...(total.churn.valor === null ? { sinDato: t("restaurantes.cfoClientes.churnSinDato") } : {})}
      />
      <StatCard icon={Repeat2} label={t("restaurantes.cfoClientes.recuperados")} value={entero(total.winBack.recuperados)} nota={t("restaurantes.cfoClientes.recuperadosNota")} />
      <StatCard icon={Repeat2} label={t("restaurantes.cfoClientes.recuperadosCampana")} value={entero(total.winBack.recuperadosPorCampana)} nota={t("restaurantes.cfoClientes.recuperadosCampanaNota")} />
      <StatCard icon={Users} label={t("restaurantes.cfoClientes.diasEntre")} value={total.diasEntrePedidosMediana.valor === null ? SIN_DATO : t("restaurantes.cfoClientes.nDias", { n: entero(total.diasEntrePedidosMediana.valor) })} nota={t("restaurantes.cfoClientes.diasEntreNota")} />
    </div>
  );
}

function Valor({ total }: { readonly total: ClientesColumna }) {
  const t = useT(restaurantesCfoClientes);
  const r = total.resumen;
  return (
    <div className="grid gap-2.5 sm:grid-cols-3" data-testid="clientes-valor">
      <StatCard
        icon={Users}
        label={t("restaurantes.cfoClientes.valorVida")}
        value={textoCifra(total.valorDeVida, "centavos")}
        nota={t("restaurantes.cfoClientes.valorVidaNota")}
        {...(total.valorDeVida.valor === null ? { sinDato: t("restaurantes.cfoClientes.valorVidaSinDato") } : {})}
      />
      <StatCard icon={Repeat2} label={t("restaurantes.cfoClientes.pedidosCliente")} value={r.pedidosPorCliente12mPromedio === null ? SIN_DATO : String(r.pedidosPorCliente12mPromedio)} nota={t("restaurantes.cfoClientes.pedidosClienteNota")} />
      <StatCard
        icon={Users}
        label={t("restaurantes.cfoClientes.concentracion")}
        value={textoCifra(total.concentracion, "pct")}
        nota={total.concentracion.valor === null ? t("restaurantes.cfoClientes.concentracionSinVentas") : t("restaurantes.cfoClientes.concentracionNota", { pct: porcentaje(total.concentracion.valor) })}
      />
    </div>
  );
}

function PorSegmento({ d }: { readonly d: ClientesVista }) {
  const t = useT(restaurantesCfoClientes);
  const segmentos: Segmento[] = ["nuevo", "recurrente", "frecuente"];
  const [elegido, setElegido] = useState<Segmento>("frecuente");
  const porSegmento = segmentos.map((s) => {
    const filas = d.segmentoHora.filter((x) => x.segmento === s);
    const pedidos = filas.reduce((a, x) => a + x.pedidos, 0);
    const neta = filas.reduce((a, x) => a + x.netaCentavos, 0);
    return { segmento: s, pedidos, neta, ticket: pedidos > 0 ? Math.round(neta / pedidos) : null };
  });
  const celdas: CeldaHeatmapUi[] = d.segmentoHora.filter((x) => x.segmento === elegido).map((x) => ({ fila: x.dow - 1, columna: x.hora, valor: x.pedidos }));
  const totalPedidos = porSegmento.reduce((a, x) => a + x.pedidos, 0);
  return (
    <div className="grid gap-2.5 lg:grid-cols-2">
      <ChartCard titulo={t("restaurantes.cfoClientes.ticketSegmento")} subtitulo={t("restaurantes.cfoClientes.ticketSegmentoSub")} tamano="M">
        <DataTable<(typeof porSegmento)[number]>
          etiqueta={t("restaurantes.cfoClientes.ticketSegmentoTabla")}
          filas={porSegmento}
          obtenerId={(f) => f.segmento}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: t("restaurantes.cfoClientes.sinPedidosIdentificados") }}
          columnas={[
            { id: "segmento", encabezado: t("restaurantes.cfoClientes.col.segmento"), principal: true, celda: (f) => ETIQUETA_SEGMENTO[f.segmento] },
            { id: "pedidos", encabezado: t("restaurantes.cfoClientes.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
            { id: "part", encabezado: t("restaurantes.cfoClientes.col.pctPedidos"), alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(pct(f.pedidos, totalPedidos)) },
            { id: "ticket", encabezado: t("restaurantes.cfoClientes.col.ticket"), alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ticket) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">{t("restaurantes.cfoClientes.unSegmento")}</p>
      </ChartCard>
      <ChartCard
        titulo={t("restaurantes.cfoClientes.horario")}
        subtitulo={t("restaurantes.cfoClientes.horarioSub")}
        tamano="M"
        accion={
          <FormField label={t("restaurantes.cfoClientes.segmento")} className="w-40">
            <Selector size="sm" value={elegido} onChange={(e) => setElegido(e.target.value as Segmento)} data-testid="segmento-horario">
              {segmentos.map((s) => (
                <option key={s} value={s}>
                  {ETIQUETA_SEGMENTO[s]}
                </option>
              ))}
            </Selector>
          </FormField>
        }
      >
        <Heatmap celdas={celdas} formato={entero} metrica="pedidos" sinDatos={t("restaurantes.cfoClientes.sinPedidosSegmento")} />
        <TablaDatosGrafica
          titulo={t("restaurantes.cfoClientes.pedidosDe", { segmento: ETIQUETA_SEGMENTO[elegido].toLowerCase() })}
          encabezados={[t("restaurantes.cfoClientes.col.dia"), t("restaurantes.cfoClientes.col.hora"), t("restaurantes.cfoClientes.col.pedidos")]}
          filas={[...celdas].filter((c) => c.valor !== null).sort((a, b) => a.fila - b.fila || a.columna - b.columna).map((c) => [DIAS_CORTOS[c.fila] ?? String(c.fila + 1), t("restaurantes.cfoClientes.hora", { hora: c.columna }), entero(c.valor)])}
        />
      </ChartCard>
    </div>
  );
}

function PorSucursal({ d }: { readonly d: ClientesVista }) {
  type Fila = ClientesVista["porSucursal"][number];
  const t = useT(restaurantesCfoClientes);
  return (
    <ChartCard titulo={t("restaurantes.cfoClientes.porSucursal")} subtitulo={t("restaurantes.cfoClientes.porSucursalSub")} tamano="S">
      <DataTable<Fila>
        etiqueta={t("restaurantes.cfoClientes.porSucursal")}
        filas={d.porSucursal}
        obtenerId={(f) => f.propertyId}
        paginacion={false}
        vista="tabla"
        vacio={{ mensaje: t("restaurantes.cfoClientes.sinSucursales") }}
        columnas={[
          { id: "n", encabezado: t("restaurantes.cfoClientes.col.sucursal"), principal: true, celda: (f) => f.nombre },
          { id: "c", encabezado: t("restaurantes.cfoClientes.col.conPedido"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.clientesConPedido) },
          { id: "nu", encabezado: ETIQUETA_SEGMENTO.nuevo, alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.nuevos) },
          { id: "re", encabezado: ETIQUETA_SEGMENTO.recurrente, alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.recurrentes) },
          { id: "fr", encabezado: ETIQUETA_SEGMENTO.frecuente, alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.segmentos.frecuentes)} (${textoCifra(f.segmentos.frecuentesPct, "pct")})` },
          { id: "ac", encabezado: t("restaurantes.cfoClientes.activos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.activos) },
          { id: "do", encabezado: t("restaurantes.cfoClientes.dormidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.dormidos) },
          { id: "pe", encabezado: t("restaurantes.cfoClientes.perdidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.perdidos) },
          { id: "ch", encabezado: t("restaurantes.cfoClientes.col.churn"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.churn, "pct") },
          { id: "co", encabezado: t("restaurantes.cfoClientes.concentracion"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.concentracion, "pct") },
          { id: "vv", encabezado: t("restaurantes.cfoClientes.col.valorVida"), alinear: "right", className: "tabular-nums", celda: (f) => <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.valorDeVida, "centavos")}<ChipDeCifra cifra={f.valorDeVida} /></span> },
        ]}
      />
    </ChartCard>
  );
}

function Contenido({ d, props, onAjustes }: { readonly d: ClientesVista; readonly props: CfoPaginaProps; readonly onAjustes: () => void }) {
  const t = useT(restaurantesCfoClientes);
  const total = useMemo(() => totalDe(d), [d]);
  const leyenda = d.definiciones["frecuente"] ?? t("restaurantes.cfoClientes.frecuenteDefault");
  const varias = d.porSucursal.length > 1;
  return (
    <>
      <Callout tone="neutral" data-testid="clientes-aviso-mostrador">
        {t("restaurantes.cfoClientes.avisoMostrador")}
      </Callout>
      <AvisosCfo vista={d} />
      {total === null ? (
        <EstadoVacio icon={Users} titulo={t("restaurantes.cfoClientes.sinDatos")} mensaje={t("restaurantes.cfoClientes.sinDatosMensaje")} />
      ) : (
        <>
          <Resumen total={total} leyenda={leyenda} onAjustes={onAjustes} />
          {varias && (
            <Callout tone="info" data-testid="clientes-multisucursal">
              {d.multiSucursal.clientes === null
                ? t("restaurantes.cfoClientes.multiSinDato")
                : t("restaurantes.cfoClientes.multiNoSuma", {
                    texto: d.multiSucursal.texto ?? t("restaurantes.cfoClientes.multiClientes", { n: entero(d.multiSucursal.clientes) }),
                    suma: entero(d.multiSucursal.sumaPorSucursal),
                    total: entero(total.resumen.clientesConPedido),
                  })}
            </Callout>
          )}
          <div className="grid gap-2.5 lg:grid-cols-2">
            <Altas d={d} />
            <Base total={total} />
          </div>
          <Cohortes d={d} />
          <ChurnYRecuperados total={total} />
          <Valor total={total} />
          <PorSegmento d={d} />
          <div className="flex flex-wrap items-center gap-2" data-testid="clientes-drill">
            <BotonPedidos etiqueta={t("restaurantes.cfoClientes.verPedidosAlias")} onClick={() => props.abrirPedidos({})} />
            <span className="text-xs text-muted-foreground">{t("restaurantes.cfoClientes.aliasNota")}</span>
          </div>
          {props.filtros.vista === "sucursal" && <PorSucursal d={d} />}
        </>
      )}
      {d.pedidosSinCliente > 0 && <p className="text-xs text-muted-foreground">{t("restaurantes.cfoClientes.sinCliente", { n: entero(d.pedidosSinCliente) })}</p>}
    </>
  );
}

export function CfoClientes(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchClientes(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [ajustes, setAjustes] = useState(false);
  const t = useT(restaurantesCfoClientes);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-clientes">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoClientes.cargando")}>

        {(d) => <Contenido d={d} props={props} onAjustes={() => setAjustes(true)} />}
      </CargaCfoVista>
      <AjustesCfoDialogo abierto={ajustes} onCerrar={() => setAjustes(false)} api={api} onGuardado={recargar} />
    </PageContainer>
  );
}
