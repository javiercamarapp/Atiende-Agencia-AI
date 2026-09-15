// Cotizador + configuración de pricing (Fase 14) — cierra el hallazgo de auditoría
// "Cotizador y configuración de pricing (6 endpoints) sin UI": GET .../cotizacion
// (R2) y los 5 POST de pricing-config.ts (Fase 2) ya existían en el backend, pero
// ninguna página de apps/web los invocaba -- el admin_gestora no podía configurar
// precios desde el producto (Dashboard.tsx lo decía explícitamente, ver su línea
// "El cotizador y el panel de finanzas de rentas todavía no tienen UI").
//
// Dos secciones, mismo patrón de "unidad seleccionada -> panel" que Calendario.tsx:
//  1. Cotizador -- fechas + canal opcional -> GET cotización. Disponible para
//     CUALQUIER staff con acceso a la property (igual que el backend:
//     cotizaciones.ts no exige `PRICING_ESCRITURA_ROLES`, solo
//     `requirePropertyMembership`).
//  2. Configuración de pricing -- los 5 POST, gateados en el CLIENTE por
//     `PRICING_ESCRITURA_ROLES = ["admin_gestora"]` (packages/domain-rentas/src/
//     roles.ts) para no mostrarle a un operador un formulario que el servidor
//     rechazaría con 403 igual -- el servidor SIEMPRE re-valida vía
//     `assertVerticalRole` (pricing-config.ts), este gate es solo UX. Rol resuelto
//     de `session.organizations` (misma fuente que Dashboard.tsx ya usa para
//     mostrar "rol <strong>{org.rol}</strong>").
//
// Límite real, documentado también en pricing-client.ts: pricing-config.ts NUNCA
// expuso un GET que liste la configuración ya guardada (solo los 5 POST) -- por
// eso cada sub-formulario muestra "Configurado en esta sesión" en vez de un
// historial persistente; recargar la página pierde esa lista local (los datos en
// el servidor NO se pierden, solo la vista de "qué acabo de crear").
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  basisPointsAPorcentaje,
  CANALES_CON_MARKUP,
  centavosAPesos,
  crearDescuentoDuracion,
  crearReglaCanal,
  crearReglaMinStay,
  crearTarifaBase,
  crearTemporada,
  fetchCotizacion,
  fetchUnidades,
  pesosACentavos,
  porcentajeABasisPoints,
  TODOS_LOS_CANALES,
} from "../lib/pricing-client.ts";
import type {
  DescuentoDuracionCreado,
  MinStayCreada,
  ReglaCanalCreada,
  ResultadoCotizacion,
  TarifaBaseCreada,
  TemporadaCreada,
  UnidadOption,
} from "../lib/pricing-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const PRICING_ESCRITURA_ROLES = new Set(["admin_gestora"]);

const inputStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const labelStyle: CSSProperties = { fontSize: 13 };
const sectionStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const formRowStyle: CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap" };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const noticeStyle: CSSProperties = { margin: 0, fontSize: 12, color: "#065f46", background: "#d1fae5", padding: "6px 10px", borderRadius: 8 };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };
const creadoListStyle: CSSProperties = { margin: "4px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#374151" };

const DIA_SEMANA_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export function PreciosPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? PRICING_ESCRITURA_ROLES.has(org.rol) : false;

  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [apiBaseUrl, token, propertyId]);

  if (unidades && unidades.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Precios</h1>
        <p role="alert" style={errorStyle}>
          Esta propiedad todavía no tiene ninguna unidad configurada.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Precios</h1>
        <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>Cotiza una estadía y, si tu rol lo permite, configura la tarifa de la unidad.</p>
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

      {unidadId && <Cotizador apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />}

      {unidadId && puedeEscribir && <ConfiguracionPricing apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />}

      {unidadId && !puedeEscribir && (
        <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
          Solo el rol <strong>admin_gestora</strong> puede configurar tarifa base, temporadas, descuentos por duración, estancia mínima y reglas por canal
          {org ? <> — tu rol actual es <strong>{org.rol}</strong>.</> : "."}
        </p>
      )}
    </div>
  );
}

interface UnidadPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
}

