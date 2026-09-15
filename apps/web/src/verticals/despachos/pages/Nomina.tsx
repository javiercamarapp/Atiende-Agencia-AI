// Panel de nómina -- hallazgo de auditoría (severidad ALTA, "Siete módulos con
// ruta HTTP real y sin UI", porción "nómina" tras vencimientos y declaraciones):
// nomina.ts expone POST /nomina/calcular y POST /nomina/generar-xml (motor
// determinista y verificado contra el intérprete Python real, ver
// @atiende/domain-despachos/nomina/payroll-engine.ts y xml-nomina.ts), pero
// ningún cliente web ni página los usaba. Esta página cierra el gap: formulario
// de cálculo de nómina de un periodo con una fila por empleado, el desglose de
// impuestos resultante (ISR/IMSS obrero/IMSS patronal/Infonavit/neto) y, a
// partir de ese mismo periodo ya calculado, la generación del XML del
// complemento Nómina 1.2 por empleado.
//
// Ambos cálculos son PUROS sin persistencia (ver comentario de nomina.ts en
// apps/api): esta página nunca "guarda" un periodo de nómina como entidad
// propia -- muestra el desglose y el XML para que el contador los use donde
// corresponda. `generar-xml` reusa internamente el MISMO motor que `calcular`
// (nunca acepta cifras ya calculadas desde el cliente para el XML fiscal), así
// que aquí también se recalcula el periodo completo al generar el XML -- nunca
// se manda un `taxes` capturado en el navegador.
import { useState } from "react";
import type { FormEvent } from "react";
import { calcularNomina, generarXmlNomina } from "../lib/nomina-client.ts";
import type { ComprobanteNomina, EmployeePayroll, GenerarXmlNominaInput, PayrollPeriodResultado, TipoNomina } from "../lib/nomina-client.ts";
import { formatMoney, formatPeriodo } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que NOMINA_ROLES (@atiende/domain-despachos/roles.ts) --
// cosmético, el servidor aplica exactamente el mismo filtro vía
// assertVerticalRole en las dos rutas de nomina.ts. Nunca la única barrera.
const NOMINA_ROLES = new Set(["admin", "contador"]);

const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: "100%" } as const;
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 12, color: "#374151" };

interface EmpleadoFila {
  readonly key: string;
  employeeId: string;
  nombre: string;
  salarioBruto: string;
  percepciones: string;
  salarioDiario: string;
  // Solo necesarios para /generar-xml -- opcionales mientras solo se calcula.
  rfcReceptor: string;
  nombreReceptor: string;
  domicilioFiscalReceptor: string;
  regimenFiscalReceptor: string;
  folio: string;
}

let filaSeq = 0;
function nuevaFila(): EmpleadoFila {
  filaSeq += 1;
  return {
    key: `fila-${filaSeq}`,
    employeeId: "",
    nombre: "",
    salarioBruto: "",
    percepciones: "",
    salarioDiario: "",
    rfcReceptor: "",
    nombreReceptor: "",
    domicilioFiscalReceptor: "",
    regimenFiscalReceptor: "",
    folio: "",
  };
}

function toNumberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function DesgloseTabla({ resultado }: { resultado: PayrollPeriodResultado }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {resultado.requiresHumanReview && (
        <p role="alert" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 10, fontSize: 13, margin: 0 }}>
          Requiere revisión humana: {resultado.humanReviewReason}
        </p>
      )}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
        <span>
          <strong>Periodo:</strong> {formatPeriodo(resultado.year, resultado.month)}
        </span>
        <span>
          <strong>Total bruto:</strong> {formatMoney(resultado.totalBruto)}
        </span>
        <span>
          <strong>Total deducciones:</strong> {formatMoney(resultado.totalDeducciones)}
        </span>
        <span>
          <strong>Total neto:</strong> {formatMoney(resultado.totalNeto)}
        </span>
        <span>
          <strong>Total IMSS patronal:</strong> {formatMoney(resultado.totalImssPatronal)}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
              <th style={{ padding: "6px 8px" }}>Empleado</th>
              <th style={{ padding: "6px 8px" }}>Bruto</th>
              <th style={{ padding: "6px 8px" }}>Percepciones</th>
              <th style={{ padding: "6px 8px" }}>ISR</th>
              <th style={{ padding: "6px 8px" }}>IMSS obrero</th>
              <th style={{ padding: "6px 8px" }}>IMSS patronal</th>
              <th style={{ padding: "6px 8px" }}>Infonavit</th>
              <th style={{ padding: "6px 8px" }}>Deducciones</th>
              <th style={{ padding: "6px 8px" }}>Neto</th>
            </tr>
          </thead>
          <tbody>
            {resultado.employees.map((e: EmployeePayroll) => (
              <tr key={e.employeeId || e.nombre} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "8px" }}>{e.nombre || e.employeeId || "—"}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.salarioBruto)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.percepciones)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.taxes.isr)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.taxes.imssObrero)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.taxes.imssPatronal)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.taxes.infonavit)}</td>
                <td style={{ padding: "8px" }}>{formatMoney(e.deducciones)}</td>
                <td style={{ padding: "8px", fontWeight: 700 }}>{formatMoney(e.neto)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>
        {resultado.referenciaLegal} -- Cálculo sin persistencia. Clave de idempotencia: <code>{resultado.idempotencyKey}</code>
      </p>
    </div>
  );
}

