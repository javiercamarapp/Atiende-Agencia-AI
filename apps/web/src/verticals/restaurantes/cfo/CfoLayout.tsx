// CFO-07 · marco del apartado CFO (`/restaurantes/:orgSlug/cfo/*`): encabezado, barra de filtros fija (rango, sucursales, comparar, Total / Por
// sucursal, Exportar), pestañas del registro `paginas.ts` y el drill-down a pedidos. El estado de los filtros vive en la URL
// (`?desde&hasta&sucursales&comparar[&vista]`) para que un enlace comparta la vista. Fail-closed: sin `cfo.ver` (o con 403) no se pinta ninguna cifra.
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { SearchX } from "lucide-react";
import type { FiltroPedidosDetalle } from "@atiende/domain-restaurantes/cfo";
import { Callout, EstadoCargando, EstadoVacio, PageContainer, PageHeader, cn, notify } from "@atiende/ui";
import { puedeEn } from "../lib/permisos.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { CfoExportarNoDisponibleError, descargarExportacionCfo, fetchAlcance, guardarArchivo, type ContextoCfo, type FormatoExportacionCfo } from "./cfo-client.ts";
import { aplicarDrill, filtroDeParams, pedidosAbiertos, quitarDrill, type CfoPaginaProps } from "./contexto.ts";
import { escribirFiltros, hoyLocal, leerFiltros, type FiltrosCfo } from "./filtros-url.ts";
import { FiltrosCfoBarra } from "./FiltrosCfo.tsx";
import { PAGINAS_CFO, SLUG_INICIAL_CFO } from "./paginas.ts";
import { PedidosDrill } from "./PedidosDrill.tsx";
import { AvisoNoSustitucion, CargaCfoVista, SinAccesoCfo } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

export type CfoLayoutProps = RestaurantesShellContext & {
  readonly fetchImpl?: typeof fetch;
  /** Solo para pruebas: fija «hoy» (`YYYY-MM-DD`). */
  readonly hoy?: string;
};

export function CfoLayout(props: CfoLayoutProps) {
  // Rol sin `cfo.ver` (o desconocido): ni siquiera se piden datos.
  if (!puedeEn(props.role, "cfo.ver")) return <SinAccesoCfo />;
  return <CfoLayoutConAcceso {...props} />;
}

