// CFO-08 · pestaña Operación y agente: tiempos de entrega por sucursal y hora (p90 del conjunto, no suma), repartidores, embudo del agente (WhatsApp y voz),
// escalaciones por hora y costo del agente (IA de texto «No asignado», voz, telefonía y Meta «no medido»). Cifras `null` = «—».
import { Bot, Clock3, Phone, Truck } from "lucide-react";
import type { CostoAgenteApi, EmbudoAgenteApi, EntregasSucursalApi, OperacionVista } from "@atiende/domain-restaurantes/cfo";
import type { FilaRepartidor } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, ChartCard, DataTable, EstadoVacio, Heatmap, PageContainer, StatCard, TablaDatosGrafica, useT } from "@atiende/ui";
import { restaurantesCfoOperacion } from "@atiende/ui/i18n/restaurantes/cfoOperacion";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { fetchOperacion } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, claveCarga } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

function Entregas({ d, abrir }: { readonly d: OperacionVista; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.entregas")} subtitulo={t("restaurantes.cfoOperacion.entregasSub")} tamano="M" accion={<BotonPedidos etiqueta={t("restaurantes.cfoOperacion.verTardias")} onClick={() => abrir({ entrega_tarde: true })} />}>
      <DataTable<EntregasSucursalApi>
        etiqueta={t("restaurantes.cfoOperacion.entregas")}
        filas={d.entregas}
        obtenerId={(f) => f.propertyId ?? "conjunto"}
        paginacion={false}
        vista="tabla"
        atributosFila={(f) => ({ "data-tipo": f.conjunto ? "conjunto" : "sucursal" })}
        vacio={{ mensaje: t("restaurantes.cfoOperacion.sinEntregas") }}
        columnas={[
          { id: "n", encabezado: t("restaurantes.cfoOperacion.col.sucursal"), principal: true, celda: (f) => <span className={f.conjunto ? "font-semibold" : undefined}>{f.nombre}</span> },
          { id: "e", encabezado: t("restaurantes.cfoOperacion.col.entregas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.entregados) },
          { id: "pr", encabezado: t("restaurantes.cfoOperacion.col.promedio"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.promedioMin, "minutos") },
          { id: "me", encabezado: t("restaurantes.cfoOperacion.col.mediana"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.p50Min, "minutos") },
          {
            id: "p9",
            encabezado: "p90",
            alinear: "right",
            className: "tabular-nums",
            celda: (f) => (
              <span>
                {textoCifra(f.p90Min, "minutos")}
                {f.conjunto && <span className="block text-2xs text-muted-foreground">{t("restaurantes.cfoOperacion.notaP90")}</span>}
              </span>
            ),
          },
          { id: "ta", encabezado: t("restaurantes.cfoOperacion.col.sobrePromesa"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.tardePct, "pct") },
        ]}
      />
      <p className="mt-2 text-2xs text-muted-foreground">{t("restaurantes.cfoOperacion.p90Nota")}</p>
    </ChartCard>
  );
}

function PorHora({ d }: { readonly d: OperacionVista }) {
  const filas = d.entregasPorHora.filter((h) => h.entregados > 0);
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.porHora")} subtitulo={t("restaurantes.cfoOperacion.porHoraSub")} tamano="M">
      <BarChartSimple datos={filas.map((h) => ({ dia: t("restaurantes.cfoOperacion.hora", { hora: h.hora }), valor: h.promedioMin ?? 0 }))} etiquetaValor={(v) => minutos(v)} sinDatos={t("restaurantes.cfoOperacion.sinEntregasPeriodo")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoOperacion.entregasHora")}
        encabezados={[t("restaurantes.cfoOperacion.col.hora"), t("restaurantes.cfoOperacion.col.entregas"), t("restaurantes.cfoOperacion.col.promedio"), t("restaurantes.cfoOperacion.col.sobrePromesa")]}
        filas={filas.map((h) => [t("restaurantes.cfoOperacion.hora", { hora: h.hora }), entero(h.entregados), minutos(h.promedioMin), porcentaje(h.tardePct)])}
      />
    </ChartCard>
  );
}

function Repartidores({ d }: { readonly d: OperacionVista }) {
  const nombres = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.repartidores")} subtitulo={t("restaurantes.cfoOperacion.repartidoresSub")} tamano="S">
      <DataTable<FilaRepartidor>
        etiqueta={t("restaurantes.cfoOperacion.repartidores")}
        filas={d.repartidores}
        obtenerId={(f) => f.repartidorId}
        paginacion={{ tamano: 10 }}
        vista="tabla"
        vacio={{ mensaje: t("restaurantes.cfoOperacion.sinRepartidores") }}
        columnas={[
          { id: "n", encabezado: t("restaurantes.cfoOperacion.col.repartidor"), principal: true, celda: (f) => f.nombre },
          { id: "s", encabezado: t("restaurantes.cfoOperacion.col.sucursal"), celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
          { id: "e", encabezado: t("restaurantes.cfoOperacion.col.entregas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.entregas) },
          { id: "t", encabezado: t("restaurantes.cfoOperacion.col.tiempoProm"), alinear: "right", className: "tabular-nums", celda: (f) => (f.entregas > 0 ? minutos(Math.round((f.minSuma / f.entregas) * 10) / 10) : SIN_DATO) },
          { id: "ta", encabezado: t("restaurantes.cfoOperacion.col.tarde"), alinear: "right", className: "tabular-nums", celda: (f) => (f.entregas > 0 ? `${entero(f.tarde)} (${porcentaje(Math.round((f.tarde / f.entregas) * 1000) / 10)})` : SIN_DATO) },
          { id: "i", encabezado: t("restaurantes.cfoOperacion.col.incidencias"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.incidencias) },
        ]}
      />
    </ChartCard>
  );
}

function Embudo({ d }: { readonly d: OperacionVista }) {
  const e: EmbudoAgenteApi = d.embudo.total;
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.embudo")} subtitulo={t("restaurantes.cfoOperacion.embudoSub")} tamano="M">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="embudo-agente">
        <StatCard icon={Bot} label={t("restaurantes.cfoOperacion.waConversaciones")} value={entero(e.whatsapp.conversaciones)} nota={t("restaurantes.cfoOperacion.waNota", { conPedido: entero(e.whatsapp.conPedido), handoff: entero(e.whatsapp.conHandoff) })} />
        <StatCard icon={Bot} label={t("restaurantes.cfoOperacion.waCierre")} value={textoCifra(e.whatsapp.tasaCierre, "pct")} nota={t("restaurantes.cfoOperacion.waCierreNota")} {...(e.whatsapp.tasaCierre.valor === null ? { sinDato: t("restaurantes.cfoOperacion.sinConversaciones") } : {})} />
        <StatCard icon={Phone} label={t("restaurantes.cfoOperacion.vozLlamadas")} value={entero(e.voz.llamadas)} nota={t("restaurantes.cfoOperacion.vozNota", { pedido: entero(e.voz.pedidoCreado), escalado: entero(e.voz.escalado), abandonado: entero(e.voz.abandonado) })} />
        <StatCard icon={Phone} label={t("restaurantes.cfoOperacion.vozCierre")} value={textoCifra(e.voz.tasaCierre, "pct")} nota={t("restaurantes.cfoOperacion.vozCierreNota")} {...(e.voz.tasaCierre.valor === null ? { sinDato: t("restaurantes.cfoOperacion.sinLlamadas") } : {})} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("restaurantes.cfoOperacion.cierreAgente")}<strong className="font-semibold text-foreground">{textoCifra(e.tasaCierreAgente, "pct")}</strong> <ChipDeCifra cifra={e.tasaCierreAgente} />
      </p>
      {d.embudo.porSucursal.length > 1 && (
        <div className="mt-3">
          <DataTable<(typeof d.embudo.porSucursal)[number]>
            etiqueta={t("restaurantes.cfoOperacion.embudoSucursal")}
            filas={d.embudo.porSucursal}
            obtenerId={(f) => f.propertyId}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "n", encabezado: t("restaurantes.cfoOperacion.col.sucursal"), principal: true, celda: (f) => f.nombre },
              { id: "wc", encabezado: t("restaurantes.cfoOperacion.col.waConv"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.whatsapp.conversaciones) },
              { id: "wt", encabezado: t("restaurantes.cfoOperacion.col.waCierre"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.whatsapp.tasaCierre, "pct") },
              { id: "vl", encabezado: t("restaurantes.cfoOperacion.col.vozLlamadas"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.voz.llamadas) },
              { id: "vt", encabezado: t("restaurantes.cfoOperacion.col.vozCierre"), alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.voz.tasaCierre, "pct") },
            ]}
          />
        </div>
      )}
    </ChartCard>
  );
}

