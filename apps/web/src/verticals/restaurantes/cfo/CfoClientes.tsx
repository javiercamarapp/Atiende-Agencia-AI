// CFO-08 · pestaña Clientes: base y su evolución, activa / dormida / perdida, nuevos / recurrentes / frecuentes, cohortes 30/60/90 con mapa de calor por celda,
// churn y recuperados, recompra, concentración, horario preferido por segmento y la nota «el total no es la suma». Sin nombres, teléfonos ni direcciones:
// el drill-down lleva a pedidos con alias. Cifras `null` = «—».
import { useMemo, useState } from "react";
import { Repeat2, Settings2, UserPlus, Users } from "lucide-react";
import type { ClientesColumna, ClientesVista, CohorteApi } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, Button, Callout, ChartCard, DataTable, Dona, EstadoVacio, FormField, Heatmap, NativeSelect, PageContainer, StatCard, TablaDatosGrafica, cn } from "@atiende/ui";
import type { CeldaHeatmapUi } from "@atiende/ui";
import { AjustesCfoDialogo } from "./AjustesCfoDialogo.tsx";
import { fetchClientes } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, porcentaje, textoCifra } from "./formato.ts";
import { AvisosCfo, CargaCfoVista, ChipDeCifra } from "./piezas.tsx";
import { BotonPedidos, DIAS_CORTOS, claveCarga, diaCorto, rellenoCelda } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export const AVISO_MOSTRADOR = "Clientes = quienes pidieron por WhatsApp o voz; los clientes de mostrador no se identifican.";
type Segmento = "nuevo" | "recurrente" | "frecuente";
const ETIQUETA_SEGMENTO: Readonly<Record<Segmento, string>> = { nuevo: "Nuevos", recurrente: "Recurrentes", frecuente: "Frecuentes" };

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
  const r = total.resumen;
  const base = r.clientesConPedido;
  const nota = (n: number) => (pct(n, base) === null ? "Sin clientes con pedido" : `${porcentaje(pct(n, base))} de los clientes con pedido`);
  return (
    <div className="space-y-2" data-testid="clientes-resumen">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="Clientes con pedido en el periodo" value={entero(base)} nota="Únicos del conjunto, no la suma de sucursales" />
        <StatCard icon={UserPlus} label="Nuevos" value={entero(r.nuevos)} nota={nota(r.nuevos)} />
        <StatCard icon={Repeat2} label="Recurrentes" value={entero(r.recurrentes)} nota={nota(r.recurrentes)} />
        <StatCard icon={Users} label="Frecuentes" value={entero(total.segmentos.frecuentes)} nota={total.segmentos.frecuentesPct.valor === null ? "Sin clientes clasificados" : `${textoCifra(total.segmentos.frecuentesPct, "pct")} de tu base`} />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="clientes-leyenda-frecuente">
        <span>{leyenda}</span>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onAjustes}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          Editar en Ajustes del CFO
        </Button>
      </p>
    </div>
  );
}

function Altas({ d }: { readonly d: ClientesVista }) {
  const filas = altasSemanales(d);
  return (
    <ChartCard titulo="Clientes nuevos por semana" subtitulo="Altas: clientes cuyo primer pedido cayó en la semana (lunes a domingo)" tamano="M">
      {filas === null ? (
        <p role="status" className="py-6 text-center text-xs text-faint">
          Con varias sucursales las altas no se suman (un cliente puede darse de alta en dos): elige «Todas» o una sola sucursal.
        </p>
      ) : (
        <BarChartSimple datos={filas.map((a) => ({ dia: diaCorto(a.semana), valor: a.altas }))} etiquetaValor={entero} sinDatos="Sin altas de clientes en este periodo" />
      )}
      {filas !== null && <TablaDatosGrafica titulo="Clientes nuevos por semana" encabezados={["Semana del", "Clientes nuevos"]} filas={filas.map((a) => [diaCorto(a.semana), entero(a.altas)])} />}
    </ChartCard>
  );
}

