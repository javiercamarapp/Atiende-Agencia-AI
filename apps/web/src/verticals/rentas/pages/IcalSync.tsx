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
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Badge/Input/
// Label/EstadoCargando/EstadoError + clases de token en vez de los `style={{...}}`
// hechos a mano. El formulario de "conectar feed" pasa a <ModalFormularioLateral>
// (el shell de modal ya existente del repo), conservando EXACTAMENTE su submit, su
// validación local ("La URL del feed a importar es requerida.") y su recarga
// (`onCambio`). CERO cambios de lógica ni de gates de rol.
import { useEffect, useState } from "react";
import { Copy, Link2, Plug, Unplug } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import {
  CANALES_CON_MARKUP,
  conectarFeed,
  construirUrlFeedExportacion,
  desconectarFeed,
  fetchFeedsUnidad,
  fetchUnidades,
} from "../lib/ical-sync-client.ts";
import type { FeedIcalSync, UnidadOption } from "../lib/ical-sync-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES
// (packages/domain-rentas/src/roles.ts) -- mismo criterio que
// PRICING_ESCRITURA_ROLES en Precios.tsx: apps/web nunca importa un paquete
// domain-* (ver comentario de cabecera de calendario-client.ts), así que el
// espejo de rol vive aquí, redeclarado a mano.
const SYNC_CALENDARIO_LECTURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"]);
const SYNC_CALENDARIO_ESCRITURA_ROLES = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

/** Mismos tokens que el <Input> de @atiende/ui aplicados al <select> nativo de
 * unidades: es un dropdown de datos reales con su estado `<option>Cargando…</option>`,
 * se queda nativo y solo se re-estila. */
const SELECT_CLASES =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";
const RUBRO_CLASES = "m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

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
      <div className="flex flex-col gap-4 max-w-[640px]">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Sincronización de calendario (iCal)</h1>
        <p className="m-0 text-[13px] text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso de lectura a la sincronización de calendario. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong>, <strong className="text-foreground">operador:acceso_total</strong>,{" "}
          <strong className="text-foreground">operador:calendario_mensajeria</strong> y <strong className="text-foreground">operador:solo_calendario</strong>.
        </p>
      </div>
    );
  }

  if (unidades && unidades.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Sincronización de calendario (iCal)</h1>
        <EstadoError titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 max-w-[760px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Sincronización de calendario (iCal)</h1>
        <p className="m-0 text-[13px] text-muted-foreground">
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
        <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className={SELECT_CLASES} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </select>
      </Label>

      {error && <EstadoError mensaje={error} />}

      {unidadId && <CanalesSync apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} puedeEscribir={puedeEscribir} />}
    </div>
  );
}

interface CanalesSyncProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly puedeEscribir: boolean;
}

function CanalesSync({ apiBaseUrl, token, propertyId, unidadId, puedeEscribir }: CanalesSyncProps) {
  const [feeds, setFeeds] = useState<readonly FeedIcalSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    (async () => {
      try {
        const list = await fetchFeedsUnidad(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (!cancelado) setFeeds(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el estado de sincronización de esta unidad.");
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
}

function CanalCard({ apiBaseUrl, token, propertyId, unidadId, canalCodigo, canalNombre, feed, puedeEscribir, onCambio }: CanalCardProps) {
  const [urlImportacion, setUrlImportacion] = useState("");
  const [modalAbierto, setModalAbierto] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlExportacion = construirUrlFeedExportacion(apiBaseUrl, propertyId, unidadId, canalCodigo);

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

  return (
    <Card>
      <CardHeader className="p-4 pb-2 flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-[15px] font-semibold">{canalNombre}</CardTitle>
        {feed && (
          <Badge variant={feed.enCuarentenaDesde ? "destructive" : feed.activo ? "default" : "outline"}>
            {feed.enCuarentenaDesde ? "En cuarentena" : feed.activo ? "Conectado" : "Inactivo"}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        {error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <p className={RUBRO_CLASES}>Importar desde {canalNombre}</p>
          {feed ? (
            <div className="flex flex-col gap-1.5 text-[13px]">
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
                <Button type="button" variant="destructive" size="sm" onClick={handleDesconectar} disabled={desconectando} className="self-start">
                  <Unplug className="w-4 h-4" strokeWidth={1.75} />
                  {desconectando ? "Desconectando…" : "Desconectar"}
                </Button>
              )}
            </div>
          ) : puedeEscribir ? (
            <Button type="button" size="sm" onClick={() => setModalAbierto(true)} className="self-start">
              <Plug className="w-4 h-4" strokeWidth={1.75} />
              Conectar
            </Button>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">Ningún feed conectado todavía.</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <p className={RUBRO_CLASES}>Exportar hacia {canalNombre}</p>
          <p className="m-0 text-xs text-muted-foreground">Pega esta URL como feed de importación dentro de {canalNombre} para que reciba nuestra disponibilidad.</p>
          <div className="flex gap-2 items-center flex-wrap">
            <Input readOnly value={urlExportacion} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-[260px] text-xs" />
            <Button type="button" variant="outline" size="sm" onClick={handleCopiarExport}>
              <Copy className="w-4 h-4" strokeWidth={1.75} />
              {copiado ? "¡Copiada!" : "Copiar"}
            </Button>
          </div>
        </div>
      </CardContent>

      {/* Conectar feed: mismo submit exacto que el <form> inline previo, ahora en el
          shell de modal del repo. */}
      <ModalFormularioLateral
        open={modalAbierto}
        onOpenChange={(abierto) => {
          setModalAbierto(abierto);
          if (!abierto) setError(null);
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
          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </div>
      </ModalFormularioLateral>
    </Card>
  );
}
