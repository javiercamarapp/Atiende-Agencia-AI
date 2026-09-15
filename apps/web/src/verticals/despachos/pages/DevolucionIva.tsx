// Panel de devolución de IVA -- hallazgo de auditoría (severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI", penúltima porción tras vencimientos/
// declaraciones/nómina/conciliación/migración de catálogo): devolucion-iva.ts
// expone GET /facturas/:periodo y 7 POST (diot, conciliacion, saldo-favor,
// congruencia, solicitud, plazo-resolucion, papel-trabajo) sobre el motor
// completo de @atiende/domain-despachos/devolucion-iva/, pero ningún cliente
// web ni página los usaba. Esta página cierra el gap con un flujo guiado de 8
// pasos, en el MISMO orden en que la ruta HTTP los declara -- cada paso
// alimenta al siguiente con los datos que ya calculó (facturas -> DIOT ->
// conciliación -> saldo a favor -> congruencia -> solicitud -> plazo de
// resolución -> papel de trabajo), nunca captura suelta sin relación.
//
// Ninguna "solicitud de devolución" se persiste server-side en esta fase (ver
// cabecera de devolucion-iva.ts): el resultado del paso 6 se muestra tal cual,
// es responsabilidad de quien opera el despacho archivarlo donde corresponda.
import { useState } from "react";
import type { FormEvent } from "react";
import {
  fetchFacturasPeriodoDevolucionIva,
  postCongruenciaDevolucionIva,
  postConciliacionDevolucionIva,
  postDiotDevolucionIva,
  postPapelTrabajoDevolucionIva,
  postPlazoResolucionDevolucionIva,
  postSaldoFavorDevolucionIva,
  postSolicitudDevolucionIva,
} from "../lib/devolucion-iva-client.ts";
import type {
  ClasificacionIva,
  CongruenciaDiotCfdiDeclaracion,
  ConciliacionDeclaracionSaldo,
  ConciliacionDiotDeclaracion,
  ConciliacionFacturaDiot,
  DeclaracionMensualIva,
  DiotEntryIva,
  FacturaCfdiIva,
  MontoDevolucion,
  PapelTrabajoDevolucionIva,
  SolicitudDevolucion,
  TipoFacturaIva,
} from "../lib/devolucion-iva-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que DEVOLUCION_IVA_ROLES (@atiende/domain-despachos/roles.ts)
// -- las 8 rutas de devolucion-iva.ts exigen este rol en CADA llamada, mismo
// criterio que Conciliacion.tsx: cosmético, el servidor rechazaría igual.
const DEVOLUCION_IVA_ROLES = new Set(["admin", "contador"]);

const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12, color: "#374151" };
const sectionStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const buttonPrimary = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 } as const;
const buttonSecondary = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontSize: 12 } as const;
const cellInput = { ...inputStyle, width: 110 } as const;

const TIPO_FACTURA_OPTIONS: readonly TipoFacturaIva[] = ["Ingreso", "Egreso", "Traslado", "Nómina", "Pago"];
const CATEGORIA_OPTIONS: readonly ClasificacionIva[] = ["acreditable_100", "acreditable_proporcional", "no_acreditable"];
const CATEGORIA_LABELS: Record<ClasificacionIva, string> = { acreditable_100: "Acreditable 100%", acreditable_proporcional: "Acreditable proporcional", no_acreditable: "No acreditable" };

interface FacturaFila {
  readonly key: string;
  uuid: string;
  rfcEmisor: string;
  nombreEmisor: string;
  rfcReceptor: string;
  fecha: string;
  subtotal: string;
  iva: string;
  total: string;
  tipo: TipoFacturaIva;
  categoria: ClasificacionIva;
  proporcionalidad: string;
  referenciaComplementoPago: string;
}

let facturaSeq = 0;
function nuevaFacturaFila(base?: Partial<FacturaFila>): FacturaFila {
  facturaSeq += 1;
  return {
    key: `fac-${facturaSeq}`,
    uuid: "",
    rfcEmisor: "",
    nombreEmisor: "",
    rfcReceptor: "",
    fecha: "",
    subtotal: "",
    iva: "",
    total: "",
    tipo: "Ingreso",
    categoria: "acreditable_100",
    proporcionalidad: "1",
    referenciaComplementoPago: "",
    ...base,
  };
}

