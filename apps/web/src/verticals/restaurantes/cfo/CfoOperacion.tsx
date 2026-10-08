// CFO-08 · pestaña Operación y agente: tiempos de entrega por sucursal y hora (p90 del conjunto, no suma), repartidores, embudo del agente (WhatsApp y voz),
// escalaciones por hora y costo del agente (IA de texto «No asignado», voz, telefonía y Meta «no medido»). Cifras `null` = «—».
import { Bot, Clock3, Phone, Truck } from "lucide-react";
import type { CostoAgenteApi, EmbudoAgenteApi, EntregasSucursalApi, OperacionVista } from "@atiende/domain-restaurantes/cfo";
import type { FilaRepartidor } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, ChartCard, DataTable, EstadoVacio, Heatmap, PageContainer, StatCard, TablaDatosGrafica } from "@atiende/ui";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { fetchOperacion } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, minutos, pesosExactos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, claveCarga } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export const NOTA_P90 = "p90 del conjunto, no suma";
export const META_NO_MEDIDO = "Meta: no medido";

function Entregas({ d, abrir }: { readonly d: OperacionVista; readonly abrir: CfoPaginaProps["abrirPedidos"] }) {
  return (
    <ChartCard titulo="Tiempos de entrega por sucursal" subtitulo="Pedidos a domicilio entregados: promedio, mediana, p90 y % sobre la promesa" tamano="M" accion={<BotonPedidos etiqueta="Ver entregas tardías" onClick={() => abrir({ entrega_tarde: true })} />}>
      <DataTable<EntregasSucursalApi>
        etiqueta="Tiempos de entrega por sucursal"
        filas={d.entregas}
        obtenerId={(f) => f.propertyId ?? "conjunto"}
        paginacion={false}
        vista="tabla"
        atributosFila={(f) => ({ "data-tipo": f.conjunto ? "conjunto" : "sucursal" })}
        vacio={{ mensaje: "Sin entregas a domicilio en este periodo." }}
        columnas={[
          { id: "n", encabezado: "Sucursal", principal: true, celda: (f) => <span className={f.conjunto ? "font-semibold" : undefined}>{f.nombre}</span> },
          { id: "e", encabezado: "Entregas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.entregados) },
          { id: "pr", encabezado: "Promedio", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.promedioMin, "minutos") },
          { id: "me", encabezado: "Mediana", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.p50Min, "minutos") },
          {
            id: "p9",
            encabezado: "p90",
            alinear: "right",
            className: "tabular-nums",
            celda: (f) => (
              <span>
                {textoCifra(f.p90Min, "minutos")}
                {f.conjunto && <span className="block text-2xs text-muted-foreground">{NOTA_P90}</span>}
              </span>
            ),
          },
          { id: "ta", encabezado: "% sobre la promesa", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.tardePct, "pct") },
        ]}
      />
      <p className="mt-2 text-2xs text-muted-foreground">El p90 y la mediana se calculan sobre todas las entregas; no se obtienen de promediar los de cada sucursal.</p>
    </ChartCard>
  );
}

function PorHora({ d }: { readonly d: OperacionVista }) {
  const filas = d.entregasPorHora.filter((h) => h.entregados > 0);
  return (
    <ChartCard titulo="Tiempo de entrega por hora" subtitulo="Promedio de minutos de las entregas de cada hora" tamano="M">
      <BarChartSimple datos={filas.map((h) => ({ dia: `${h.hora} h`, valor: h.promedioMin ?? 0 }))} etiquetaValor={(v) => minutos(v)} sinDatos="Sin entregas en este periodo" />
      <TablaDatosGrafica
        titulo="Entregas por hora"
        encabezados={["Hora", "Entregas", "Promedio", "% sobre la promesa"]}
        filas={filas.map((h) => [`${h.hora} h`, entero(h.entregados), minutos(h.promedioMin), porcentaje(h.tardePct)])}
      />
    </ChartCard>
  );
}