function ComprobanteXml({ comprobante }: { comprobante: ComprobanteNomina }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(comprobante.xml);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>
          <strong>Folio {comprobante.folio}</strong> -- empleado {comprobante.employeeId}
        </span>
        <button type="button" onClick={copiar} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12 }}>
          {copiado ? "Copiado" : "Copiar XML"}
        </button>
      </div>
      <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", background: "#f9fafb", padding: 10, borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{comprobante.xml}</pre>
    </div>
  );
}

export function NominaPage(ctx: DespachosShellContext) {
  const puedeUsar = NOMINA_ROLES.has(ctx.role);

  const now = new Date();
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [diasPagados, setDiasPagados] = useState("30");
  const [salarioDiarioDefault, setSalarioDiarioDefault] = useState("");
  const [empleados, setEmpleados] = useState<readonly EmpleadoFila[]>([nuevaFila()]);

  const [resultado, setResultado] = useState<PayrollPeriodResultado | null>(null);
  const [errorCalculo, setErrorCalculo] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  const [tipoNomina, setTipoNomina] = useState<TipoNomina>("O");
  const [serie, setSerie] = useState("");
  const [emisorRfc, setEmisorRfc] = useState("");
  const [emisorNombre, setEmisorNombre] = useState("");
  const [emisorRegimenFiscal, setEmisorRegimenFiscal] = useState("");
  const [emisorLugarExpedicion, setEmisorLugarExpedicion] = useState("");
  const [emisorNoCertificado, setEmisorNoCertificado] = useState("");
  const [xmlResultado, setXmlResultado] = useState<readonly ComprobanteNomina[] | null>(null);
  const [errorXml, setErrorXml] = useState<string | null>(null);
  const [generandoXml, setGenerandoXml] = useState(false);

  if (!puedeUsar) {
    return (
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Nómina</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Tu rol ({ctx.role}) no tiene acceso a nómina. Solo admin/contador.
        </p>
      </div>
    );
  }

  function actualizarFila(key: string, cambios: Partial<EmpleadoFila>) {
    setEmpleados((prev) => prev.map((f) => (f.key === key ? { ...f, ...cambios } : f)));
  }

  function agregarFila() {
    setEmpleados((prev) => [...prev, nuevaFila()]);
  }

  function quitarFila(key: string) {
    setEmpleados((prev) => (prev.length <= 1 ? prev : prev.filter((f) => f.key !== key)));
  }

  async function handleCalcular(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCalculo(null);
    setResultado(null);
    setXmlResultado(null);
    setErrorXml(null);

    const monthNum = toNumberOrUndefined(month);
    const yearNum = toNumberOrUndefined(year);
    const diasPagadosNum = toNumberOrUndefined(diasPagados);
    const salarioDiarioDefaultNum = toNumberOrUndefined(salarioDiarioDefault);

    setCalculando(true);
    try {
      const r = await calcularNomina(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum },
        employees: empleados.map((f) => ({
          employeeId: f.employeeId.trim() || undefined,
          nombre: f.nombre.trim() || undefined,
          salarioBruto: toNumberOrUndefined(f.salarioBruto),
          percepciones: toNumberOrUndefined(f.percepciones),
          salarioDiario: toNumberOrUndefined(f.salarioDiario),
        })),
        tenantId: null,
      });
      setResultado(r);
    } catch (err) {
      setErrorCalculo(err instanceof Error ? err.message : "No se pudo calcular la nómina.");
    } finally {
      setCalculando(false);
    }
  }

  async function handleGenerarXml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorXml(null);
    setXmlResultado(null);

    if (!emisorRfc.trim() || !emisorNombre.trim() || !emisorRegimenFiscal.trim() || !emisorLugarExpedicion.trim()) {
      setErrorXml("Completa los datos fiscales del emisor (RFC, nombre, régimen fiscal y lugar de expedición).");
      return;
    }
    const faltante = empleados.find((f) => !f.rfcReceptor.trim() || !f.domicilioFiscalReceptor.trim() || !f.folio.trim());
    if (faltante) {
      setErrorXml(`Falta RFC receptor, domicilio fiscal o folio del empleado "${faltante.nombre || faltante.employeeId || "sin nombre"}".`);
      return;
    }

    const monthNum = toNumberOrUndefined(month);
    const yearNum = toNumberOrUndefined(year);
    const diasPagadosNum = toNumberOrUndefined(diasPagados);
    const salarioDiarioDefaultNum = toNumberOrUndefined(salarioDiarioDefault);

    const input: GenerarXmlNominaInput = {
      period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum, tipoNomina, serie: serie.trim() || undefined },
      employees: empleados.map((f) => ({
        employeeId: f.employeeId.trim() || undefined,
        nombre: f.nombre.trim() || undefined,
        salarioBruto: toNumberOrUndefined(f.salarioBruto),
        percepciones: toNumberOrUndefined(f.percepciones),
        salarioDiario: toNumberOrUndefined(f.salarioDiario),
        rfcReceptor: f.rfcReceptor.trim(),
        nombreReceptor: f.nombreReceptor.trim() || undefined,
        domicilioFiscalReceptor: f.domicilioFiscalReceptor.trim(),
        regimenFiscalReceptor: f.regimenFiscalReceptor.trim() || undefined,
        folio: f.folio.trim(),
      })),
      emisor: {
        rfc: emisorRfc.trim(),
        nombre: emisorNombre.trim(),
        regimenFiscal: emisorRegimenFiscal.trim(),
        lugarExpedicion: emisorLugarExpedicion.trim(),
        noCertificado: emisorNoCertificado.trim() || undefined,
      },
      tenantId: null,
    };

    setGenerandoXml(true);
    try {
      const r = await generarXmlNomina(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, input);
      setXmlResultado(r.comprobantes);
    } catch (err) {
      setErrorXml(err instanceof Error ? err.message : "No se pudo generar el XML de nómina.");
    } finally {
      setGenerandoXml(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Nómina</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Calcula ISR, IMSS e Infonavit de un periodo y genera el XML del complemento Nómina 1.2 (sin timbrar).</p>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Periodo y empleados</h2>
        <form onSubmit={handleCalcular} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ ...labelStyle, width: 100 }}>
              Mes
              <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, width: 100 }}>
              Año
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, width: 130 }}>
              Días pagados
              <input type="number" value={diasPagados} onChange={(e) => setDiasPagados(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, width: 200 }}>
              Salario diario por defecto
              <input type="number" step="0.01" value={salarioDiarioDefault} onChange={(e) => setSalarioDiarioDefault(e.target.value)} placeholder="Opcional" style={inputStyle} />
            </label>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={{ padding: "4px 6px" }}>ID empleado</th>
                  <th style={{ padding: "4px 6px" }}>Nombre</th>
                  <th style={{ padding: "4px 6px" }}>Salario bruto</th>
                  <th style={{ padding: "4px 6px" }}>Percepciones</th>
                  <th style={{ padding: "4px 6px" }}>Salario diario</th>
                  <th style={{ padding: "4px 6px" }} />
                </tr>
              </thead>
              <tbody>
                {empleados.map((f) => (
                  <tr key={f.key}>
                    <td style={{ padding: "4px 6px" }}>
                      <input value={f.employeeId} onChange={(e) => actualizarFila(f.key, { employeeId: e.target.value })} style={inputStyle} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <input value={f.nombre} onChange={(e) => actualizarFila(f.key, { nombre: e.target.value })} style={inputStyle} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <input type="number" step="0.01" value={f.salarioBruto} onChange={(e) => actualizarFila(f.key, { salarioBruto: e.target.value })} style={inputStyle} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <input type="number" step="0.01" value={f.percepciones} onChange={(e) => actualizarFila(f.key, { percepciones: e.target.value })} placeholder="0" style={inputStyle} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <input type="number" step="0.01" value={f.salarioDiario} onChange={(e) => actualizarFila(f.key, { salarioDiario: e.target.value })} placeholder="Opcional" style={inputStyle} />
                    </td>
                    <td style={{ padding: "4px 6px" }}>
                      <button type="button" onClick={() => quitarFila(f.key)} disabled={empleados.length <= 1} style={{ border: "none", background: "transparent", color: "#b91c1c", cursor: "pointer", fontSize: 12 }}>
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={agregarFila} style={{ alignSelf: "flex-start", padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", fontSize: 12 }}>
            + Agregar empleado
          </button>

          {errorCalculo && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {errorCalculo}
            </p>
          )}
          <button
            type="submit"
            disabled={calculando}
            style={{ alignSelf: "flex-start", padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {calculando ? "Calculando…" : "Calcular nómina"}
          </button>
        </form>

        {resultado && <DesgloseTabla resultado={resultado} />}
      </section>

      {resultado && (
        <section style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid #e5e7eb", paddingTop: 20 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Generar XML del complemento Nómina 1.2</h2>
          <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>Genera el XML SIN sellar para cada empleado del periodo de arriba. El sellado con la FIEL/CSD real y el timbrado ante el PAC quedan fuera de esta página.</p>
          <form onSubmit={handleGenerarXml} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label style={{ ...labelStyle, width: 180 }}>
                RFC emisor *
                <input value={emisorRfc} onChange={(e) => setEmisorRfc(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ ...labelStyle, width: 260 }}>
                Nombre / razón social emisor *
                <input value={emisorNombre} onChange={(e) => setEmisorNombre(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ ...labelStyle, width: 160 }}>
                Régimen fiscal *
                <input value={emisorRegimenFiscal} onChange={(e) => setEmisorRegimenFiscal(e.target.value)} placeholder="601" style={inputStyle} />
              </label>
              <label style={{ ...labelStyle, width: 160 }}>
                Lugar de expedición (CP) *
                <input value={emisorLugarExpedicion} onChange={(e) => setEmisorLugarExpedicion(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ ...labelStyle, width: 200 }}>
                No. certificado
                <input value={emisorNoCertificado} onChange={(e) => setEmisorNoCertificado(e.target.value)} placeholder="Opcional" style={inputStyle} />
              </label>
              <label style={{ ...labelStyle, width: 140 }}>
                Tipo de nómina
                <select value={tipoNomina} onChange={(e) => setTipoNomina(e.target.value as TipoNomina)} style={inputStyle}>
                  <option value="O">O -- Ordinaria</option>
                  <option value="E">E -- Extraordinaria</option>
                </select>
              </label>
              <label style={{ ...labelStyle, width: 120 }}>
                Serie
                <input value={serie} onChange={(e) => setSerie(e.target.value)} placeholder="Opcional" style={inputStyle} />
              </label>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#6b7280" }}>
                    <th style={{ padding: "4px 6px" }}>Empleado</th>
                    <th style={{ padding: "4px 6px" }}>RFC receptor *</th>
                    <th style={{ padding: "4px 6px" }}>Nombre receptor</th>
                    <th style={{ padding: "4px 6px" }}>CP fiscal receptor *</th>
                    <th style={{ padding: "4px 6px" }}>Régimen fiscal receptor</th>
                    <th style={{ padding: "4px 6px" }}>Folio *</th>
                  </tr>
                </thead>
                <tbody>
                  {empleados.map((f) => (
                    <tr key={f.key}>
                      <td style={{ padding: "4px 6px" }}>{f.nombre || f.employeeId || "—"}</td>
                      <td style={{ padding: "4px 6px" }}>
                        <input value={f.rfcReceptor} onChange={(e) => actualizarFila(f.key, { rfcReceptor: e.target.value })} style={inputStyle} />
                      </td>
                      <td style={{ padding: "4px 6px" }}>
                        <input value={f.nombreReceptor} onChange={(e) => actualizarFila(f.key, { nombreReceptor: e.target.value })} placeholder="= nombre de nómina" style={inputStyle} />
                      </td>
                      <td style={{ padding: "4px 6px" }}>
                        <input value={f.domicilioFiscalReceptor} onChange={(e) => actualizarFila(f.key, { domicilioFiscalReceptor: e.target.value })} style={inputStyle} />
                      </td>
                      <td style={{ padding: "4px 6px" }}>
                        <input value={f.regimenFiscalReceptor} onChange={(e) => actualizarFila(f.key, { regimenFiscalReceptor: e.target.value })} placeholder="Opcional" style={inputStyle} />
                      </td>
                      <td style={{ padding: "4px 6px" }}>
                        <input value={f.folio} onChange={(e) => actualizarFila(f.key, { folio: e.target.value })} style={inputStyle} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {errorXml && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {errorXml}
              </p>
            )}
            <button
              type="submit"
              disabled={generandoXml}
              style={{ alignSelf: "flex-start", padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {generandoXml ? "Generando…" : "Generar XML"}
            </button>
          </form>

          {xmlResultado && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {xmlResultado.map((c) => (
                <ComprobanteXml key={`${c.employeeId}-${c.folio}`} comprobante={c} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
