// CFO «Análisis de clientes» (Fase A, solo lectura): resumen, segmentos RFM, concentración (Pareto), reactivación priorizada, intervalo de recompra, productos
// con afinidad (soporte, confianza y lift) y tortilla. Cada bloque tiene carga, error, vacío y «no disponible aún: requiere …», y una definición con su periodo
// en el tooltip. Sin nombres, teléfonos ni direcciones: los clientes se muestran con un alias de 8 caracteres. Esta pantalla no envía nada ni crea campañas.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, Clock, Info, PlugZap, Repeat2, TrendingDown, Users } from "lucide-react";
import type { AfinidadAnalisis, AnalisisClientesVista, ConsentimientoMarketing, FilaIntervaloRecompra, FilaReactivacion, ParAfinidadApi, ParetoRfm, ReactivacionAnalisis, SeccionAnalisis } from "@atiende/domain-restaurantes/cfo";
import { BarChartSimple, ChartCard, Callout, DataTable, EstadoCargando, EstadoVacio, PageContainer, Selector, StatCard, StatusBadge, TablaDatosGrafica, Popover, PopoverContent, PopoverTrigger, traductorActivo, useT } from "@atiende/ui";
import type { Clave, StatusTone } from "@atiende/ui";
import { restaurantesCfoAnalisis } from "@atiende/ui/i18n/restaurantes/cfoAnalisis";
import { fetchAnalisisClientes } from "./cfo-client.ts";
import type { CfoPaginaProps } from "./contexto.ts";
import { SIN_DATO, entero, pesos, porcentaje } from "./formato.ts";
import { AvisosCfo, CargaCfoVista } from "./piezas.tsx";
import { claveCarga, diaCorto } from "./piezas-b.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

const tr = traductorActivo(restaurantesCfoAnalisis);
const LIMITES = [25, 50, 100, 200] as const;
const decimal = (n: number | null | undefined): string => (n === null || n === undefined ? SIN_DATO : String(n));
const dias = (n: number | null | undefined): string => (n === null || n === undefined ? SIN_DATO : tr("restaurantes.cfoAnalisis.dias", { n: decimal(n) }));
const pctDe = (parte: number, total: number): number | null => (total > 0 ? Math.round((parte / total) * 1000) / 10 : null);

const CONSENTIMIENTO: Readonly<Record<ConsentimientoMarketing, { readonly clave: Clave; readonly tono: StatusTone }>> = {
  otorgado: { clave: "restaurantes.cfoAnalisis.consent.otorgado", tono: "success" },
  revocado: { clave: "restaurantes.cfoAnalisis.consent.revocado", tono: "danger" },
  sin_registro: { clave: "restaurantes.cfoAnalisis.consent.sin_registro", tono: "neutral" },
};

// ---- Marco de un bloque ---------------------------------------------------------------------------------------------------------------

/**
 * Definición + periodo del bloque. Es un Popover (abre con clic, Enter o Espacio: sirve con teclado y en pantallas táctiles, donde un tooltip de cursor no existe).
 * El texto también va en el nombre accesible del botón, así que un lector de pantalla lo anuncia sin abrirlo.
 */
function Definicion({ titulo, texto, periodo }: { readonly titulo: string; readonly texto: string; readonly periodo: string }) {
  const t = useT(restaurantesCfoAnalisis);
  const completo = t("restaurantes.cfoAnalisis.defCompleta", { texto, periodo });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("restaurantes.cfoAnalisis.defAria", { titulo, completo })}
          data-testid="definicion"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-xs text-sm" data-testid="definicion-texto">
        <p>{texto}</p>
        <p className="mt-1 text-muted-foreground">{t("restaurantes.cfoAnalisis.periodo", { periodo })}</p>
      </PopoverContent>
    </Popover>
  );
}

