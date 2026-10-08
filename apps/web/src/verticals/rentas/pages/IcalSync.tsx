// Sincronización de calendario por iCal (Airbnb/Booking/Vrbo) — cierra el hallazgo
// de auditoría "el backend de iCal-sync está completo (Fase 5:
// apps/api/src/routes/verticals/rentas/ical-sync.ts + ical-feed-publico.ts) pero
// apps/web no tiene ningún cliente ni pantalla que lo consuma: es la capacidad
// núcleo de un PMS de renta vacacional (evitar doble reserva entre canales)". Hasta
// esta fase un admin_gestora no tenía forma de conectar el feed externo de un canal
// ni de copiar la URL del feed de exportación propio desde el producto.
//
// Mismo patrón exacto que Precios.tsx: selector de unidad (fetchUnidades) -> panel
// por unidad, gate de lectura/escritura en el CLIENTE calcado 1:1 de
// SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES
// (packages/domain-rentas/src/roles.ts) -- el servidor SIEMPRE re-valida vía
// `assertVerticalRole` en cada ruta, este gate es solo UX (mismo criterio que
// Finanzas.tsx::FINANZAS_LECTURA_ROLES/FINANZAS_ESCRITURA_ROLES, incluyendo el
// gate de LECTURA a nivel de página completa: `operador:solo_calendario` puede leer
// pero `contador`/`limpieza` no participan de sync de calendario y verían un 403 si
// esta página no los filtrara antes de llamar a fetchFeedsUnidad).
//
// Tres canales externos con feed real (CANALES_CON_MARKUP, reusado de
// pricing-client.ts) -- "manual" es reserva directa/bloqueo interno, nunca tiene
// feed que conectar, mismo criterio que ya excluye "manual" de ese catálogo. Cada
// canal muestra dos cosas independientes:
//  1. Import -- URL del feed externo (Airbnb/Booking/Vrbo) que ESTE producto debe
//     leer, con el estado de la última corrida (conectar/desconectar, escritura).
//  2. Export -- URL pública de ESTE producto (.../feed.ics, ical-feed-publico.ts,
//     SIN auth) que hay que pegar en el canal externo para que él nos lea a
//     nosotros. Es una URL 100% determinística (construirUrlFeedExportacion, sin
//     red) -- se muestra siempre que se puede leer la página, nunca gateada por
//     escritura, exactamente igual que "ver el detalle de un payout" en Finanzas.
//
// Paridad3 (Rn-13, Rn-P3-15/17/23): el bloque de EXPORTACIÓN usa una URL con TOKEN opaco y rotable (se muestra UNA vez, al
// generarla o rotarla; la URL por UUID queda como "anterior" con aviso de deprecación); el catálogo de canales aporta la latencia
// declarada (con su confianza) y la advertencia de Booking.com; "Probar URL" descarga y resume el .ics sin guardar nada;
// "Sincronizar ahora" corre el ciclo de UN feed con el lease existente.
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Badge/Input/
// Label/EstadoCargando/EstadoError + clases de token en vez de los `style={{...}}`
// hechos a mano. El formulario de "conectar feed" pasa a <FormDialog>
// (el shell de modal ya existente del repo), conservando EXACTAMENTE su submit, su
// validación local ("La URL del feed a importar es requerida.") y su recarga
// (`onCambio`). CERO cambios de lógica ni de gates de rol.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Copy, KeyRound, Link2, Plug, RefreshCcw, Unplug } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, EstadoCargando, EstadoError, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge } from "@atiende/ui";
import {
  CANALES_CON_MARKUP,
  conectarFeed,
  construirUrlFeedExportacion,
  desconectarFeed,
  fetchFeedsUnidad,
  fetchUnidades,
} from "../lib/ical-sync-client.ts";
import type { FeedIcalSync, UnidadOption } from "../lib/ical-sync-client.ts";
import { fetchCatalogoCanales, fetchFeedTokens, probarUrlFeed, resumenSincronizacion, rotarFeedToken, sincronizarFeedAhora } from "../lib/conectividad-client.ts";
import type { CanalCatalogo, FeedTokensUnidad, ResultadoProbarUrl } from "../lib/conectividad-client.ts";
import { feedCanalTone } from "../lib/status-tones.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES
// (packages/domain-rentas/src/roles.ts) -- mismo criterio que
// PRICING_ESCRITURA_ROLES en Precios.tsx: apps/web nunca importa un paquete
// domain-* (ver comentario de cabecera de calendario-client.ts), así que el
// espejo de rol vive aquí, redeclarado a mano.
const SYNC_CALENDARIO_LECTURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"]);
const SYNC_CALENDARIO_ESCRITURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
const RUBRO_CLASES = "m-0 font-mono text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";

