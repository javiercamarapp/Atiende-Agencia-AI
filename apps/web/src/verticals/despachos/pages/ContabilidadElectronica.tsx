// Panel de contabilidad electrónica SAT (Anexo 24) -- hallazgo de auditoría:
// el motor completo (catálogo de cuentas XML, balanza XML, paquete completo
// con hash SHA-1) ya existía en @atiende/domain-despachos con tests, pero
// ninguna ruta HTTP ni pantalla lo exponía. Obligación fiscal MENSUAL real de
// un despacho -- la plantilla de cierre mensual ya lista esta generación como
// categoría "electronica" (tarea "contabilidad_elect", ver
// CierreMensualDetalle.tsx) sin poder generarla desde el producto hasta esta
// pantalla.
//
// Flujo: 1) periodo (ejercicio/mes/RFC/razón social) + asientos contables del
// mes (el catálogo usa el default Anexo 24 del SAT, cargado de
// GET /catalogo-base) -> 2) "Generar paquete completo" corre el motor
// (catálogo + balanza + hashes, estado inicial "listo_para_timbrar") -> 3) el
// contador puede descargar cada XML y, si el paquete quedó bien, confirmar el
// estado "listo para timbrar" (idempotente). Ningún paquete se persiste
// server-side en esta fase (ver cabecera de contabilidad-electronica.ts en
// apps/api): el estado que se muestra es el que devolvió la última llamada.
import { useEffect, useState } from "react";
import {
  fetchCatalogoBaseContabilidadElectronica,
  postPaqueteContabilidadElectronica,
  postListoParaTimbrarContabilidadElectronica,
} from "../lib/contabilidad-electronica-client.ts";
import type { AsientoContable, CuentaAnexo24, EstadoPaqueteContabilidad, PaqueteContabilidadElectronica } from "../lib/contabilidad-electronica-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que CONTABILIDAD_ELECTRONICA_ROLES (@atiende/domain-despachos/
// roles.ts) -- la ruta exige este rol en cada llamada; esto es cosmético
// (ocultar botones que el servidor rechazaría igual), mismo criterio que
// DevolucionIva.tsx/Conciliacion.tsx.
const CONTABILIDAD_ELECTRONICA_ROLES = new Set(["admin", "contador"]);

const ESTADO_LABELS: Record<EstadoPaqueteContabilidad, string> = {
  borrador: "Borrador",
  listo_para_timbrar: "Listo para timbrar",
  timbrado: "Timbrado",
  enviado: "Enviado",
};

const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12, color: "#374151" };
const sectionStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const buttonPrimary = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 } as const;
const buttonSecondary = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontSize: 12 } as const;
const cellInput = { ...inputStyle, width: 110 } as const;

interface AsientoFila {
  readonly key: string;
  cuenta: string;
  debe: string;
  haber: string;
  fecha: string;
}

let asientoSeq = 0;
function nuevaAsientoFila(): AsientoFila {
  asientoSeq += 1;
  return { key: `as-${asientoSeq}`, cuenta: "", debe: "", haber: "", fecha: "" };
}

function filaAAsiento(a: AsientoFila): AsientoContable | null {
  const cuenta = a.cuenta.trim();
  if (!cuenta) return null;
  return {
    cuenta,
    debe: a.debe.trim() ? Number(a.debe) : undefined,
    haber: a.haber.trim() ? Number(a.haber) : undefined,
    fecha: a.fecha.trim() || null,
  };
}

