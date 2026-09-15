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
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
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

const inputStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const labelStyle: CSSProperties = { fontSize: 13 };
const sectionStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const formRowStyle: CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap" };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const dangerButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const secondaryButtonStyle: CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };
const badgeOkStyle: CSSProperties = { fontSize: 11, color: "#065f46", background: "#d1fae5", padding: "2px 8px", borderRadius: 999 };
const badgeWarnStyle: CSSProperties = { fontSize: 11, color: "#92400e", background: "#fef3c7", padding: "2px 8px", borderRadius: 999 };
const badgeOffStyle: CSSProperties = { fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 999 };

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
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Sincronización de calendario (iCal)</h1>
        <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
          Tu rol actual{org ? <> (<strong>{org.rol}</strong>)</> : ""} no tiene acceso de lectura a la sincronización de calendario. Roles con acceso:{" "}
          <strong>admin_gestora</strong>, <strong>operador:acceso_total</strong>, <strong>operador:calendario_mensajeria</strong> y <strong>operador:solo_calendario</strong>.
        </p>
      </div>
    );
  }

  if (unidades && unidades.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Sincronización de calendario (iCal)</h1>
        <p role="alert" style={errorStyle}>
          Esta propiedad todavía no tiene ninguna unidad configurada.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Sincronización de calendario (iCal)</h1>
        <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>
          Conecta el feed iCal de cada canal externo para importar su disponibilidad y evitar doble reserva, y copia la URL del feed de exportación de esta unidad para pegarla
          en el canal.
          {!puedeEscribir && (
            <>
              {" "}
              Tu rol (<strong>{org?.rol}</strong>) es de solo lectura — conectar/desconectar es exclusivo de <strong>admin_gestora</strong>, <strong>operador:acceso_total</strong> y{" "}
              <strong>operador:calendario_mensajeria</strong>.
            </>
          )}
        </p>
      </header>

      <label style={{ ...labelStyle, maxWidth: 320 }}>
        Unidad
        <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} style={inputStyle} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}

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
    return (
      <p role="alert" style={errorStyle}>
        {error}
      </p>
    );
  }

  if (!feeds) {
    return <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>;
  }

  const feedPorCanal = new Map(feeds.map((f) => [f.canal, f] as const));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
  const [guardando, setGuardando] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlExportacion = construirUrlFeedExportacion(apiBaseUrl, propertyId, unidadId, canalCodigo);

  async function handleConectar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!urlImportacion.trim()) return setError("La URL del feed a importar es requerida.");
    setGuardando(true);
    try {
      await conectarFeed(fetch, apiBaseUrl, token, propertyId, unidadId, canalCodigo, urlImportacion.trim());
      setUrlImportacion("");
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
    <section style={sectionStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{canalNombre}</h2>
        {feed && (
          <span style={feed.enCuarentenaDesde ? badgeWarnStyle : feed.activo ? badgeOkStyle : badgeOffStyle}>
            {feed.enCuarentenaDesde ? "En cuarentena" : feed.activo ? "Conectado" : "Inactivo"}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p style={{ margin: 0, fontSize: 12, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>Importar desde {canalNombre}</p>
        {feed ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <p style={{ margin: 0, wordBreak: "break-all" }}>{feed.urlImportacion}</p>
            <p style={{ margin: 0, color: "#6b7280", fontSize: 12 }}>Última sincronización exitosa: {formatearFecha(feed.ultimaSincronizacionExitosaEn)}</p>
            {feed.intentosFallidosConsecutivos > 0 && (
              <p style={{ margin: 0, color: "#92400e", fontSize: 12 }}>
                {feed.intentosFallidosConsecutivos} intento{feed.intentosFallidosConsecutivos === 1 ? "" : "s"} fallido{feed.intentosFallidosConsecutivos === 1 ? "" : "s"} consecutivo
                {feed.intentosFallidosConsecutivos === 1 ? "" : "s"}
                {feed.motivoCuarentena ? ` — ${feed.motivoCuarentena}` : ""}
              </p>
            )}
            {puedeEscribir && (
              <button type="button" onClick={handleDesconectar} disabled={desconectando} style={{ ...dangerButtonStyle, alignSelf: "flex-start" }}>
                {desconectando ? "Desconectando…" : "Desconectar"}
              </button>
            )}
          </div>
        ) : puedeEscribir ? (
          <form onSubmit={handleConectar} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={formRowStyle}>
              <label style={{ ...labelStyle, flex: 1, minWidth: 260 }}>
                URL del feed de {canalNombre} (.ics)
                <input
                  type="url"
                  value={urlImportacion}
                  onChange={(e) => setUrlImportacion(e.target.value)}
                  required
                  style={inputStyle}
                  placeholder={`https://www.${canalCodigo}.com/calendar/ical/....ics`}
                />
              </label>
            </div>
            <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
              {guardando ? "Conectando…" : "Conectar"}
            </button>
          </form>
        ) : (
          <p style={{ margin: 0, color: "#9ca3af", fontSize: 12 }}>Ningún feed conectado todavía.</p>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Exportar hacia {canalNombre}
        </p>
        <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Pega esta URL como feed de importación dentro de {canalNombre} para que reciba nuestra disponibilidad.</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input readOnly value={urlExportacion} onFocus={(e) => e.currentTarget.select()} style={{ ...inputStyle, flex: 1, minWidth: 260, margin: 0, fontSize: 12 }} />
          <button type="button" onClick={handleCopiarExport} style={secondaryButtonStyle}>
            {copiado ? "¡Copiada!" : "Copiar"}
          </button>
        </div>
      </div>
    </section>
  );
}