function formatearFecha(iso: string | null): string {
  if (!iso) return "nunca";
  return new Date(iso).toLocaleString("es-MX");
}

export function IcalSyncPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? SYNC_CALENDARIO_LECTURA_ROLES.has(org.rol) : false;
  const puedeEscribir = org ? SYNC_CALENDARIO_ESCRITURA_ROLES.has(org.rol) : false;

  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!puedeLeer) return;
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeLeer]);

  if (!puedeLeer) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Sincronización de calendario (iCal)</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso de lectura a la sincronización de calendario. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong>,{" "}
          <strong className="text-foreground">operador:calendario_mensajeria</strong> y <strong className="text-foreground">operador:solo_calendario</strong>.
        </p>
      </PageContainer>
    );
  }

  if (unidades && unidades.length === 0) {
    return (
      <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Sincronización de calendario (iCal)</h1>
        <EstadoError titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="md" className="gap-5 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Sincronización de calendario (iCal)</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Conecta el feed iCal de cada canal externo para importar su disponibilidad y evitar doble reserva, y copia la URL del feed de exportación de esta unidad para pegarla
          en el canal.
          {!puedeEscribir && (
            <>
              {" "}
              Tu rol (<strong className="text-foreground">{org?.rol}</strong>) es de solo lectura — conectar/desconectar es exclusivo de{" "}
              <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong> y{" "}
              <strong className="text-foreground">operador:calendario_mensajeria</strong>.
            </>
          )}
        </p>
      </header>

      <Label className={`${LABEL_CLASES} max-w-[320px]`}>
        Unidad
        <NativeSelect value={unidadId} onChange={(e) => setUnidadId(e.target.value)} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </NativeSelect>
      </Label>

      {error && <EstadoError mensaje={error} />}

      {unidadId && <CanalesSync apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} orgSlug={orgSlug} puedeEscribir={puedeEscribir} />}
    </PageContainer>
  );
}

interface CanalesSyncProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly orgSlug: string;
  readonly puedeEscribir: boolean;
}

