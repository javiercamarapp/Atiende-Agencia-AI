// «Resumen general» de restaurantes (/restaurantes/:orgSlug/general): TODAS las sucursales de la organizacion en una vista, con la
// composicion de Rovaq «Hoy» (eyebrow, H1, frase con las cifras clave en negritas, tira de KPI, franja de estado de los datos,
// «Requiere tu atencion», comparativo por sucursal y su propio «Pregúntale a tus datos»).
//
// Datos: SOLO la vista `/admin/cfo/resumen` (dueño/admin, accion `cfo.ver`). No hay endpoint nuevo: el CFO ya fija el alcance desde la
// membresia verificada (toda la organizacion o las sucursales del admin acotado), incluye las sucursales de «solo venta local» con su
// venta importada de SoftRestaurant y declara sus fuentes. Sin modelo de IA: todo es determinista. «Pregúntale a tus datos» abre el
// Copiloto de restaurantes, cuyo alcance de datos ya es el de la membresia (todas las sucursales para el dueño), nunca la sucursal activa.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ClipboardList, Lock, Receipt, Sparkles, Store, Wallet, XCircle } from "lucide-react";
import { Button, Card, DataTable, EstadoCargando, EstadoError, EstadoVacio, Input, PageContainer, RadioSegmentado, SectionLabel, StatCard, cn, useT } from "@atiende/ui";
import { useFormatos } from "@atiende/ui/i18n/formato";
import { resumenGeneral } from "@atiende/ui/i18n/resumen-general";
import type { ResumenVista } from "@atiende/domain-restaurantes/cfo";
import { CfoNoDisponibleError, CfoSinAccesoError, fetchResumen, type ContextoCfo } from "../cfo/cfo-client.ts";
import { enlaceDeAccion } from "../cfo/contexto.ts";
import { ATAJOS_RANGO, atajoActivo, escribirFiltros, hoyLocal, leerFiltros, type FiltrosCfo } from "../cfo/filtros-url.ts";
import { PAGINAS_CFO } from "../cfo/paginas.ts";
import { puedeEn } from "../lib/permisos.ts";
import { ATAJOS_RESUMEN_GENERAL, armarAtencion, armarComparativo, armarEstadoDatos, sucursalLider, variacionDe, type AtajoResumenGeneral, type FilaComparativo } from "../lib/resumen-general.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

type Carga = { readonly fase: "cargando" } | { readonly fase: "listo"; readonly d: ResumenVista } | { readonly fase: "sin_acceso" } | { readonly fase: "no_disponible" } | { readonly fase: "error" };

const PESTANAS_CFO: ReadonlySet<string> = new Set(PAGINAS_CFO.map((p) => p.slug));
const ETIQUETA_ATAJO = { "7d": "rg.periodo.7d", "30d": "rg.periodo.30d", mes: "rg.periodo.mes", "12m": "rg.periodo.12m" } as const;