function Repartidores({ d }: { readonly d: OperacionVista }) {
  const nombres = new Map(d.sucursales.map((s) => [s.propertyId, s.nombre]));
  return (
    <ChartCard titulo="Repartidores" subtitulo="Entregas, tiempo promedio, entregas tarde e incidencias · solo dueño y administradores" tamano="S">
      <DataTable<FilaRepartidor>
        etiqueta="Repartidores"
        filas={d.repartidores}
        obtenerId={(f) => f.repartidorId}
        paginacion={{ tamano: 10 }}
        vista="tabla"
        vacio={{ mensaje: "Sin entregas de repartidores en este periodo." }}
        columnas={[
          { id: "n", encabezado: "Repartidor", principal: true, celda: (f) => f.nombre },
          { id: "s", encabezado: "Sucursal", celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
          { id: "e", encabezado: "Entregas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.entregas) },
          { id: "t", encabezado: "Tiempo prom.", alinear: "right", className: "tabular-nums", celda: (f) => (f.entregas > 0 ? minutos(Math.round((f.minSuma / f.entregas) * 10) / 10) : SIN_DATO) },
          { id: "ta", encabezado: "Tarde", alinear: "right", className: "tabular-nums", celda: (f) => (f.entregas > 0 ? `${entero(f.tarde)} (${porcentaje(Math.round((f.tarde / f.entregas) * 1000) / 10)})` : SIN_DATO) },
          { id: "i", encabezado: "Incidencias", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.incidencias) },
        ]}
      />
    </ChartCard>
  );
}

function Embudo({ d }: { readonly d: OperacionVista }) {
  const t: EmbudoAgenteApi = d.embudo.total;
  return (
    <ChartCard titulo="Embudo del agente" subtitulo="Cuántas conversaciones y llamadas terminan en pedido" tamano="M">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="embudo-agente">
        <StatCard icon={Bot} label="WhatsApp: conversaciones" value={entero(t.whatsapp.conversaciones)} nota={`${entero(t.whatsapp.conPedido)} con pedido · ${entero(t.whatsapp.conHandoff)} con handoff`} />
        <StatCard icon={Bot} label="WhatsApp: tasa de cierre" value={textoCifra(t.whatsapp.tasaCierre, "pct")} nota="Conversaciones que terminan en pedido" {...(t.whatsapp.tasaCierre.valor === null ? { sinDato: "Sin conversaciones en el periodo." } : {})} />
        <StatCard icon={Phone} label="Voz: llamadas" value={entero(t.voz.llamadas)} nota={`${entero(t.voz.pedidoCreado)} pedido · ${entero(t.voz.escalado)} escalado · ${entero(t.voz.abandonado)} abandonado`} />
        <StatCard icon={Phone} label="Voz: tasa de cierre" value={textoCifra(t.voz.tasaCierre, "pct")} nota="Llamadas que terminan en pedido" {...(t.voz.tasaCierre.valor === null ? { sinDato: "Sin llamadas en el periodo." } : {})} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Tasa de cierre del agente (WhatsApp y voz juntos): <strong className="font-semibold text-foreground">{textoCifra(t.tasaCierreAgente, "pct")}</strong> <ChipDeCifra cifra={t.tasaCierreAgente} />
      </p>
      {d.embudo.porSucursal.length > 1 && (
        <div className="mt-3">
          <DataTable<(typeof d.embudo.porSucursal)[number]>
            etiqueta="Embudo del agente por sucursal"
            filas={d.embudo.porSucursal}
            obtenerId={(f) => f.propertyId}
            paginacion={false}
            vista="tabla"
            columnas={[
              { id: "n", encabezado: "Sucursal", principal: true, celda: (f) => f.nombre },
              { id: "wc", encabezado: "WhatsApp conv.", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.whatsapp.conversaciones) },
              { id: "wt", encabezado: "WhatsApp cierre", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.whatsapp.tasaCierre, "pct") },
              { id: "vl", encabezado: "Voz llamadas", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.voz.llamadas) },
              { id: "vt", encabezado: "Voz cierre", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.voz.tasaCierre, "pct") },
            ]}
          />
        </div>
      )}
    </ChartCard>
  );
}