function Base({ total }: { readonly total: ClientesColumna }) {
  const s = total.segmentos;
  const suma = s.activos + s.dormidos + s.perdidos;
  const filas = [
    { etiqueta: "Activos", n: s.activos },
    { etiqueta: "Dormidos", n: s.dormidos },
    { etiqueta: "Perdidos", n: s.perdidos },
  ];
  return (
    <ChartCard titulo="Base de clientes" subtitulo={`${entero(suma)} clientes clasificados por su último pedido`} tamano="M">
      <Dona segmentos={filas.map((f) => ({ etiqueta: `${f.etiqueta} · ${entero(f.n)}`, valor: f.n }))} sinDatos="Sin clientes en la base" />
      <TablaDatosGrafica titulo="Base de clientes" encabezados={["Segmento", "Clientes", "% de la base"]} filas={filas.map((f) => [f.etiqueta, entero(f.n), porcentaje(pct(f.n, suma))])} />
    </ChartCard>
  );
}

type VentanaRecompra = "recompra30" | "recompra60" | "recompra90";

/** Celda del mapa de calor de cohortes: un bloque con relleno de un solo tono según el % de recompra; «—» si la ventana aún no se cumple. */
function CeldaCohorte({ c, ventana }: { readonly c: CohorteApi; readonly ventana: VentanaRecompra }) {
  const v = c[ventana];
  const valor = v.pct.valor;
  const { clase, fuerte } = rellenoCelda(valor, 100);
  return (
    <div className={cn("rounded-md px-2 py-1 text-right tabular-nums", clase, fuerte && "text-primary-foreground")} data-testid="cohorte-celda" data-valor={valor ?? ""}>
      {valor === null ? SIN_DATO : porcentaje(valor)}
      <span className="block text-2xs opacity-80">{valor === null ? "aún no observable" : `${entero(v.con)} de ${entero(v.observables)}`}</span>
    </div>
  );
}

function Cohortes({ d }: { readonly d: ClientesVista }) {
  const cs = cohortesDelAlcance(d);
  const acum = (ventana: VentanaRecompra) => {
    const con = cs.reduce((s, c) => s + c[ventana].con, 0);
    const obs = cs.reduce((s, c) => s + c[ventana].observables, 0);
    return { con, obs, pct: pct(con, obs) };
  };
  const ventana = (id: VentanaRecompra, encabezado: string) => ({ id, encabezado, alinear: "right" as const, celda: (c: CohorteApi) => <CeldaCohorte c={c} ventana={id} /> });
  return (
    <ChartCard titulo="Recompra por cohorte" subtitulo="De los clientes que hicieron su primer pedido en el mes, cuántos volvieron a pedir en 30, 60 y 90 días" tamano="M">
      <div data-testid="cohortes-tabla">
        <DataTable<CohorteApi>
          etiqueta="Cohortes de recompra a 30, 60 y 90 días"
          filas={cs}
          obtenerId={(c) => c.mesCohorte}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: "Sin cohortes para esta selección." }}
          columnas={[
            { id: "mes", encabezado: "Mes del primer pedido", principal: true, celda: (c) => c.mesCohorte },
            { id: "clientes", encabezado: "Clientes", alinear: "right", className: "tabular-nums", celda: (c) => entero(c.clientes) },
            ventana("recompra30", "A 30 días"),
            ventana("recompra60", "A 60 días"),
            ventana("recompra90", "A 90 días"),
          ]}
        />
      </div>
      {cs.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="recompra-acumulada">
          Recompra de todas las cohortes observables: a 30 días {porcentaje(acum("recompra30").pct)}, a 60 días {porcentaje(acum("recompra60").pct)}, a 90 días {porcentaje(acum("recompra90").pct)}. Una celda con «—» aún no cumple su ventana.
        </p>
      )}
    </ChartCard>
  );
}

function ChurnYRecuperados({ total }: { readonly total: ClientesColumna }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="clientes-churn">
      <StatCard
        icon={Users}
        label="Churn del periodo"
        value={textoCifra(total.churn, "pct")}
        nota="Clientes activos al inicio que ya cumplen el tiempo de «perdido»"
        {...(total.churn.valor === null ? { sinDato: "Aún no hay clientes activos al inicio del periodo para medirlo." } : {})}
      />
      <StatCard icon={Repeat2} label="Clientes recuperados" value={entero(total.winBack.recuperados)} nota="Volvieron a pedir después de estar dormidos" />
      <StatCard icon={Repeat2} label="Recuperados por campaña" value={entero(total.winBack.recuperadosPorCampana)} nota="Atribuido, no causal: pidieron tras recibir una campaña" />
      <StatCard icon={Users} label="Días entre pedidos (mediana)" value={total.diasEntrePedidosMediana.valor === null ? SIN_DATO : `${entero(total.diasEntrePedidosMediana.valor)} días`} nota="Mitad de los clientes repite antes de este plazo" />
    </div>
  );
}

