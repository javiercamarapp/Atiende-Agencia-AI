// Analítica del dueño · pestaña Demanda: pedidos por día de la semana y hora (mapa de calor), picos CALCULADOS, franjas de refuerzo (percentil 80),
// recorte vie–dom, tendencia semanal, ticket, mezcla de pago y tiempo real de entrega contra el prometido. Datos de `analitica_demanda` (migración 160).
import { useState } from "react";
import { CalendarClock, Clock, Flame, Receipt } from "lucide-react";
import type { DemandaSucursal } from "@atiende/domain-restaurantes/analitica";
import { BarChartSimple, Callout, ChartCard, DataTable, Dona, EstadoVacio, Heatmap, PageContainer, StatCard, TablaDatosGrafica } from "@atiende/ui";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { fetchDemanda } from "./analitica-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, etiquetaFormaPago, minutos, pesos, pesosExactos, porcentaje } from "./formato.ts";
import { CargaCfoVista } from "./piezas.tsx";
import { DIAS_CORTOS, claveCarga } from "./piezas-b.tsx";
import { SelectorSucursalAnalitica, TODAS, nombreDe } from "./piezas-analitica.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const hora = (h: number): string => `${h}:00`;

export function CfoDemanda({ api, filtros }: CfoPaginaProps) {
  const { carga, recargando, recargar } = useCargaCfo(() => fetchDemanda(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [sel, setSel] = useState<string>(TODAS);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-demanda">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando la demanda…">
        {(v) => {
          const nombres = nombreDe(v.sucursales);
          const d = v.demanda;
          const hayTotal = d.sucursales.some((s) => s.propertyId === null);
          const clave = sel === TODAS ? (hayTotal ? null : (d.sucursales[0]?.propertyId ?? null)) : sel;
          const actual: DemandaSucursal | undefined = d.sucursales.find((s) => s.propertyId === clave);
          const semanas = d.semanas.filter((s) => s.propertyId === clave);
          const pago = d.pago.filter((p) => p.propertyId === clave);
          const ticket = d.ticket.filter((t) => t.propertyId === clave);
          const promesa = d.promesa.filter((p) => clave === null || p.propertyId === clave);
          const celdas: CeldaHeatmapUi[] = actual ? actual.celdas.map((c) => ({ fila: c.dow - 1, columna: c.hora, valor: c.pedidos })) : [];
          if (!actual) return <EstadoVacio icon={CalendarClock} titulo="Sin pedidos en el periodo" mensaje="Cuando haya ventas verás aquí qué días y horas pesan más." />;
          return (
            <>
              {d.avisos.map((a) => (
                <Callout key={a} tone="info" data-testid="demanda-aviso">
                  {a}
                </Callout>
              ))}
              <SelectorSucursalAnalitica nombre="analitica-demanda-sucursal" sucursales={v.sucursales} valor={sel} onChange={setSel} hayTotal={hayTotal} />
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="demanda-resumen">
                <StatCard icon={Receipt} label="Pedidos de venta" value={entero(actual.pedidos)} nota={pesos(actual.netaCentavos)} />
                <StatCard icon={Flame} label="Vie–Dom" value={porcentaje(actual.vieDom.pctPedidos)} nota={`${porcentaje(actual.vieDom.pctNeta)} de la venta`} {...(actual.vieDom.pctPedidos === null ? { sinDato: "Sin pedidos en el periodo." } : {})} />
                <StatCard
                  icon={Clock}
                  label="Horas pico"
                  value={actual.picos.length > 0 ? actual.picos.map((p) => hora(p.hora)).join(" y ") : SIN_DATO}
                  nota={actual.picos.length > 0 ? `${porcentaje(actual.picos.reduce((s, p) => s + (p.pctDelTotal ?? 0), 0))} de los pedidos` : undefined}
                  {...(actual.picos.length === 0 ? { sinDato: "Aún no hay pedidos para calcularlas." } : {})}
                />
                <StatCard icon={CalendarClock} label="Días con ventas" value={entero(d.diasConVenta)} nota="El historial corto limita las conclusiones" />
              </div>
              <ChartCard titulo="Pedidos por día y hora" subtitulo="Día de negocio y hora local de cada sucursal" tamano="L">
                <Heatmap celdas={celdas} formato={entero} metrica="pedidos" sinDatos="Sin pedidos en este periodo" />
                <TablaDatosGrafica
                  titulo="Pedidos por día y hora"
                  encabezados={["Día", "Hora", "Pedidos", "Venta neta"]}
                  filas={actual.celdas.map((c) => [DIAS_CORTOS[c.dow - 1] ?? String(c.dow), hora(c.hora), entero(c.pedidos), pesosExactos(c.netaCentavos)])}
                />
              </ChartCard>
              <div className="grid gap-2.5 lg:grid-cols-2">
                <ChartCard titulo="Franjas de refuerzo sugerido" subtitulo={actual.umbralRefuerzo === null ? "Sin datos" : `Celdas día × hora con ${entero(actual.umbralRefuerzo)} pedidos o más (percentil 80)`} tamano="M">
                  <DataTable<(typeof actual.refuerzo)[number]>
                    etiqueta="Franjas con más demanda"
                    filas={actual.refuerzo.slice(0, 10)}
                    obtenerId={(f) => `${f.dow}-${f.hora}`}
                    paginacion={false}
                    vista="tabla"
                    vacio={{ mensaje: "Sin franjas para sugerir todavía." }}
                    columnas={[
                      { id: "d", encabezado: "Día", principal: true, celda: (f) => DIAS_CORTOS[f.dow - 1] ?? String(f.dow) },
                      { id: "h", encabezado: "Hora", celda: (f) => hora(f.hora) },
                      { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                      { id: "v", encabezado: "Venta", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.netaCentavos) },
                    ]}
                  />
                </ChartCard>
                <ChartCard titulo="Tendencia semanal" subtitulo="Pedidos por semana (lunes). Una semana incompleta trae menos días" tamano="M">
                  <BarChartSimple datos={semanas.map((s) => ({ dia: s.semana.slice(5), valor: s.pedidos }))} etiquetaValor={entero} sinDatos="Sin semanas en este periodo" />
                  <TablaDatosGrafica
                    titulo="Pedidos por semana"
                    encabezados={["Semana", "Días con venta", "Pedidos", "Venta neta", "Cambio de pedidos"]}
                    filas={semanas.map((s) => [s.semana, entero(s.dias), entero(s.pedidos), pesosExactos(s.netaCentavos), s.variacionPedidosPct === null ? SIN_DATO : porcentaje(s.variacionPedidosPct)])}
                  />
                </ChartCard>
              </div>
              <div className="grid gap-2.5 lg:grid-cols-2">
                <ChartCard titulo="Canal y origen" subtitulo="Cómo llegan los pedidos" tamano="M">
                  <DataTable<{ readonly id: string; readonly pedidos: number; readonly netaCentavos: number }>
                    etiqueta="Pedidos por canal y origen"
                    filas={[...actual.porCanal.map((c) => ({ id: c.canal === "domicilio" ? "Domicilio" : c.canal === "recoger" ? "Recoger" : c.canal, pedidos: c.pedidos, netaCentavos: c.netaCentavos })), ...actual.porOrigen.map((o) => ({ id: o.source === "whatsapp" ? "WhatsApp" : o.source === "voice" ? "Voz" : o.source === "web" ? "Web" : o.source, pedidos: o.pedidos, netaCentavos: o.netaCentavos }))]}
                    obtenerId={(f) => f.id}
                    paginacion={false}
                    vista="tabla"
                    columnas={[
                      { id: "k", encabezado: "Canal / origen", principal: true, celda: (f) => f.id },
                      { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                      { id: "v", encabezado: "Venta", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.netaCentavos) },
                    ]}
                  />
                </ChartCard>
                <ChartCard titulo="Forma de pago" subtitulo="% de pedidos por forma de pago" tamano="M">
                  <Dona segmentos={pago.map((p) => ({ etiqueta: etiquetaFormaPago(p.formaPago), valor: p.pedidos }))} sinDatos="Sin pedidos en este periodo" />
                </ChartCard>
              </div>
              <ChartCard titulo="Ticket promedio" subtitulo="Promedio y, cuando es de una sola sucursal, mediana y percentil 90" tamano="M">
                <DataTable<(typeof ticket)[number]>
                  etiqueta="Ticket por canal"
                  filas={ticket}
                  obtenerId={(f) => `${f.propertyId}-${f.canal}`}
                  paginacion={false}
                  vista="tabla"
                  vacio={{ mensaje: "Sin tickets en este periodo." }}
                  columnas={[
                    { id: "c", encabezado: "Canal", principal: true, celda: (f) => (f.canal === "domicilio" ? "Domicilio" : f.canal === "recoger" ? "Recoger" : f.canal) },
                    { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                    { id: "t", encabezado: "Promedio", alinear: "right", className: "tabular-nums", celda: (f) => pesosExactos(f.ticketPromedioCentavos) },
                    { id: "m", encabezado: "Mediana", alinear: "right", className: "tabular-nums", celda: (f) => pesosExactos(f.medianaCentavos) },
                    { id: "q", encabezado: "Percentil 90", alinear: "right", className: "tabular-nums", celda: (f) => pesosExactos(f.p90Centavos) },
                  ]}
                />
              </ChartCard>
              <ChartCard titulo="Entrega real contra la promesa" subtitulo="Solo domicilios entregados con hora prometida; los demás se cuentan aparte" tamano="L">
                <DataTable<(typeof promesa)[number]>
                  etiqueta="Entrega real contra la promesa por sucursal"
                  filas={promesa}
                  obtenerId={(f) => f.propertyId}
                  paginacion={false}
                  vista="tabla"
                  vacio={{ mensaje: "Sin domicilios en este periodo." }}
                  columnas={[
                    { id: "s", encabezado: "Sucursal", principal: true, celda: (f) => nombres.get(f.propertyId) ?? SIN_DATO },
                    { id: "a", encabezado: "A tiempo", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(f.aTiempoPct) },
                    { id: "r", encabezado: "Real (mediana)", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.realMedianaMin) },
                    { id: "m", encabezado: "Prometido (mediana)", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.prometidoMedianaMin) },
                    { id: "x", encabezado: "Desvío (mediana)", alinear: "right", className: "tabular-nums", celda: (f) => minutos(f.desvioMedianaMin) },
                    { id: "n", encabezado: "Sin promesa", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sinPromesa) },
                    { id: "c", encabezado: "Sin cierre", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.sinCierre) },
                  ]}
                />
              </ChartCard>
            </>
          );
        }}
      </CargaCfoVista>
    </PageContainer>
  );
}
