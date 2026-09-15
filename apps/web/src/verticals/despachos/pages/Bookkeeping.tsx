// Panel de bookkeeping / auto-clasificador de pólizas -- hallazgo de auditoría
// (severidad ALTA, "Siete módulos con ruta HTTP real y sin UI" -- última porción,
// cierra 7/7 junto con devolución de IVA construida en paralelo): bookkeeping.ts
// expone GET /catalogo, POST /clasificar, POST /poliza, POST /ajuste y POST
// /overrides/sugerencias sobre el motor determinista de
// @atiende/domain-despachos/bookkeeping/* (puerto de b2b_ai/features/bookkeeping/,
// SIN el nivel ML -- ver clasificador.ts), pero ningún cliente web ni página los
// usaba. Esta página cierra el gap.
//
// Flujo: 1) captura el lote de CFDI a clasificar (tabla editable, mismo patrón
// exacto que la tabla de movimientos de Conciliacion.tsx) + el historial de
// overrides humanos ya conocido (usado tanto por /clasificar como prioridad
// máxima, como por /overrides/sugerencias para agregarlos); 2) clasifica el lote
// -- el resultado queda en una tabla editable (el contador puede corregir la
// categoría antes de generar pólizas, exactamente el override que este mismo
// módulo aprende); 3) genera + valida pólizas contables sobre esas
// clasificaciones; 4) registra ajustes manuales (diario) fuera del flujo de CFDI;
// 5) ve las sugerencias de override agregadas por RFC. El catálogo de cuentas SAT
// se carga aparte, de solo lectura, como referencia.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  clasificarCfdisBookkeeping,
  fetchCatalogoBookkeeping,
  fetchSugerenciasOverridesBookkeeping,
  generarAjusteBookkeeping,
  generarPolizasBookkeeping,
} from "../lib/bookkeeping-client.ts";
import type {
  CatalogoBookkeeping,
  CfdiClasificarInput,
  CfdiClassification,
  EntradaAjusteInput,
  OverrideRecord,
  PolizaContable,
  PolizaResultado,
  SuggestionRetraining,
  TipoCfdiBookkeeping,
} from "../lib/bookkeeping-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que BOOKKEEPING_ROLES (@atiende/domain-despachos/roles.ts) --
// las 5 rutas de bookkeeping.ts exigen este rol en CADA llamada, así que -- mismo
// criterio que Conciliacion.tsx -- aquí no hay vista degradada para otros roles:
// el servidor rechazaría cualquier acción igual. Cosmético -- nunca la única
// barrera.
const BOOKKEEPING_ROLES = new Set(["admin", "contador"]);

const TIPOS_CFDI: readonly TipoCfdiBookkeeping[] = ["I", "E", "T", "P", "N"];
const TIPO_CFDI_LABELS: Record<TipoCfdiBookkeeping, string> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12, color: "#374151" };
const sectionStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const buttonPrimary = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 } as const;
const buttonSecondary = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontSize: 12 } as const;

// -- Fila: CFDI a clasificar -----------------------------------------------

interface CfdiFila {
  readonly key: string;
  cfdiUuid: string;
  rfcEmisor: string;
  rfcReceptor: string;
  descripcion: string;
  subtotal: string;
  iva: string;
  total: string;
  tasaIva: string;
  tipoCfdi: TipoCfdiBookkeeping;
}

let cfdiSeq = 0;
function nuevaCfdiFila(): CfdiFila {
  cfdiSeq += 1;
  return { key: `cfdi-${cfdiSeq}`, cfdiUuid: "", rfcEmisor: "", rfcReceptor: "", descripcion: "", subtotal: "", iva: "", total: "", tasaIva: "0.16", tipoCfdi: "I" };
}

