// CFO «Análisis de clientes» (Fase A, solo lectura): resumen, segmentos RFM, concentración (Pareto), reactivación priorizada, intervalo de recompra, productos
// con afinidad (soporte, confianza y lift) y tortilla. Cada bloque tiene carga, error, vacío y «no disponible aún: requiere …», y una definición con su periodo
// en el tooltip. Sin nombres, teléfonos ni direcciones: los clientes se muestran con un alias de 8 caracteres. Esta pantalla no envía nada ni crea campañas.
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, Clock, Info, PlugZap, Repeat2, TrendingDown, Users } from "lucide-react";
import type { AfinidadAnalisis, AnalisisClientesVista, ConsentimientoMarketing, FilaIntervaloRecompra, FilaReactivacion, ParAfinidadApi, ParetoRfm, SeccionAnalisis } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, ChartCard, Callout, DataTable, EstadoCargando, EstadoVacio, PageContainer, Selector, StatCard, StatusBadge, TablaDatosGrafica, Popover, PopoverContent, PopoverTrigger } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { fetchAnalisisClientes } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, porcentaje } from "./formato.ts";
import { AvisosCfo, CargaCfoVista } from "./piezas.tsx";
import { claveCarga, diaCorto } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const LIMITES = [25, 50, 100, 200] as const;
const decimal = (n: number | null | undefined): string => (n === null || n === undefined ? SIN_DATO : String(n));
const dias = (n: number | null | undefined): string => (n === null || n === undefined ? SIN_DATO : `${decimal(n)} d`);
const pctDe = (parte: number, total: number): number | null => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

const CONSENTIMIENTO: Readonly<Record<ConsentimientoMarketing, { readonly texto: string; readonly tono: StatusTone }>> = {
  otorgado: { texto: "Otorgado", tono: "success" },
  revocado: { texto: "Revocado", tono: "danger" },
  sin_registro: { texto: "Sin registro", tono: "neutral" },
};

// ---- Marco de un bloque ---------------------------------------------------------------------------------------------------------------

/**
 * Definición + periodo del bloque. Es un Popover (abre con clic, Enter o Espacio: sirve con teclado y en pantallas táctiles, donde un tooltip de cursor no existe).
 * El texto también va en el nombre accesible del botón, así que un lector de pantalla lo anuncia sin abrirlo.
 */
