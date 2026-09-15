// Finanzas (Fase 16) — cierra el hallazgo de auditoría ALTA "Finanzas (movimientos,
// owner statements, payouts/conciliación) sin UI para admin_gestora ni contador":
// finanzas.ts (POST/GET .../reservas/:ocupacionId/movimiento), finanzas-statements.ts
// (POST/GET .../owners/:ownerId/statements, GET .../statements/:id) y
// finanzas-payouts.ts (POST .../payouts, GET .../payouts/:id) ya estaban montados y
// probados en apps/api sin que ninguna página de apps/web los invocara.
//
// Tres secciones independientes, mismo patrón de "gate en el CLIENTE solo por UX,
// el servidor SIEMPRE re-valida vía assertVerticalRole" que ya usa Precios.tsx:
//  1. Movimiento financiero por reserva -- LECTURA para FINANZAS_LECTURA_ROLES
//     (admin_gestora + contador), ESCRITURA (registrar) solo admin_gestora
//     (FINANZAS_ESCRITURA_ROLES en packages/domain-rentas/src/roles.ts).
//  2. Owner statements -- misma separación lectura/escritura. Generar exige
//     motivoVersion cuando ya existe una versión previa (el servidor lo exige; esta
//     UI lo pide siempre que haya al menos un statement listado, para no
//     sorprender con un 400).
//  3. Payouts de canal + conciliación -- crear (POST) es escritura; ver el detalle
//     de un payout ya creado es lectura.
//
// Límite real (documentado también en finanzas-client.ts): ningún endpoint expone
// un catálogo de propietarios de una property ni una lista de payouts ya
// importados -- `ownerId`/`payoutId` se piden como texto libre, igual que
// pricing-client.ts documenta la ausencia de un GET de configuración de pricing.
//
// Portal de propietario (Fase 3 backend, UI de esta fase): "Invitar a este
// propietario" en la sección de owner statements llama
// POST .../owners/:ownerId/portal-invite (owner-portal-invite.ts) -- mismo
// FINANZAS_LECTURA_ROLES que ya gatea esta sección completa, el servidor
// re-valida con assertVerticalRole igual que el resto de esta página. El token
// de invitación se muestra UNA sola vez (nunca se puede recuperar de nuevo) para
// que staff lo copie/pegue en el mensaje que le mande al propietario -- no hay
// envío de correo real en este monorepo todavía (ver el comentario de cabecera
// de owner-portal-invite.ts). El propietario activa su cuenta y consulta sus
// statements en una superficie SEPARADA de este panel de staff (ver
// pages/OwnerPortalLogin.tsx/OwnerPortalActivar.tsx/OwnerPortalDashboard.tsx --
// login propio contra el JWT del portal, nunca el de staff).
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  CANALES_PAYOUT,
  centavosAPesos,
  fetchMovimiento,
  fetchOcupaciones,
  fetchOwnerStatementDetalle,
  fetchOwnerStatements,
  fetchPayoutDetalle,
  fetchUnidades,
  generarOwnerStatement,
  importarPayout,
  invitarPropietarioAlPortal,
  pesosACentavos,
  porcentajeABasisPoints,
  registrarMovimiento,
} from "../lib/finanzas-client.ts";
import type {
  BaseComisionGestor,
  LineaGastoEntrada,
  LineaImpuestoEntrada,
  LineaOwnerStatement,
  MovimientoDetalle,
  OcupacionCalendario,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutCreado,
  PayoutDetalle,
  PortalInviteEmitida,
  UnidadOption,
} from "../lib/finanzas-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const FINANZAS_LECTURA_ROLES = new Set(["admin_gestora", "contador"]);
const FINANZAS_ESCRITURA_ROLES = new Set(["admin_gestora"]);

const inputStyle: CSSProperties = { display: "block", width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" };
const labelStyle: CSSProperties = { fontSize: 13 };
const sectionStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const formRowStyle: CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap" };
const primaryButtonStyle: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 };
const secondaryButtonStyle: CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" };
const noticeStyle: CSSProperties = { margin: 0, fontSize: 12, color: "#065f46", background: "#d1fae5", padding: "6px 10px", borderRadius: 8 };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };

const TIPO_LINEA_LABELS: Record<string, string> = {
  ingreso: "Ingreso",
  comision_canal: "Comisión de canal",
  comision_gestor: "Comisión de gestor",
  gasto: "Gasto",
  impuesto: "Impuesto",
};

const ESTADO_CONCILIACION_LABELS: Record<string, string> = {
  conciliado: "Conciliado",
  pendiente: "Pendiente",
  discrepancia: "Discrepancia",
};

export function FinanzasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? FINANZAS_LECTURA_ROLES.has(org.rol) : false;
  const puedeEscribir = org ? FINANZAS_ESCRITURA_ROLES.has(org.rol) : false;

  if (!puedeLeer) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Finanzas</h1>
        <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
          Tu rol actual{org ? <> (<strong>{org.rol}</strong>)</> : ""} no tiene acceso de lectura a Finanzas. Roles con acceso: <strong>admin_gestora</strong> y <strong>contador</strong>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Finanzas</h1>
        <p style={{ color: "#6b7280", margin: 0, fontSize: 13 }}>
          Movimiento financiero por reserva, owner statements y payouts de canal.
          {!puedeEscribir && (
            <>
              {" "}
              Tu rol (<strong>{org?.rol}</strong>) es de solo lectura — registrar/generar es exclusivo de <strong>admin_gestora</strong>.
            </>
          )}
        </p>
      </header>

      <MovimientoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <OwnerStatementsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <PayoutsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
    </div>
  );
}

interface SectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

// ---------------------------------------------------------------------------
// 1. Movimiento financiero por reserva
// ---------------------------------------------------------------------------

function MovimientoSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState("");
  const [ocupaciones, setOcupaciones] = useState<readonly OcupacionCalendario[] | null>(null);
  const [ocupacionId, setOcupacionId] = useState("");
  const [cargando, setCargando] = useState(false);
  const [movimiento, setMovimiento] = useState<MovimientoDetalle | null>(null);
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

  useEffect(() => {
    if (!unidadId) return;
    let cancelado = false;
    setOcupaciones(null);
    setOcupacionId("");
    setMovimiento(null);
    (async () => {
      try {
        const list = await fetchOcupaciones(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (cancelado) return;
        const reservas = list.filter((o) => o.capa === "reserva");
        setOcupaciones(reservas);
        setOcupacionId(reservas[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas de esta unidad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, unidadId]);

  async function handleVerMovimiento() {
    if (!ocupacionId) return;
    setError(null);
    setCargando(true);
    setMovimiento(null);
    try {
      const m = await fetchMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId);
      setMovimiento(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el movimiento financiero.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Movimiento financiero por reserva</h2>

      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 180 }}>
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
        <label style={{ ...labelStyle, flex: 1, minWidth: 220 }}>
          Reserva
          <select value={ocupacionId} onChange={(e) => setOcupacionId(e.target.value)} style={inputStyle} disabled={!ocupaciones || ocupaciones.length === 0}>
            {!ocupaciones && <option>Cargando…</option>}
            {ocupaciones && ocupaciones.length === 0 && <option>Sin reservas en esta unidad</option>}
            {ocupaciones?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.rango.inicio} → {o.rango.fin} {o.huespedNombre ? `· ${o.huespedNombre}` : ""} ({o.estado})
              </option>
            ))}
          </select>
        </label>
      </div>

      <button type="button" onClick={handleVerMovimiento} disabled={!ocupacionId || cargando} style={{ ...secondaryButtonStyle, alignSelf: "flex-start" }}>
        {cargando ? "Consultando…" : "Ver movimiento registrado"}
      </button>

      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {movimiento && <MovimientoResumen m={movimiento} />}

      {puedeEscribir && ocupacionId && (
        <RegistrarMovimientoForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          ocupacionId={ocupacionId}
          onRegistrado={(m) => setMovimiento(m)}
        />
      )}
    </section>
  );
}

function MovimientoResumen({ m }: { m: MovimientoDetalle }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
      <Linea label="Ingreso bruto" valorCentavos={m.ingresoBrutoCentavos} moneda={m.moneda} />
      <Linea label={`Comisión de canal (${m.comisionCanalFuente})`} valorCentavos={-m.comisionCanalCentavos} moneda={m.moneda} />
      <Linea label="Monto recibido del canal" valorCentavos={m.montoRecibidoCentavos} moneda={m.moneda} />
      <Linea label="Comisión de gestor" valorCentavos={-m.comisionGestorCentavos} moneda={m.moneda} />
      <Linea label="Gastos" valorCentavos={-m.gastosCentavos} moneda={m.moneda} />
      <Linea label="Impuestos" valorCentavos={-m.impuestosCentavos} moneda={m.moneda} />
      <Linea label="Neto" valorCentavos={m.netoCentavos} moneda={m.moneda} fuerte />
    </div>
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

interface GastoRow {
  readonly key: string;
  tipo: string;
  descripcion: string;
  monto: string;
}

interface ImpuestoRow {
  readonly key: string;
  tipo: string;
  monto: string;
}

let filaSeq = 0;
function nuevaKey(): string {
  filaSeq += 1;
  return `fila-${filaSeq}`;
}

function RegistrarMovimientoForm({
  apiBaseUrl,
  token,
  propertyId,
  ocupacionId,
  onRegistrado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ocupacionId: string;
  onRegistrado: (m: MovimientoDetalle) => void;
}) {
  const [moneda, setMoneda] = useState("MXN");
  const [montoBruto, setMontoBruto] = useState("");
  const [comisionGestorPct, setComisionGestorPct] = useState("");
  const [comisionGestorBase, setComisionGestorBase] = useState<BaseComisionGestor>("bruto");
  const [gastos, setGastos] = useState<readonly GastoRow[]>([]);
  const [impuestos, setImpuestos] = useState<readonly ImpuestoRow[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function agregarGasto() {
    setGastos((prev) => [...prev, { key: nuevaKey(), tipo: "", descripcion: "", monto: "" }]);
  }
  function actualizarGasto(key: string, patch: Partial<GastoRow>) {
    setGastos((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function quitarGasto(key: string) {
    setGastos((prev) => prev.filter((g) => g.key !== key));
  }

  function agregarImpuesto() {
    setImpuestos((prev) => [...prev, { key: nuevaKey(), tipo: "", monto: "" }]);
  }
  function actualizarImpuesto(key: string, patch: Partial<ImpuestoRow>) {
    setImpuestos((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }
  function quitarImpuesto(key: string) {
    setImpuestos((prev) => prev.filter((i) => i.key !== key));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const brutoNum = Number(montoBruto);
    const pctNum = Number(comisionGestorPct);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!montoBruto || Number.isNaN(brutoNum) || brutoNum < 0) return setError("Monto bruto inválido.");
    if (!comisionGestorPct || Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) return setError("Comisión de gestor: 0 a 100%.");
    for (const g of gastos) {
      if (!g.tipo.trim()) return setError("Cada gasto necesita un tipo.");
      if (!g.monto || Number.isNaN(Number(g.monto)) || Number(g.monto) < 0) return setError(`Monto inválido en gasto "${g.tipo}".`);
    }
    for (const i of impuestos) {
      if (!i.tipo.trim()) return setError("Cada impuesto necesita un tipo.");
      if (!i.monto || Number.isNaN(Number(i.monto)) || Number(i.monto) < 0) return setError(`Monto inválido en impuesto "${i.tipo}".`);
    }

    const gastosPayload: LineaGastoEntrada[] = gastos.map((g) => ({ tipo: g.tipo.trim(), descripcion: g.descripcion.trim() || null, montoCentavos: pesosACentavos(Number(g.monto)) }));
    const impuestosPayload: LineaImpuestoEntrada[] = impuestos.map((i) => ({ tipo: i.tipo.trim(), montoCentavos: pesosACentavos(Number(i.monto)) }));

    setGuardando(true);
    try {
      const creado = await registrarMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId, {
        moneda: moneda.toUpperCase(),
        montoBrutoCentavos: pesosACentavos(brutoNum),
        comisionGestorBasisPoints: porcentajeABasisPoints(pctNum),
        comisionGestorBase,
        gastos: gastosPayload,
        impuestos: impuestosPayload,
      });
      onRegistrado(creado);
      setMontoBruto("");
      setComisionGestorPct("");
      setGastos([]);
      setImpuestos([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar el movimiento.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...sectionStyle, borderStyle: "dashed" }}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Registrar movimiento</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, width: 90 }}>
          Moneda
          <input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required style={inputStyle} placeholder="MXN" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 160 }}>
          Monto bruto (por el canal)
          <input type="number" min="0" step="0.01" value={montoBruto} onChange={(e) => setMontoBruto(e.target.value)} required style={inputStyle} placeholder="5000.00" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 160 }}>
          Comisión de gestor (%)
          <input type="number" min="0" max="100" step="0.01" value={comisionGestorPct} onChange={(e) => setComisionGestorPct(e.target.value)} required style={inputStyle} placeholder="10" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 180 }}>
          Base de la comisión de gestor
          <select value={comisionGestorBase} onChange={(e) => setComisionGestorBase(e.target.value as BaseComisionGestor)} style={inputStyle}>
            <option value="bruto">Sobre el bruto</option>
            <option value="neto_de_canal">Sobre el neto de comisión de canal</option>
          </select>
        </label>
      </div>

      <div>
        <p style={{ ...labelStyle, margin: "0 0 6px" }}>Gastos (opcional)</p>
        {gastos.map((g) => (
          <div key={g.key} style={{ ...formRowStyle, marginBottom: 6 }}>
            <input value={g.tipo} onChange={(e) => actualizarGasto(g.key, { tipo: e.target.value })} placeholder="Tipo (ej. limpieza)" style={{ ...inputStyle, flex: 1, minWidth: 140, marginTop: 0 }} />
            <input value={g.descripcion} onChange={(e) => actualizarGasto(g.key, { descripcion: e.target.value })} placeholder="Descripción (opcional)" style={{ ...inputStyle, flex: 1, minWidth: 160, marginTop: 0 }} />
            <input type="number" min="0" step="0.01" value={g.monto} onChange={(e) => actualizarGasto(g.key, { monto: e.target.value })} placeholder="Monto" style={{ ...inputStyle, width: 110, marginTop: 0 }} />
            <button type="button" onClick={() => quitarGasto(g.key)} style={secondaryButtonStyle}>
              Quitar
            </button>
          </div>
        ))}
        <button type="button" onClick={agregarGasto} style={secondaryButtonStyle}>
          + Agregar gasto
        </button>
      </div>

      <div>
        <p style={{ ...labelStyle, margin: "0 0 6px" }}>Impuestos (opcional — siempre sujetos a revisión fiscal)</p>
        {impuestos.map((i) => (
          <div key={i.key} style={{ ...formRowStyle, marginBottom: 6 }}>
            <input value={i.tipo} onChange={(e) => actualizarImpuesto(i.key, { tipo: e.target.value })} placeholder="Tipo (ej. ISR retenido)" style={{ ...inputStyle, flex: 1, minWidth: 160, marginTop: 0 }} />
            <input type="number" min="0" step="0.01" value={i.monto} onChange={(e) => actualizarImpuesto(i.key, { monto: e.target.value })} placeholder="Monto" style={{ ...inputStyle, width: 110, marginTop: 0 }} />
            <button type="button" onClick={() => quitarImpuesto(i.key)} style={secondaryButtonStyle}>
              Quitar
            </button>
          </div>
        ))}
        <button type="button" onClick={agregarImpuesto} style={secondaryButtonStyle}>
          + Agregar impuesto
        </button>
      </div>

      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Registrando…" : "Registrar movimiento"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2. Owner statements
// ---------------------------------------------------------------------------

function OwnerStatementsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [ownerId, setOwnerId] = useState("");
  const [statements, setStatements] = useState<readonly OwnerStatementSummary[] | null>(null);
  const [detalle, setDetalle] = useState<OwnerStatementDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResultado, setUltimoResultado] = useState<string | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [invite, setInvite] = useState<PortalInviteEmitida | null>(null);
  const [errorInvite, setErrorInvite] = useState<string | null>(null);

  async function invitarPropietario() {
    if (!ownerId.trim()) return setErrorInvite("Ingresa primero el id del propietario arriba.");
    setErrorInvite(null);
    setInvite(null);
    setInvitando(true);
    try {
      const resultado = await invitarPropietarioAlPortal(fetch, apiBaseUrl, token, propertyId, ownerId.trim());
      setInvite(resultado);
    } catch (err) {
      setErrorInvite(err instanceof Error ? err.message : "No se pudo invitar a este propietario.");
    } finally {
      setInvitando(false);
    }
  }

  async function cargarStatements(idOwner: string) {
    if (!idOwner.trim()) return setError("Se necesita el id del propietario.");
    setError(null);
    setCargando(true);
    setDetalle(null);
    try {
      const list = await fetchOwnerStatements(fetch, apiBaseUrl, token, propertyId, idOwner.trim());
      setStatements(list);
    } catch (err) {
      setStatements(null);
      setError(err instanceof Error ? err.message : "No se pudieron cargar los statements de este propietario.");
    } finally {
      setCargando(false);
    }
  }

  async function verDetalle(statementId: string) {
    setError(null);
    try {
      const d = await fetchOwnerStatementDetalle(fetch, apiBaseUrl, token, propertyId, statementId);
      setDetalle(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle del statement.");
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Owner statements</h2>
      <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>
        No hay un catálogo de propietarios en el backend todavía — ingresa el id del propietario (mismo que usa el portal del propietario).
      </p>

      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 220 }}>
          Id del propietario (ownerId)
          <input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={inputStyle} placeholder="uuid del propietario" />
        </label>
        <button type="button" onClick={() => cargarStatements(ownerId)} disabled={cargando} style={{ ...secondaryButtonStyle, alignSelf: "flex-end", marginBottom: 4 }}>
          {cargando ? "Consultando…" : "Ver statements"}
        </button>
        <button type="button" onClick={invitarPropietario} disabled={invitando} style={{ ...secondaryButtonStyle, alignSelf: "flex-end", marginBottom: 4 }}>
          {invitando ? "Invitando…" : "Invitar a este propietario"}
        </button>
      </div>

      {errorInvite && <p role="alert" style={errorStyle}>{errorInvite}</p>}
      {invite && (
        <p style={noticeStyle}>
          Invitación creada (vence {invite.expiresAt}). Comparte este token con el propietario para que active su cuenta en el portal:{" "}
          <code style={{ userSelect: "all", background: "#fff", padding: "1px 4px", borderRadius: 4 }}>{invite.inviteToken}</code>
        </p>
      )}

      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {statements && statements.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Este propietario no tiene ningún statement generado todavía.</p>}

      {statements && statements.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={{ padding: "4px 0" }}>Periodo</th>
              <th style={{ padding: "4px 0" }}>Versión</th>
              <th style={{ padding: "4px 0", textAlign: "right" }}>Neto</th>
              <th style={{ padding: "4px 0" }}>Generado</th>
              <th style={{ padding: "4px 0" }}></th>
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                <td style={{ padding: "4px 0" }}>
                  {s.periodo.inicio} → {s.periodo.fin}
                </td>
                <td style={{ padding: "4px 0" }}>v{s.version}</td>
                <td style={{ padding: "4px 0", textAlign: "right" }}>
                  {centavosAPesos(s.netoCentavos)} {s.moneda}
                </td>
                <td style={{ padding: "4px 0", color: "#6b7280" }}>{s.generadoEn}</td>
                <td style={{ padding: "4px 0" }}>
                  <button type="button" onClick={() => verDetalle(s.id)} style={secondaryButtonStyle}>
                    Ver detalle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detalle && (
        <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            Statement v{detalle.version} — {detalle.periodo.inicio} → {detalle.periodo.fin}
          </p>
          {detalle.motivoVersion && (
            <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Motivo de esta versión: {detalle.motivoVersion}</p>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 0" }}>Reserva</th>
                <th style={{ padding: "4px 0" }}>Tipo</th>
                <th style={{ padding: "4px 0", textAlign: "right" }}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {detalle.lineas.map((l: LineaOwnerStatement, i: number) => (
                <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px 0" }}>{l.ocupacionId}</td>
                  <td style={{ padding: "4px 0" }}>{TIPO_LINEA_LABELS[l.tipo] ?? l.tipo}</td>
                  <td style={{ padding: "4px 0", textAlign: "right" }}>
                    {centavosAPesos(l.montoCentavos)} {detalle.moneda}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
            <Linea label="Ingresos brutos" valorCentavos={detalle.totales.ingresosBrutosCentavos} moneda={detalle.moneda} />
            <Linea label="Comisión de canal" valorCentavos={-detalle.totales.comisionCanalCentavos} moneda={detalle.moneda} />
            <Linea label="Comisión de gestor" valorCentavos={-detalle.totales.comisionGestorCentavos} moneda={detalle.moneda} />
            <Linea label="Gastos" valorCentavos={-detalle.totales.gastosCentavos} moneda={detalle.moneda} />
            <Linea label="Impuestos" valorCentavos={-detalle.totales.impuestosCentavos} moneda={detalle.moneda} />
            <Linea label="Neto" valorCentavos={detalle.totales.netoCentavos} moneda={detalle.moneda} fuerte />
          </div>
        </div>
      )}

      {puedeEscribir && (
        <GenerarStatementForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          ownerId={ownerId}
          hayVersionPrevia={(statements?.length ?? 0) > 0}
          onGenerado={(resultado) => {
            setUltimoResultado(
              resultado.creado
                ? `Statement nuevo creado: versión ${resultado.version}.`
                : `Sin cambios: el contenido es idéntico al de la versión ${resultado.version} ya existente (idempotente).`,
            );
            if (ownerId.trim()) cargarStatements(ownerId);
          }}
        />
      )}
      {ultimoResultado && <p style={noticeStyle}>{ultimoResultado}</p>}
    </section>
  );
}

function GenerarStatementForm({
  apiBaseUrl,
  token,
  propertyId,
  ownerId,
  hayVersionPrevia,
  onGenerado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ownerId: string;
  hayVersionPrevia: boolean;
  onGenerado: (r: { creado: boolean; version: number }) => void;
}) {
  const [periodoInicio, setPeriodoInicio] = useState("");
  const [periodoFin, setPeriodoFin] = useState("");
  const [motivoVersion, setMotivoVersion] = useState("");
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!ownerId.trim()) return setError("Ingresa primero el id del propietario arriba.");
    if (!periodoInicio || !periodoFin) return setError("Periodo inicio y fin son requeridos.");
    if (hayVersionPrevia && !motivoVersion.trim()) return setError("Ya existe una versión previa para este propietario — el motivo de la nueva versión es obligatorio.");
    setGenerando(true);
    try {
      const resultado = await generarOwnerStatement(fetch, apiBaseUrl, token, propertyId, ownerId.trim(), {
        periodoInicio,
        periodoFin,
        motivoVersion: motivoVersion.trim() || undefined,
      });
      onGenerado(resultado);
      setMotivoVersion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el statement.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...sectionStyle, borderStyle: "dashed" }}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Generar statement</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Periodo inicio
          <input type="date" value={periodoInicio} onChange={(e) => setPeriodoInicio(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 130 }}>
          Periodo fin
          <input type="date" value={periodoFin} onChange={(e) => setPeriodoFin(e.target.value)} required style={inputStyle} />
        </label>
      </div>
      <label style={labelStyle}>
        Motivo de nueva versión {hayVersionPrevia ? "(obligatorio: ya existe al menos una versión)" : "(opcional — todavía no hay ninguna versión previa)"}
        <input value={motivoVersion} onChange={(e) => setMotivoVersion(e.target.value)} style={inputStyle} placeholder="Corrección de gastos de limpieza reportados tarde" />
      </label>
      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={generando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {generando ? "Generando…" : "Generar statement"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3. Payouts de canal + conciliación
// ---------------------------------------------------------------------------

interface LineaPayoutRow {
  readonly key: string;
  referencia: string;
  monto: string;
}

function PayoutsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [payoutId, setPayoutId] = useState("");
  const [detalle, setDetalle] = useState<PayoutDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verPayout(id: string) {
    if (!id.trim()) return setError("Se necesita el id del payout.");
    setError(null);
    setCargando(true);
    try {
      const d = await fetchPayoutDetalle(fetch, apiBaseUrl, token, propertyId, id.trim());
      setDetalle(d);
    } catch (err) {
      setDetalle(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar el payout.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Payouts de canal + conciliación</h2>
      <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>
        No hay un listado de payouts ya importados en el backend todavía — al crear uno aquí, su id queda precargado abajo para consultarlo.
      </p>

      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 220 }}>
          Id del payout
          <input value={payoutId} onChange={(e) => setPayoutId(e.target.value)} style={inputStyle} placeholder="uuid del payout" />
        </label>
        <button type="button" onClick={() => verPayout(payoutId)} disabled={cargando} style={{ ...secondaryButtonStyle, alignSelf: "flex-end", marginBottom: 4 }}>
          {cargando ? "Consultando…" : "Ver payout"}
        </button>
      </div>

      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {detalle && <PayoutResumen detalle={detalle} />}

      {puedeEscribir && (
        <ImportarPayoutForm
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          onCreado={(creado) => {
            setPayoutId(creado.id);
            setDetalle({ id: creado.id, propertyId, canalCodigo: creado.canalCodigo, moneda: creado.moneda, montoTotalCentavos: creado.montoTotalCentavos, fechaPayout: creado.fechaPayout, referenciaExterna: null, resumen: creado.resumen, lineas: creado.lineas });
          }}
        />
      )}
    </section>
  );
}

function PayoutResumen({ detalle }: { detalle: PayoutDetalle }) {
  return (
    <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13 }}>
        <strong>{detalle.canalCodigo}</strong> · {centavosAPesos(detalle.montoTotalCentavos)} {detalle.moneda} · pagado {detalle.fechaPayout}
        {detalle.referenciaExterna ? ` · ref. ${detalle.referenciaExterna}` : ""}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
        {detalle.resumen.conciliadas} conciliadas · {detalle.resumen.pendientes} pendientes · {detalle.resumen.discrepancias} con discrepancia
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={{ padding: "4px 0" }}>Referencia</th>
            <th style={{ padding: "4px 0" }}>Reserva</th>
            <th style={{ padding: "4px 0", textAlign: "right" }}>Monto</th>
            <th style={{ padding: "4px 0", textAlign: "right" }}>Esperado</th>
            <th style={{ padding: "4px 0" }}>Estado</th>
          </tr>
        </thead>
        <tbody>
          {detalle.lineas.map((l, i) => (
            <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
              <td style={{ padding: "4px 0" }}>{l.referenciaExternaReserva ?? "—"}</td>
              <td style={{ padding: "4px 0" }}>{l.ocupacionId ?? "sin match"}</td>
              <td style={{ padding: "4px 0", textAlign: "right" }}>{centavosAPesos(l.montoCentavos)}</td>
              <td style={{ padding: "4px 0", textAlign: "right" }}>{l.montoEsperadoCentavos !== null ? centavosAPesos(l.montoEsperadoCentavos) : "—"}</td>
              <td style={{ padding: "4px 0" }}>{ESTADO_CONCILIACION_LABELS[l.estado] ?? l.estado}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportarPayoutForm({ apiBaseUrl, token, propertyId, onCreado }: { apiBaseUrl: string; token: string; propertyId: string; onCreado: (creado: PayoutCreado) => void }) {
  const [canalCodigo, setCanalCodigo] = useState(CANALES_PAYOUT[0]!.codigo);
  const [moneda, setMoneda] = useState("MXN");
  const [fechaPayout, setFechaPayout] = useState("");
  const [referenciaExterna, setReferenciaExterna] = useState("");
  const [lineas, setLineas] = useState<readonly LineaPayoutRow[]>([{ key: nuevaKey(), referencia: "", monto: "" }]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResumen, setUltimoResumen] = useState<string | null>(null);

  function agregarLinea() {
    setLineas((prev) => [...prev, { key: nuevaKey(), referencia: "", monto: "" }]);
  }
  function actualizarLinea(key: string, patch: Partial<LineaPayoutRow>) {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function quitarLinea(key: string) {
    setLineas((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!fechaPayout) return setError("La fecha del payout es requerida.");
    if (lineas.length === 0) return setError("Se necesita al menos una línea.");
    for (const l of lineas) {
      if (!l.monto || Number.isNaN(Number(l.monto)) || Number(l.monto) < 0) return setError("Cada línea necesita un monto válido.");
    }

    setGuardando(true);
    try {
      const creado = await importarPayout(fetch, apiBaseUrl, token, propertyId, {
        canalCodigo,
        moneda: moneda.toUpperCase(),
        fechaPayout,
        referenciaExterna: referenciaExterna.trim() || null,
        lineas: lineas.map((l) => ({ referenciaExternaReserva: l.referencia.trim() || null, montoCentavos: pesosACentavos(Number(l.monto)) })),
      });
      onCreado(creado);
      setUltimoResumen(`Payout ${creado.id}: ${creado.resumen.conciliadas} conciliadas · ${creado.resumen.pendientes} pendientes · ${creado.resumen.discrepancias} con discrepancia.`);
      setFechaPayout("");
      setReferenciaExterna("");
      setLineas([{ key: nuevaKey(), referencia: "", monto: "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el payout.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ ...sectionStyle, borderStyle: "dashed" }}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Importar payout</h3>
      <div style={formRowStyle}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 150 }}>
          Canal
          <select value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)} style={inputStyle}>
            {CANALES_PAYOUT.map((c) => (
              <option key={c.codigo} value={c.codigo}>
                {c.nombre}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, width: 90 }}>
          Moneda
          <input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required style={inputStyle} placeholder="MXN" />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 140 }}>
          Fecha de pago
          <input type="date" value={fechaPayout} onChange={(e) => setFechaPayout(e.target.value)} required style={inputStyle} />
        </label>
        <label style={{ ...labelStyle, flex: 1, minWidth: 160 }}>
          Referencia externa (opcional)
          <input value={referenciaExterna} onChange={(e) => setReferenciaExterna(e.target.value)} style={inputStyle} placeholder="Id del reporte del canal" />
        </label>
      </div>

      <div>
        <p style={{ ...labelStyle, margin: "0 0 6px" }}>Líneas del payout (según el reporte del canal, ya normalizadas)</p>
        {lineas.map((l) => (
          <div key={l.key} style={{ ...formRowStyle, marginBottom: 6 }}>
            <input
              value={l.referencia}
              onChange={(e) => actualizarLinea(l.key, { referencia: e.target.value })}
              placeholder="Referencia externa de la reserva (opcional)"
              style={{ ...inputStyle, flex: 1, minWidth: 200, marginTop: 0 }}
            />
            <input type="number" min="0" step="0.01" value={l.monto} onChange={(e) => actualizarLinea(l.key, { monto: e.target.value })} placeholder="Monto" required style={{ ...inputStyle, width: 110, marginTop: 0 }} />
            <button type="button" onClick={() => quitarLinea(l.key)} disabled={lineas.length === 1} style={secondaryButtonStyle}>
              Quitar
            </button>
          </div>
        ))}
        <button type="button" onClick={agregarLinea} style={secondaryButtonStyle}>
          + Agregar línea
        </button>
      </div>

      {error && <p role="alert" style={errorStyle}>{error}</p>}
      <button type="submit" disabled={guardando} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
        {guardando ? "Importando…" : "Importar payout"}
      </button>
      {ultimoResumen && <p style={noticeStyle}>{ultimoResumen}</p>}
    </form>
  );
}