function Cotizador({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [canal, setCanal] = useState("");
  const [cotizando, setCotizando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCotizacion | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCotizar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!checkIn || !checkOut) return setError("Check-in y check-out son requeridos.");
    setCotizando(true);
    setResultado(null);
    try {
      const r = await fetchCotizacion(fetch, apiBaseUrl, token, propertyId, unidadId, { inicio: checkIn, fin: checkOut }, canal || undefined);
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular la cotización.");
    } finally {
      setCotizando(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Cotizador</h2>
      <form onSubmit={handleCotizar} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={formRowStyle}>
          <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
            Check-in
            <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
            Check-out
            <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, flex: 1, minWidth: 160 }}>
            Canal (opcional)
            <select value={canal} onChange={(e) => setCanal(e.target.value)} style={inputStyle}>
              <option value="">Reserva directa (sin canal)</option>
              {TODOS_LOS_CANALES.map((c) => (
                <option key={c.codigo} value={c.codigo}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        )}
        <button type="submit" disabled={cotizando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
          {cotizando ? "Cotizando…" : "Cotizar"}
        </button>
      </form>

      {resultado && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 0" }}>Noche</th>
                <th style={{ padding: "4px 0" }}>Origen</th>
                <th style={{ padding: "4px 0", textAlign: "right" }}>Precio</th>
              </tr>
            </thead>
            <tbody>
              {resultado.desgloseNoches.map((n) => (
                <tr key={n.fecha} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px 0" }}>{n.fecha}</td>
                  <td style={{ padding: "4px 0", color: "#6b7280" }}>{n.origen === "temporada" ? `Temporada: ${n.temporadaNombre}` : "Base"}</td>
                  <td style={{ padding: "4px 0", textAlign: "right" }}>
                    {centavosAPesos(n.precioCentavos)} {resultado.moneda}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <Linea label={`Subtotal (${resultado.noches} noche${resultado.noches === 1 ? "" : "s"})`} valorCentavos={resultado.subtotalAntesDescuentoCentavos} moneda={resultado.moneda} />
            {resultado.descuentoAplicado && (
              <Linea
                label={`Descuento (${resultado.descuentoAplicado.nochesMinimas}+ noches, ${basisPointsAPorcentaje(resultado.descuentoAplicado.porcentajeDescuentoBasisPoints)}% — ${resultado.descuentoAplicado.fuente})`}
                valorCentavos={-resultado.descuentoAplicado.montoCentavos}
                moneda={resultado.moneda}
              />
            )}
            {resultado.markupCanalCentavos > 0 && <Linea label="Markup de canal" valorCentavos={resultado.markupCanalCentavos} moneda={resultado.moneda} />}
            <Linea label="Total" valorCentavos={resultado.totalCentavos} moneda={resultado.moneda} fuerte />
          </div>

          {resultado.violacionesMinStay.length > 0 && (
            <div style={{ fontSize: 12, color: "#92400e", background: "#fef3c7", padding: "8px 12px", borderRadius: 8 }}>
              {resultado.violacionesMinStay.map((v, i) => (
                <p key={i} style={{ margin: i === 0 ? 0 : "4px 0 0" }}>
                  No cumple la estancia mínima de {v.regla.nochesMinimas} noches
                  {v.regla.diaSemanaCheckIn !== null ? ` para check-in en ${DIA_SEMANA_LABELS[v.regla.diaSemanaCheckIn]}` : ""} ({v.regla.rango.inicio}..{v.regla.rango.fin}) — se solicitaron{" "}
                  {v.nochesSolicitadas}. Esto es informativo: el precio de arriba SÍ es el precio real, la decisión de bloquear la reserva es del calendario, no del cotizador.
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Linea({ label, valorCentavos, moneda, fuerte }: { label: string; valorCentavos: number; moneda: string; fuerte?: boolean }) {
  const signo = valorCentavos < 0 ? "-" : "";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: fuerte ? 700 : 400 }}>
      <span>{label}</span>
      <span>
        {signo}
        {centavosAPesos(Math.abs(valorCentavos))} {moneda}
      </span>
    </div>
  );
}

function ConfiguracionPricing({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Configuración de pricing</h2>
      <TarifaBaseForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <TemporadaForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <DescuentoDuracionForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <MinStayForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <ReglaCanalForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
    </section>
  );
}

function TarifaBaseForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [precio, setPrecio] = useState("");
  const [moneda, setMoneda] = useState("MXN");
  const [vigenteDesde, setVigenteDesde] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly TarifaBaseCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const precioNum = Number(precio);
    if (!precio || Number.isNaN(precioNum) || precioNum < 0) return setError("Precio por noche inválido.");
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    setGuardando(true);
    try {
      const creada = await crearTarifaBase(fetch, apiBaseUrl, token, propertyId, unidadId, {
        precioNocheCentavos: pesosACentavos(precioNum),
        moneda: moneda.toUpperCase(),
        vigenteDesde: vigenteDesde || undefined,
      });
      setCreadas((prev) => [creada, ...prev]);
      setPrecio("");
      setVigenteDesde("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la tarifa base.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Tarifa base</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Precio por noche
          <input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} required style={inputStyle} placeholder="1000.00" />
        </label>
        <label style={{ ...labelStyle, width: 90 }}>
          Moneda
          <input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required style={inputStyle} placeholder="MXN" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Vigente desde (opcional, hoy si se deja vacío)
          <input type="date" value={vigenteDesde} onChange={(e) => setVigenteDesde(e.target.value)} style={inputStyle} />
        </label>
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Guardando…" : "Guardar tarifa base"}
      </button>
      {creadas.length > 0 && (
        <div>
          <p style={noticeStyle}>Configurado en esta sesión (no hay lectura persistente todavía — ver comentario en pricing-client.ts):</p>
          <ul style={creadoListStyle}>
            {creadas.map((c) => (
              <li key={c.id}>
                {centavosAPesos(c.precioNocheCentavos)} {c.moneda} · vigente desde {c.vigenteDesde}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function TemporadaForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [nombre, setNombre] = useState("");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [precio, setPrecio] = useState("");
  const [moneda, setMoneda] = useState("MXN");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly TemporadaCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const precioNum = Number(precio);
    if (!nombre.trim()) return setError("El nombre de la temporada es requerido.");
    if (!inicio || !fin) return setError("Inicio y fin son requeridos.");
    if (!precio || Number.isNaN(precioNum) || precioNum < 0) return setError("Precio por noche inválido.");
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    setGuardando(true);
    try {
      const creada = await crearTemporada(fetch, apiBaseUrl, token, propertyId, unidadId, {
        nombre: nombre.trim(),
        rango: { inicio, fin },
        precioNocheCentavos: pesosACentavos(precioNum),
        moneda: moneda.toUpperCase(),
      });
      setCreadas((prev) => [creada, ...prev]);
      setNombre("");
      setInicio("");
      setFin("");
      setPrecio("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la temporada.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Temporadas</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 160 }}>
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required style={inputStyle} placeholder="Semana Santa" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Inicio
          <input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Fin (exclusivo)
          <input type="date" value={fin} onChange={(e) => setFin(e.target.value)} required style={inputStyle} />
        </label>
      </div>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Precio por noche
          <input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} required style={inputStyle} placeholder="1500.00" />
        </label>
        <label style={{ ...labelStyle, width: 90 }}>
          Moneda
          <input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required style={inputStyle} placeholder="MXN" />
        </label>
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Guardando…" : "Agregar temporada"}
      </button>
      {creadas.length > 0 && (
        <div>
          <p style={noticeStyle}>Configurado en esta sesión:</p>
          <ul style={creadoListStyle}>
            {creadas.map((c) => (
              <li key={c.id}>
                {c.nombre}: {c.rango.inicio} → {c.rango.fin} · {centavosAPesos(c.precioNocheCentavos)} {c.moneda}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function DescuentoDuracionForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [nochesMinimas, setNochesMinimas] = useState("");
  const [porcentaje, setPorcentaje] = useState("");
  const [fuente, setFuente] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creados, setCreados] = useState<readonly DescuentoDuracionCreado[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const noches = Number(nochesMinimas);
    const pct = Number(porcentaje);
    if (!nochesMinimas || !Number.isInteger(noches) || noches < 1) return setError("Noches mínimas: entero >= 1.");
    if (!porcentaje || Number.isNaN(pct) || pct < 0 || pct > 100) return setError("Porcentaje de descuento: 0 a 100.");
    if (!fuente.trim()) return setError("La fuente del descuento es requerida (ej. \"promoción semanal\").");
    setGuardando(true);
    try {
      const creado = await crearDescuentoDuracion(fetch, apiBaseUrl, token, propertyId, unidadId, {
        nochesMinimas: noches,
        porcentajeDescuentoBasisPoints: porcentajeABasisPoints(pct),
        fuente: fuente.trim(),
      });
      setCreados((prev) => [creado, ...prev]);
      setNochesMinimas("");
      setPorcentaje("");
      setFuente("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el descuento por duración.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Descuentos por duración</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Noches mínimas
          <input type="number" min="1" step="1" value={nochesMinimas} onChange={(e) => setNochesMinimas(e.target.value)} required style={inputStyle} placeholder="7" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Descuento (%)
          <input type="number" min="0" max="100" step="0.01" value={porcentaje} onChange={(e) => setPorcentaje(e.target.value)} required style={inputStyle} placeholder="10" />
        </label>
        <label style={{ ...labelStyle, flex: 2, minWidth: 200 }}>
          Fuente
          <input value={fuente} onChange={(e) => setFuente(e.target.value)} required style={inputStyle} placeholder="Promoción semanal" />
        </label>
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Guardando…" : "Agregar descuento"}
      </button>
      {creados.length > 0 && (
        <div>
          <p style={noticeStyle}>Configurado en esta sesión:</p>
          <ul style={creadoListStyle}>
            {creados.map((c) => (
              <li key={c.id}>
                {c.nochesMinimas}+ noches: {basisPointsAPorcentaje(c.porcentajeDescuentoBasisPoints)}% ({c.fuente})
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function MinStayForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [diaSemana, setDiaSemana] = useState("");
  const [nochesMinimas, setNochesMinimas] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly MinStayCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const noches = Number(nochesMinimas);
    if (!inicio || !fin) return setError("Inicio y fin son requeridos.");
    if (!nochesMinimas || !Number.isInteger(noches) || noches < 1) return setError("Noches mínimas: entero >= 1.");
    setGuardando(true);
    try {
      const creada = await crearReglaMinStay(fetch, apiBaseUrl, token, propertyId, unidadId, {
        rango: { inicio, fin },
        diaSemanaCheckIn: diaSemana === "" ? null : Number(diaSemana),
        nochesMinimas: noches,
      });
      setCreadas((prev) => [creada, ...prev]);
      setInicio("");
      setFin("");
      setDiaSemana("");
      setNochesMinimas("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla de estancia mínima.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Estancia mínima (min-stay)</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Inicio
          <input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Fin (exclusivo)
          <input type="date" value={fin} onChange={(e) => setFin(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 150 }}>
          Día de check-in
          <select value={diaSemana} onChange={(e) => setDiaSemana(e.target.value)} style={inputStyle}>
            <option value="">Todos los días</option>
            {DIA_SEMANA_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Noches mínimas
          <input type="number" min="1" step="1" value={nochesMinimas} onChange={(e) => setNochesMinimas(e.target.value)} required style={inputStyle} placeholder="3" />
        </label>
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Guardando…" : "Agregar regla"}
      </button>
      {creadas.length > 0 && (
        <div>
          <p style={noticeStyle}>Configurado en esta sesión:</p>
          <ul style={creadoListStyle}>
            {creadas.map((c) => (
              <li key={c.id}>
                {c.rango.inicio} → {c.rango.fin}{c.diaSemanaCheckIn !== null ? ` (${DIA_SEMANA_LABELS[c.diaSemanaCheckIn]})` : ""}: mínimo {c.nochesMinimas} noches
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function ReglaCanalForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [canalCodigo, setCanalCodigo] = useState(CANALES_CON_MARKUP[0]!.codigo);
  const [markup, setMarkup] = useState("");
  const [activo, setActivo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly ReglaCanalCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const pct = Number(markup);
    if (!markup || Number.isNaN(pct) || pct < 0 || pct > 100) return setError("Markup: 0 a 100%.");
    setGuardando(true);
    try {
      const creada = await crearReglaCanal(fetch, apiBaseUrl, token, propertyId, unidadId, {
        canalCodigo,
        markupBasisPoints: porcentajeABasisPoints(pct),
        activo,
      });
      setCreadas((prev) => [creada, ...prev]);
      setMarkup("");
      setActivo(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla de canal.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={sectionStyle}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Reglas por canal</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 150 }}>
          Canal
          <select value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)} style={inputStyle}>
            {CANALES_CON_MARKUP.map((c) => (
              <option key={c.codigo} value={c.codigo}>
                {c.nombre}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Markup (%)
          <input type="number" min="0" max="100" step="0.01" value={markup} onChange={(e) => setMarkup(e.target.value)} required style={inputStyle} placeholder="15" />
        </label>
        <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6, marginTop: 20 }}>
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Activa (aplica al cotizar para este canal)
        </label>
      </div>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Guardando…" : "Guardar regla de canal"}
      </button>
      {creadas.length > 0 && (
        <div>
          <p style={noticeStyle}>Configurado en esta sesión:</p>
          <ul style={creadoListStyle}>
            {creadas.map((c) => (
              <li key={c.id}>
                {c.canalCodigo}: {basisPointsAPorcentaje(c.markupBasisPoints)}% markup — {c.activo ? "activa" : "inactiva"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