function cfdiFilaAInput(f: CfdiFila): CfdiClasificarInput | null {
  const cfdiUuid = f.cfdiUuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  if (!cfdiUuid || !rfcEmisor) return null;
  return {
    cfdiUuid,
    rfcEmisor: rfcEmisor.toUpperCase(),
    rfcReceptor: f.rfcReceptor.trim() ? f.rfcReceptor.trim().toUpperCase() : undefined,
    descripcion: f.descripcion.trim() || undefined,
    subtotal: f.subtotal.trim() ? Number(f.subtotal) : undefined,
    iva: f.iva.trim() ? Number(f.iva) : undefined,
    total: f.total.trim() ? Number(f.total) : undefined,
    tasaIva: f.tasaIva.trim() ? Number(f.tasaIva) : undefined,
    tipoCfdi: f.tipoCfdi,
  };
}

// -- Fila: override humano ---------------------------------------------------

interface OverrideFila {
  readonly key: string;
  cfdiUuid: string;
  rfcEmisor: string;
  newCategoria: string;
  tenantId: string;
}

let overrideSeq = 0;
function nuevaOverrideFila(): OverrideFila {
  overrideSeq += 1;
  return { key: `ov-${overrideSeq}`, cfdiUuid: "", rfcEmisor: "", newCategoria: "", tenantId: "" };
}

function overrideFilaAInput(f: OverrideFila): OverrideRecord | null {
  const cfdiUuid = f.cfdiUuid.trim();
  const rfcEmisor = f.rfcEmisor.trim();
  const newCategoria = f.newCategoria.trim();
  if (!cfdiUuid || !rfcEmisor || !newCategoria) return null;
  return { cfdiUuid, rfcEmisor: rfcEmisor.toUpperCase(), newCategoria, tenantId: f.tenantId.trim() };
}

// -- Fila: entrada de ajuste manual ------------------------------------------

interface AjusteEntryFila {
  readonly key: string;
  cuenta: string;
  debe: string;
  haber: string;
  concepto: string;
}

let ajusteSeq = 0;
function nuevaAjusteFila(): AjusteEntryFila {
  ajusteSeq += 1;
  return { key: `adj-${ajusteSeq}`, cuenta: "", debe: "", haber: "", concepto: "" };
}

function ajusteFilaAInput(f: AjusteEntryFila): EntradaAjusteInput | null {
  const cuenta = f.cuenta.trim();
  if (!cuenta) return null;
  const debe = f.debe.trim() ? Number(f.debe) : undefined;
  const haber = f.haber.trim() ? Number(f.haber) : undefined;
  return { cuenta, debe, haber, concepto: f.concepto.trim() || undefined };
}

function ConfidenceBadge({ confidence, needsHumanReview }: { confidence: number; needsHumanReview: boolean }) {
  const bg = needsHumanReview ? "#fef9c3" : confidence >= 0.85 ? "#dcfce7" : "#dbeafe";
  const fg = needsHumanReview ? "#854d0e" : confidence >= 0.85 ? "#166534" : "#1e40af";
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: bg, color: fg, fontWeight: 600 }}>
      {(confidence * 100).toFixed(0)}% {needsHumanReview ? "· revisar" : ""}
    </span>
  );
}