function CanalesSync({ apiBaseUrl, token, propertyId, unidadId, orgSlug, puedeEscribir }: CanalesSyncProps) {
  const [feeds, setFeeds] = useState<readonly FeedIcalSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Catálogo de canales y tokens de exportación: complementos de la pantalla. Si alguna de las dos lecturas falla, la pantalla sigue
  // siendo útil (sin advertencias de catálogo / solo con la URL por UUID) y lo dice; nunca bloquea la conexión de feeds.
  const [catalogo, setCatalogo] = useState<readonly CanalCatalogo[] | null>(null);
  const [tokens, setTokens] = useState<FeedTokensUnidad | null>(null);
  const [errorTokens, setErrorTokens] = useState<string | null>(null);

  async function recargarTokens() {
    try {
      setTokens(await fetchFeedTokens(fetch, apiBaseUrl, token, propertyId, unidadId));
      setErrorTokens(null);
    } catch (err) {
      setErrorTokens(err instanceof Error ? err.message : "No se pudo consultar el estado de la URL con token.");
    }
  }

  async function recargar() {
    try {
      const list = await fetchFeedsUnidad(fetch, apiBaseUrl, token, propertyId, unidadId);
      setFeeds(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado de sincronización de esta unidad.");
    }
  }

  useEffect(() => {
    let cancelado = false;
    setFeeds(null);
    setTokens(null);
    (async () => {
      try {
        const list = await fetchFeedsUnidad(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (!cancelado) setFeeds(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el estado de sincronización de esta unidad.");
      }
    })();
    (async () => {
      try {
        const [cat, tok] = await Promise.all([fetchCatalogoCanales(fetch, apiBaseUrl, token, propertyId), fetchFeedTokens(fetch, apiBaseUrl, token, propertyId, unidadId)]);
        if (cancelado) return;
        setCatalogo(cat);
        setTokens(tok);
        setErrorTokens(null);
      } catch (err) {
        if (!cancelado) setErrorTokens(err instanceof Error ? err.message : "No se pudo consultar el catálogo de canales ni la URL con token.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, unidadId]);

  if (error) {
    return <EstadoError mensaje={error} />;
  }

  if (!feeds) {
    return <EstadoCargando lineas={2} />;
  }

  const feedPorCanal = new Map(feeds.map((f) => [f.canal, f] as const));

  return (
    <div className="flex flex-col gap-4">
      {CANALES_CON_MARKUP.map((canal) => (
        <CanalCard
          key={canal.codigo}
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          unidadId={unidadId}
          canalCodigo={canal.codigo}
          canalNombre={canal.nombre}
          feed={feedPorCanal.get(canal.codigo) ?? null}
          puedeEscribir={puedeEscribir}
          onCambio={recargar}
          orgSlug={orgSlug}
          catalogo={catalogo?.find((c) => c.canalAtiende === canal.codigo) ?? null}
          tokens={tokens}
          errorTokens={errorTokens}
          onTokensCambio={recargarTokens}
        />
      ))}
    </div>
  );
}

interface CanalCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalCodigo: string;
  readonly canalNombre: string;
  readonly feed: FeedIcalSync | null;
  readonly puedeEscribir: boolean;
  readonly onCambio: () => void;
  readonly orgSlug: string;
  /** Entrada del catálogo de canales (latencia declarada, vía iCal, bloqueo); `null` si no se pudo leer. */
  readonly catalogo: CanalCatalogo | null;
  /** Tokens de exportación de la unidad; `null` mientras cargan o si la lectura falló. */
  readonly tokens: FeedTokensUnidad | null;
  readonly errorTokens: string | null;
  readonly onTokensCambio: () => void;
}

const ETIQUETA_CONFIANZA = { alta: "alta", media: "media", baja: "baja", sin_evidencia: "sin evidencia" } as const;

function CanalCard({ apiBaseUrl, token, propertyId, unidadId, canalCodigo, canalNombre, feed, puedeEscribir, onCambio, orgSlug, catalogo, tokens, errorTokens, onTokensCambio }: CanalCardProps) {
  const [urlImportacion, setUrlImportacion] = useState("");
  const [modalAbierto, setModalAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const [confirmandoDesconectar, setConfirmandoDesconectar] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Probar URL (Rn-P3-17): descarga y resume el .ics sin guardar nada.
  const [probando, setProbando] = useState(false);
  const [prueba, setPrueba] = useState<ResultadoProbarUrl | null>(null);
  // Sincronizar ahora (Rn-P3-23).
  const [sincronizando, setSincronizando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState<string | null>(null);
  // URL con token (Rn-13): el valor en claro solo existe en memoria tras generarla/rotarla; al recargar la página ya no se puede ver.
  const [urlNueva, setUrlNueva] = useState<string | null>(null);
  const [copiadoNueva, setCopiadoNueva] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [confirmandoRotar, setConfirmandoRotar] = useState(false);

  const urlExportacion = construirUrlFeedExportacion(apiBaseUrl, propertyId, unidadId, canalCodigo);
  const tokenCanal = tokens?.disponible ? (tokens.tokens.find((t) => t.canal === canalCodigo) ?? null) : null;
  // Sin vía iCal en el catálogo (`no_disponible`) no se ofrece conectar; `sin_evidencia` (Booking.com) sí, pero con la advertencia.
  const viaIcalBloqueada = catalogo?.viaIcal === "no_disponible";
  const viaIcalSinEvidencia = catalogo?.viaIcal === "sin_evidencia";

  async function handleConectar() {
    setError(null);
    if (!urlImportacion.trim()) return setError("La URL del feed a importar es requerida.");
    setGuardando(true);
    try {
      await conectarFeed(fetch, apiBaseUrl, token, propertyId, unidadId, canalCodigo, urlImportacion.trim());
      setUrlImportacion("");
      setModalAbierto(false);
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar el feed.");
    } finally {
      setGuardando(false);
    }
  }

  async function handleDesconectar() {
    setError(null);
    setDesconectando(true);
    try {
      await desconectarFeed(fetch, apiBaseUrl, token, propertyId, unidadId, canalCodigo);
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo desconectar el feed.");
    } finally {
      setDesconectando(false);
    }
  }

  async function handleCopiarExport() {
    try {
      await navigator.clipboard.writeText(urlExportacion);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles (ej. contexto no seguro en pruebas/preview) --
      // el input de abajo sigue mostrando la URL completa, seleccionable a mano.
    }
  }

  async function handleCopiarNueva() {
    if (!urlNueva) return;
    try {
      await navigator.clipboard.writeText(urlNueva);
      setCopiadoNueva(true);
      setTimeout(() => setCopiadoNueva(false), 2000);
    } catch {
      // Sin portapapeles: la URL sigue visible y seleccionable en el campo de arriba.
    }
  }

  async function handleGenerarToken() {
    setError(null);
    setGenerando(true);
    try {
      const r = await rotarFeedToken(fetch, apiBaseUrl, token, propertyId, unidadId, canalCodigo);
      setUrlNueva(r.url);
      onTokensCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar la URL con token.");
    } finally {
      setGenerando(false);
    }
  }

  async function handleProbar() {
    setError(null);
    setPrueba(null);
    if (!urlImportacion.trim()) return setError("Escribe la URL del feed antes de probarla.");
    setProbando(true);
    try {
      setPrueba(await probarUrlFeed(fetch, apiBaseUrl, token, propertyId, unidadId, urlImportacion.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo probar la URL.");
    } finally {
      setProbando(false);
    }
  }

  async function handleSincronizarAhora() {
    setError(null);
    setResultadoSync(null);
    setSincronizando(true);
    try {
      const r = await sincronizarFeedAhora(fetch, apiBaseUrl, token, propertyId, unidadId, canalCodigo);
      setResultadoSync(resumenSincronizacion(r));
      onCambio();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo sincronizar el feed.");
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base font-semibold">{canalNombre}</CardTitle>
        {feed && (
          <StatusBadge tone={feedCanalTone(feed)}>{feed.enCuarentenaDesde ? "En cuarentena" : feed.activo ? "Conectado" : "Inactivo"}</StatusBadge>
        )}
      </CardHeader>

      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        {error && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        )}

        {catalogo && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className="m-0">
              <strong className="text-foreground">Latencia declarada:</strong> {catalogo.latencia.texto} (confianza {ETIQUETA_CONFIANZA[catalogo.latencia.confianza]}
              {catalogo.latencia.fuente ? `; fuente ${catalogo.latencia.fuente}` : ""}). La latencia es del canal, no de Atiende.
            </p>
            <Link to={`/rentas/${orgSlug}/conectividad?unidad=${unidadId}&canal=${canalCodigo}`} className="self-start text-primary hover:underline">
              Asistente de conexión paso a paso
            </Link>
          </div>
        )}
        {catalogo && (viaIcalSinEvidencia || viaIcalBloqueada) && (
          <div role="note" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="m-0 font-semibold">
                {viaIcalBloqueada ? `${canalNombre} no tiene una vía iCal disponible` : `Sin evidencia de que ${canalNombre} ofrezca iCal`}
              </p>
              <p className="m-0 text-muted-foreground">{catalogo.descripcionVia}.</p>
              {catalogo.bloqueo && (
                <p className="m-0 text-muted-foreground">
                  {catalogo.bloqueo.motivo} <span className="italic">({catalogo.bloqueo.cita})</span>
                </p>
              )}
              {catalogo.latencia.confianza === "sin_evidencia" && <p className="m-0 text-muted-foreground">No hay ninguna cifra de latencia con fuente: no se muestra una estimada.</p>}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <p className={RUBRO_CLASES}>Importar desde {canalNombre}</p>
          {feed ? (
            <div className="flex flex-col gap-1.5 text-sm">
              <p className="m-0 break-all text-foreground">{feed.urlImportacion}</p>
              <p className="m-0 text-xs text-muted-foreground">Última sincronización exitosa: {formatearFecha(feed.ultimaSincronizacionExitosaEn)}</p>
              {feed.intentosFallidosConsecutivos > 0 && (
                <p className="m-0 text-xs text-destructive">
                  {feed.intentosFallidosConsecutivos} intento{feed.intentosFallidosConsecutivos === 1 ? "" : "s"} fallido{feed.intentosFallidosConsecutivos === 1 ? "" : "s"} consecutivo
                  {feed.intentosFallidosConsecutivos === 1 ? "" : "s"}
                  {feed.motivoCuarentena ? ` — ${feed.motivoCuarentena}` : ""}
                </p>
              )}
              {puedeEscribir && (
                <div className="flex flex-wrap items-center gap-2">
                  {feed.activo && (
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleSincronizarAhora()} disabled={sincronizando}>
                      <RefreshCcw className="w-4 h-4" strokeWidth={1.75} />
                      {sincronizando ? "Sincronizando…" : "Sincronizar ahora"}
                    </Button>
                  )}
                  <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmandoDesconectar(true)} disabled={desconectando}>
                    <Unplug className="w-4 h-4" strokeWidth={1.75} />
                    {desconectando ? "Desconectando…" : "Desconectar"}
                  </Button>
                </div>
              )}
              {resultadoSync && (
                <p role="status" className="m-0 text-xs text-muted-foreground">
                  {resultadoSync}
                </p>
              )}
            </div>
          ) : puedeEscribir && !viaIcalBloqueada ? (
            <Button type="button" size="sm" onClick={() => setModalAbierto(true)} className="self-start">
              <Plug className="w-4 h-4" strokeWidth={1.75} />
              Conectar
            </Button>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">{viaIcalBloqueada ? "Este canal no se puede conectar por iCal." : "Ningún feed conectado todavía."}</p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className={RUBRO_CLASES}>Exportar hacia {canalNombre}</p>
          <p className="m-0 text-xs text-muted-foreground">Pega esta URL como feed de importación dentro de {canalNombre} para que reciba nuestra disponibilidad.</p>

          {errorTokens && (
            <p role="alert" className="m-0 text-xs text-destructive">
              {errorTokens}
            </p>
          )}

          {tokens?.disponible && (
            <div className="flex flex-col gap-2">
              <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                {tokenCanal ? (
                  <span>
                    URL con token creada el {formatearFecha(tokenCanal.creadoEn)}. Última consulta de {canalNombre}: {tokenCanal.ultimoAccesoEn ? formatearFecha(tokenCanal.ultimoAccesoEn) : "aún no la ha consultado"}.
                  </span>
                ) : (
                  <span>Todavía no generas una URL con token para este canal.</span>
                )}
              </p>
              {urlNueva && (
                <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3">
                  <div className="flex gap-2 items-center flex-wrap">
                    <Input readOnly value={urlNueva} aria-label={`URL con token para ${canalNombre}`} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-[260px] text-xs" />
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleCopiarNueva()}>
                      <Copy className="w-4 h-4" strokeWidth={1.75} />
                      {copiadoNueva ? "¡Copiada!" : "Copiar"}
                    </Button>
                  </div>
                  <p className="m-0 flex items-start gap-1.5 text-xs text-foreground">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.75} aria-hidden />
                    Cópiala ahora y pégala en {canalNombre}: por seguridad no se vuelve a mostrar. Si la pierdes, genera una nueva.
                  </p>
                </div>
              )}
              {puedeEscribir && (
                <Button type="button" variant="outline" size="sm" className="self-start" disabled={generando} onClick={() => (tokenCanal ? setConfirmandoRotar(true) : void handleGenerarToken())}>
                  <KeyRound className="w-4 h-4" strokeWidth={1.75} />
                  {generando ? "Generando…" : tokenCanal ? "Rotar URL" : "Generar URL con token"}
                </Button>
              )}
            </div>
          )}
          {tokens && !tokens.disponible && (
            <p className="m-0 text-xs text-muted-foreground">La URL con token aún no está disponible en este entorno (requiere actualizar la base de datos). Mientras tanto usa la URL de abajo.</p>
          )}

          {/* URL por UUID: con token disponible queda como "anterior" (deprecada); sin token es la única que hay. */}
          {(!tokens || !tokens.disponible || tokens.urlUuidActiva) && (
            <div className="flex flex-col gap-1.5">
              {tokens?.disponible && (
                <p role="note" className="m-0 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
                  URL anterior (deprecada). Actualiza la URL en {canalNombre}: la anterior dejará de funcionar.
                </p>
              )}
              <div className="flex gap-2 items-center flex-wrap">
                <Input readOnly value={urlExportacion} aria-label={`URL de exportación por UUID para ${canalNombre}`} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-[260px] text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={handleCopiarExport}>
                  <Copy className="w-4 h-4" strokeWidth={1.75} />
                  {copiado ? "¡Copiada!" : "Copiar"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>

      {/* Desconectar deja de importar la disponibilidad del canal (riesgo de doble reserva): pide confirmación con el
          nombre del canal; "Cancelar", Escape o clic fuera no desconectan nada. */}
      <ConfirmDialog
        open={confirmandoDesconectar}
        onOpenChange={setConfirmandoDesconectar}
        tono="danger"
        titulo={`¿Desconectar ${canalNombre}?`}
        descripcion={`Dejaremos de importar la disponibilidad de ${canalNombre} para esta unidad: el calendario ya no se actualizará con sus reservas y podría haber doble reserva hasta que vuelvas a conectarlo.`}
        confirmar="Sí, desconectar"
        onConfirm={() => handleDesconectar()}
      />

      {/* Rotar la URL deja sin calendario a la OTA hasta que pegues la nueva: pide confirmación; "Cancelar", Escape o clic fuera no rotan nada. */}
      <ConfirmDialog
        open={confirmandoRotar}
        onOpenChange={setConfirmandoRotar}
        tono="danger"
        titulo={`¿Rotar la URL de exportación de ${canalNombre}?`}
        descripcion={`${canalNombre} dejará de ver tu calendario hasta que pegues la URL nueva en su panel.`}
        confirmar="Sí, rotar URL"
        onConfirm={() => handleGenerarToken()}
      />

      {/* Conectar feed: mismo submit exacto que el <form> inline previo, ahora en el
          shell de modal del repo. */}
      <FormDialog
        open={modalAbierto}
        onOpenChange={(abierto) => {
          setModalAbierto(abierto);
          if (!abierto) {
            setError(null);
            setPrueba(null);
          }
        }}
        titulo={`Conectar ${canalNombre}`}
        subtitulo="Importa la disponibilidad de este canal para evitar doble reserva en esta unidad."
        anchoClase="max-w-2xl"
        onGuardar={() => void handleConectar()}
        guardando={guardando}
        textoBotonGuardar="Conectar"
      >
        <div className="flex flex-col gap-3">
          <Label className={LABEL_CLASES}>
            URL del feed de {canalNombre} (.ics)
            <Input
              type="url"
              value={urlImportacion}
              onChange={(e) => setUrlImportacion(e.target.value)}
              required
              placeholder={`https://www.${canalCodigo}.com/calendar/ical/....ics`}
            />
          </Label>
          <p className="m-0 flex items-start gap-2 text-xs text-muted-foreground">
            <Link2 className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.75} />
            La encuentras en la configuración de calendario de {canalNombre}, como "exportar calendario".
          </p>
          <div className="flex flex-col gap-1.5">
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={probando} onClick={() => void handleProbar()}>
              {probando ? "Probando…" : "Probar URL"}
            </Button>
            <p className="m-0 text-xs text-muted-foreground">Descarga el calendario y cuenta sus eventos sin guardar nada.</p>
            {prueba?.ok === true && (
              <p role="status" className="m-0 flex items-start gap-1.5 text-xs text-foreground">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.75} aria-hidden />
                <span>
                  La URL funciona: {prueba.eventos} evento{prueba.eventos === 1 ? "" : "s"}
                  {prueba.desde && prueba.hasta ? `, del ${prueba.desde} al ${prueba.hasta}` : ""}
                  {prueba.cancelados > 0 ? ` (${prueba.cancelados} cancelado${prueba.cancelados === 1 ? "" : "s"})` : ""}.
                </span>
              </p>
            )}
            {prueba?.ok === false && (
              <p role="alert" className="m-0 text-xs text-destructive">
                {prueba.mensaje}
                {prueba.errores.length > 0 ? ` ${prueba.errores.map((e) => e.mensaje).join(" ")}` : ""}
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </FormDialog>
    </Card>
  );
}