function Definicion({ titulo, texto, periodo }: { readonly titulo: string; readonly texto: string; readonly periodo: string }) {
  const completo = `${texto} Periodo: ${periodo}.`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Definición de ${titulo}: ${completo}`}
          data-testid="definicion"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-xs text-sm" data-testid="definicion-texto">
        <p>{texto}</p>
        <p className="mt-1 text-muted-foreground">Periodo: {periodo}</p>
      </PopoverContent>
    </Popover>
  );
}

function NoDisponibleBloque({ motivo }: { readonly motivo: string }) {
  return <EstadoVacio compacto icon={PlugZap} titulo="No disponible aún" mensaje={motivo} />;
}

interface BloqueProps<T> {
  readonly id: string;
  readonly titulo: string;
  readonly subtitulo?: string;
  readonly definicion: string;
  readonly periodo: string;
  /** null = todavía cargando. */
  readonly seccion: SeccionAnalisis<T> | null;
  readonly children: (datos: T) => ReactNode;
}

function Bloque<T>({ id, titulo, subtitulo, definicion, periodo, seccion, children }: BloqueProps<T>) {
  return (
    <section aria-label={titulo} data-testid={`bloque-${id}`} data-estado={seccion === null ? "cargando" : seccion.disponible ? "listo" : "no_disponible"}>
      <ChartCard titulo={titulo} {...(subtitulo ? { subtitulo } : {})} tamano="S" accion={<Definicion titulo={titulo} texto={definicion} periodo={periodo} />}>
        {seccion === null ? <EstadoCargando etiqueta={`Cargando ${titulo.toLowerCase()}…`} /> : !seccion.disponible || seccion.datos === null ? <NoDisponibleBloque motivo={seccion.motivo ?? "No disponible aún."} /> : children(seccion.datos)}
      </ChartCard>
    </section>
  );
}

// ---- Bloques --------------------------------------------------------------------------------------------------------------------------

function Resumen({ d }: { readonly d: AnalisisClientesVista }) {
  return (
    <Bloque id="resumen" titulo="Resumen" subtitulo="Clientes con venta identificada en el periodo" definicion={d.definiciones["resumen"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.resumen}>
      {(r) =>
        r.clientesConVenta === 0 ? (
          <EstadoVacio compacto icon={Users} titulo="Sin clientes con venta en este periodo" mensaje="Cuando alguien pida por WhatsApp o voz dentro del periodo elegido, aquí verás su comportamiento." />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5" data-testid="analisis-resumen">
            <StatCard icon={Users} label="Clientes con venta" value={entero(r.clientesConVenta)} nota={`${entero(r.activos30)} compraron en los últimos 30 días del periodo`} />
            <StatCard icon={Repeat2} label="Recompra" value={porcentaje(r.recompraPct)} nota={`${entero(r.clientesRecompra)} clientes con 2 o más ventas`} />
            <StatCard icon={Clock} label="Intervalo mediano" value={dias(r.intervaloMedianoDias)} nota={r.intervaloMedianoDias === null ? "Menos de 5 intervalos: sin dato" : "Entre una compra y la siguiente"} />
            <StatCard icon={TrendingDown} label="Dormidos" value={entero(r.dormidos)} nota="Con 2+ ventas y sin pedir más de lo habitual" />
            <StatCard icon={Activity} label="Venta en riesgo" value={pesos(r.ventaEnRiesgoCentavos)} nota={`De ${pesos(r.ventaTotalCentavos)} vendidos; dormidos y en riesgo de alto valor`} />
          </div>
        )
      }
    </Bloque>
  );
}

function Segmentos({ d }: { readonly d: AnalisisClientesVista }) {
  const totalVenta = d.secciones.resumen.datos?.ventaTotalCentavos ?? 0;
  const totalClientes = d.secciones.resumen.datos?.clientesConVenta ?? 0;
  return (
    <Bloque id="segmentos" titulo="Segmentos RFM" subtitulo="Recencia, frecuencia y monto de cada cliente" definicion={`${d.definiciones["recencia"] ?? ""} ${d.definiciones["frecuencia"] ?? ""} ${d.definiciones["monetario"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={d.secciones.segmentos}>
      {(s) =>
        totalClientes === 0 ? (
          <EstadoVacio compacto icon={Users} titulo="Sin clientes para segmentar" mensaje="No hay ventas con cliente identificado en el periodo." />
        ) : (
          <div className="space-y-2">
            {s.pocosClientes && <Callout tone="warning" data-testid="segmentos-pocos">Con menos de 5 clientes los puntajes de recencia y monto no son estables.</Callout>}
            <DataTable
              etiqueta="Segmentos RFM"
              filas={s.segmentos}
              obtenerId={(f) => f.segmento}
              paginacion={false}
              atributosFila={(f) => ({ "data-segmento": f.segmento })}
              columnas={[
                { id: "s", encabezado: "Segmento", principal: true, celda: (f) => <span title={f.definicion}>{f.etiqueta}</span> },
                { id: "c", encabezado: "Clientes", alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.clientes)} (${porcentaje(pctDe(f.clientes, totalClientes))})` },
                { id: "v", encabezado: "Venta", alinear: "right", className: "tabular-nums", celda: (f) => `${pesos(f.ventaCentavos)} (${porcentaje(pctDe(f.ventaCentavos, totalVenta))})` },
                { id: "t", encabezado: "Ticket", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ticketCentavos) },
                { id: "r", encabezado: "Recencia mediana", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.recenciaMedianaDias) },
              ]}
            />
            <details className="text-xs text-muted-foreground" data-testid="segmentos-definiciones">
              <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cómo se define cada segmento</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {s.segmentos.map((f) => (
                  <li key={f.segmento}>
                    <strong className="font-medium text-foreground">{f.etiqueta}:</strong> {f.definicion}
                  </li>
                ))}
              </ul>
              <p className="mt-1">Se evalúan en este orden y gana el primero que cumpla. {d.definiciones["dormido"]}</p>
            </details>
          </div>
        )
      }
    </Bloque>
  );
}

function Concentracion({ d }: { readonly d: AnalisisClientesVista }) {
  return (
    <Bloque id="concentracion" titulo="Concentración (Pareto)" subtitulo="Qué parte de la venta reúnen tus mejores clientes" definicion={d.definiciones["concentracion"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.concentracion}>
      {(p: ParetoRfm) =>
        p.puntos.length === 0 ? (
          <EstadoVacio compacto icon={Users} titulo="Sin ventas para medir la concentración" mensaje="No hay ventas con cliente identificado en el periodo." />
        ) : (
          <div className="space-y-2">
            <p className="text-sm" data-testid="pareto-texto">
              {p.clientesPara50Pct === null ? null : <span>El {porcentaje(p.clientesPara50Pct)} de tus clientes reúne el 50 % de la venta</span>}
              {p.clientesPara80Pct === null ? null : <span>{p.clientesPara50Pct === null ? "El" : " y el"} {porcentaje(p.clientesPara80Pct)} reúne el 80 %</span>}
              .
            </p>
            <BarChartSimple datos={p.puntos.map((x) => ({ dia: `${x.clientesPct} %`, valor: x.ventaPct }))} etiquetaValor={(v) => porcentaje(v)} sinDatos="Sin ventas en este periodo" />
            <TablaDatosGrafica titulo="Concentración de la venta" encabezados={["Clientes (los de mayor venta)", "Clientes", "% acumulado de la venta"]} filas={p.puntos.map((x) => [`Primeros ${x.clientesPct} %`, entero(x.clientes), porcentaje(x.ventaPct)])} />
          </div>
        )
      }
    </Bloque>
  );
}

function Reactivacion({ d, limite, onLimite, base }: { readonly d: AnalisisClientesVista; readonly limite: number; readonly onLimite: (n: number) => void; readonly base: string }) {
  return (
    <Bloque id="reactivacion" titulo="Reactivación priorizada" subtitulo="Clientes que ya tardan más de lo habitual en volver" definicion={`${d.definiciones["reactivacion"] ?? ""} ${d.definiciones["prioridad"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={d.secciones.reactivacion}>
      {(r) => (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-sm" data-testid="reactivacion-resumen">
              {entero(r.totalElegibles)} clientes por reactivar · {pesos(r.ventaEnJuegoCentavos)} de venta del periodo en juego · {entero(r.dormidos)} dormidos. Consentimiento de mensajes: {entero(r.consentimiento.otorgado)} otorgado, {entero(r.consentimiento.revocado)} revocado, {entero(r.consentimiento.sinRegistro)} sin registro.
            </p>
            <div className="w-full sm:w-44">
              <label htmlFor="analisis-limite" className="mb-1 block text-xs text-muted-foreground">
                Clientes por mostrar
              </label>
              <Selector id="analisis-limite" size="sm" value={String(limite)} onChange={(e) => onLimite(Number(e.target.value))} data-testid="analisis-limite">
                {LIMITES.map((n) => (
                  <option key={n} value={String(n)}>
                    {n} clientes
                  </option>
                ))}
              </Selector>
            </div>
          </div>
          {r.filas.length === 0 ? (
            <EstadoVacio compacto icon={Users} titulo="Nadie por reactivar" mensaje="Ningún cliente con 2 o más ventas supera su ritmo de recompra en este periodo." />
          ) : (
            <DataTable
              etiqueta="Clientes por reactivar"
              filas={r.filas}
              obtenerId={(f) => f.alias}
              paginacion={false}
              atributosFila={(f) => ({ "data-alias": f.alias })}
              columnas={[
                { id: "a", encabezado: "Cliente (alias)", principal: true, celda: (f) => <code className="font-mono text-xs">{f.alias}</code> },
                { id: "u", encabezado: "Última venta", alinear: "right", className: "tabular-nums", celda: (f) => diaCorto(f.ultimaVenta) },
                { id: "ds", encabezado: "Sin pedir", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.diasSinPedir) },
                { id: "i", encabezado: "Su ritmo", alinear: "right", className: "tabular-nums", celda: (f) => (f.intervaloMedianoDias === null ? "Sin ritmo propio" : `cada ${decimal(f.intervaloMedianoDias)} d`) },
                { id: "v", encabezado: "Venta del periodo", alinear: "right", className: "tabular-nums", celda: (f) => `${pesos(f.ventaCentavos)} · ${entero(f.ventas)} ventas` },
                { id: "p", encabezado: "Prioridad", alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.prioridadCentavos) },
                { id: "e", encabezado: "Estado", celda: (f: FilaReactivacion) => (f.dormido ? <StatusBadge tone="warning">Dormido</StatusBadge> : <StatusBadge tone="neutral">Pasado su ritmo</StatusBadge>) },
                { id: "k", encabezado: "Consentimiento", celda: (f: FilaReactivacion) => <StatusBadge tone={CONSENTIMIENTO[f.consentimiento].tono}>{CONSENTIMIENTO[f.consentimiento].texto}</StatusBadge> },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground" data-testid="reactivacion-nota">
            Esta pantalla solo muestra; no envía mensajes. Para contactar a clientes con consentimiento otorgado, crea una campaña en{" "}
            <Link to={`${base}/campanas`} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Campañas
            </Link>
            .
          </p>
        </div>
      )}
    </Bloque>
  );
}

function Intervalo({ d }: { readonly d: AnalisisClientesVista }) {
  const etiqueta = (f: FilaIntervaloRecompra): string => (f.segmento === "global" ? "Todos los clientes" : (d.secciones.segmentos.datos?.segmentos.find((s) => s.segmento === f.segmento)?.etiqueta ?? f.segmento));
  return (
    <Bloque id="intervalo" titulo="Intervalo de recompra" subtitulo="Días entre una compra y la siguiente" definicion={d.definiciones["intervalo"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.intervalo}>
      {(filas) => {
        const conDato = filas.filter((f) => f.intervalos > 0);
        return conDato.length === 0 ? (
          <EstadoVacio compacto icon={Clock} titulo="Aún no hay compras repetidas" mensaje="Cuando un cliente compre en dos días distintos del periodo, aquí verás cada cuántos días vuelve." />
        ) : (
          <DataTable
            etiqueta="Intervalo de recompra por segmento"
            filas={conDato}
            obtenerId={(f) => f.segmento}
            paginacion={false}
            columnas={[
              { id: "s", encabezado: "Grupo", principal: true, celda: etiqueta },
              { id: "n", encabezado: "Intervalos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.intervalos) },
              { id: "p25", encabezado: "p25", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p25) },
              { id: "p50", encabezado: "Mediana", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p50) },
              { id: "p75", encabezado: "p75", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p75) },
              { id: "p90", encabezado: "p90", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p90) },
            ]}
          />
        );
      }}
    </Bloque>
  );
}

function Afinidad({ d }: { readonly d: AnalisisClientesVista }) {
  return (
    <Bloque id="afinidad" titulo="Productos que se piden juntos" subtitulo="Soporte, confianza y lift de cada par" definicion={`${d.definiciones["soporte"] ?? ""} ${d.definiciones["confianza"] ?? ""} ${d.definiciones["lift"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={d.secciones.afinidad}>
      {(a: AfinidadAnalisis) => (
        <div className="space-y-2">
          {a.pares.length === 0 ? (
            <EstadoVacio compacto icon={Users} titulo="Sin pares frecuentes" mensaje={`Ningún par de productos se pidió junto en ${a.minimoPedidos} o más pedidos en este periodo.`} />
          ) : (
            <DataTable
              etiqueta="Pares de productos con afinidad"
              filas={a.pares}
              obtenerId={(f: ParAfinidadApi) => `${f.productoA}|${f.productoB}`}
              paginacion={false}
              columnas={[
                { id: "p", encabezado: "Productos", principal: true, celda: (f: ParAfinidadApi) => `${f.nombreA} + ${f.nombreB}` },
                { id: "j", encabezado: "Pedidos juntos", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => entero(f.pedidosJuntos) },
                { id: "s", encabezado: "Soporte", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.soportePct) },
                { id: "c1", encabezado: "Confianza A→B", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.confianzaAB) },
                { id: "c2", encabezado: "Confianza B→A", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.confianzaBA) },
                { id: "l", encabezado: "Lift", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => (f.lift === null ? SIN_DATO : f.lift.toFixed(2)) },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground" data-testid="afinidad-nota">
            Solo se muestran pares con {a.minimoPedidos} o más pedidos juntos{a.ocultosPorPrivacidad > 0 ? ` (${entero(a.ocultosPorPrivacidad)} pares con menos pedidos se ocultan por privacidad)` : ""}. A→B = de los pedidos con el primer producto, cuántos llevan también el segundo.
            {a.multiSucursal ? " Con varias sucursales el lift es una cota superior." : ""}
          </p>
        </div>
      )}
    </Bloque>
  );
}

function Tortilla({ d }: { readonly d: AnalisisClientesVista }) {
  return (
    <Bloque id="tortilla" titulo="Tortilla en los pedidos" subtitulo="Maíz, harina o mixta" definicion={d.definiciones["tortilla"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.tortilla}>
      {(t) => {
        const total = t.tortilla.reduce((s, x) => s + x.renglones, 0);
        return (
          <div className="space-y-2">
            {total === 0 ? (
              <EstadoVacio compacto icon={Users} titulo="Sin renglones con tortilla" mensaje={`Ningún renglón del periodo trae tortilla elegida (${entero(t.pedidosConItems)} pedidos con detalle).`} />
            ) : (
              <DataTable
                etiqueta="Tortilla por tipo"
                filas={t.tortilla}
                obtenerId={(f) => f.tipo}
                paginacion={false}
                columnas={[
                  { id: "t", encabezado: "Tortilla", principal: true, celda: (f) => f.etiqueta },
                  { id: "r", encabezado: "Renglones", alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.renglones)} (${porcentaje(pctDe(f.renglones, total))})` },
                  { id: "u", encabezado: "Unidades", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.unidades) },
                  { id: "p", encabezado: "Pedidos", alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                ]}
              />
            )}
            <p className="text-xs text-muted-foreground" data-testid="tortilla-salsas">
              Salsas y omisiones: {t.salsas.motivo}
            </p>
          </div>
        );
      }}
    </Bloque>
  );
}