function PolizaCard({ resultado }: { resultado: PolizaResultado }) {
  const { poliza, errores } = resultado;
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>CFDI {resultado.cfdiUuid}</strong>
        {poliza && (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: poliza.cuadrada ? "#dcfce7" : "#fee2e2", color: poliza.cuadrada ? "#166534" : "#991b1b", fontWeight: 600 }}>
            {poliza.cuadrada ? "Cuadrada" : "Desbalanceada"}
          </span>
        )}
      </div>
      {errores.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, color: "#b91c1c", fontSize: 12 }}>
          {errores.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {poliza && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 480 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 6px" }}>Cuenta</th>
                <th style={{ padding: "4px 6px" }}>Concepto</th>
                <th style={{ padding: "4px 6px" }}>Debe</th>
                <th style={{ padding: "4px 6px" }}>Haber</th>
              </tr>
            </thead>
            <tbody>
              {poliza.lineas.map((l, i) => (
                <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{l.cuenta}</td>
                  <td style={{ padding: "4px 6px", color: "#6b7280" }}>{l.concepto}</td>
                  <td style={{ padding: "4px 6px" }}>{l.debe > 0 ? formatMoney(l.debe) : "—"}</td>
                  <td style={{ padding: "4px 6px" }}>{l.haber > 0 ? formatMoney(l.haber) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid #e5e7eb", fontWeight: 600 }}>
                <td style={{ padding: "4px 6px" }} colSpan={2}>
                  Totales · {poliza.tipo} · {poliza.fecha || "(sin fecha)"}
                </td>
                <td style={{ padding: "4px 6px" }}>{formatMoney(poliza.totalDebe)}</td>
                <td style={{ padding: "4px 6px" }}>{formatMoney(poliza.totalHaber)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

export function BookkeepingPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const puedeGestionar = BOOKKEEPING_ROLES.has(role);

  // -- Catálogo de cuentas (solo lectura) ------------------------------------
  const [catalogo, setCatalogo] = useState<CatalogoBookkeeping | null>(null);
  const [catalogoError, setCatalogoError] = useState<string | null>(null);
  const [catalogoFiltro, setCatalogoFiltro] = useState("");
  const [catalogoAbierto, setCatalogoAbierto] = useState(false);

  useEffect(() => {
    if (!puedeGestionar) return;
    let cancelado = false;
    (async () => {
      try {
        const c = await fetchCatalogoBookkeeping(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setCatalogo(c);
      } catch (err) {
        if (!cancelado) setCatalogoError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de cuentas.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [puedeGestionar, apiBaseUrl, token, propertyId]);

  const cuentasFiltradas = catalogo
    ? Object.entries(catalogo.catalogoCuentas).filter(([codigo, nombre]) => !catalogoFiltro.trim() || codigo.includes(catalogoFiltro.trim()) || nombre.toLowerCase().includes(catalogoFiltro.trim().toLowerCase()))
    : [];

  // -- Overrides humanos (historial compartido: /clasificar y /overrides/sugerencias) --
  const [overrideFilas, setOverrideFilas] = useState<readonly OverrideFila[]>([]);
  const overridesLote = overrideFilas.map(overrideFilaAInput).filter((o): o is OverrideRecord => o !== null);

  function actualizarOverrideFila(key: string, campo: keyof OverrideFila, valor: string) {
    setOverrideFilas(overrideFilas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  // -- 1. Clasificar CFDI -----------------------------------------------------
  const [cfdiFilas, setCfdiFilas] = useState<readonly CfdiFila[]>([nuevaCfdiFila()]);
  const [clasifLoading, setClasifLoading] = useState(false);
  const [clasifError, setClasifError] = useState<string | null>(null);
  const [clasificaciones, setClasificaciones] = useState<readonly CfdiClassification[]>([]);

  function actualizarCfdiFila(key: string, campo: keyof CfdiFila, valor: string) {
    setCfdiFilas(cfdiFilas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  async function handleClasificar() {
    setClasifError(null);
    const cfdis = cfdiFilas.map(cfdiFilaAInput).filter((c): c is CfdiClasificarInput => c !== null);
    if (cfdis.length === 0) {
      setClasifError("Captura al menos un CFDI con UUID y RFC emisor.");
      return;
    }
    setClasifLoading(true);
    try {
      const { clasificaciones: result } = await clasificarCfdisBookkeeping(fetch, apiBaseUrl, token, propertyId, cfdis, overridesLote);
      setClasificaciones(result);
    } catch (err) {
      setClasifError(err instanceof Error ? err.message : "No se pudo clasificar el lote.");
    } finally {
      setClasifLoading(false);
    }
  }

  function corregirCategoria(idx: number, categoria: string) {
    setClasificaciones(clasificaciones.map((c, i) => (i === idx ? { ...c, categoria, needsHumanReview: false } : c)));
  }

  // -- 2. Generar pólizas ------------------------------------------------------
  const [polizaTenantId, setPolizaTenantId] = useState("");
  const [polizaFecha, setPolizaFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [polizaLoading, setPolizaLoading] = useState(false);
  const [polizaError, setPolizaError] = useState<string | null>(null);
  const [polizas, setPolizas] = useState<readonly PolizaResultado[] | null>(null);

  async function handleGenerarPolizas() {
    setPolizaError(null);
    if (clasificaciones.length === 0) {
      setPolizaError("Clasifica al menos un CFDI primero (sección de arriba).");
      return;
    }
    setPolizaLoading(true);
    try {
      const { polizas: result } = await generarPolizasBookkeeping(fetch, apiBaseUrl, token, propertyId, clasificaciones, polizaTenantId.trim() || undefined, polizaFecha || undefined);
      setPolizas(result);
    } catch (err) {
      setPolizaError(err instanceof Error ? err.message : "No se pudieron generar las pólizas.");
    } finally {
      setPolizaLoading(false);
    }
  }

  // -- 3. Ajuste manual (diario) ------------------------------------------------
  const [ajusteFecha, setAjusteFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [ajusteConcepto, setAjusteConcepto] = useState("");
  const [ajusteTenantId, setAjusteTenantId] = useState("");
  const [ajusteEntries, setAjusteEntries] = useState<readonly AjusteEntryFila[]>([nuevaAjusteFila(), nuevaAjusteFila()]);
  const [ajusteLoading, setAjusteLoading] = useState(false);
  const [ajusteError, setAjusteError] = useState<string | null>(null);
  const [ajusteResultado, setAjusteResultado] = useState<{ readonly poliza: PolizaContable; readonly errores: readonly string[] } | null>(null);

  function actualizarAjusteFila(key: string, campo: keyof AjusteEntryFila, valor: string) {
    setAjusteEntries(ajusteEntries.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  function eliminarAjusteFila(key: string) {
    setAjusteEntries(ajusteEntries.filter((f) => f.key !== key));
  }

  async function handleAjuste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAjusteError(null);
    const entries = ajusteEntries.map(ajusteFilaAInput).filter((e): e is EntradaAjusteInput => e !== null);
    if (entries.length < 2) {
      setAjusteError("Captura al menos 2 movimientos (una póliza necesita mínimo un cargo y un abono).");
      return;
    }
    setAjusteLoading(true);
    try {
      const resultado = await generarAjusteBookkeeping(fetch, apiBaseUrl, token, propertyId, ajusteFecha, ajusteConcepto.trim(), entries, ajusteTenantId.trim() || undefined);
      setAjusteResultado(resultado);
    } catch (err) {
      setAjusteError(err instanceof Error ? err.message : "No se pudo registrar el ajuste.");
    } finally {
      setAjusteLoading(false);
    }
  }

  // -- 4. Sugerencias de override -----------------------------------------------
  const [sugerenciasLoading, setSugerenciasLoading] = useState(false);
  const [sugerenciasError, setSugerenciasError] = useState<string | null>(null);
  const [sugerencias, setSugerencias] = useState<readonly SuggestionRetraining[] | null>(null);

  async function handleSugerencias() {
    setSugerenciasError(null);
    if (overridesLote.length === 0) {
      setSugerenciasError("Captura al menos un override humano en la tabla de arriba.");
      return;
    }
    setSugerenciasLoading(true);
    try {
      const { sugerencias: result } = await fetchSugerenciasOverridesBookkeeping(fetch, apiBaseUrl, token, propertyId, overridesLote);
      setSugerencias(result);
    } catch (err) {
      setSugerenciasError(err instanceof Error ? err.message : "No se pudieron calcular las sugerencias.");
    } finally {
      setSugerenciasLoading(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Bookkeeping</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede clasificar CFDI, generar pólizas ni registrar ajustes -- el servidor las rechazaría igual.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Bookkeeping</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Auto-clasificador de pólizas: clasifica CFDI por reglas determinísticas (override humano por RFC tiene prioridad máxima), genera + valida pólizas contables, registra ajustes manuales y revisa qué correcciones humanas conviene convertir en override permanente.
        </p>
      </header>

      <section style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Catálogo de cuentas (SAT)</h2>
          <button type="button" onClick={() => setCatalogoAbierto(!catalogoAbierto)} style={buttonSecondary}>
            {catalogoAbierto ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        {catalogoError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {catalogoError}
          </p>
        )}
        {catalogoAbierto && (
          <>
            {!catalogo ? (
              <p style={{ color: "#6b7280", fontSize: 13 }}>Cargando…</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input type="text" placeholder="Filtrar por código o nombre…" value={catalogoFiltro} onChange={(e) => setCatalogoFiltro(e.target.value)} style={{ ...inputStyle, maxWidth: 320 }} />
                <div style={{ overflowX: "auto", maxHeight: 260, overflowY: "auto", border: "1px solid #f3f4f6", borderRadius: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#6b7280", position: "sticky", top: 0, background: "#fff" }}>
                        <th style={{ padding: "4px 8px" }}>Código</th>
                        <th style={{ padding: "4px 8px" }}>Nombre</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuentasFiltradas.map(([codigo, nombre]) => (
                        <tr key={codigo} style={{ borderTop: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{codigo}</td>
                          <td style={{ padding: "4px 8px" }}>{nombre}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>{Object.keys(catalogo.mapeosDefault).length} mapeos default (tipoCfdi|categoría → cuentas) precargados en el motor.</p>
              </div>
            )}
          </>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Overrides humanos conocidos</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
          Historial de correcciones ya persistidas (este motor no guarda estado propio -- mándalas aquí en cada sesión). Se usan como prioridad máxima al clasificar y para calcular sugerencias de override permanente por RFC.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 6px" }}>CFDI UUID</th>
                <th style={{ padding: "4px 6px" }}>RFC emisor</th>
                <th style={{ padding: "4px 6px" }}>Categoría corregida</th>
                <th style={{ padding: "4px 6px" }}>Tenant (opcional)</th>
                <th style={{ padding: "4px 6px" }} />
              </tr>
            </thead>
            <tbody>
              {overrideFilas.map((f) => (
                <tr key={f.key}>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.cfdiUuid} onChange={(e) => actualizarOverrideFila(f.key, "cfdiUuid", e.target.value)} style={{ ...inputStyle, width: 160 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.rfcEmisor} onChange={(e) => actualizarOverrideFila(f.key, "rfcEmisor", e.target.value.toUpperCase())} style={{ ...inputStyle, width: 140 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.newCategoria} onChange={(e) => actualizarOverrideFila(f.key, "newCategoria", e.target.value)} style={{ ...inputStyle, width: 180 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.tenantId} onChange={(e) => actualizarOverrideFila(f.key, "tenantId", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <button type="button" onClick={() => setOverrideFilas(overrideFilas.filter((r) => r.key !== f.key))} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="button" onClick={() => setOverrideFilas([...overrideFilas, nuevaOverrideFila()])} style={buttonSecondary}>
            + Agregar override
          </button>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>1. Clasificar CFDI</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 900 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 6px" }}>UUID *</th>
                <th style={{ padding: "4px 6px" }}>RFC emisor *</th>
                <th style={{ padding: "4px 6px" }}>RFC receptor</th>
                <th style={{ padding: "4px 6px" }}>Descripción</th>
                <th style={{ padding: "4px 6px" }}>Subtotal</th>
                <th style={{ padding: "4px 6px" }}>IVA</th>
                <th style={{ padding: "4px 6px" }}>Total</th>
                <th style={{ padding: "4px 6px" }}>Tasa IVA</th>
                <th style={{ padding: "4px 6px" }}>Tipo</th>
                <th style={{ padding: "4px 6px" }} />
              </tr>
            </thead>
            <tbody>
              {cfdiFilas.map((f) => (
                <tr key={f.key}>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.cfdiUuid} onChange={(e) => actualizarCfdiFila(f.key, "cfdiUuid", e.target.value)} style={{ ...inputStyle, width: 150 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.rfcEmisor} onChange={(e) => actualizarCfdiFila(f.key, "rfcEmisor", e.target.value.toUpperCase())} style={{ ...inputStyle, width: 130 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.rfcReceptor} onChange={(e) => actualizarCfdiFila(f.key, "rfcReceptor", e.target.value.toUpperCase())} style={{ ...inputStyle, width: 130 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="text" value={f.descripcion} onChange={(e) => actualizarCfdiFila(f.key, "descripcion", e.target.value)} placeholder="p.ej. Honorarios enero" style={{ ...inputStyle, width: 200 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="number" step="0.01" value={f.subtotal} onChange={(e) => actualizarCfdiFila(f.key, "subtotal", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="number" step="0.01" value={f.iva} onChange={(e) => actualizarCfdiFila(f.key, "iva", e.target.value)} style={{ ...inputStyle, width: 90 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="number" step="0.01" value={f.total} onChange={(e) => actualizarCfdiFila(f.key, "total", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <input type="number" step="0.01" value={f.tasaIva} onChange={(e) => actualizarCfdiFila(f.key, "tasaIva", e.target.value)} style={{ ...inputStyle, width: 80 }} />
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <select value={f.tipoCfdi} onChange={(e) => actualizarCfdiFila(f.key, "tipoCfdi", e.target.value)} style={{ ...inputStyle, width: 90 }}>
                      {TIPOS_CFDI.map((t) => (
                        <option key={t} value={t}>
                          {t} · {TIPO_CFDI_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <button type="button" onClick={() => setCfdiFilas(cfdiFilas.filter((r) => r.key !== f.key))} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button type="button" onClick={() => setCfdiFilas([...cfdiFilas, nuevaCfdiFila()])} style={buttonSecondary}>
            + Agregar CFDI
          </button>
        </div>
        {clasifError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {clasifError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleClasificar()} disabled={clasifLoading} style={buttonPrimary}>
            {clasifLoading ? "Clasificando…" : "Clasificar lote"}
          </button>
        </div>

        {clasificaciones.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#374151", margin: "8px 0 4px" }}>Resultado ({clasificaciones.length}) -- la categoría es editable antes de generar pólizas</p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 720 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={{ padding: "4px 6px" }}>UUID</th>
                  <th style={{ padding: "4px 6px" }}>RFC emisor</th>
                  <th style={{ padding: "4px 6px" }}>Categoría</th>
                  <th style={{ padding: "4px 6px" }}>Confianza</th>
                </tr>
              </thead>
              <tbody>
                {clasificaciones.map((c, i) => (
                  <tr key={c.cfdiUuid} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{c.cfdiUuid}</td>
                    <td style={{ padding: "4px 6px" }}>{c.rfcEmisor}</td>
                    <td style={{ padding: "4px 6px" }}>
                      <input type="text" value={c.categoria} onChange={(e) => corregirCategoria(i, e.target.value)} style={{ ...inputStyle, width: 200 }} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <ConfidenceBadge confidence={c.confidence} needsHumanReview={c.needsHumanReview} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>2. Generar pólizas</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Genera + valida una póliza por cada CFDI clasificado arriba (sección 1). Si no hay mapeo contable para (tipo, categoría) el resultado trae el error explícito en vez de una póliza a medias.</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, width: 200 }}>
            Tenant (opcional, mapeos custom)
            <input type="text" value={polizaTenantId} onChange={(e) => setPolizaTenantId(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...labelStyle, width: 160 }}>
            Fecha de la póliza
            <input type="date" value={polizaFecha} onChange={(e) => setPolizaFecha(e.target.value)} style={inputStyle} />
          </label>
        </div>
        {polizaError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {polizaError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleGenerarPolizas()} disabled={polizaLoading} style={buttonPrimary}>
            {polizaLoading ? "Generando…" : "Generar pólizas"}
          </button>
        </div>
        {polizas && polizas.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {polizas.map((r) => (
              <PolizaCard key={r.cfdiUuid} resultado={r} />
            ))}
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>3. Registrar ajuste manual (diario)</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
          Póliza de diario fuera del flujo de CFDI (depreciación, provisiones, correcciones). El motor NO garantiza el balance automáticamente aquí -- captura cargos y abonos que ya cuadren; los errores de validación se muestran abajo si no cuadra.
        </p>
        <form onSubmit={handleAjuste} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ ...labelStyle, width: 160 }}>
              Fecha *
              <input type="date" value={ajusteFecha} onChange={(e) => setAjusteFecha(e.target.value)} required style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, width: 260 }}>
              Concepto *
              <input type="text" value={ajusteConcepto} onChange={(e) => setAjusteConcepto(e.target.value)} required placeholder="p.ej. Depreciación mensual equipo de cómputo" style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, width: 160 }}>
              Tenant (opcional)
              <input type="text" value={ajusteTenantId} onChange={(e) => setAjusteTenantId(e.target.value)} style={inputStyle} />
            </label>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={{ padding: "4px 6px" }}>Cuenta *</th>
                  <th style={{ padding: "4px 6px" }}>Debe</th>
                  <th style={{ padding: "4px 6px" }}>Haber</th>
                  <th style={{ padding: "4px 6px" }}>Concepto</th>
                  <th style={{ padding: "4px 6px" }} />
                </tr>
              </thead>
              <tbody>
                {ajusteEntries.map((f) => (
                  <tr key={f.key}>
                    <td style={{ padding: "3px 6px" }}>
                      <input type="text" value={f.cuenta} onChange={(e) => actualizarAjusteFila(f.key, "cuenta", e.target.value)} placeholder="p.ej. 6020300" style={{ ...inputStyle, width: 120 }} />
                    </td>
                    <td style={{ padding: "3px 6px" }}>
                      <input type="number" step="0.01" value={f.debe} onChange={(e) => actualizarAjusteFila(f.key, "debe", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                    </td>
                    <td style={{ padding: "3px 6px" }}>
                      <input type="number" step="0.01" value={f.haber} onChange={(e) => actualizarAjusteFila(f.key, "haber", e.target.value)} style={{ ...inputStyle, width: 100 }} />
                    </td>
                    <td style={{ padding: "3px 6px" }}>
                      <input type="text" value={f.concepto} onChange={(e) => actualizarAjusteFila(f.key, "concepto", e.target.value)} style={{ ...inputStyle, width: 200 }} />
                    </td>
                    <td style={{ padding: "3px 6px" }}>
                      <button type="button" onClick={() => eliminarAjusteFila(f.key)} style={{ ...buttonSecondary, color: "#b91c1c", borderColor: "#fecaca" }}>
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <button type="button" onClick={() => setAjusteEntries([...ajusteEntries, nuevaAjusteFila()])} style={buttonSecondary}>
              + Agregar movimiento
            </button>
          </div>
          {ajusteError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {ajusteError}
            </p>
          )}
          <div>
            <button type="submit" disabled={ajusteLoading} style={buttonPrimary}>
              {ajusteLoading ? "Registrando…" : "Registrar ajuste"}
            </button>
          </div>
        </form>
        {ajusteResultado && <PolizaCard resultado={{ cfdiUuid: "ajuste manual", poliza: ajusteResultado.poliza, errores: ajusteResultado.errores }} />}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>4. Sugerencias de override</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
          Agrega el historial de overrides humanos capturado arriba por RFC -- sugiere convertir en override permanente solo cuando hay señal fuerte (2+ correcciones y más de la mitad coinciden en la misma categoría).
        </p>
        {sugerenciasError && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {sugerenciasError}
          </p>
        )}
        <div>
          <button type="button" onClick={() => void handleSugerencias()} disabled={sugerenciasLoading} style={buttonPrimary}>
            {sugerenciasLoading ? "Calculando…" : "Ver sugerencias"}
          </button>
        </div>
        {sugerencias && sugerencias.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Sin señal suficiente todavía para sugerir ningún override permanente.</p>}
        {sugerencias && sugerencias.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                  <th style={{ padding: "6px 8px" }}>RFC</th>
                  <th style={{ padding: "6px 8px" }}>Categoría sugerida</th>
                  <th style={{ padding: "6px 8px" }}>Coincidencias</th>
                  <th style={{ padding: "6px 8px" }}>Total correcciones</th>
                  <th style={{ padding: "6px 8px" }}>Confianza</th>
                </tr>
              </thead>
              <tbody>
                {sugerencias.map((s) => (
                  <tr key={s.rfc} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{s.rfc}</td>
                    <td style={{ padding: "6px 8px" }}>{s.suggestedCategoria}</td>
                    <td style={{ padding: "6px 8px" }}>{s.overrideCount}</td>
                    <td style={{ padding: "6px 8px" }}>{s.totalCorrections}</td>
                    <td style={{ padding: "6px 8px" }}>{(s.confidence * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
