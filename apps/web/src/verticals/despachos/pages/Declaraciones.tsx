// Panel de declaraciones fiscales -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI", porción "declaraciones" tras
// vencimientos): declaraciones.ts expone POST /declaraciones/isr/pf,
// /isr/pm, /isr/pm-resico y GET /declaraciones/diot/:periodo (motor 100%
// determinista y verificado contra el intérprete Python real, ver
// @atiende/domain-despachos/declaraciones/isr-engine.ts y diot-aggregate.ts),
// pero ningún cliente web ni página los usaba. Esta página cierra el gap:
// selector de tipo de declaración ISR (PF / PM / PM-RESICO), un formulario de
// cálculo por tipo, y la consulta de DIOT ya agregado por periodo.
//
// El cálculo de ISR es un endpoint PURO sin persistencia (ver comentario de
// declaraciones.ts en apps/api): esta página nunca "guarda" una declaración
// como entidad propia -- muestra el resultado para que el contador lo
// registre donde corresponda (ej. como comprobanteUrl de un vencimiento fiscal
// en Vencimientos.tsx). DIOT sí reconstruye datos reales ya persistidos
// (invoices con diot.proveedoresReportables), por eso es una consulta, no un
// formulario de captura.
import { useState } from "react";
import type { FormEvent } from "react";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, fetchDiot } from "../lib/declaraciones-client.ts";
import type { DiotAgregado, IsrResultado } from "../lib/declaraciones-client.ts";
import { formatDiotTipoOperacion, formatMoney, formatTablaAplicadaIsr } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que DECLARACIONES_ROLES (@atiende/domain-despachos/roles.ts) --
// cosmético, el servidor aplica exactamente el mismo filtro vía
// assertVerticalRole en las 4 rutas de declaraciones.ts. Nunca la única barrera.
const DECLARACIONES_ROLES = new Set(["admin", "contador"]);

type TipoDeclaracion = "pf" | "pm" | "pm-resico";

const TIPOS: ReadonlyArray<{ value: TipoDeclaracion; label: string }> = [
  { value: "pf", label: "ISR PF (honorarios / arrendamiento)" },
  { value: "pm", label: "ISR PM (30% sobre utilidad fiscal)" },
  { value: "pm-resico", label: "ISR PM RESICO" },
];

function ResultadoIsr({ resultado }: { resultado: IsrResultado }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
      <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", margin: 0 }}>
        {formatTablaAplicadaIsr(resultado.tablaAplicada)} · {resultado.tipoContribuyente === "PF" ? "Persona física" : "Persona moral"}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 16px", fontSize: 14 }}>
        <span style={{ color: "#6b7280" }}>Base gravable</span>
        <span style={{ textAlign: "right" }}>{formatMoney(resultado.baseGravable)}</span>
        <span style={{ color: "#6b7280" }}>ISR bruto</span>
        <span style={{ textAlign: "right" }}>{formatMoney(resultado.isrBruto)}</span>
        <span style={{ color: "#6b7280" }}>Tasa efectiva</span>
        <span style={{ textAlign: "right" }}>{(resultado.tasaEfectiva * 100).toFixed(2)}%</span>
        <span style={{ color: "#6b7280" }}>Pagos provisionales</span>
        <span style={{ textAlign: "right" }}>{formatMoney(resultado.pagosProvisionales)}</span>
        <span style={{ fontWeight: 700, color: "#111827" }}>ISR neto a pagar</span>
        <span style={{ textAlign: "right", fontWeight: 700, color: "#111827" }}>{formatMoney(resultado.isrNeto)}</span>
      </div>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>Cálculo sin persistencia -- copia el ISR neto donde corresponda (ej. comprobante de un vencimiento fiscal ya registrado).</p>
    </div>
  );
}