function descargarXml(nombre: string, xml: string) {
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function AsientosEditor({ filas, setFilas }: { filas: readonly AsientoFila[]; setFilas: (f: readonly AsientoFila[]) => void }) {
  function actualizar(key: string, campo: keyof AsientoFila, valor: string) {
    setFilas(filas.map((a) => (a.key === key ? { ...a, [campo]: valor } : a)));
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={{ padding: "4px 6px" }}>Cuenta *</th>
              <th style={{ padding: "4px 6px" }}>Debe</th>
              <th style={{ padding: "4px 6px" }}>Haber</th>
              <th style={{ padding: "4px 6px" }}>Fecha</th>
              <th style={{ padding: "4px 6px" }} />
            </tr>
          </thead>
          <tbody>
            {filas.map((a) => (
              <tr key={a.key}>
                <td style={{ padding: "3px 6px" }}>
                  <input type="text" value={a.cuenta} onChange={(e) => actualizar(a.key, "cuenta", e.target.value)} placeholder="1101" style={cellInput} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={a.debe} onChange={(e) => actualizar(a.key, "debe", e.target.value)} style={cellInput} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="number" step="0.01" value={a.haber} onChange={(e) => actualizar(a.key, "haber", e.target.value)} style={cellInput} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <input type="date" value={a.fecha} onChange={(e) => actualizar(a.key, "fecha", e.target.value)} style={{ ...cellInput, width: 140 }} />
                </td>
                <td style={{ padding: "3px 6px" }}>
                  <button type="button" onClick={() => setFilas(filas.filter((r) => r.key !== a.key))} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button type="button" onClick={() => setFilas([...filas, nuevaAsientoFila()])} style={buttonSecondary}>
          + Agregar asiento
        </button>
      </div>
    </div>
  );
}

export function ContabilidadElectronicaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = CONTABILIDAD_ELECTRONICA_ROLES.has(role);

  const now = new Date();
  const [ejercicio, setEjercicio] = useState(String(now.getFullYear()));
  const [mes, setMes] = useState(String(now.getMonth() + 1));
  const [rfc, setRfc] = useState("");
  const [razonSocial, setRazonSocial] = useState("");

  const [catalogoBase, setCatalogoBase] = useState<readonly CuentaAnexo24[] | null>(null);
  const [catalogoError, setCatalogoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCatalogoBaseContabilidadElectronica(fetch, apiBaseUrl, token, propertyId)
      .then((c) => {
        if (!cancelado) setCatalogoBase(c);
      })
      .catch((err) => {
        if (!cancelado) setCatalogoError(err instanceof Error ? err.message : "No se pudo cargar el catálogo base.");
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  const [asientoFilas, setAsientoFilas] = useState<readonly AsientoFila[]>([nuevaAsientoFila()]);
  const asientos = asientoFilas.map(filaAAsiento).filter((a): a is AsientoContable => a !== null);

  const [generando, setGenerando] = useState(false);
  const [generarError, setGenerarError] = useState<string | null>(null);
  const [paquete, setPaquete] = useState<PaqueteContabilidadElectronica | null>(null);

  const [confirmando, setConfirmando] = useState(false);
  const [confirmarError, setConfirmarError] = useState<string | null>(null);

  async function handleGenerarPaquete() {
    setGenerarError(null);
    const ejercicioNum = Number(ejercicio);
    const mesNum = Number(mes);
    if (!Number.isFinite(ejercicioNum)) return setGenerarError("Ejercicio: captura un año válido.");
    if (!Number.isFinite(mesNum) || mesNum < 1 || mesNum > 12) return setGenerarError("Mes: captura un valor entre 1 y 12.");
    if (asientos.length === 0) return setGenerarError("Captura al menos un asiento contable con cuenta.");
    setGenerando(true);
    try {
      const resultado = await postPaqueteContabilidadElectronica(fetch, apiBaseUrl, token, propertyId, {
        ejercicio: ejercicioNum,
        mes: mesNum,
        rfc: rfc.trim() || undefined,
        razonSocial: razonSocial.trim() || undefined,
        asientos,
      });
      setPaquete(resultado);
    } catch (err) {
      setGenerarError(err instanceof Error ? err.message : "No se pudo generar el paquete de contabilidad electrónica.");
    } finally {
      setGenerando(false);
    }
  }

  async function handleMarcarListoParaTimbrar() {
    if (!paquete) return;
    setConfirmarError(null);
    setConfirmando(true);
    try {
      const { estado } = await postListoParaTimbrarContabilidadElectronica(fetch, apiBaseUrl, token, propertyId, paquete.estado);
      setPaquete({ ...paquete, estado });
    } catch (err) {
      setConfirmarError(err instanceof Error ? err.message : "No se pudo confirmar el estado del paquete.");
    } finally {
      setConfirmando(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Contabilidad electrónica</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede generar la contabilidad electrónica -- el servidor lo rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Contabilidad electrónica (Anexo 24)</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Genera el catálogo de cuentas XML, la balanza de comprobación XML y el paquete completo (con hash SHA-1) exigidos por el SAT cada mes. El catálogo usa el default Anexo 24 del SAT
          {catalogoBase ? ` (${catalogoBase.length} cuentas)` : ""}.
        </p>
        {catalogoError && (
          <p role="alert" style={{ color: "#b91c1c", margin: "4px 0 0", fontSize: 13 }}>
            {catalogoError}
          </p>
        )}
      </header>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Periodo</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, width: 120 }}>
            Ejercicio *
            <input type="number" value={ejercicio} onChange={(e) => setEjercicio(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 100 }}>
            Mes *
            <input type="number" min={1} max={12} value={mes} onChange={(e) => setMes(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 200 }}>
            RFC (opcional)
            <input type="text" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 260 }}>
            Razón social (opcional)
            <input type="text" value={razonSocial} onChange={(e) => setRazonSocial(e.target.value)} style={inputStyle} />
          </label>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Asientos contables del mes</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
          Captura los movimientos (cuenta + debe/haber) que alimentan la balanza de comprobación del periodo. Un asiento sin fecha nunca se excluye por periodo.
        </p>
        <AsientosEditor filas={asientoFilas} setFilas={setAsientoFilas} />
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Generar paquete completo</h2>
        {generarError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {generarError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleGenerarPaquete()} disabled={generando} style={buttonPrimary}>
            {generando ? "Generando…" : "Generar catálogo + balanza + paquete"}
          </button>
        </div>

        {paquete && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
              <span>
                <strong>Periodo:</strong> {paquete.periodo}
              </span>
              <span>
                <strong>Estado:</strong> {ESTADO_LABELS[paquete.estado] ?? paquete.estado}
              </span>
              <span>
                <strong>Balanza cuadrada:</strong> {paquete.balanza.cuadrada ? "Sí" : "No"}
              </span>
              <span>
                <strong>Generado:</strong> {paquete.generadoEn}
              </span>
            </div>

            {!paquete.balanza.cuadrada && (
              <p role="alert" style={{ color: "#b91c1c", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 8, padding: 8, margin: 0, fontSize: 13 }}>
                La balanza no cuadra (total debe ≠ total haber). Revisa los asientos antes de timbrar.
              </p>
            )}
            {paquete.resumenBalanza.saldosAnomalos.length > 0 && (
              <p role="alert" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 8, margin: 0, fontSize: 13 }}>
                Cuentas con saldo anómalo: {paquete.resumenBalanza.saldosAnomalos.join(", ")}.
              </p>
            )}

            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>Catálogo de cuentas</p>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {paquete.catalogo.cuentas} cuentas · SHA-1 <span style={{ fontFamily: "monospace" }}>{paquete.catalogo.sha1}</span>
                </span>
                <button type="button" onClick={() => descargarXml(`catalogo-cuentas-${paquete.periodo}.xml`, paquete.catalogo.xml)} style={buttonSecondary}>
                  Descargar catálogo XML
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>Balanza de comprobación</p>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {paquete.balanza.cuentas} cuentas · SHA-1 <span style={{ fontFamily: "monospace" }}>{paquete.balanza.sha1}</span>
                </span>
                <button type="button" onClick={() => descargarXml(`balanza-comprobacion-${paquete.periodo}.xml`, paquete.balanza.xml)} style={buttonSecondary}>
                  Descargar balanza XML
                </button>
              </div>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>Cuenta</th>
                    <th style={{ padding: "6px 8px" }}>Descripción</th>
                    <th style={{ padding: "6px 8px" }}>Saldo inicial</th>
                    <th style={{ padding: "6px 8px" }}>Debe</th>
                    <th style={{ padding: "6px 8px" }}>Haber</th>
                    <th style={{ padding: "6px 8px" }}>Saldo final</th>
                  </tr>
                </thead>
                <tbody>
                  {paquete.resumenBalanza.lineas.map((l) => (
                    <tr key={l.cuenta} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{l.cuenta}</td>
                      <td style={{ padding: "6px 8px" }}>{l.descripcion}</td>
                      <td style={{ padding: "6px 8px" }}>{formatMoney(Number(l.saldoInicial))}</td>
                      <td style={{ padding: "6px 8px" }}>{formatMoney(Number(l.debe))}</td>
                      <td style={{ padding: "6px 8px" }}>{formatMoney(Number(l.haber))}</td>
                      <td style={{ padding: "6px 8px" }}>{formatMoney(Number(l.saldoFinal))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }} colSpan={3}>
                      Totales
                    </td>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{formatMoney(Number(paquete.resumenBalanza.totalDebe))}</td>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{formatMoney(Number(paquete.resumenBalanza.totalHaber))}</td>
                    <td style={{ padding: "6px 8px" }} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {confirmarError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {confirmarError}
              </p>
            )}
            <div>
              <button type="button" onClick={() => void handleMarcarListoParaTimbrar()} disabled={confirmando || paquete.estado !== "listo_para_timbrar"} style={buttonPrimary}>
                {confirmando ? "Confirmando…" : paquete.estado === "listo_para_timbrar" ? "Confirmar listo para timbrar" : `Estado actual: ${ESTADO_LABELS[paquete.estado] ?? paquete.estado}`}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