/** Envuelve en <strong> los valores de las variables (la frase de Rovaq lleva las cifras en negritas) sin perder la traduccion. */
function conNegritas(texto: string, valores: readonly string[]): ReactNode[] {
  const marcados = valores.filter((v) => v.length > 0);
  if (marcados.length === 0) return [texto];
  const re = new RegExp(`(${marcados.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return texto.split(re).map((p, i) => (marcados.includes(p) ? <strong key={i}>{p}</strong> : p));
}

export interface ResumenGeneralPageProps extends RestaurantesShellContext {
  /** Inyectable en pruebas. */
  readonly fetchImpl?: typeof fetch;
  readonly hoy?: string;
}

export function ResumenGeneralPage(props: ResumenGeneralPageProps) {
  const t = useT(resumenGeneral);
  if (!puedeEn(props.role, "cfo.ver")) {
    return (
      <PageContainer>
        <EstadoVacio icon={Lock} titulo={t("rg.sinAcceso.titulo")} mensaje={t("rg.sinAcceso.mensaje")} />
      </PageContainer>
    );
  }
  return <ResumenGeneralConAcceso {...props} />;
}

function ResumenGeneralConAcceso({ apiBaseUrl, token, propertyId, orgSlug, fetchImpl, hoy: hoyProp }: ResumenGeneralPageProps) {
  const t = useT(resumenGeneral);
  const f = useFormatos();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const hoy = hoyProp ?? hoyLocal();
  // Siempre toda la organizacion (las sucursales que permite la membresia): el filtro de sucursal del CFO no aplica aqui.
  const filtros: FiltrosCfo = { ...leerFiltros(sp, hoy), sucursales: null, vista: "total" };
  const base = `/restaurantes/${encodeURIComponent(orgSlug)}`;
  const api = useMemo<ContextoCfo>(() => ({ fetchImpl: fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), apiBaseUrl, token, propertyId }), [fetchImpl, apiBaseUrl, token, propertyId]);
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);
  const [pregunta, setPregunta] = useState("");

  useEffect(() => {
    let vigente = true;
    setCarga({ fase: "cargando" });
    fetchResumen(api, filtros, "impacto").then(
      (d) => vigente && setCarga({ fase: "listo", d }),
      (e: unknown) => {
        if (!vigente) return;
        if (e instanceof CfoSinAccesoError) setCarga({ fase: "sin_acceso" });
        else if (e instanceof CfoNoDisponibleError) setCarga({ fase: "no_disponible" });
        else setCarga({ fase: "error" });
      },
    );
    return () => {
      vigente = false;
    };
    // `filtros` se deriva de la URL en cada render: la carga depende solo del rango y de la API.
  }, [api, filtros.desde, filtros.hasta, filtros.comparar, intento]);

  const atajo = atajoActivo(filtros.desde, filtros.hasta, hoy);
  const elegirAtajo = (id: string) => {
    const r = ATAJOS_RANGO.find((a) => a.id === id)?.rango(hoy);
    if (r) setSp(escribirFiltros(new URLSearchParams(sp), { ...filtros, ...r }), { replace: true });
  };
  const preguntar = (texto: string) => {
    const q = texto.trim();
    if (q) navigate(`${base}/copiloto?q=${encodeURIComponent(q.slice(0, 500))}`);
  };
  const alEnviar = (e: FormEvent) => {
    e.preventDefault();
    preguntar(pregunta);
  };

  const dinero = (centavos: number | null) => (centavos === null ? null : f.moneda(centavos / 100, { decimales: 0 }));
  const fecha = (dia: string, estilo: "diaMes" | "media") => f.fecha(`${dia}T12:00:00`, estilo);
  const rango = filtros.desde === filtros.hasta ? fecha(filtros.hasta, "media") : `${fecha(filtros.desde, "diaMes")} – ${fecha(filtros.hasta, "media")}`;

  if (carga.fase === "cargando") return <PageContainer><EstadoCargando etiqueta={t("rg.cargando")} /></PageContainer>;
  if (carga.fase === "sin_acceso") return <PageContainer><EstadoVacio icon={Lock} titulo={t("rg.sinAcceso.titulo")} mensaje={t("rg.sinAcceso.mensaje")} /></PageContainer>;
  if (carga.fase === "no_disponible") return <PageContainer><EstadoVacio icon={Store} titulo={t("rg.noDisponible.titulo")} mensaje={t("rg.noDisponible.mensaje")} /></PageContainer>;
  if (carga.fase === "error") return <PageContainer><EstadoError titulo={t("rg.error.titulo")} mensaje={t("rg.error.mensaje")} onReintentar={() => setIntento((n) => n + 1)} /></PageContainer>;

  const { d } = carga;
  const comparativo = armarComparativo(d);
  const estado = armarEstadoDatos(d);
  const atencion = armarAtencion(d.hallazgos);
  const lider = sucursalLider(comparativo);
  const n = comparativo.filas.length;
  const totalTexto = dinero(d.titular.cifra.valor);
  const liderPct = lider?.participacion != null ? f.porcentaje(lider.participacion, 1) : null;
  const fraseVentas = totalTexto ? t("rg.frase.ventas", { count: n, total: totalTexto, rango }) : t("rg.frase.sinVentas", { rango });
  const fraseTop = lider && liderPct && n > 1 ? ` ${t("rg.frase.top", { sucursal: lider.nombre, pct: liderPct })}` : "";
  const kpi = (id: string) => d.kpis.total.kpis.find((k) => k.id === id);
  const k = (id: string) => kpi(id)?.valor.valor ?? null;
  const delta = (id: string) => variacionDe(kpi(id));

  return (
    <PageContainer padding="none" data-testid="resumen-general">
      <div className="ds3-resumen min-w-0 space-y-2.5" data-con-frase="">
        <div className="flex min-w-0 flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <p data-parte="eyebrow" className="hidden" aria-hidden="true">{t("rg.eyebrow")}</p>
            <h1 data-parte="titulo" className="truncate font-display text-xl font-semibold text-foreground">{t("rg.titulo")}</h1>
            <p data-parte="subtitulo" className="mt-1 truncate text-ui text-muted-foreground">{t("rg.subtitulo", { count: n })}</p>
            <p data-parte="frase" className="hidden" data-testid="resumen-general-frase">
              {conNegritas(`${fraseVentas}${fraseTop}`, [totalTexto ?? "", rango, lider && fraseTop ? lider.nombre : "", fraseTop && liderPct ? liderPct : ""])}
            </p>
          </div>
          <RadioSegmentado<string>
            name="resumen-general-periodo"
            label={t("rg.periodo.etiqueta")}
            value={atajo}
            onChange={elegirAtajo}
            className="gap-1"
            opciones={[
              ...ATAJOS_RESUMEN_GENERAL.map((id: AtajoResumenGeneral) => ({ id, rotulo: t(ETIQUETA_ATAJO[id]) })),
              ...(ATAJOS_RESUMEN_GENERAL.includes(atajo as AtajoResumenGeneral) ? [] : [{ id: atajo, rotulo: t("rg.periodo.otro") }]),
            ]}
          />
        </div>

        <Card className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3.5 py-2.5 text-xs" data-testid="resumen-general-datos" aria-label={t("rg.datos.etiqueta")}>
          <span>
            <span className="text-muted-foreground">{t("rg.datos.fuentes")}</span> <strong className="font-semibold">{t("rg.datos.fuentesValor", { con: estado.conDatos, total: estado.total })}</strong>
            {estado.sinCargar.length > 0 && <span className="text-muted-foreground"> {t("rg.datos.sinCargar", { lista: f.lista(estado.sinCargar) })}</span>}
          </span>
          <span>
            <span className="text-muted-foreground">{t("rg.datos.hasta")}</span> <strong className="font-semibold">{estado.hasta ? fecha(estado.hasta, "media") : t("rg.datos.sinFecha")}</strong>
          </span>
          <Link className="font-medium text-primary underline-offset-2 hover:underline" to={`${base}/cfo/resumen`}>{t("rg.datos.verCfo")}</Link>
        </Card>

        <div data-parte="kpis" aria-label={t("rg.kpis.etiqueta")} className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatCard icon={Wallet} label={d.titular.etiqueta} value={totalTexto ?? ""} sinDato={totalTexto ? undefined : t("rg.kpi.sinDato")} delta={delta(d.titular.origen === "softrestaurant" ? "ventas_negocio_sr" : "ventas_netas")} deltaNota={t("rg.kpi.vsAnterior")} />
          {d.titular.origen === "softrestaurant" ? (
            <StatCard icon={Sparkles} label={t("rg.kpi.ventasAgente")} value={dinero(k("ventas_netas")) ?? ""} sinDato={k("ventas_netas") === null ? t("rg.kpi.sinDato") : undefined} delta={delta("ventas_netas")} deltaNota={t("rg.kpi.vsAnterior")} />
          ) : (
            <StatCard icon={XCircle} label={t("rg.kpi.cancelacion")} value={k("cancelacion_pct") === null ? "" : `${k("cancelacion_pct")}%`} sinDato={k("cancelacion_pct") === null ? t("rg.kpi.sinDato") : undefined} delta={delta("cancelacion_pct")} deltaNota={t("rg.kpi.vsAnterior")} />
          )}
          <StatCard icon={ClipboardList} label={t("rg.kpi.pedidos")} value={k("pedidos") === null ? "" : f.numero(k("pedidos") as number)} sinDato={k("pedidos") === null ? t("rg.kpi.sinDato") : undefined} delta={delta("pedidos")} deltaNota={t("rg.kpi.vsAnterior")} />
          <StatCard icon={Receipt} label={t("rg.kpi.ticket")} value={dinero(k("ticket")) ?? ""} sinDato={k("ticket") === null ? t("rg.kpi.sinDato") : undefined} delta={delta("ticket")} deltaNota={t("rg.kpi.vsAnterior")} />
        </div>

        <div className="grid min-w-0 gap-2.5 lg:grid-cols-2">
          <Card className="min-w-0 p-3.5" data-testid="resumen-general-atencion">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {t("rg.atencion.titulo")} <span className="font-normal text-muted-foreground">({atencion.total})</span>
              </h2>
              {atencion.total > atencion.avisos.length && <Link className="text-xs font-medium text-primary hover:underline" to={`${base}/cfo/resumen`}>{t("rg.atencion.verTodo")}</Link>}
            </div>
            {atencion.avisos.length === 0 ? (
              <p className="text-ui text-muted-foreground">{t("rg.atencion.vacio")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {atencion.avisos.map((a) => {
                  const href = enlaceDeAccion(a.ruta, base, filtros, PESTANAS_CFO);
                  const cuerpo = (
                    <>
                      <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", a.urgente ? "bg-destructive" : "bg-foreground")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-medium text-foreground">
                          {a.urgente && <span className="sr-only">{t("rg.atencion.urgente")}: </span>}
                          {a.titulo}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{a.nota}</span>
                      </span>
                      <span className="shrink-0 text-ui font-semibold tabular-nums">{a.cifra}</span>
                    </>
                  );
                  return (
                    <li key={a.id} data-testid="resumen-general-aviso" data-urgente={a.urgente ? "1" : "0"}>
                      {href ? (
                        <Link to={href} className="flex min-w-0 items-start gap-2.5 py-2 hover:bg-muted/40">{cuerpo}</Link>
                      ) : (
                        <div className="flex min-w-0 items-start gap-2.5 py-2">{cuerpo}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="min-w-0 p-3.5" data-testid="resumen-general-preguntar">
            <h2 className="text-sm font-semibold">{t("rg.preguntar.titulo")}</h2>
            <p className="mb-2 text-xs text-muted-foreground">{t("rg.preguntar.descripcion", { count: n })}</p>
            <form onSubmit={alEnviar} className="flex min-w-0 gap-2">
              <Input aria-label={t("rg.preguntar.campo")} placeholder={t("rg.preguntar.placeholder")} value={pregunta} maxLength={500} onChange={(e) => setPregunta(e.target.value)} className="min-w-0 flex-1" />
              <Button type="submit" disabled={pregunta.trim().length === 0}>{t("rg.preguntar.enviar")}</Button>
            </form>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["rg.preguntar.s1", "rg.preguntar.s2", "rg.preguntar.s3"] as const).map((clave) => (
                <Button key={clave} type="button" variant="outline" size="sm" onClick={() => preguntar(t(clave))}>{t(clave)}</Button>
              ))}
            </div>
          </Card>
        </div>

        <section aria-labelledby="resumen-general-comparativo" className="space-y-1.5">
          <SectionLabel id="resumen-general-comparativo">{t("rg.comparativo.titulo")}</SectionLabel>
          <p className="text-xs text-muted-foreground">{t("rg.comparativo.descripcion")}</p>
          <DataTable<FilaComparativo>
            etiqueta={t("rg.comparativo.titulo")}
            filas={comparativo.filas}
            obtenerId={(fila) => fila.propertyId}
            paginacion={false}
            vista="tabla"
            atributosFila={(fila) => ({ "data-sucursal": fila.nombre })}
            columnas={[
              { id: "sucursal", encabezado: t("rg.col.sucursal"), principal: true, celda: (fila) => (fila.activa ? fila.nombre : `${fila.nombre} (${t("rg.fila.inactiva")})`) },
              ...(comparativo.conVentasNegocio ? [{ id: "negocio", encabezado: t("rg.col.ventasNegocio"), alinear: "right" as const, className: "tabular-nums", celda: (fila: FilaComparativo) => dinero(fila.ventasNegocio) ?? "—" }] : []),
              { id: "agente", encabezado: t("rg.col.ventasAgente"), alinear: "right", className: "tabular-nums", celda: (fila) => dinero(fila.ventasAgente) ?? "—" },
              { id: "pedidos", encabezado: t("rg.col.pedidos"), alinear: "right", className: "tabular-nums", celda: (fila) => (fila.pedidos === null ? "—" : f.numero(fila.pedidos)) },
              { id: "ticket", encabezado: t("rg.col.ticket"), alinear: "right", className: "tabular-nums", celda: (fila) => dinero(fila.ticket) ?? "—" },
              { id: "variacion", encabezado: t("rg.col.variacion"), alinear: "right", className: "tabular-nums", celda: (fila) => <Delta v={fila.variacion} /> },
              { id: "participacion", encabezado: t("rg.col.participacion"), alinear: "right", className: "tabular-nums", celda: (fila) => (fila.participacion === null ? "—" : f.porcentaje(fila.participacion, 1)) },
            ]}
          />
          <p className="text-right text-xs text-muted-foreground" data-testid="resumen-general-total">
            {t("rg.col.total")}: <strong className="font-semibold tabular-nums">{totalTexto ?? "—"}</strong>
          </p>
        </section>
      </div>
    </PageContainer>
  );
}

function Delta({ v }: { readonly v: FilaComparativo["variacion"] }) {
  if (!v) return <>—</>;
  const tono = v.pct === 0 ? "neutro" : v.bueno ? "bueno" : "malo";
  return (
    <span className={cn("ds3-delta", tono === "bueno" ? "text-success" : tono === "malo" ? "text-destructive" : "text-muted-foreground")} data-tono={tono}>
      {v.pct > 0 ? "↑ " : v.pct < 0 ? "↓ " : ""}
      {Math.abs(v.pct)}%
    </span>
  );
}