function Valor({ total }: { readonly total: ClientesColumna }) {
  const r = total.resumen;
  return (
    <div className="grid gap-2.5 sm:grid-cols-3" data-testid="clientes-valor">
      <StatCard
        icon={Users}
        label="Valor de vida simple"
        value={textoCifra(total.valorDeVida, "centavos")}
        nota="Ticket × pedidos por cliente en 12 meses (estimado)"
        {...(total.valorDeVida.valor === null ? { sinDato: "Sin pedidos suficientes para estimarlo." } : {})}
      />
      <StatCard icon={Repeat2} label="Pedidos por cliente (12 meses)" value={r.pedidosPorCliente12mPromedio === null ? SIN_DATO : String(r.pedidosPorCliente12mPromedio)} nota="Promedio de la base completa" />
      <StatCard
        icon={Users}
        label="Concentración"
        value={textoCifra(total.concentracion, "pct")}
        nota={total.concentracion.valor === null ? "Sin ventas a clientes identificados" : `El 10 % de tus clientes genera el ${porcentaje(total.concentracion.valor)} de la venta`}
      />
    </div>
  );
}

function PorSegmento({ d }: { readonly d: ClientesVista }) {
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
      <ChartCard titulo="Ticket por segmento" subtitulo="Pedidos del periodo de cada segmento de cliente" tamano="M">
        <DataTable<(typeof porSegmento)[number]>
          etiqueta="Ticket y pedidos por segmento de cliente"
          filas={porSegmento}
          obtenerId={(f) => f.segmento}
          paginacion={false}
          vista="tabla"
          vacio={{ mensaje: "Sin pedidos de clientes identificados en este periodo." }}
          columnas={[
            { id: "segmento", encabezado: "Segmento", principal: true, celda: (f) => ETIQUETA_SEGMENTO[f.segmento] },
            { id: "pedidos", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
            { id: "part", encabezado: "% de pedidos", alinear: "right", className: "tabular-nums", celda: (f) => porcentaje(pct(f.pedidos, totalPedidos)) },
            { id: "ticket", encabezado: "Ticket", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ticket) },
          ]}
        />
        <p className="mt-2 text-2xs text-muted-foreground">Un cliente cuenta en un solo segmento. «—» = sin pedidos del segmento.</p>
      </ChartCard>
      <ChartCard
        titulo="Horario preferido por segmento"
        subtitulo="Pedidos por día de negocio y hora"
        tamano="M"
        accion={
          <FormField label="Segmento" className="w-40">
            <NativeSelect size="sm" value={elegido} onChange={(e) => setElegido(e.target.value as Segmento)} data-testid="segmento-horario">
              {segmentos.map((s) => (
                <option key={s} value={s}>
                  {ETIQUETA_SEGMENTO[s]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        }
      >
        <Heatmap celdas={celdas} formato={entero} metrica="pedidos" sinDatos="Sin pedidos de este segmento en el periodo" />
        <TablaDatosGrafica
          titulo={`Pedidos de ${ETIQUETA_SEGMENTO[elegido].toLowerCase()} por día y hora`}
          encabezados={["Día", "Hora", "Pedidos"]}
          filas={[...celdas].filter((c) => c.valor !== null).sort((a, b) => a.fila - b.fila || a.columna - b.columna).map((c) => [DIAS_CORTOS[c.fila] ?? String(c.fila + 1), `${c.columna} h`, entero(c.valor)])}
        />
      </ChartCard>
    </div>
  );
}

function PorSucursal({ d }: { readonly d: ClientesVista }) {
  type Fila = ClientesVista["porSucursal"][number];
  return (
    <ChartCard titulo="Clientes por sucursal" subtitulo="Cada cliente cuenta en cada sucursal donde compró" tamano="S">
      <DataTable<Fila>
        etiqueta="Clientes por sucursal"
        filas={d.porSucursal}
        obtenerId={(f) => f.propertyId}
        paginacion={false}
        vista="tabla"
        vacio={{ mensaje: "Sin sucursales en esta selección." }}
        columnas={[
          { id: "n", encabezado: "Sucursal", principal: true, celda: (f) => f.nombre },
          { id: "c", encabezado: "Con pedido", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.clientesConPedido) },
          { id: "nu", encabezado: "Nuevos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.nuevos) },
          { id: "re", encabezado: "Recurrentes", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.resumen.recurrentes) },
          { id: "fr", encabezado: "Frecuentes", alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.segmentos.frecuentes)} (${textoCifra(f.segmentos.frecuentesPct, "pct")})` },
          { id: "ac", encabezado: "Activos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.activos) },
          { id: "do", encabezado: "Dormidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.dormidos) },
          { id: "pe", encabezado: "Perdidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.segmentos.perdidos) },
          { id: "ch", encabezado: "Churn", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.churn, "pct") },
          { id: "co", encabezado: "Concentración", alinear: "right", className: "tabular-nums", celda: (f) => textoCifra(f.concentracion, "pct") },
          { id: "vv", encabezado: "Valor de vida", alinear: "right", className: "tabular-nums", celda: (f) => <span className="inline-flex items-center justify-end gap-1">{textoCifra(f.valorDeVida, "centavos")}<ChipDeCifra cifra={f.valorDeVida} /></span> },
        ]}
      />
    </ChartCard>
  );
}

function Contenido({ d, props, onAjustes }: { readonly d: ClientesVista; readonly props: CfoPaginaProps; readonly onAjustes: () => void }) {
  const total = useMemo(() => totalDe(d), [d]);
  const leyenda = d.definiciones["frecuente"] ?? "Frecuente = 3+ pedidos en 90 días.";
  const varias = d.porSucursal.length > 1;
  return (
    <>
      <Callout tone="neutral" data-testid="clientes-aviso-mostrador">
        {AVISO_MOSTRADOR}
      </Callout>
      <AvisosCfo vista={d} />
      {total === null ? (
        <EstadoVacio icon={Users} titulo="Sin datos de clientes en esta selección" mensaje="Todavía no hay clientes identificados en el periodo elegido. Cuando alguien pida por WhatsApp o voz, aquí verás su evolución." />
      ) : (
        <>
          <Resumen total={total} leyenda={leyenda} onAjustes={onAjustes} />
          {varias && (
            <Callout tone="info" data-testid="clientes-multisucursal">
              {d.multiSucursal.clientes === null ? "Sin dato de clientes que compraron en más de una sucursal." : `${d.multiSucursal.texto ?? `${entero(d.multiSucursal.clientes)} clientes compraron en más de una sucursal`}: el total no es la suma de las sucursales (suman ${entero(d.multiSucursal.sumaPorSucursal)}, el total real es ${entero(total.resumen.clientesConPedido)}).`}
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
            <BotonPedidos etiqueta="Ver pedidos del periodo (con alias de cliente)" onClick={() => props.abrirPedidos({})} />
            <span className="text-xs text-muted-foreground">Cada pedido muestra un alias de 8 caracteres, nunca el nombre ni el teléfono.</span>
          </div>
          {props.filtros.vista === "sucursal" && <PorSucursal d={d} />}
        </>
      )}
      {d.pedidosSinCliente > 0 && <p className="text-xs text-muted-foreground">{entero(d.pedidosSinCliente)} pedidos del periodo no tienen un cliente identificado y no entran en estas cifras.</p>}
    </>
  );
}

export function CfoClientes(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const { carga, recargando, recargar } = useCargaCfo(() => fetchClientes(api, filtros), [claveCarga(filtros), api.propertyId, api.token]);
  const [ajustes, setAjustes] = useState(false);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-clientes">
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando los clientes…">
        {(d) => <Contenido d={d} props={props} onAjustes={() => setAjustes(true)} />}
      </CargaCfoVista>
      <AjustesCfoDialogo abierto={ajustes} onCerrar={() => setAjustes(false)} api={api} onGuardado={recargar} />
    </PageContainer>
  );
}
