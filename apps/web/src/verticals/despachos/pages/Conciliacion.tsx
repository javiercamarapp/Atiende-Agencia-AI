// Panel de conciliación bancaria -- hallazgo de auditoría (severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI", porción "conciliación bancaria" tras
// vencimientos/declaraciones/nómina): conciliacion.ts expone POST
// /conciliacion/matching (motor determinista de niveles 1-3 contra los CFDI ya
// ingeridos de esta property), POST /conciliacion/alertas (aging/comisiones/
// duplicados/discrepancia de ingresos, Art. 91 LISR), POST
// /conciliacion/clasificar-deposito (CFF Art. 59 fr. III) y POST
// /conciliacion/verificar-spei (matching por clave de rastreo o RFC), pero ningún
// cliente web ni página los usaba. Esta página cierra el gap.
//
// El parsing de CSV/OFX del banco queda fuera de esta fase (ver cabecera de
// conciliacion.ts en apps/api): el servidor espera los movimientos YA parseados.
// Esta UI los captura en una tabla editable (una fila por movimiento -- mismo
// patrón exacto que la tabla de empleados de Nomina.tsx) y reusa ese mismo lote
// para correr matching, ver alertas y verificar SPEI/proveedor -- son 3 vistas
// distintas sobre el mismo lote, nunca 3 capturas separadas. La clasificación de
// depósito es la única acción que no depende del lote (opera sobre un solo
// depósito suelto).
import { useState } from "react";
import type { FormEvent } from "react";
import {
  clasificarDepositoConciliacion,
  correrMatchingConciliacion,
  fetchAlertasConciliacion,
  verificarSpeiConciliacion,
} from "../lib/conciliacion-client.ts";
import type {
  AlertaConciliacion,
  ClasificacionDeposito,
  MovimientoBancarioInput,
  NivelCoincidencia,
  ResultadoClasificacionDeposito,
  ResultadoConciliacion,
  ResultadoVerificacionSpei,
  SeveridadAlerta,
} from "../lib/conciliacion-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que CONCILIACION_ROLES (@atiende/domain-despachos/roles.ts) --
// las 4 rutas de conciliacion.ts exigen este rol en CADA llamada (a diferencia de
// vencimientos/cobranza, este módulo no tiene ningún GET de solo lectura), así que
// a diferencia de esas páginas aquí no hay una vista degradada para otros roles:
// el servidor rechazaría cualquier acción igual. Cosmético -- nunca la única
// barrera.
const CONCILIACION_ROLES = new Set(["admin", "contador"]);

const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12, color: "#374151" };
const sectionStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const buttonPrimary = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 } as const;
const buttonSecondary = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontSize: 12 } as const;

interface MovimientoFila {
  readonly key: string;
  fecha: string;
  descripcion: string;
  referencia: string;
  cargo: string;
  abono: string;
  banco: string;
}

let filaSeq = 0;
function nuevaFila(): MovimientoFila {
  filaSeq += 1;
  return { key: `mov-${filaSeq}`, fecha: "", descripcion: "", referencia: "", cargo: "", abono: "", banco: "" };
}

function filaAInput(f: MovimientoFila): MovimientoBancarioInput | null {
  const fecha = f.fecha.trim();
  if (!fecha) return null;
  const cargoNum = f.cargo.trim() ? Number(f.cargo) : undefined;
  const abonoNum = f.abono.trim() ? Number(f.abono) : undefined;
  return {
    fecha,
    descripcion: f.descripcion.trim() || undefined,
    referencia: f.referencia.trim() || undefined,
    cargo: cargoNum !== undefined && Number.isFinite(cargoNum) ? cargoNum : undefined,
    abono: abonoNum !== undefined && Number.isFinite(abonoNum) ? abonoNum : undefined,
    banco: f.banco.trim() || undefined,
  };
}

const NIVEL_LABELS: Record<NivelCoincidencia, string> = { exacto: "Exacto", fuzzy: "Fuzzy", multi_linea: "Multi-línea", llm: "Asistido por IA", manual: "Manual" };
const NIVEL_COLORS: Record<NivelCoincidencia, { bg: string; fg: string }> = {
  exacto: { bg: "#dcfce7", fg: "#166534" },
  fuzzy: { bg: "#dbeafe", fg: "#1e40af" },
  multi_linea: { bg: "#e0e7ff", fg: "#3730a3" },
  llm: { bg: "#f3e8ff", fg: "#6b21a8" },
  manual: { bg: "#e5e7eb", fg: "#374151" },
};