function Pendientes({ d }: { readonly d: AnalisisClientesVista }) {
  return (
    <section aria-label="Lo que todavía no está disponible" data-testid="bloque-pendientes">
      <ChartCard titulo="Todavía no disponible" subtitulo="Lo que necesita datos que hoy no se guardan; no se simula" tamano="S">
        <ul className="space-y-2" data-testid="pendientes-lista">
          {d.pendientes.map((p) => (
            <li key={p.clave} data-clave={p.clave} className="text-sm">
              <span className="font-medium">{p.titulo}.</span> <span className="text-muted-foreground">{p.motivo}</span>
            </li>
          ))}
        </ul>
      </ChartCard>
    </section>
  );
}

const periodoTexto = (d: AnalisisClientesVista): string => `${diaCorto(d.periodo.desde)} a ${diaCorto(d.periodo.hasta)} (${entero(d.periodo.dias)} días)`;

function Contenido({ d, props, limite, onLimite }: { readonly d: AnalisisClientesVista; readonly props: CfoPaginaProps; readonly limite: number; readonly onLimite: (n: number) => void }) {
  return (
    <>
      <div className="space-y-2.5">
        <Callout tone="neutral" data-testid="analisis-periodo">
          Periodo: {periodoTexto(d)}. La recencia se mide contra el último día del periodo. Los clientes aparecen con un alias de 8 caracteres, nunca con nombre ni teléfono.
        </Callout>
        <AvisosCfo vista={d} />
        <Resumen d={d} />
        <Segmentos d={d} />
        <Concentracion d={d} />
        <Reactivacion d={d} limite={limite} onLimite={onLimite} base={props.base} />
        <Intervalo d={d} />
        <Afinidad d={d} />
        <Tortilla d={d} />
        <Pendientes d={d} />
      </div>
    </>
  );
}