function NoDisponibleBloque({ motivo }: { readonly motivo: string }) {
  const t = useT(restaurantesCfoAnalisis);
  return <EstadoVacio compacto icon={PlugZap} titulo={t("restaurantes.cfoAnalisis.noDisponible")} mensaje={motivo} />;
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
  const t = useT(restaurantesCfoAnalisis);
  return (
    <section aria-label={titulo} data-testid={`bloque-${id}`} data-estado={seccion === null ? "cargando" : seccion.disponible ? "listo" : "no_disponible"}>
      <ChartCard titulo={titulo} {...(subtitulo ? { subtitulo } : {})} tamano="S" accion={<Definicion titulo={titulo} texto={definicion} periodo={periodo} />}>
        {seccion === null ? <EstadoCargando etiqueta={t("restaurantes.cfoAnalisis.cargandoBloque", { titulo: titulo.toLowerCase() })} /> : !seccion.disponible || seccion.datos === null ? <NoDisponibleBloque motivo={seccion.motivo ?? t("restaurantes.cfoAnalisis.noDisponibleMotivo")} /> : children(seccion.datos)}
      </ChartCard>
    </section>
  );
}

// ---- Bloques --------------------------------------------------------------------------------------------------------------------------

function Resumen({ d }: { readonly d: AnalisisClientesVista }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="resumen" titulo={t("restaurantes.cfoAnalisis.b.resumen")} subtitulo={t("restaurantes.cfoAnalisis.b.resumenSub")} definicion={d.definiciones["resumen"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.resumen}>
      {(r) =>
        r.clientesConVenta === 0 ? (
          <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.sinVentaTitulo")} mensaje={t("restaurantes.cfoAnalisis.sinVentaMensaje")} />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5" data-testid="analisis-resumen">
            <StatCard icon={Users} label={t("restaurantes.cfoAnalisis.clientesVenta")} value={entero(r.clientesConVenta)} nota={t("restaurantes.cfoAnalisis.activos30", { n: entero(r.activos30) })} />
            <StatCard icon={Repeat2} label={t("restaurantes.cfoAnalisis.recompra")} value={porcentaje(r.recompraPct)} nota={t("restaurantes.cfoAnalisis.recompraNota", { n: entero(r.clientesRecompra) })} />
            <StatCard icon={Clock} label={t("restaurantes.cfoAnalisis.intervaloMediano")} value={dias(r.intervaloMedianoDias)} nota={t(r.intervaloMedianoDias === null ? "restaurantes.cfoAnalisis.menosDe5" : "restaurantes.cfoAnalisis.entreCompras")} />
            <StatCard icon={TrendingDown} label={t("restaurantes.cfoAnalisis.dormidos")} value={entero(r.dormidos)} nota={t("restaurantes.cfoAnalisis.dormidosNota")} />
            <StatCard icon={Activity} label={t("restaurantes.cfoAnalisis.ventaRiesgo")} value={pesos(r.ventaEnRiesgoCentavos)} nota={t("restaurantes.cfoAnalisis.ventaRiesgoNota", { total: pesos(r.ventaTotalCentavos) })} />
          </div>
        )
      }
    </Bloque>
  );
}