function facturaDelServidorAFila(f: FacturaCfdiIva): FacturaFila {
  return nuevaFacturaFila({
    uuid: f.uuid,
    rfcEmisor: f.rfcEmisor,
    nombreEmisor: f.nombreEmisor ?? "",
    rfcReceptor: f.rfcReceptor,
    fecha: f.fecha,
    subtotal: f.subtotal !== undefined ? String(f.subtotal) : "",
    iva: f.iva !== undefined ? String(f.iva) : "",
    total: f.total !== undefined ? String(f.total) : "",
    tipo: f.tipo ?? "Ingreso",
    categoria: f.categoria ?? "acreditable_100",
    proporcionalidad: f.proporcionalidad !== undefined ? String(f.proporcionalidad) : "1",
    referenciaComplementoPago: f.referenciaComplementoPago ?? "",
  });
}

function filaAFactura(f: FacturaFila): FacturaCfdiIva | null {
  const uuid = f.uuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  const rfcReceptor = f.rfcReceptor.trim();
  const fecha = f.fecha.trim();
  if (!uuid || !rfcEmisor || !rfcReceptor || !fecha) return null;
  const subtotal = f.subtotal.trim() ? Number(f.subtotal) : undefined;
  const iva = f.iva.trim() ? Number(f.iva) : undefined;
  const total = f.total.trim() ? Number(f.total) : undefined;
  const proporcionalidad = f.proporcionalidad.trim() ? Number(f.proporcionalidad) : undefined;
  return {
    uuid,
    rfcEmisor: rfcEmisor.toUpperCase(),
    nombreEmisor: f.nombreEmisor.trim() || undefined,
    rfcReceptor: rfcReceptor.toUpperCase(),
    fecha,
    subtotal: subtotal !== undefined && Number.isFinite(subtotal) ? subtotal : undefined,
    iva: iva !== undefined && Number.isFinite(iva) ? iva : undefined,
    total: total !== undefined && Number.isFinite(total) ? total : undefined,
    tipo: f.tipo,
    categoria: f.categoria,
    proporcionalidad: proporcionalidad !== undefined && Number.isFinite(proporcionalidad) ? proporcionalidad : undefined,
    referenciaComplementoPago: f.referenciaComplementoPago.trim() || null,
  };
}

interface DeclaracionFila {
  readonly key: string;
  mes: string;
  año: string;
  ivaCobrado: string;
  ivaPagado: string;
  saldoFavor: string;
  saldoContra: string;
}

let declaracionSeq = 0;
function nuevaDeclaracionFila(): DeclaracionFila {
  declaracionSeq += 1;
  return { key: `decl-${declaracionSeq}`, mes: "", año: "", ivaCobrado: "", ivaPagado: "", saldoFavor: "", saldoContra: "" };
}

function filaADeclaracion(d: DeclaracionFila): DeclaracionMensualIva | null {
  const mes = d.mes.trim() ? Number(d.mes) : NaN;
  const año = d.año.trim() ? Number(d.año) : NaN;
  if (!Number.isFinite(mes) || !Number.isFinite(año)) return null;
  return {
    mes,
    año,
    ivaCobrado: d.ivaCobrado.trim() ? Number(d.ivaCobrado) || 0 : 0,
    ivaPagado: d.ivaPagado.trim() ? Number(d.ivaPagado) || 0 : 0,
    saldoFavor: d.saldoFavor.trim() ? Number(d.saldoFavor) || 0 : 0,
    saldoContra: d.saldoContra.trim() ? Number(d.saldoContra) || 0 : 0,
  };
}