/** Esqueleto: cada bloque muestra su propia carga mientras llega la respuesta. */
function Esqueleto() {
  const bloques: ReadonlyArray<readonly [string, string]> = [["resumen", "Resumen"], ["segmentos", "Segmentos RFM"], ["concentracion", "Concentración (Pareto)"], ["reactivacion", "Reactivación priorizada"], ["afinidad", "Productos que se piden juntos"]];
  return (
    <>
      <div className="space-y-2.5" data-testid="analisis-cargando">
        {bloques.map(([id, titulo]) => (
          <Bloque key={id} id={id} titulo={titulo} definicion="" periodo="" seccion={null}>
            {() => null}
          </Bloque>
        ))}
      </div>
    </>
  );
}

export function CfoAnalisisClientes(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const [limite, setLimite] = useState<number>(50);
  const { carga, recargando, recargar } = useCargaCfo(() => fetchAnalisisClientes(api, filtros, limite), [claveCarga(filtros), api.propertyId, api.token, limite]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-analisis-clientes">
      {carga.estado === "cargando" ? (
        <Esqueleto />
      ) : (
        <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando el análisis de clientes…">
          {(d) => <Contenido d={d} props={props} limite={limite} onLimite={setLimite} />}
        </CargaCfoVista>
      )}
    </PageContainer>
  );
}