const SEVERIDAD_COLORS: Record<SeveridadAlerta, { bg: string; fg: string }> = {
  info: { bg: "#dbeafe", fg: "#1e40af" },
  warning: { bg: "#fef9c3", fg: "#854d0e" },
  critical: { bg: "#fee2e2", fg: "#991b1b" },
};

const CLASIFICACION_LABELS: Record<ClasificacionDeposito, string> = {
  ingreso: "Ingreso gravable",
  financiamiento: "Financiamiento",
  aportacion_socio: "Aportación de socio",
  garantia: "Garantía",
  otro_no_gravable: "Otro no gravable",
};

function NivelBadge({ level }: { level: NivelCoincidencia }) {
  const c = NIVEL_COLORS[level];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 600 }}>{NIVEL_LABELS[level]}</span>;
}

function SeveridadBadge({ severity }: { severity: SeveridadAlerta }) {
  const c = SEVERIDAD_COLORS[severity];
  const label = severity === "info" ? "Info" : severity === "warning" ? "Atención" : "Crítica";
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 600 }}>{label}</span>;
}

function MovimientosEditor({ filas, setFilas }: { filas: readonly MovimientoFila[]; setFilas: (f: readonly MovimientoFila[]) => void }) {
  function actualizarFila(key: string, campo: keyof MovimientoFila, valor: string) {
    setFilas(filas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  function eliminarFila(key: string) {
    setFilas(filas.filter((f) => f.key !== key));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 720 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={{ padding: "4px 6px" }}>Fecha *</th>
              <th style={{ padding: "4px 6px" }}>Descripción</th>
              <th style={{ padding: "4px 6px" }}>Referencia</th>
              <th style={{ padding: "4px 6px" }}>Cargo</th>
              <th style={{ padding: "4px 6px" }}>Abono</th>
              <th style={{ padding: "4px 6px" }}>Banco</th>
              <th style={{ padding: "4px 6px" }} />
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key}>
                <td style={{ padding: "3px 6px" }}>
                  <input type="date" value={f.fecha} onChange={(e) => actualizarFila(f.key, "fecha", e.target.value)} style={{ ...inputStyle, width: 130 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.descripcion} onChange={(e) => actualizarFila(f.key, "descripcion", e.target.value)} placeholder="p.ej. PAGO PROVEEDOR" style={{ ...inputStyle, width: 200 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.referencia} onChange={(e) => actualizarFila(f.key, "referencia", e.target.value)} style={{ ...inputStyle, width: 120 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={f.cargo} onChange={(e) => actualizarFila(f.key, "cargo", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={f.abono} onChange={(e) => actualizarFila(f.key, "abono", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={f.banco} onChange={(e) => actualizarFila(f.key, "banco", e.target.value)} placeholder="generic" style={{ ...inputStyle, width: 100 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <button type="button" onClick={() => eliminarFila(f.key)} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" onClick={() => setFilas([...filas, nuevaFila()])} style={buttonSecondary}>
          + Agregar movimiento
        </button>
      </div>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>
        Captura los movimientos del estado de cuenta ya identificados (cargo = salida, abono = entrada). Este lote se usa para las 3 acciones de abajo (matching, alertas y verificación SPEI/proveedor).
      </p>
    </div>
  );
}

function ResultadoMatching({ resultado }: { resultado: ResultadoConciliacion }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
        <span>
          <strong>Confianza:</strong> {(resultado.confidence * 100).toFixed(0)}%
        </span>
        <span>
          <strong>Conciliados:</strong> {resultado.totalMatched} / {resultado.totalMovements} movimientos ({(resultado.matchRate * 100).toFixed(0)}%)
        </span>
        <span>
          <strong>Monto conciliado:</strong> {formatMoney(resultado.montoMatched)}
        </span>
        <span>
          <strong>Sin conciliar (banco):</strong> {formatMoney(resultado.montoUnmatchedBank)}
        </span>
        <span>
          <strong>Sin conciliar (CFDI):</strong> {formatMoney(resultado.montoUnmatchedBooks)}
        </span>
      </div>

      {resultado.matched.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>Coincidencias ({resultado.matched.length})</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Nivel</th>
                <th style={{ padding: "6px 8px" }}>Score</th>
                <th style={{ padding: "6px 8px" }}>Monto banco</th>
                <th style={{ padding: "6px 8px" }}>Monto CFDI</th>
                <th style={{ padding: "6px 8px" }}>Fecha banco</th>
                <th style={{ padding: "6px 8px" }}>Fecha CFDI</th>
                <th style={{ padding: "6px 8px" }}>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {resultado.matched.map((m, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 8px" }}>
                    <NivelBadge level={m.level} />
                  </td>
                  <td style={{ padding: "6px 8px" }}>{m.score.toFixed(0)}</td>
                  <td style={{ padding: "6px 8px" }}>{formatMoney(m.montoBanco)}</td>
                  <td style={{ padding: "6px 8px" }}>{formatMoney(m.montoRegistro)}</td>
                  <td style={{ padding: "6px 8px" }}>{m.fechaBanco}</td>
                  <td style={{ padding: "6px 8px" }}>{m.fechaRegistro}</td>
                  <td style={{ padding: "6px 8px", color: "#6b7280" }}>{m.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resultado.unmatchedBank.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>Movimientos bancarios sin conciliar ({resultado.unmatchedBank.length})</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Fecha</th>
                <th style={{ padding: "6px 8px" }}>Descripción</th>
                <th style={{ padding: "6px 8px" }}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {resultado.unmatchedBank.map((m, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 8px" }}>{m.fecha}</td>
                  <td style={{ padding: "6px 8px" }}>{m.descripcion || "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{formatMoney(m.monto)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resultado.unmatchedBooks.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>CFDI sin conciliar ({resultado.unmatchedBooks.length})</p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Fecha</th>
                <th style={{ padding: "6px 8px" }}>Emisor</th>
                <th style={{ padding: "6px 8px" }}>Folio fiscal</th>
                <th style={{ padding: "6px 8px" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {resultado.unmatchedBooks.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 8px" }}>{r.fecha}</td>
                  <td style={{ padding: "6px 8px" }}>{r.descripcion ?? "—"}</td>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace", fontSize: 11 }}>{r.folioFiscal ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>{typeof r.total === "number" ? formatMoney(r.total) : (r.total ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ConciliacionPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = CONCILIACION_ROLES.has(role);

  const [filas, setFilas] = useState<readonly MovimientoFila[]>([nuevaFila()]);
  const movimientosLote = filas.map(filaAInput).filter((m): m is MovimientoBancarioInput => m !== null);

  // -- Matching --------------------------------------------------------------
  const [dateToleranceDays, setDateToleranceDays] = useState("3");
  const [montoTolerancePct, setMontoTolerancePct] = useState("5");
  const [fuzzyThreshold, setFuzzyThreshold] = useState("80");
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchResultado, setMatchResultado] = useState<ResultadoConciliacion | null>(null);

  async function handleMatching() {
    setMatchError(null);
    if (movimientosLote.length === 0) {
      setMatchError("Captura al menos un movimiento con fecha.");
      return;
    }
    setMatchLoading(true);
    try {
      const resultado = await correrMatchingConciliacion(fetch, apiBaseUrl, token, propertyId, movimientosLote, {
        dateToleranceDays: dateToleranceDays.trim() ? Number(dateToleranceDays) : undefined,
        montoTolerancePct: montoTolerancePct.trim() ? Number(montoTolerancePct) : undefined,
        fuzzyThreshold: fuzzyThreshold.trim() ? Number(fuzzyThreshold) : undefined,
      });
      setMatchResultado(resultado);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "No se pudo correr el matching.");
    } finally {
      setMatchLoading(false);
    }
  }

  // -- Alertas -----------------------------------------------------------
  const [declaredIncome, setDeclaredIncome] = useState("");
  const [alertasLoading, setAlertasLoading] = useState(false);
  const [alertasError, setAlertasError] = useState<string | null>(null);
  const [alertas, setAlertas] = useState<readonly AlertaConciliacion[] | null>(null);

  async function handleAlertas() {
    setAlertasError(null);
    if (movimientosLote.length === 0) {
      setAlertasError("Captura al menos un movimiento con fecha.");
      return;
    }
    setAlertasLoading(true);
    try {
      const income = declaredIncome.trim() ? Number(declaredIncome) : undefined;
      const { alertas: result } = await fetchAlertasConciliacion(fetch, apiBaseUrl, token, propertyId, movimientosLote, income);
      setAlertas(result);
    } catch (err) {
      setAlertasError(err instanceof Error ? err.message : "No se pudieron obtener las alertas.");
    } finally {
      setAlertasLoading(false);
    }
  }

  // -- Clasificar depósito -----------------------------------------------
  const [clasifDescripcion, setClasifDescripcion] = useState("");
  const [clasifReferencia, setClasifReferencia] = useState("");
  const [clasifLoading, setClasifLoading] = useState(false);
  const [clasifError, setClasifError] = useState<string | null>(null);
  const [clasifResultado, setClasifResultado] = useState<ResultadoClasificacionDeposito | null>(null);

  async function handleClasificar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClasifError(null);
    setClasifLoading(true);
    try {
      const resultado = await clasificarDepositoConciliacion(fetch, apiBaseUrl, token, propertyId, clasifDescripcion.trim(), clasifReferencia.trim() || null);
      setClasifResultado(resultado);
    } catch (err) {
      setClasifError(err instanceof Error ? err.message : "No se pudo clasificar el depósito.");
    } finally {
      setClasifLoading(false);
    }
  }

  // -- Verificar SPEI / proveedor ------------------------------------------
  const [speiModo, setSpeiModo] = useState<"clave" | "rfc">("clave");
  const [speiClave, setSpeiClave] = useState("");
  const [speiRfc, setSpeiRfc] = useState("");
  const [speiMonto, setSpeiMonto] = useState("");
  const [speiFecha, setSpeiFecha] = useState("");
  const [speiTolerancia, setSpeiTolerancia] = useState("3");
  const [speiLoading, setSpeiLoading] = useState(false);
  const [speiError, setSpeiError] = useState<string | null>(null);
  const [speiResultado, setSpeiResultado] = useState<ResultadoVerificacionSpei | null>(null);

  async function handleVerificarSpei(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSpeiError(null);
    if (movimientosLote.length === 0) {
      setSpeiError("Captura al menos un movimiento con fecha.");
      return;
    }
    const monto = Number(speiMonto);
    if (!Number.isFinite(monto)) {
      setSpeiError("Monto inválido.");
      return;
    }
    setSpeiLoading(true);
    try {
      const resultado = await verificarSpeiConciliacion(fetch, apiBaseUrl, token, propertyId, {
        movimientos: movimientosLote,
        claveRastreo: speiModo === "clave" ? speiClave.trim() : undefined,
        rfc: speiModo === "rfc" ? speiRfc.trim() : undefined,
        monto,
        fecha: speiFecha,
        dateToleranceDays: speiTolerancia.trim() ? Number(speiTolerancia) : undefined,
      });
      setSpeiResultado(resultado);
    } catch (err) {
      setSpeiError(err instanceof Error ? err.message : "No se pudo verificar el pago.");
    } finally {
      setSpeiLoading(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Conciliación bancaria</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede correr matching, alertas ni verificaciones -- el servidor las rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Conciliación bancaria</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Corre el matching determinista contra los CFDI ya ingeridos, revisa alertas de antigüedad/comisión/duplicados, clasifica depósitos (CFF Art. 59 fr. III) y verifica pagos SPEI/proveedor.
        </p>
      </header>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>1. Movimientos bancarios</h2>
        <MovimientosEditor filas={filas} setFilas={setFilas} />
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>2. Matching contra CFDI</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, width: 160 }}>
            Tolerancia de fecha (días)
            <input type="number" value={dateToleranceDays} onChange={(e) => setDateToleranceDays(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 160 }}>
            Tolerancia de monto (%)
            <input type="number" step="0.1" value={montoTolerancePct} onChange={(e) => setMontoTolerancePct(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 160 }}>
            Umbral fuzzy (0-100)
            <input type="number" value={fuzzyThreshold} onChange={(e) => setFuzzyThreshold(e.target.value)} style={inputStyle} />
          </label>
        </div>
        {matchError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {matchError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleMatching()} disabled={matchLoading} style={buttonPrimary}>
            {matchLoading ? "Corriendo…" : "Correr matching"}
          </button>
        </div>
        {matchResultado && <ResultadoMatching resultado={matchResultado} />}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>3. Alertas</h2>
        <label style={{ ...labelStyle, width: 240 }}>
          Ingreso declarado del periodo (opcional, Art. 91 LISR)
          <input type="number" step="0.01" value={declaredIncome} onChange={(e) => setDeclaredIncome(e.target.value)} style={inputStyle} />
        </label>
        {alertasError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {alertasError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleAlertas()} disabled={alertasLoading} style={buttonPrimary}>
            {alertasLoading ? "Revisando…" : "Ver alertas"}
          </button>
        </div>
        {alertas && alertas.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin alertas para este lote.</p>}
        {alertas && alertas.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {alertas.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, borderBottom: "1px solid #f3f4f6", paddingBottom: 6 }}>
                <SeveridadBadge severity={a.severity} />
                <div style={{ fontSize: 13 }}>
                  <div>{a.message}</div>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>
                    regla: {a.rule} {a.fecha && `· ${a.fecha}`} {a.daysUnreconciled > 0 && `· ${a.daysUnreconciled}d sin conciliar`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Clasificar depósito (CFF Art. 59 fr. III)</h2>
        <form onSubmit={handleClasificar} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
          <label style={labelStyle}>
            Descripción del depósito *
            <input type="text" value={clasifDescripcion} onChange={(e) => setClasifDescripcion(e.target.value)} required placeholder="p.ej. APORTACION SOCIO CAPITAL" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Referencia (opcional)
            <input type="text" value={clasifReferencia} onChange={(e) => setClasifReferencia(e.target.value)} style={inputStyle} />
          </label>
          {clasifError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {clasifError}
            </p>
          )}
          <div>
            <button type="submit" disabled={clasifLoading} style={buttonPrimary}>
              {clasifLoading ? "Clasificando…" : "Clasificar"}
            </button>
          </div>
        </form>
        {clasifResultado && (
          <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            <div>
              <strong>Clasificación:</strong> {CLASIFICACION_LABELS[clasifResultado.clasificacion]} ({(clasifResultado.confidence * 100).toFixed(0)}% confianza)
            </div>
            {clasifResultado.articuloCff && <div style={{ color: "#6b7280" }}>{clasifResultado.articuloCff}</div>}
            {clasifResultado.requiresHumanReview && (
              <p role="alert" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 8, margin: 0 }}>
                Requiere revisión humana antes de persistirse -- confianza baja o clasificación no trivial.
              </p>
            )}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Verificar pago SPEI / proveedor</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Busca, dentro del lote de movimientos capturado arriba, el que mejor coincida con la clave de rastreo (o el RFC del proveedor) más monto y fecha.</p>
        <form onSubmit={handleVerificarSpei} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
          <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={speiModo === "clave"} onChange={() => setSpeiModo("clave")} /> Clave de rastreo SPEI
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={speiModo === "rfc"} onChange={() => setSpeiModo("rfc")} /> RFC de proveedor
            </label>
          </div>
          {speiModo === "clave" ? (
            <label style={labelStyle}>
              Clave de rastreo *
              <input type="text" value={speiClave} onChange={(e) => setSpeiClave(e.target.value)} required style={inputStyle} />
            </label>
          ) : (
            <label style={labelStyle}>
              RFC del proveedor *
              <input type="text" value={speiRfc} onChange={(e) => setSpeiRfc(e.target.value.toUpperCase())} required style={inputStyle} />
            </label>
          )}
          <label style={labelStyle}>
            Monto *
            <input type="number" step="0.01" value={speiMonto} onChange={(e) => setSpeiMonto(e.target.value)} required style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Fecha del pago *
            <input type="date" value={speiFecha} onChange={(e) => setSpeiFecha(e.target.value)} required style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 160 }}>
            Tolerancia de fecha (días)
            <input type="number" value={speiTolerancia} onChange={(e) => setSpeiTolerancia(e.target.value)} style={inputStyle} />
          </label>
          {speiError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {speiError}
            </p>
          )}
          <div>
            <button type="submit" disabled={speiLoading} style={buttonPrimary}>
              {speiLoading ? "Verificando…" : "Verificar"}
            </button>
          </div>
        </form>
        {speiResultado && (
          <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            <div>
              <strong>{speiResultado.verified ? "Verificado" : "No verificado"}</strong> -- score {speiResultado.bestScore.toFixed(0)}
            </div>
            {speiResultado.movementIdx !== null && movimientosLote[speiResultado.movementIdx] && (
              <div style={{ color: "#6b7280" }}>
                Mejor coincidencia: {movimientosLote[speiResultado.movementIdx]!.fecha} -- {movimientosLote[speiResultado.movementIdx]!.descripcion || "(sin descripción)"}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