function Segmentos({ d }: { readonly d: AnalisisClientesVista }) {
  const totalVenta = d.secciones.resumen.datos?.ventaTotalCentavos ?? 0;
  const totalClientes = d.secciones.resumen.datos?.clientesConVenta ?? 0;
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="segmentos" titulo={t("restaurantes.cfoAnalisis.b.segmentos")} subtitulo={t("restaurantes.cfoAnalisis.b.segmentosSub")} definicion={`${d.definiciones["recencia"] ?? ""} ${d.definiciones["frecuencia"] ?? ""} ${d.definiciones["monetario"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={d.secciones.segmentos}>
      {(s) =>
        totalClientes === 0 ? (
          <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.sinSegmentar")} mensaje={t("restaurantes.cfoAnalisis.sinVentasCliente")} />
        ) : (
          <div className="space-y-2">
            {s.pocosClientes && <Callout tone="warning" data-testid="segmentos-pocos">{t("restaurantes.cfoAnalisis.pocos")}</Callout>}
            <DataTable
              etiqueta={t("restaurantes.cfoAnalisis.b.segmentos")}
              filas={s.segmentos}
              obtenerId={(f) => f.segmento}
              paginacion={false}
              atributosFila={(f) => ({ "data-segmento": f.segmento })}
              columnas={[
                { id: "s", encabezado: t("restaurantes.cfoAnalisis.col.segmento"), principal: true, celda: (f) => <span title={f.definicion}>{f.etiqueta}</span> },
                { id: "c", encabezado: t("restaurantes.cfoAnalisis.col.clientes"), alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.clientes)} (${porcentaje(pctDe(f.clientes, totalClientes))})` },
                { id: "v", encabezado: t("restaurantes.cfoAnalisis.col.venta"), alinear: "right", className: "tabular-nums", celda: (f) => `${pesos(f.ventaCentavos)} (${porcentaje(pctDe(f.ventaCentavos, totalVenta))})` },
                { id: "t", encabezado: t("restaurantes.cfoAnalisis.col.ticket"), alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.ticketCentavos) },
                { id: "r", encabezado: t("restaurantes.cfoAnalisis.col.recencia"), alinear: "right", className: "tabular-nums", celda: (f) => dias(f.recenciaMedianaDias) },
              ]}
            />
            <details className="text-xs text-muted-foreground" data-testid="segmentos-definiciones">
              <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("restaurantes.cfoAnalisis.comoSeDefine")}</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {s.segmentos.map((f) => (
                  <li key={f.segmento}>
                    <strong className="font-medium text-foreground">{f.etiqueta}:</strong> {f.definicion}
                  </li>
                ))}
              </ul>
              <p className="mt-1">{t("restaurantes.cfoAnalisis.orden")} {d.definiciones["dormido"]}</p>
            </details>
          </div>
        )
      }
    </Bloque>
  );
}

function Concentracion({ d }: { readonly d: AnalisisClientesVista }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="concentracion" titulo={t("restaurantes.cfoAnalisis.b.concentracion")} subtitulo={t("restaurantes.cfoAnalisis.b.concentracionSub")} definicion={d.definiciones["concentracion"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.concentracion}>
      {(p: ParetoRfm) =>
        p.puntos.length === 0 ? (
          <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.sinConcentracion")} mensaje={t("restaurantes.cfoAnalisis.sinVentasCliente")} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm" data-testid="pareto-texto">
              {p.clientesPara50Pct === null ? null : <span>{t("restaurantes.cfoAnalisis.pareto50", { pct: porcentaje(p.clientesPara50Pct) })}</span>}
              {p.clientesPara80Pct === null ? null : <span>{t(p.clientesPara50Pct === null ? "restaurantes.cfoAnalisis.pareto80Solo" : "restaurantes.cfoAnalisis.pareto80Y", { pct: porcentaje(p.clientesPara80Pct) })}</span>}
              .
            </p>
            <BarChartSimple datos={p.puntos.map((x) => ({ dia: t("restaurantes.cfoAnalisis.pct", { n: String(x.clientesPct) }), valor: x.ventaPct }))} etiquetaValor={(v) => porcentaje(v)} sinDatos={t("restaurantes.cfoAnalisis.sinVentas")} />
            <TablaDatosGrafica titulo={t("restaurantes.cfoAnalisis.concentracionTabla")} encabezados={[t("restaurantes.cfoAnalisis.col.mayorVenta"), t("restaurantes.cfoAnalisis.col.clientes"), t("restaurantes.cfoAnalisis.col.pctAcumulado")]} filas={p.puntos.map((x) => [t("restaurantes.cfoAnalisis.primeros", { n: String(x.clientesPct) }), entero(x.clientes), porcentaje(x.ventaPct)])} />
          </div>
        )
      }
    </Bloque>
  );
}