function FacturasEditor({ filas, setFilas }: { filas: readonly FacturaFila[]; setFilas: (f: readonly FacturaFila[]) => void }) {
  function actualizar<K extends keyof FacturaFila>(key: string, campo: K, valor: FacturaFila[K]) {
    setFilas(filas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1200 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={{ padding: "4px 6px" }}>UUID *</th>
              <th style={{ padding: "4px 6px" }}>RFC emisor *</th>
              <th style={{ padding: "4px 6px" }}>Emisor</th>
              <th style={{ padding: "4px 6px" }}>RFC receptor *</th>
              <th style={{ padding: "4px 6px" }}>Fecha *</th>
              <th style={{ padding: "4px 6px" }}>Subtotal</th>
              <th style={{ padding: "4px 6px" }}>IVA</th>
              <th style={{ padding: "4px 6px" }}>Total</th>
              <th style={{ padding: "4px 6px" }}>Tipo</th>
              <th style={{ padding: "4px 6px" }}>Categoría</th>
              <th style={{ padding: "4px 6px" }}>Proporc.</th>
              <th style={{ padding: "4px 6px" }}>UUID REP</th>
              <th style={{ padding: "4px 6px" }} />
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key}>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.uuid} onChange={(e) => actualizar(f.key, "uuid", e.target.value)} style={{ ...cellInput, width: 160, fontFamily: "monospace" }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.rfcEmisor} onChange={(e) => actualizar(f.key, "rfcEmisor", e.target.value.toUpperCase())} style={cellInput} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.nombreEmisor} onChange={(e) => actualizar(f.key, "nombreEmisor", e.target.value)} style={{ ...cellInput, width: 150 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.rfcReceptor} onChange={(e) => actualizar(f.key, "rfcReceptor", e.target.value.toUpperCase())} style={cellInput} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="date" value={f.fecha} onChange={(e) => actualizar(f.key, "fecha", e.target.value)} style={{ ...cellInput, width: 130 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={f.subtotal} onChange={(e) => actualizar(f.key, "subtotal", e.target.value)} style={{ ...cellInput, width: 90 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={f.iva} onChange={(e) => actualizar(f.key, "iva", e.target.value)} style={{ ...cellInput, width: 90 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={f.total} onChange={(e) => actualizar(f.key, "total", e.target.value)} style={{ ...cellInput, width: 90 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <select value={f.tipo} onChange={(e) => actualizar(f.key, "tipo", e.target.value as TipoFacturaIva)} style={{ ...cellInput, width: 100 }}>
                    {TIPO_FACTURA_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <select value={f.categoria} onChange={(e) => actualizar(f.key, "categoria", e.target.value as ClasificacionIva)} style={{ ...cellInput, width: 160 }}>
                    {CATEGORIA_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORIA_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" min={0} max={1} value={f.proporcionalidad} onChange={(e) => actualizar(f.key, "proporcionalidad", e.target.value)} style={{ ...cellInput, width: 70 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.referenciaComplementoPago} onChange={(e) => actualizar(f.key, "referenciaComplementoPago", e.target.value)} placeholder="UUID del REP" style={{ ...cellInput, width: 140, fontFamily: "monospace" }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <button type="button" onClick={() => setFilas(filas.filter((r) => r.key !== f.key))} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" onClick={() => setFilas([...filas, nuevaFacturaFila()])} style={buttonSecondary}>
          + Agregar factura
        </button>
      </div>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>
        Sin UUID REP (complemento de pago), el IVA de esa factura no cuenta como efectivamente pagado (LIVA Art. 5 fracc. III). Este lote alimenta DIOT, conciliación, congruencia y el papel de trabajo de abajo.
      </p>
    </div>
  );
}

function DeclaracionesEditor({ filas, setFilas }: { filas: readonly DeclaracionFila[]; setFilas: (f: readonly DeclaracionFila[]) => void }) {
  function actualizar(key: string, campo: keyof DeclaracionFila, valor: string) {
    setFilas(filas.map((d) => (d.key === key ? { ...d, [campo]: valor } : d)));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={{ padding: "4px 6px" }}>Mes *</th>
              <th style={{ padding: "4px 6px" }}>Año *</th>
              <th style={{ padding: "4px 6px" }}>IVA cobrado</th>
              <th style={{ padding: "4px 6px" }}>IVA pagado</th>
              <th style={{ padding: "4px 6px" }}>Saldo a favor</th>
              <th style={{ padding: "4px 6px" }}>Saldo a cargo</th>
              <th style={{ padding: "4px 6px" }} />
            </tr>
          </thead>
          <tbody>
            {filas.map((d) => (
              <tr key={d.key}>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" min={1} max={12} value={d.mes} onChange={(e) => actualizar(d.key, "mes", e.target.value)} style={{ ...cellInput, width: 70 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" value={d.año} onChange={(e) => actualizar(d.key, "año", e.target.value)} style={{ ...cellInput, width: 80 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={d.ivaCobrado} onChange={(e) => actualizar(d.key, "ivaCobrado", e.target.value)} style={{ ...cellInput, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={d.ivaPagado} onChange={(e) => actualizar(d.key, "ivaPagado", e.target.value)} style={{ ...cellInput, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={d.saldoFavor} onChange={(e) => actualizar(d.key, "saldoFavor", e.target.value)} style={{ ...cellInput, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={d.saldoContra} onChange={(e) => actualizar(d.key, "saldoContra", e.target.value)} style={{ ...cellInput, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <button type="button" onClick={() => setFilas(filas.filter((r) => r.key !== d.key))} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" onClick={() => setFilas([...filas, nuevaDeclaracionFila()])} style={buttonSecondary}>
          + Agregar declaración
        </button>
      </div>
    </div>
  );
}

const ESTATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  match: { bg: "#dcfce7", fg: "#166534" },
  mismatch: { bg: "#fee2e2", fg: "#991b1b" },
  missing: { bg: "#fee2e2", fg: "#991b1b" },
};

function EstatusBadge({ status }: { status: string }) {
  const c = ESTATUS_COLORS[status] ?? { bg: "#e5e7eb", fg: "#374151" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 600 }}>{status}</span>;
}

export function DevolucionIvaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = DEVOLUCION_IVA_ROLES.has(role);

  const [periodo, setPeriodo] = useState("");

  // -- Paso 1: facturas del periodo ------------------------------------------
  const [facturaFilas, setFacturaFilas] = useState<readonly FacturaFila[]>([nuevaFacturaFila()]);
  const facturas = facturaFilas.map(filaAFactura).filter((f): f is FacturaCfdiIva => f !== null);
  const [cargandoFacturas, setCargandoFacturas] = useState(false);
  const [errorFacturas, setErrorFacturas] = useState<string | null>(null);
  const [clasificacionResumen, setClasificacionResumen] = useState<{ acreditable100: number; acreditableProporcional: number; noAcreditable: number } | null>(null);

  async function handleCargarFacturas() {
    setErrorFacturas(null);
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      setErrorFacturas("Captura el periodo en formato YYYY-MM antes de cargar las facturas ingeridas.");
      return;
    }
    setCargandoFacturas(true);
    try {
      const { facturas: encontradas, clasificacion } = await fetchFacturasPeriodoDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo);
      if (encontradas.length > 0) setFacturaFilas(encontradas.map(facturaDelServidorAFila));
      setClasificacionResumen({
        acreditable100: clasificacion.acreditable_100.length,
        acreditableProporcional: clasificacion.acreditable_proporcional.length,
        noAcreditable: clasificacion.no_acreditable.length,
      });
      if (encontradas.length === 0) setErrorFacturas("No hay CFDI ya ingeridos para este periodo. Captúralas manualmente abajo.");
    } catch (err) {
      setErrorFacturas(err instanceof Error ? err.message : "No se pudieron cargar las facturas del periodo.");
    } finally {
      setCargandoFacturas(false);
    }
  }

  // -- Paso 2: DIOT ------------------------------------------------------
  const [diotLoading, setDiotLoading] = useState(false);
  const [diotError, setDiotError] = useState<string | null>(null);
  const [diotEntries, setDiotEntries] = useState<readonly DiotEntryIva[] | null>(null);
  const [diotErrores, setDiotErrores] = useState<readonly string[]>([]);

  async function handleGenerarDiot() {
    setDiotError(null);
    if (facturas.length === 0) {
      setDiotError("Captura al menos una factura con UUID/RFC emisor/RFC receptor/fecha.");
      return;
    }
    setDiotLoading(true);
    try {
      const { diotEntries: entries, errores } = await postDiotDevolucionIva(fetch, apiBaseUrl, token, propertyId, facturas, periodo.trim() || undefined);
      setDiotEntries(entries);
      setDiotErrores(errores);
    } catch (err) {
      setDiotError(err instanceof Error ? err.message : "No se pudo generar la DIOT.");
    } finally {
      setDiotLoading(false);
    }
  }

  // -- Declaraciones (alimentan conciliación/saldo/congruencia/solicitud) ----
  const [declaracionFilas, setDeclaracionFilas] = useState<readonly DeclaracionFila[]>([nuevaDeclaracionFila()]);
  const declaraciones = declaracionFilas.map(filaADeclaracion).filter((d): d is DeclaracionMensualIva => d !== null);

  // -- Paso 3: conciliación ------------------------------------------------
  const [conciliacionLoading, setConciliacionLoading] = useState(false);
  const [conciliacionError, setConciliacionError] = useState<string | null>(null);
  const [facturasVsDiot, setFacturasVsDiot] = useState<readonly ConciliacionFacturaDiot[] | null>(null);
  const [diotVsDeclaracion, setDiotVsDeclaracion] = useState<readonly ConciliacionDiotDeclaracion[] | null>(null);

  async function handleConciliar() {
    setConciliacionError(null);
    if (!diotEntries) {
      setConciliacionError("Genera la DIOT (paso 2) antes de conciliar.");
      return;
    }
    setConciliacionLoading(true);
    try {
      const { facturasVsDiot: fvd, diotVsDeclaracion: dvd } = await postConciliacionDevolucionIva(fetch, apiBaseUrl, token, propertyId, facturas, diotEntries, declaraciones);
      setFacturasVsDiot(fvd);
      setDiotVsDeclaracion(dvd);
    } catch (err) {
      setConciliacionError(err instanceof Error ? err.message : "No se pudo conciliar.");
    } finally {
      setConciliacionLoading(false);
    }
  }

  // -- Paso 4: saldo a favor -----------------------------------------------
  const [saldoLoading, setSaldoLoading] = useState(false);
  const [saldoError, setSaldoError] = useState<string | null>(null);
  const [saldoFavor, setSaldoFavor] = useState<number | null>(null);
  const [montoDevolucion, setMontoDevolucion] = useState<MontoDevolucion | null>(null);
  const [saldoVerificacion, setSaldoVerificacion] = useState<ConciliacionDeclaracionSaldo | null>(null);

  async function handleCalcularSaldo() {
    setSaldoError(null);
    if (declaraciones.length === 0) {
      setSaldoError("Captura al menos una declaración mensual con mes y año.");
      return;
    }
    setSaldoLoading(true);
    try {
      const { saldoFavor: sf, montoDevolucion: md, verificacion } = await postSaldoFavorDevolucionIva(fetch, apiBaseUrl, token, propertyId, declaraciones);
      setSaldoFavor(sf);
      setMontoDevolucion(md);
      setSaldoVerificacion(verificacion);
    } catch (err) {
      setSaldoError(err instanceof Error ? err.message : "No se pudo calcular el saldo a favor.");
    } finally {
      setSaldoLoading(false);
    }
  }

  // -- Paso 5: congruencia --------------------------------------------------
  const [tolerancia, setTolerancia] = useState("1");
  const [congruenciaLoading, setCongruenciaLoading] = useState(false);
  const [congruenciaError, setCongruenciaError] = useState<string | null>(null);
  const [congruencia, setCongruencia] = useState<CongruenciaDiotCfdiDeclaracion | null>(null);

  async function handleVerificarCongruencia() {
    setCongruenciaError(null);
    if (!periodo.trim()) {
      setCongruenciaError("Captura el periodo (YYYY-MM) arriba antes de verificar congruencia.");
      return;
    }
    setCongruenciaLoading(true);
    try {
      const resultado = await postCongruenciaDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo.trim(), facturas, diotEntries ?? [], declaraciones, tolerancia.trim() ? Number(tolerancia) : undefined);
      setCongruencia(resultado);
    } catch (err) {
      setCongruenciaError(err instanceof Error ? err.message : "No se pudo verificar la congruencia.");
    } finally {
      setCongruenciaLoading(false);
    }
  }

  // -- Paso 6: solicitud -----------------------------------------------------
  const [cuentaBanco, setCuentaBanco] = useState("");
  const [clabe, setClabe] = useState("");
  const [documentosTexto, setDocumentosTexto] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [solicitudLoading, setSolicitudLoading] = useState(false);
  const [solicitudError, setSolicitudError] = useState<string | null>(null);
  const [solicitud, setSolicitud] = useState<SolicitudDevolucion | null>(null);

  async function handlePrepararSolicitud(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSolicitudError(null);
    if (!periodo.trim()) {
      setSolicitudError("Captura el periodo (YYYY-MM) arriba.");
      return;
    }
    if (!montoDevolucion) {
      setSolicitudError("Calcula el saldo a favor (paso 4) antes de preparar la solicitud.");
      return;
    }
    setSolicitudLoading(true);
    try {
      const documentos = documentosTexto
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      const resultado = await postSolicitudDevolucionIva(
        fetch,
        apiBaseUrl,
        token,
        propertyId,
        periodo.trim(),
        { montoDevolucionSugerido: montoDevolucion.montoDevolucionSugerido },
        {
          cuentaBanco: cuentaBanco.trim() || undefined,
          clabe: clabe.trim() || undefined,
          documentos: documentos.length > 0 ? documentos : undefined,
          tenantId: tenantId.trim() || undefined,
          facturas,
          diotEntries: diotEntries ?? undefined,
          declaraciones,
        },
      );
      setSolicitud(resultado);
    } catch (err) {
      setSolicitudError(err instanceof Error ? err.message : "No se pudo preparar la solicitud.");
    } finally {
      setSolicitudLoading(false);
    }
  }

  // -- Paso 7: plazo de resolución -------------------------------------------
  const [fechaPresentacion, setFechaPresentacion] = useState("");
  const [hayDictamenOGarantia, setHayDictamenOGarantia] = useState(false);
  const [plazoLoading, setPlazoLoading] = useState(false);
  const [plazoError, setPlazoError] = useState<string | null>(null);
  const [fechaLimite, setFechaLimite] = useState<string | null>(null);

  async function handleCalcularPlazo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPlazoError(null);
    setPlazoLoading(true);
    try {
      const { fechaLimite: limite } = await postPlazoResolucionDevolucionIva(fetch, apiBaseUrl, token, propertyId, fechaPresentacion, hayDictamenOGarantia);
      setFechaLimite(limite);
    } catch (err) {
      setPlazoError(err instanceof Error ? err.message : "No se pudo calcular el plazo de resolución.");
    } finally {
      setPlazoLoading(false);
    }
  }

  // -- Paso 8: papel de trabajo ------------------------------------------
  const [documentosSoporteTexto, setDocumentosSoporteTexto] = useState("");
  const [papelLoading, setPapelLoading] = useState(false);
  const [papelError, setPapelError] = useState<string | null>(null);
  const [papel, setPapel] = useState<PapelTrabajoDevolucionIva | null>(null);

  async function handleGenerarPapel() {
    setPapelError(null);
    if (!periodo.trim()) {
      setPapelError("Captura el periodo (YYYY-MM) arriba.");
      return;
    }
    setPapelLoading(true);
    try {
      const documentosSoporte = documentosSoporteTexto
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      const resultado = await postPapelTrabajoDevolucionIva(fetch, apiBaseUrl, token, propertyId, periodo.trim(), facturas, diotEntries ?? undefined, declaraciones, {
        tenantId: tenantId.trim() || undefined,
        documentosSoporte,
      });
      setPapel(resultado);
    } catch (err) {
      setPapelError(err instanceof Error ? err.message : "No se pudo generar el papel de trabajo.");
    } finally {
      setPapelLoading(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Devolución de IVA</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede correr el flujo de devolución de IVA -- el servidor lo rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Devolución de IVA</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Flujo guiado del papel de trabajo de devolución de IVA: facturas del periodo → DIOT → conciliación → saldo a favor → congruencia (REQ-IVA-010) → solicitud → plazo de resolución (Art. 22 CFF) → papel de trabajo.
        </p>
      </header>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Periodo</h2>
        <label style={{ ...labelStyle, width: 160 }}>
          Periodo (YYYY-MM) *
          <input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} style={inputStyle} />
        </label>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>1. Facturas del periodo</h2>
        {errorFacturas && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {errorFacturas}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleCargarFacturas()} disabled={cargandoFacturas} style={buttonPrimary}>
            {cargandoFacturas ? "Cargando…" : "Cargar CFDI ya ingeridos del periodo"}
          </button>
        </div>
        {clasificacionResumen && (
          <div style={{ display: "flex", gap: 20, fontSize: 13 }}>
            <span>
              <strong>Acreditable 100%:</strong> {clasificacionResumen.acreditable100}
            </span>
            <span>
              <strong>Acreditable proporcional:</strong> {clasificacionResumen.acreditableProporcional}
            </span>
            <span>
              <strong>No acreditable:</strong> {clasificacionResumen.noAcreditable}
            </span>
          </div>
        )}
        <FacturasEditor filas={facturaFilas} setFilas={setFacturaFilas} />
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>2. DIOT</h2>
        {diotError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {diotError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleGenerarDiot()} disabled={diotLoading} style={buttonPrimary}>
            {diotLoading ? "Generando…" : "Generar DIOT"}
          </button>
        </div>
        {diotErrores.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {diotErrores.map((e, i) => (
              <p key={i} role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 12 }}>
                {e}
              </p>
            ))}
          </div>
        )}
        {diotEntries && diotEntries.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "6px 8px" }}>RFC tercero</th>
                  <th style={{ padding: "6px 8px" }}>Nombre</th>
                  <th style={{ padding: "6px 8px" }}>Monto neto</th>
                  <th style={{ padding: "6px 8px" }}>IVA trasladado</th>
                  <th style={{ padding: "6px 8px" }}>IVA acreditable</th>
                  <th style={{ padding: "6px 8px" }}># CFDI</th>
                </tr>
              </thead>
              <tbody>
                {diotEntries.map((e, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{e.rfcTercero}</td>
                    <td style={{ padding: "6px 8px" }}>{e.nombre || "—"}</td>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(e.montoNeto)}</td>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(e.ivaTrasladado)}</td>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(e.ivaAcreditable)}</td>
                    <td style={{ padding: "6px 8px" }}>{e.foliosFiscales.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Declaraciones mensuales</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Captura las declaraciones mensuales de IVA ya presentadas -- alimentan conciliación, saldo a favor, congruencia y solicitud.</p>
        <DeclaracionesEditor filas={declaracionFilas} setFilas={setDeclaracionFilas} />
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>3. Conciliación (facturas ↔ DIOT ↔ declaración)</h2>
        {conciliacionError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {conciliacionError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleConciliar()} disabled={conciliacionLoading} style={buttonPrimary}>
            {conciliacionLoading ? "Conciliando…" : "Conciliar"}
          </button>
        </div>
        {facturasVsDiot && (
          <div style={{ overflowX: "auto" }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>Facturas vs DIOT</p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "6px 8px" }}>Factura</th>
                  <th style={{ padding: "6px 8px" }}>Estatus</th>
                  <th style={{ padding: "6px 8px" }}>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {facturasVsDiot.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{r.facturaUuid}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <EstatusBadge status={r.status} />
                    </td>
                    <td style={{ padding: "6px 8px", color: "#6b7280" }}>{r.detalles}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {diotVsDeclaracion && diotVsDeclaracion.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>DIOT vs declaración</p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "6px 8px" }}>IVA DIOT</th>
                  <th style={{ padding: "6px 8px" }}>IVA declaración</th>
                  <th style={{ padding: "6px 8px" }}>Diferencia</th>
                  <th style={{ padding: "6px 8px" }}>Estatus</th>
                </tr>
              </thead>
              <tbody>
                {diotVsDeclaracion.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(r.diotIvaTotal)}</td>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(r.declaracionIvaAcreditable)}</td>
                    <td style={{ padding: "6px 8px" }}>{formatMoney(r.diferencia)}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <EstatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>4. Saldo a favor / monto de devolución</h2>
        {saldoError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {saldoError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleCalcularSaldo()} disabled={saldoLoading} style={buttonPrimary}>
            {saldoLoading ? "Calculando…" : "Calcular saldo a favor"}
          </button>
        </div>
        {montoDevolucion && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <span>
                <strong>Saldo a favor:</strong> {formatMoney(saldoFavor ?? 0)}
              </span>
              <span>
                <strong>Monto de devolución sugerido:</strong> {formatMoney(montoDevolucion.montoDevolucionSugerido)}
              </span>
              <span>
                <strong>Periodo más antiguo:</strong> {montoDevolucion.periodoMasAntiguo ?? "—"}
              </span>
            </div>
            {saldoVerificacion && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong>Verificación:</strong>
                <EstatusBadge status={saldoVerificacion.consistente ? "match" : "mismatch"} />
                <span style={{ color: "#6b7280" }}>diferencia {formatMoney(saldoVerificacion.diferencia)}</span>
              </div>
            )}
            <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>
              El factor de actualización (INPC) y la verificación de prescripción de 5 años son placeholders documentados del motor -- no sustituyen la actualización fiscal real.
            </p>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>5. Congruencia DIOT ↔ CFDI ↔ declaración (REQ-IVA-010)</h2>
        <label style={{ ...labelStyle, width: 160 }}>
          Tolerancia (MXN)
          <input type="number" step="0.01" value={tolerancia} onChange={(e) => setTolerancia(e.target.value)} style={inputStyle} />
        </label>
        {congruenciaError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {congruenciaError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleVerificarCongruencia()} disabled={congruenciaLoading} style={buttonPrimary}>
            {congruenciaLoading ? "Verificando…" : "Verificar congruencia"}
          </button>
        </div>
        {congruencia && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong>{congruencia.congruente ? "Congruente" : "No congruente"}</strong>
              <EstatusBadge status={congruencia.congruente ? "match" : "mismatch"} />
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <span>CFDI: {formatMoney(congruencia.totalCfdiIvaAcreditable)}</span>
              <span>DIOT: {formatMoney(congruencia.totalDiotIvaAcreditable)}</span>
              <span>Declaración: {formatMoney(congruencia.totalDeclaracionIvaPagado)}</span>
              <span>Diferencia máxima: {formatMoney(congruencia.diferenciaMaxima)}</span>
            </div>
            {!congruencia.diotExiste && <p style={{ color: "#b91c1c", margin: 0 }}>No existe DIOT registrada para el periodo.</p>}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>6. Solicitud de devolución</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
          Usa el monto sugerido del paso 4. Por encima de ${" "}
          10,001 MXN, el servidor exige congruencia (paso 5) para dejarla lista para envío -- si no es congruente, queda "requiere aclaración". No se persiste: archívala donde corresponda.
        </p>
        <form onSubmit={handlePrepararSolicitud} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 480 }}>
          <label style={labelStyle}>
            Cuenta bancaria (opcional)
            <input type="text" value={cuentaBanco} onChange={(e) => setCuentaBanco(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            CLABE (opcional, 18 dígitos)
            <input type="text" value={clabe} onChange={(e) => setClabe(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Documentos soporte (separados por coma)
            <input type="text" value={documentosTexto} onChange={(e) => setDocumentosTexto(e.target.value)} placeholder="cfdi.zip, diot.txt, declaraciones.pdf" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Tenant ID (opcional)
            <input type="text" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={inputStyle} />
          </label>
          {solicitudError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {solicitudError}
            </p>
          )}
          <div>
            <button type="submit" disabled={solicitudLoading} style={buttonPrimary}>
              {solicitudLoading ? "Preparando…" : "Preparar solicitud"}
            </button>
          </div>
        </form>
        {solicitud && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <span>
                <strong>Folio:</strong> <span style={{ fontFamily: "monospace" }}>{solicitud.solicitudId}</span>
              </span>
              <span>
                <strong>Monto solicitado:</strong> {formatMoney(solicitud.montoSolicitado)}
              </span>
              <span>
                <strong>Status:</strong> {solicitud.status}
              </span>
            </div>
            {solicitud.estado === "lista_para_envio" ? (
              <p style={{ color: "#166534", background: "#dcfce7", border: "1px solid #bbf7d0", borderRadius: 8, padding: 8, margin: 0 }}>Lista para envío.</p>
            ) : (
              <p role="alert" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 8, margin: 0 }}>
                Requiere aclaración: {solicitud.motivoAclaracion}
              </p>
            )}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>7. Plazo de resolución (Art. 22 CFF)</h2>
        <form onSubmit={handleCalcularPlazo} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 320 }}>
          <label style={labelStyle}>
            Fecha de presentación *
            <input type="date" value={fechaPresentacion} onChange={(e) => setFechaPresentacion(e.target.value)} required style={inputStyle} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={hayDictamenOGarantia} onChange={(e) => setHayDictamenOGarantia(e.target.checked)} />
            Hay dictamen de contador público registrado o garantía del interés fiscal (plazo de 20 días hábiles en vez de 40)
          </label>
          {plazoError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {plazoError}
            </p>
          )}
          <div>
            <button type="submit" disabled={plazoLoading} style={buttonPrimary}>
              {plazoLoading ? "Calculando…" : "Calcular plazo"}
            </button>
          </div>
        </form>
        {fechaLimite && (
          <p style={{ fontSize: 13, margin: 0 }}>
            <strong>Fecha límite de resolución:</strong> {fechaLimite}
          </p>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>8. Papel de trabajo</h2>
        <label style={labelStyle}>
          Documentos soporte (separados por coma)
          <input type="text" value={documentosSoporteTexto} onChange={(e) => setDocumentosSoporteTexto(e.target.value)} placeholder="cfdi.zip, diot.txt, estados_cuenta.pdf" style={{ ...inputStyle, maxWidth: 420 }} />
        </label>
        {papelError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {papelError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleGenerarPapel()} disabled={papelLoading} style={buttonPrimary}>
            {papelLoading ? "Generando…" : "Generar papel de trabajo"}
          </button>
        </div>
        {papel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <span>
                <strong>Facturas:</strong> {papel.metadata.totalFacturas}
              </span>
              <span>
                <strong>Entradas DIOT:</strong> {papel.metadata.totalDiotEntries}
              </span>
              <span>
                <strong>Declaraciones:</strong> {papel.metadata.totalDeclaraciones}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>1. Resumen del periodo</p>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "#374151" }}>
                <span>Subtotal: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalSubtotal)}</span>
                <span>IVA trasladado: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalIvaTrasladado)}</span>
                <span>Total: {formatMoney(papel.secciones["1_resumen_periodo"].resumenFacturas.totalGravado)}</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>3. Conciliación CFDI ↔ DIOT</p>
              <span style={{ color: "#374151" }}>
                {papel.secciones["3_conciliacion_cfdi_diot"].matches}/{papel.secciones["3_conciliacion_cfdi_diot"].totalFacturas} conciliadas ({papel.secciones["3_conciliacion_cfdi_diot"].tasaConciliacion}%)
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>5. Cálculo de saldo</p>
              <span style={{ color: "#374151" }}>
                Saldo a favor: {formatMoney(papel.secciones["5_calculo_saldo"].saldoAFavor)} · Monto sugerido: {formatMoney(papel.secciones["5_calculo_saldo"].montoDevolucion.montoDevolucionSugerido)}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontWeight: 600, margin: 0 }}>6. Documentos soporte</p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", color: "#374151" }}>
                <span>CFDI: {papel.secciones["6_documentos_soporte"].checklist.cfdiCompra ? "✓" : "✗"}</span>
                <span>DIOT: {papel.secciones["6_documentos_soporte"].checklist.diot ? "✓" : "✗"}</span>
                <span>Declaraciones: {papel.secciones["6_documentos_soporte"].checklist.declaraciones ? "✓" : "✗"}</span>
                <span>Estados de cuenta: {papel.secciones["6_documentos_soporte"].checklist.estadosCuenta ? "✓" : "✗"}</span>
                <span>Balanza: {papel.secciones["6_documentos_soporte"].checklist.balanza ? "✓" : "✗"}</span>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>{papel.secciones["7_no_discrepancia_fiscal_depositos"].advertenciaFiscal}</p>
          </div>
        )}
      </section>
    </div>
  );
}