function Escalaciones({ d }: { readonly d: OperacionVista }) {
  const celdas: CeldaHeatmapUi[] = d.escalacionesPorHora.map((h) => ({ fila: 0, columna: h.hora, valor: h.handoffs }));
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.escalaciones")} subtitulo={t("restaurantes.cfoOperacion.escalacionesSub")} tamano="S">
      <Heatmap celdas={celdas} filas={1} etiquetasFilas={[t("restaurantes.cfoOperacion.escalacionesFila")]} formato={entero} metrica="escalaciones" sinDatos={t("restaurantes.cfoOperacion.sinEscalaciones")} />
      <TablaDatosGrafica
        titulo={t("restaurantes.cfoOperacion.escalaciones")}
        encabezados={[t("restaurantes.cfoOperacion.col.hora"), t("restaurantes.cfoOperacion.col.conversaciones"), t("restaurantes.cfoOperacion.escalacionesFila"), t("restaurantes.cfoOperacion.col.pctEscalado")]}
        filas={d.escalacionesPorHora.map((h) => [t("restaurantes.cfoOperacion.hora", { hora: h.hora }), entero(h.conversaciones), entero(h.handoffs), porcentaje(h.handoffPct)])}
      />
    </ChartCard>
  );
}

function Costo({ d }: { readonly d: OperacionVista }) {
  const c: CostoAgenteApi = d.costoAgente.total;
  // Solo con la organización completa: es un costo que no se asigna a una sucursal y un admin acotado no lo ve.
  const llm = d.costoAgente.noAsignado?.llmTexto ?? null;
  const metaNoMedida = c.meta.valor === null;
  const t = useT(restaurantesCfoOperacion);
  return (
    <ChartCard titulo={t("restaurantes.cfoOperacion.costo")} subtitulo={t("restaurantes.cfoOperacion.costoSub")} tamano="M">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="costo-agente">
        <StatCard icon={Clock3} label={t("restaurantes.cfoOperacion.costoTotal")} value={pesosExactos(c.total.valor)} nota={t(c.completo ? "restaurantes.cfoOperacion.completo" : "restaurantes.cfoOperacion.parcial")} />
        <StatCard icon={Clock3} label={t("restaurantes.cfoOperacion.costoPedido")} value={pesosExactos(c.porPedido.valor)} nota={t("restaurantes.cfoOperacion.costoPedidoNota")} {...(c.porPedido.valor === null ? { sinDato: t("restaurantes.cfoOperacion.sinPedidosAgente") } : {})} />
        {d.alcance.organizacionCompleta && (
          <StatCard
            icon={Bot}
            label={t("restaurantes.cfoOperacion.iaTexto")}
            value={llm === null ? SIN_DATO : pesosExactos(llm.valor)}
            nota={t("restaurantes.cfoOperacion.iaTextoNota")}
            {...(llm === null ? { sinDato: t("restaurantes.cfoOperacion.sinIaTexto") } : {})}
          />
        )}
        <StatCard icon={Phone} label={t("restaurantes.cfoOperacion.voz")} value={pesosExactos(c.voz.valor)} nota={t("restaurantes.cfoOperacion.vozCostoNota")} {...(c.voz.valor === null ? { sinDato: t("restaurantes.cfoOperacion.sinLlamadas") } : {})} />
        <StatCard icon={Phone} label={t("restaurantes.cfoOperacion.telefonia")} value={pesosExactos(c.telefonia.valor)} nota={t("restaurantes.cfoOperacion.telefoniaNota")} {...(c.telefonia.valor === null ? { sinDato: t("restaurantes.cfoOperacion.sinLlamadas") } : {})} />
        <StatCard icon={Bot} label={t("restaurantes.cfoOperacion.meta")} value={metaNoMedida ? t("restaurantes.cfoOperacion.noMedido") : pesosExactos(c.meta.valor)} nota={metaNoMedida ? t("restaurantes.cfoOperacion.metaNoMedido") : t("restaurantes.cfoOperacion.metaNota")} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        {t("restaurantes.cfoOperacion.confianza")}<ChipDeCifra cifra={c.total} mostrarMedido /> {metaNoMedida && <span data-testid="meta-no-medido">{t("restaurantes.cfoOperacion.metaExplica")}</span>}
      </p>
    </ChartCard>
  );
}

export function CfoOperacion(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoOperacion);
  const { carga, recargando, recargar } = useCargaCfo(() => fetchOperacion(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-operacion">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoOperacion.cargando")}>
        {(d) =>
          d.entregas.every((e) => e.entregados === 0) && d.embudo.total.whatsapp.conversaciones === 0 && d.embudo.total.voz.llamadas === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={Truck} titulo={t("restaurantes.cfoOperacion.sinOperacion")} mensaje={t("restaurantes.cfoOperacion.sinOperacionMensaje")} />
            </>
          ) : (
            <>
              <AvisosCfo vista={d} />
              <Entregas d={d} abrir={props.abrirPedidos} />
              <PorHora d={d} />
              <Repartidores d={d} />
              <Embudo d={d} />
              <Escalaciones d={d} />
              <Costo d={d} />
            </>
          )
        }
      </CargaCfoVista>
    </PageContainer>
  );
}