function Escalaciones({ d }: { readonly d: OperacionVista }) {
  const celdas: CeldaHeatmapUi[] = d.escalacionesPorHora.map((h) => ({ fila: 0, columna: h.hora, valor: h.handoffs }));
  return (
    <ChartCard titulo="Escalaciones por hora" subtitulo="Conversaciones que el agente pasó a una persona, en cada hora" tamano="S">
      <Heatmap celdas={celdas} filas={1} etiquetasFilas={["Escalaciones"]} formato={entero} metrica="escalaciones" sinDatos="Sin escalaciones en este periodo" />
      <TablaDatosGrafica
        titulo="Escalaciones por hora"
        encabezados={["Hora", "Conversaciones", "Escalaciones", "% escalado"]}
        filas={d.escalacionesPorHora.map((h) => [`${h.hora} h`, entero(h.conversaciones), entero(h.handoffs), porcentaje(h.handoffPct)])}
      />
    </ChartCard>
  );
}

function Costo({ d }: { readonly d: OperacionVista }) {
  const c: CostoAgenteApi = d.costoAgente.total;
  const llm = d.costoAgente.noAsignado?.llmTexto ?? null;
  const metaNoMedida = c.meta.valor === null;
  return (
    <ChartCard titulo="Costo del agente" subtitulo="Lo que cuesta atender por WhatsApp y voz, total y por pedido" tamano="M">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="costo-agente">
        <StatCard icon={Clock3} label="Costo total del agente" value={pesosExactos(c.total.valor)} nota={c.completo ? "Incluye todas las partidas medidas" : "Parcial: faltan partidas por medir"} />
        <StatCard icon={Clock3} label="Costo por pedido" value={pesosExactos(c.porPedido.valor)} nota="Costo del agente entre los pedidos del agente" {...(c.porPedido.valor === null ? { sinDato: "Sin pedidos del agente en el periodo." } : {})} />
        <StatCard
          icon={Bot}
          label="IA de texto · No asignado"
          value={llm === null ? SIN_DATO : pesosExactos(llm.valor)}
          nota="Es de la organización, no de una sucursal"
          {...(llm === null ? { sinDato: "Solo se ve con la organización completa: es un costo que no se asigna a una sucursal." } : {})}
        />
        <StatCard icon={Phone} label="Voz" value={pesosExactos(c.voz.valor)} nota="Reconocimiento y síntesis de voz" {...(c.voz.valor === null ? { sinDato: "Sin llamadas en el periodo." } : {})} />
        <StatCard icon={Phone} label="Telefonía" value={pesosExactos(c.telefonia.valor)} nota="Minutos de llamada" {...(c.telefonia.valor === null ? { sinDato: "Sin llamadas en el periodo." } : {})} />
        <StatCard icon={Bot} label="Meta (WhatsApp)" value={metaNoMedida ? "No medido" : pesosExactos(c.meta.valor)} nota={metaNoMedida ? META_NO_MEDIDO : "Conversaciones de pago de Meta"} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        Confianza: <ChipDeCifra cifra={c.total} mostrarMedido /> {metaNoMedida && <span data-testid="meta-no-medido">«Meta: no medido» significa que no hubo eventos que medir; no es $0.</span>}
      </p>
    </ChartCard>
  );
}

export function CfoOperacion(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchOperacion(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-operacion">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando la operación…">
        {(d) =>
          d.entregas.every((e) => e.entregados === 0) && d.embudo.total.whatsapp.conversaciones === 0 && d.embudo.total.voz.llamadas === 0 ? (
            <>
              <AvisosCfo vista={d} />
              <EstadoVacio icon={Truck} titulo="Sin operación en este periodo" mensaje="No hay entregas, conversaciones ni llamadas en el periodo elegido." />
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