function CfoLayoutConAcceso({ apiBaseUrl, token, propertyId, orgSlug, role, fetchImpl, hoy }: CfoLayoutProps) {
  const [sp, setSp] = useSearchParams();
  const slugActual = (useParams()["*"] ?? "").split("/")[0] || SLUG_INICIAL_CFO;
  const hoyStr = useMemo(() => hoy ?? hoyLocal(), [hoy]);
  const filtros = useMemo(() => leerFiltros(sp, hoyStr), [sp, hoyStr]);
  const base = `/restaurantes/${orgSlug}`;
  const api = useMemo<ContextoCfo>(() => ({ fetchImpl: fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), apiBaseUrl, token, propertyId }), [fetchImpl, apiBaseUrl, token, propertyId]);

  // Un enlace sin fechas se completa con el rango por defecto, para que lo que se comparte sea exactamente lo que se ve.
  useEffect(() => {
    if (!sp.get("desde") || !sp.get("hasta")) setSp(escribirFiltros(sp, filtros), { replace: true });
  }, [sp, filtros, setSp]);

  const { carga, recargar } = useCargaCfo(() => fetchAlcance(api), [api]);

  // Filtros EFECTIVOS, calculados UNA vez: la URL manda, pero solo con sucursales que este actor puede ver. Una ajena o borrada se descarta (el API
  // respondería 403 y se leería como «sin acceso»). Todo lo que sale hacia el API (páginas, drill, exportar) y todo lo que se escribe en la URL parte de aquí.
  const alcanceListo = carga.estado === "listo" ? carga.datos : null;
  const { filtrosEf, descartadas, validas } = useMemo(() => {
    if (!alcanceListo || filtros.sucursales === null) return { filtrosEf: filtros, descartadas: false, validas: filtros.sucursales };
    const permitidas = new Set(alcanceListo.sucursales.map((s) => s.propertyId.toLowerCase()));
    const ok = filtros.sucursales.filter((id) => permitidas.has(id));
    const hay = ok.length !== filtros.sucursales.length;
    return { filtrosEf: hay ? { ...filtros, sucursales: ok.length > 0 ? ok : null } : filtros, descartadas: hay, validas: ok };
  }, [alcanceListo, filtros]);

  // Al primer cambio la sucursal ajena sale de la URL (parte de `filtrosEf`), y con ella el aviso.
  const setFiltros = useCallback(
    (cambios: Partial<FiltrosCfo>) => setSp(escribirFiltros(quitarDrill(sp), { ...filtrosEf, ...cambios })),
    [sp, filtrosEf, setSp],
  );
  const abrirPedidos = useCallback((f: FiltroPedidosDetalle) => setSp(aplicarDrill(escribirFiltros(sp, filtrosEf), f)), [sp, filtrosEf, setSp]);

  const pagina = PAGINAS_CFO.find((p) => p.slug === slugActual) ?? null;
  // Con nueve pestañas la barra se desplaza: la activa siempre queda a la vista (también al entrar por un enlace).
  useEffect(() => {
    document.querySelector("nav[aria-label='Secciones del CFO'] [aria-current=page]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [slugActual, carga.estado]);
  const disponibles = useMemo(() => new Set(PAGINAS_CFO.map((p) => p.slug)), []);

  const [exportando, setExportando] = useState<FormatoExportacionCfo | null>(null);
  const [exportarOculto, setExportarOculto] = useState(false);
  async function exportar(formato: FormatoExportacionCfo) {
    if (!pagina?.vistaExportacion) return;
    setExportando(formato);
    try {
      guardarArchivo(await descargarExportacionCfo(api, filtrosEf, pagina.vistaExportacion, formato));
      notify.success(`Se exportó ${pagina.etiqueta} en ${formato === "xlsx" ? "Excel" : "PDF"}.`);
    } catch (err) {
      if (err instanceof CfoExportarNoDisponibleError) {
        setExportarOculto(true);
        notify.error("La exportación todavía no está disponible en este despliegue.");
      } else {
        notify.error(err instanceof Error ? err.message : "No se pudo exportar.");
      }
    } finally {
      setExportando(null);
    }
  }

  return (
    <PageContainer padding="none" data-testid="cfo-layout">
      <PageHeader
        titulo="CFO"
        descripcion="Tus ventas, sucursales y estado de resultados en un solo lugar, con la procedencia de cada cifra."
        meta={carga.estado === "listo" ? <span className="text-xs text-muted-foreground">{carga.datos.alcance.organizacionCompleta ? "Todas las sucursales de tu organización" : `Tus ${carga.datos.sucursales.length} sucursales`}</span> : undefined}
      />
      <CargaCfoVista carga={carga} onReintentar={recargar} etiqueta="Cargando el CFO…">
        {(alcance) => {
          const paginaProps: CfoPaginaProps = { api, role, orgSlug, base, filtros: filtrosEf, alcance, setFiltros, abrirPedidos, pestanasDisponibles: disponibles };
          const Pagina = pagina?.componente;
          const tabParams = escribirFiltros(quitarDrill(sp), filtrosEf);
          return (
            <>
              <FiltrosCfoBarra
                filtros={filtrosEf}
                alcance={alcance}
                hoy={hoyStr}
                onCambiar={setFiltros}
                exportar={{ visible: puedeEn(role, "cfo.exportar") && Boolean(pagina?.vistaExportacion) && !exportarOculto, exportando, onExportar: (f) => void exportar(f) }}
              />
              {descartadas && (
                <Callout tone="warning" data-testid="cfo-sucursal-descartada">
                  El enlace traía sucursales que no existen o que no puedes ver; se ignoraron y se muestra {validas && validas.length > 0 ? "solo lo que sí puedes ver" : "«Todas»"}.
                </Callout>
              )}
              <nav aria-label="Secciones del CFO" className="-mx-1 overflow-x-auto px-1">
                <ul className="flex min-w-max gap-1 border-b border-border">
                  {PAGINAS_CFO.map((p) => {
                    const activa = p.slug === slugActual;
                    const Icono = p.icono;
                    return (
                      <li key={p.slug}>
                        <Link
                          to={`${base}/cfo/${p.slug}?${tabParams.toString()}`}
                          aria-current={activa ? "page" : undefined}
                          data-testid={`pestana-${p.slug}`}
                          className={cn(
                            "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-ui font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            activa ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Icono className="size-4" aria-hidden="true" strokeWidth={1.75} />
                          {p.etiqueta}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              {Pagina ? (
                <Suspense fallback={<EstadoCargando etiqueta="Cargando la sección…" />}>
                  <Pagina {...paginaProps} />
                </Suspense>
              ) : (
                <EstadoVacio
                  icon={SearchX}
                  titulo="Esta sección no existe"
                  mensaje="La dirección no corresponde a ninguna sección del CFO."
                  accion={
                    <Link to={`${base}/cfo/${SLUG_INICIAL_CFO}`} className="text-ui font-medium text-primary underline-offset-4 hover:underline">
                      Ir al resumen del CFO
                    </Link>
                  }
                />
              )}
              <AvisoNoSustitucion texto={alcance.avisoLegal} />
              <PedidosDrill abierto={pedidosAbiertos(sp)} onCerrar={() => setSp(quitarDrill(sp))} api={api} base={base} filtros={filtrosEf} filtroPedidos={filtroDeParams(sp)} />
            </>
          );
        }}
      </CargaCfoVista>
    </PageContainer>
  );
}