function IsrPfForm({ ctx }: { ctx: DespachosShellContext }) {
  const [baseGravable, setBaseGravable] = useState("");
  const [annual, setAnnual] = useState(false);
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const base = Number(baseGravable);
    if (!Number.isFinite(base)) {
      setError("Base gravable inválida.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPf(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        baseGravable: base,
        annual,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PF.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Base gravable *
          <input type="number" step="0.01" value={baseGravable} onChange={(e) => setBaseGravable(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={annual} onChange={(e) => setAnnual(e.target.checked)} />
          Declaración anual (si no, mensual)
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Pagos provisionales ya realizados
          <input type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {loading ? "Calculando…" : "Calcular ISR PF"}
        </button>
      </form>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function IsrPmForm({ ctx }: { ctx: DespachosShellContext }) {
  const [utilidadFiscal, setUtilidadFiscal] = useState("");
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const utilidad = Number(utilidadFiscal);
    if (!Number.isFinite(utilidad)) {
      setError("Utilidad fiscal inválida.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPm(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        utilidadFiscal: utilidad,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PM.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Utilidad fiscal *
          <input type="number" step="0.01" value={utilidadFiscal} onChange={(e) => setUtilidadFiscal(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Pagos provisionales ya realizados
          <input type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {loading ? "Calculando…" : "Calcular ISR PM"}
        </button>
      </form>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function IsrPmResicoForm({ ctx }: { ctx: DespachosShellContext }) {
  const [ingresoMensual, setIngresoMensual] = useState("");
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const ingreso = Number(ingresoMensual);
    if (!Number.isFinite(ingreso)) {
      setError("Ingreso mensual inválido.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPmResico(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        ingresoMensual: ingreso,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PM RESICO.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Ingreso mensual acumulable *
          <input type="number" step="0.01" value={ingresoMensual} onChange={(e) => setIngresoMensual(e.target.value)} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Pagos provisionales ya realizados
          <input type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {loading ? "Calculando…" : "Calcular ISR PM RESICO"}
        </button>
      </form>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function DiotConsulta({ ctx }: { ctx: DespachosShellContext }) {
  const now = new Date();
  const defaultPeriodo = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [periodo, setPeriodo] = useState(defaultPeriodo);
  const [agregado, setAgregado] = useState<DiotAgregado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      setError("Periodo inválido -- usa el formato AAAA-MM.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetchDiot(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, periodo);
      setAgregado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo consultar la DIOT del periodo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <form onSubmit={handleSubmit} style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Periodo (AAAA-MM) *
          <input type="text" value={periodo} onChange={(e) => setPeriodo(e.target.value)} placeholder="2026-03" required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db", width: 140 }} />
        </label>
        <button type="submit" disabled={loading} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          {loading ? "Consultando…" : "Consultar DIOT"}
        </button>
      </form>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
          {error}
        </p>
      )}
      {agregado && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
            <span>
              <strong>Periodo:</strong> {agregado.periodo}
            </span>
            <span>
              <strong>RFC contribuyente:</strong> {agregado.rfcContribuyente ?? "—"}
            </span>
            <span>
              <strong>Total neto:</strong> {formatMoney(agregado.totalMontoNeto)}
            </span>
            <span>
              <strong>Total IVA trasladado:</strong> {formatMoney(agregado.totalIvaTrasladado)}
            </span>
            <span>
              <strong>Total IVA acreditable:</strong> {formatMoney(agregado.totalIvaAcreditable)}
            </span>
          </div>
          {agregado.registros.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: 13 }}>Sin proveedores reportables en este periodo.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>RFC</th>
                    <th style={{ padding: "6px 8px" }}>Proveedor</th>
                    <th style={{ padding: "6px 8px" }}>Tipo</th>
                    <th style={{ padding: "6px 8px" }}>Monto neto</th>
                    <th style={{ padding: "6px 8px" }}>IVA 16%</th>
                    <th style={{ padding: "6px 8px" }}>IVA 0%</th>
                    <th style={{ padding: "6px 8px" }}>IVA exento</th>
                    <th style={{ padding: "6px 8px" }}>CFDIs</th>
                  </tr>
                </thead>
                <tbody>
                  {agregado.registros.map((r) => (
                    <tr key={`${r.rfcTercero}-${r.tipoOperacion}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td style={{ padding: "8px" }}>{r.rfcTercero}</td>
                      <td style={{ padding: "8px" }}>{r.nombre}</td>
                      <td style={{ padding: "8px" }}>{formatDiotTipoOperacion(r.tipoOperacion)}</td>
                      <td style={{ padding: "8px" }}>{formatMoney(r.montoNeto)}</td>
                      <td style={{ padding: "8px" }}>{formatMoney(r.ivaTrasladado16)}</td>
                      <td style={{ padding: "8px" }}>{formatMoney(r.ivaTrasladado0)}</td>
                      <td style={{ padding: "8px" }}>{formatMoney(r.ivaExento)}</td>
                      <td style={{ padding: "8px" }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DeclaracionesPage(ctx: DespachosShellContext) {
  const [tipo, setTipo] = useState<TipoDeclaracion>("pf");
  const puedeUsar = DECLARACIONES_ROLES.has(ctx.role);

  if (!puedeUsar) {
    return (
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Declaraciones fiscales</h1>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Tu rol ({ctx.role}) no tiene acceso a declaraciones fiscales. Solo admin/contador.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Declaraciones fiscales</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>ISR (PF / PM / PM RESICO) y consulta de DIOT ya agregada desde los CFDI ya capturados.</p>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Cálculo de ISR</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {TIPOS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTipo(t.value)}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #111827",
                background: tipo === t.value ? "#111827" : "#fff",
                color: tipo === t.value ? "#fff" : "#111827",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tipo === "pf" && <IsrPfForm ctx={ctx} />}
        {tipo === "pm" && <IsrPmForm ctx={ctx} />}
        {tipo === "pm-resico" && <IsrPmResicoForm ctx={ctx} />}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid #e5e7eb", paddingTop: 20 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>DIOT por periodo</h2>
        <DiotConsulta ctx={ctx} />
      </section>
    </div>
  );
}