function Reactivacion({ d, seccion, ocupado, limite, onLimite, base }: { readonly d: AnalisisClientesVista; readonly seccion: SeccionAnalisis<ReactivacionAnalisis>; readonly ocupado: boolean; readonly limite: number; readonly onLimite: (n: number) => void; readonly base: string }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="reactivacion" titulo={t("restaurantes.cfoAnalisis.b.reactivacion")} subtitulo={t("restaurantes.cfoAnalisis.b.reactivacionSub")} definicion={`${d.definiciones["reactivacion"] ?? ""} ${d.definiciones["prioridad"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={seccion}>
      {(r) => (
        <div className="space-y-2" aria-busy={ocupado} data-testid="reactivacion-contenido">
          <Callout tone="info" data-testid="reactivacion-alcance">
            {t("restaurantes.cfoAnalisis.alcance")}
          </Callout>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-sm" data-testid="reactivacion-resumen">
              {t("restaurantes.cfoAnalisis.resumenReactivacion", {
                elegibles: entero(r.totalElegibles),
                venta: pesos(r.ventaEnJuegoCentavos),
                dormidos: entero(r.dormidos),
                otorgado: entero(r.consentimiento.otorgado),
                revocado: entero(r.consentimiento.revocado),
                sinRegistro: entero(r.consentimiento.sinRegistro),
              })}
            </p>
            <div className="w-full sm:w-44">
              <label htmlFor="analisis-limite" className="mb-1 block text-xs text-muted-foreground">
                {t("restaurantes.cfoAnalisis.porMostrar")}
              </label>
              <Selector id="analisis-limite" size="sm" value={String(limite)} onChange={(e) => onLimite(Number(e.target.value))} data-testid="analisis-limite">
                {LIMITES.map((n) => (
                  <option key={n} value={String(n)}>
                    {t("restaurantes.cfoAnalisis.nClientes", { n: String(n) })}
                  </option>
                ))}
              </Selector>
            </div>
          </div>
          {r.filas.length === 0 ? (
            <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.nadie")} mensaje={t("restaurantes.cfoAnalisis.nadieMensaje")} />
          ) : (
            <DataTable
              etiqueta={t("restaurantes.cfoAnalisis.tablaReactivar")}
              filas={r.filas}
              obtenerId={(f) => f.alias}
              paginacion={false}
              atributosFila={(f) => ({ "data-alias": f.alias })}
              columnas={[
                { id: "a", encabezado: t("restaurantes.cfoAnalisis.col.alias"), principal: true, celda: (f) => <code className="font-mono text-xs">{f.alias}</code> },
                { id: "u", encabezado: t("restaurantes.cfoAnalisis.col.ultimaVenta"), alinear: "right", className: "tabular-nums", celda: (f) => diaCorto(f.ultimaVenta) },
                { id: "ds", encabezado: t("restaurantes.cfoAnalisis.col.sinPedir"), alinear: "right", className: "tabular-nums", celda: (f) => dias(f.diasSinPedir) },
                { id: "i", encabezado: t("restaurantes.cfoAnalisis.col.ritmo"), alinear: "right", className: "tabular-nums", celda: (f) => (f.intervaloMedianoDias === null ? t("restaurantes.cfoAnalisis.sinRitmo") : t("restaurantes.cfoAnalisis.cada", { n: decimal(f.intervaloMedianoDias) })) },
                { id: "v", encabezado: t("restaurantes.cfoAnalisis.col.ventaPeriodo"), alinear: "right", className: "tabular-nums", celda: (f) => t("restaurantes.cfoAnalisis.ventaYVentas", { venta: pesos(f.ventaCentavos), n: entero(f.ventas) }) },
                { id: "p", encabezado: t("restaurantes.cfoAnalisis.col.prioridad"), alinear: "right", className: "tabular-nums", celda: (f) => pesos(f.prioridadCentavos) },
                { id: "e", encabezado: t("restaurantes.cfoAnalisis.col.estado"), celda: (f: FilaReactivacion) => (f.dormido ? <StatusBadge tone="warning">{t("restaurantes.cfoAnalisis.dormido")}</StatusBadge> : <StatusBadge tone="neutral">{t("restaurantes.cfoAnalisis.pasado")}</StatusBadge>) },
                { id: "k", encabezado: t("restaurantes.cfoAnalisis.col.consentimiento"), celda: (f: FilaReactivacion) => <StatusBadge tone={CONSENTIMIENTO[f.consentimiento].tono}>{t(CONSENTIMIENTO[f.consentimiento].clave)}</StatusBadge> },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground" data-testid="reactivacion-nota">
            {t("restaurantes.cfoAnalisis.soloMuestra")}{" "}
            <Link to={`${base}/campanas`} className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t("restaurantes.cfoAnalisis.campanas")}
            </Link>
            .
          </p>
        </div>
      )}
    </Bloque>
  );
}

function Intervalo({ d }: { readonly d: AnalisisClientesVista }) {
  const t = useT(restaurantesCfoAnalisis);
  const etiqueta = (f: FilaIntervaloRecompra): string => (f.segmento === "global" ? t("restaurantes.cfoAnalisis.todos") : (d.secciones.segmentos.datos?.segmentos.find((s) => s.segmento === f.segmento)?.etiqueta ?? f.segmento));
  return (
    <Bloque id="intervalo" titulo={t("restaurantes.cfoAnalisis.b.intervalo")} subtitulo={t("restaurantes.cfoAnalisis.b.intervaloSub")} definicion={d.definiciones["intervalo"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.intervalo}>
      {(filas) => {
        const conDato = filas.filter((f) => f.intervalos > 0);
        return conDato.length === 0 ? (
          <EstadoVacio compacto icon={Clock} titulo={t("restaurantes.cfoAnalisis.sinRepetidas")} mensaje={t("restaurantes.cfoAnalisis.sinRepetidasMensaje")} />
        ) : (
          <DataTable
            etiqueta={t("restaurantes.cfoAnalisis.intervaloTabla")}
            filas={conDato}
            obtenerId={(f) => f.segmento}
            paginacion={false}
            columnas={[
              { id: "s", encabezado: t("restaurantes.cfoAnalisis.col.grupo"), principal: true, celda: etiqueta },
              { id: "n", encabezado: t("restaurantes.cfoAnalisis.col.intervalos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.intervalos) },
              { id: "p25", encabezado: "p25", alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p25) },
              { id: "p50", encabezado: t("restaurantes.cfoAnalisis.col.mediana"), alinear: "right", className: "tabular-nums", celda: (f) => dias(f.p50) },
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
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="afinidad" titulo={t("restaurantes.cfoAnalisis.b.afinidad")} subtitulo={t("restaurantes.cfoAnalisis.b.afinidadSub")} definicion={`${d.definiciones["soporte"] ?? ""} ${d.definiciones["confianza"] ?? ""} ${d.definiciones["lift"] ?? ""}`.trim()} periodo={periodoTexto(d)} seccion={d.secciones.afinidad}>
      {(a: AfinidadAnalisis) => (
        <div className="space-y-2">
          {a.pares.length === 0 ? (
            <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.sinPares")} mensaje={t("restaurantes.cfoAnalisis.sinParesMensaje", { min: a.minimoPedidos })} />
          ) : (
            <DataTable
              etiqueta={t("restaurantes.cfoAnalisis.afinidadTabla")}
              filas={a.pares}
              obtenerId={(f: ParAfinidadApi) => `${f.productoA}|${f.productoB}`}
              paginacion={false}
              columnas={[
                { id: "p", encabezado: t("restaurantes.cfoAnalisis.col.productos"), principal: true, celda: (f: ParAfinidadApi) => `${f.nombreA} + ${f.nombreB}` },
                { id: "j", encabezado: t("restaurantes.cfoAnalisis.col.juntos"), alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => entero(f.pedidosJuntos) },
                { id: "s", encabezado: t("restaurantes.cfoAnalisis.col.soporte"), alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.soportePct) },
                { id: "c1", encabezado: t("restaurantes.cfoAnalisis.col.confAB"), alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.confianzaAB) },
                { id: "c2", encabezado: t("restaurantes.cfoAnalisis.col.confBA"), alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => porcentaje(f.confianzaBA) },
                { id: "l", encabezado: "Lift", alinear: "right", className: "tabular-nums", celda: (f: ParAfinidadApi) => (f.lift === null ? SIN_DATO : f.lift.toFixed(2)) },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground" data-testid="afinidad-nota">
            {t("restaurantes.cfoAnalisis.afinidadNota", { min: a.minimoPedidos })}
            {a.ocultosPorPrivacidad > 0 ? t("restaurantes.cfoAnalisis.ocultos", { n: entero(a.ocultosPorPrivacidad) }) : ""}
            {t("restaurantes.cfoAnalisis.ab")}
            {a.multiSucursal ? t("restaurantes.cfoAnalisis.multi") : ""}
          </p>
        </div>
      )}
    </Bloque>
  );
}

function Tortilla({ d }: { readonly d: AnalisisClientesVista }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <Bloque id="tortilla" titulo={t("restaurantes.cfoAnalisis.b.tortilla")} subtitulo={t("restaurantes.cfoAnalisis.b.tortillaSub")} definicion={d.definiciones["tortilla"] ?? ""} periodo={periodoTexto(d)} seccion={d.secciones.tortilla}>
      {(x) => {
        const total = x.tortilla.reduce((s, y) => s + y.renglones, 0);
        return (
          <div className="space-y-2">
            {total === 0 ? (
              <EstadoVacio compacto icon={Users} titulo={t("restaurantes.cfoAnalisis.sinTortilla")} mensaje={t("restaurantes.cfoAnalisis.sinTortillaMensaje", { n: entero(x.pedidosConItems) })} />
            ) : (
              <DataTable
                etiqueta={t("restaurantes.cfoAnalisis.tortillaTabla")}
                filas={x.tortilla}
                obtenerId={(f) => f.tipo}
                paginacion={false}
                columnas={[
                  { id: "t", encabezado: t("restaurantes.cfoAnalisis.col.tortilla"), principal: true, celda: (f) => f.etiqueta },
                  { id: "r", encabezado: t("restaurantes.cfoAnalisis.col.renglones"), alinear: "right", className: "tabular-nums", celda: (f) => `${entero(f.renglones)} (${porcentaje(pctDe(f.renglones, total))})` },
                  { id: "u", encabezado: t("restaurantes.cfoAnalisis.col.unidades"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.unidades) },
                  { id: "p", encabezado: t("restaurantes.cfoAnalisis.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (f) => entero(f.pedidos) },
                ]}
              />
            )}
            <p className="text-xs text-muted-foreground" data-testid="tortilla-salsas">
              {t("restaurantes.cfoAnalisis.salsas", { motivo: x.salsas.motivo })}
            </p>
          </div>
        );
      }}
    </Bloque>
  );
}

function Pendientes({ d }: { readonly d: AnalisisClientesVista }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <section aria-label={t("restaurantes.cfoAnalisis.pendientesAria")} data-testid="bloque-pendientes">
      <ChartCard titulo={t("restaurantes.cfoAnalisis.pendientes")} subtitulo={t("restaurantes.cfoAnalisis.pendientesSub")} tamano="S">
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

const periodoTexto = (d: AnalisisClientesVista): string => tr("restaurantes.cfoAnalisis.periodoTexto", { desde: diaCorto(d.periodo.desde), hasta: diaCorto(d.periodo.hasta), n: entero(d.periodo.dias) });

function Contenido({ d, props, limite, onLimite, reactivacion, ocupado }: { readonly d: AnalisisClientesVista; readonly props: CfoPaginaProps; readonly limite: number; readonly onLimite: (n: number) => void; readonly reactivacion: SeccionAnalisis<ReactivacionAnalisis>; readonly ocupado: boolean }) {
  const t = useT(restaurantesCfoAnalisis);
  return (
    <>
      <div className="space-y-2.5">
        <Callout tone="neutral" data-testid="analisis-periodo">
          {t("restaurantes.cfoAnalisis.periodoCallout", { periodo: periodoTexto(d) })}
        </Callout>
        <AvisosCfo vista={d} />
        <Resumen d={d} />
        <Segmentos d={d} />
        <Concentracion d={d} />
        <Reactivacion d={d} seccion={reactivacion} ocupado={ocupado} limite={limite} onLimite={onLimite} base={props.base} />
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
  const t = useT(restaurantesCfoAnalisis);
  const bloques: ReadonlyArray<readonly [string, Clave]> = [["resumen", "restaurantes.cfoAnalisis.b.resumen"], ["segmentos", "restaurantes.cfoAnalisis.b.segmentos"], ["concentracion", "restaurantes.cfoAnalisis.b.concentracion"], ["reactivacion", "restaurantes.cfoAnalisis.b.reactivacion"], ["intervalo", "restaurantes.cfoAnalisis.b.intervalo"], ["afinidad", "restaurantes.cfoAnalisis.b.afinidad"], ["tortilla", "restaurantes.cfoAnalisis.b.tortilla"]];
  return (
    <>
      <div className="space-y-2.5" data-testid="analisis-cargando">
        {bloques.map(([id, titulo]) => (
          <Bloque key={id} id={id} titulo={t(titulo)} definicion="" periodo="" seccion={null}>
            {() => null}
          </Bloque>
        ))}
      </div>
    </>
  );
}

/** Límite con el que se carga toda la vista; otro límite solo recarga el bloque de reactivación (el resto de la pantalla no parpadea). */
const LIMITE_INICIAL = 50;

export function CfoAnalisisClientes(props: CfoPaginaProps) {
  const { api, filtros } = props;
  const t = useT(restaurantesCfoAnalisis);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);
  const { carga, recargando, recargar } = useCargaCfo(() => fetchAnalisisClientes(api, filtros, LIMITE_INICIAL), [claveCarga(filtros), api.propertyId, api.token]);
  // Reactivación con otro límite: se pide la vista y solo se toma ese bloque (el endpoint es uno solo); lo demás se conserva tal cual.
  const [otra, setOtra] = useState<{ readonly limite: number; readonly seccion: SeccionAnalisis<ReactivacionAnalisis> } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const clave = claveCarga(filtros);
  useEffect(() => {
    if (limite === LIMITE_INICIAL) {
      setOtra(null);
      return;
    }
    let cancelado = false;
    setOcupado(true);
    fetchAnalisisClientes(api, filtros, limite)
      .then((v) => {
        if (!cancelado) setOtra({ limite, seccion: v.secciones.reactivacion });
      })
      .catch(() => {
        if (!cancelado) setOtra({ limite, seccion: { disponible: false, motivo: tr("restaurantes.cfoAnalisis.errorLista"), datos: null } });
      })
      .finally(() => {
        if (!cancelado) setOcupado(false);
      });
    return () => {
      cancelado = true;
    };
  }, [limite, clave, api.propertyId, api.token]);
  return (
    <PageContainer padding="none" aria-busy={recargando} data-testid="cfo-analisis-clientes">
      {carga.estado === "cargando" ? (
        <Esqueleto />
      ) : (
        <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta={t("restaurantes.cfoAnalisis.cargando")}>
          {(d) => <Contenido d={d} props={props} limite={limite} onLimite={setLimite} reactivacion={otra && otra.limite === limite ? otra.seccion : d.secciones.reactivacion} ocupado={ocupado} />}
        </CargaCfoVista>
      )}
    </PageContainer>
  );
}
