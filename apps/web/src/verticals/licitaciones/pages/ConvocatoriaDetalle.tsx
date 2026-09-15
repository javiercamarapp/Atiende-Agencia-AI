// Ficha de una convocatoria (Fase 7) — trae junto lo que hoy solo existía disperso
// en 3 endpoints sin ninguna pantalla real: el `TenderRecord` (tenders.ts), el
// detalle de matching/elegibilidad con el desglose por criterio (matching.ts) y el
// historial COMPLETO de decisiones go/no-go + el formulario para tomar una nueva
// (goNoGo.ts, Fase 3 §7) -- más un resumen de solo lectura del checklist de
// integridad (checklist.ts, L1 · Flujo 1). El checklist NUNCA se ejecuta desde
// aquí (ver checklist-client.ts::fetchChecklist, solo GET): `POST
// .../checklist/run` exige metadatos reales de archivos/firmas/anexos que se
// capturan en `pages/Cierre.tsx` (Fase 14, enlazada abajo) -- esta ficha solo
// muestra el último resultado ya corrido, sin duplicar ese formulario aquí.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchMatchingDetail } from "../lib/matching-client.ts";
import type { MatchResult } from "../lib/matching-client.ts";
import { createGoNoGoDecision, fetchGoNoGoDecisions } from "../lib/go-no-go-client.ts";
import type { GoNoGoDecision, GoNoGoDecisionValue } from "../lib/go-no-go-client.ts";
import { fetchChecklist } from "../lib/checklist-client.ts";
import type { ChecklistSummary } from "../lib/checklist-client.ts";
import { formatComplianceResult, formatDate, formatDeadline, formatEligibility, formatMoney, formatTenderStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const GO_NO_GO_ROLES = new Set(["owner", "admin", "analyst", "reviewer"]);

const RESULT_COLORS: Record<string, { bg: string; fg: string }> = {
  verde: { bg: "#dcfce7", fg: "#166534" },
  ambar: { bg: "#fef9c3", fg: "#854d0e" },
  rojo: { bg: "#fee2e2", fg: "#991b1b" },
};

function ResultDot({ result }: { result: string }) {
  const colors = RESULT_COLORS[result] ?? { bg: "#f3f4f6", fg: "#4b5563" };
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg }}>{formatComplianceResult(result)}</span>;
}

export function ConvocatoriaDetallePage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [decisions, setDecisions] = useState<readonly GoNoGoDecision[]>([]);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reasonsText, setReasonsText] = useState("");
  const [submitting, setSubmitting] = useState<GoNoGoDecisionValue | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function load(id: string) {
    setLoading(true);
    setError(null);
    try {
      const [tenderData, matchData, decisionsData, checklistData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchMatchingDetail(fetch, apiBaseUrl, token, propertyId, id),
        fetchGoNoGoDecisions(fetch, apiBaseUrl, token, propertyId, id),
        fetchChecklist(fetch, apiBaseUrl, token, propertyId, id),
      ]);
      setTender(tenderData);
      setMatch(matchData);
      setDecisions(decisionsData);
      setChecklist(checklistData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la convocatoria.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  async function handleDecision(decision: GoNoGoDecisionValue) {
    if (!tenderId) return;
    setDecisionError(null);
    const reasons = reasonsText
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    if (reasons.length === 0) {
      setDecisionError("Escribe al menos un motivo (uno por línea).");
      return;
    }
    setSubmitting(decision);
    try {
      await createGoNoGoDecision(fetch, apiBaseUrl, token, propertyId, tenderId, { decision, reasons });
      setReasonsText("");
      await load(tenderId);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "No se pudo registrar la decisión.");
    } finally {
      setSubmitting(null);
    }
  }

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (error) return <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>;
  if (!tender) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 860 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← Convocatorias
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>{tender.title}</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          {tender.contractingBody ?? "Entidad no declarada"} {tender.externalId ? `· ${tender.externalId}` : ""}
        </p>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/requisitos`} style={{ display: "inline-block", marginTop: 8, fontSize: 13, color: "#111827", fontWeight: 600, textDecoration: "none" }}>
          Subir bases y ver requisitos extraídos →
        </Link>
        <br />
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} style={{ display: "inline-block", marginTop: 4, fontSize: 13, color: "#111827", fontWeight: 600, textDecoration: "none" }}>
          Correr checklist, aprobar y ensamblar el paquete de cierre →
        </Link>
      </div>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Fecha límite</p>
          <p style={{ fontSize: 14, margin: "4px 0 0", fontWeight: 600 }}>{formatDeadline(tender.submissionDeadline)}</p>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Presupuesto</p>
          <p style={{ fontSize: 14, margin: "4px 0 0", fontWeight: 600 }}>{formatMoney(tender.budgetAmount, tender.currency)}</p>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, textTransform: "uppercase", color: "#6b7280", margin: 0 }}>Estatus</p>
          <p style={{ fontSize: 14, margin: "4px 0 0", fontWeight: 600 }}>{formatTenderStatus(tender.status)}</p>
        </div>
      </section>

      {match && (
        <section>
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Matching</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 28, fontWeight: 700 }}>{match.score}</span>
            <span style={{ fontSize: 12, color: "#6b7280" }}>de 100 · elegibilidad: {formatEligibility(match.eligibility.status)}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {match.criteria.map((c) => (
              <div key={c.criterion} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderBottom: "1px solid #f3f4f6", paddingBottom: 4 }}>
                <span style={{ color: "#374151" }}>{c.explanation}</span>
                <span style={{ fontWeight: 600 }}>
                  {c.score}/{c.maxScore}
                </span>
              </div>
            ))}
          </div>
          {match.eligibility.criteria.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
              {match.eligibility.criteria.map((c, i) => (
                <p key={i} style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
                  {formatEligibility(c.status)}: {c.explanation}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Go / No-go</h2>
        {decisions.length === 0 && <p style={{ fontSize: 13, color: "#6b7280" }}>Sin decisiones registradas todavía.</p>}
        {decisions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {decisions.map((d) => (
              <div key={d.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong style={{ color: d.decision === "go" ? "#166534" : "#991b1b" }}>{d.decision === "go" ? "GO" : "NO-GO"}</strong>
                  <span style={{ color: "#6b7280" }}>{formatDate(d.decidedAt)}</span>
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {d.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  Score al decidir: {d.matchScore} · elegibilidad: {formatEligibility(d.matchEligibilityStatus)}
                </p>
              </div>
            ))}
          </div>
        )}

        {GO_NO_GO_ROLES.has(role) ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Motivos (uno por línea)
              <textarea value={reasonsText} onChange={(e) => setReasonsText(e.target.value)} rows={3} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontFamily: "inherit" }} />
            </label>
            {decisionError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {decisionError}
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => void handleDecision("go")} disabled={submitting !== null} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #166534", background: "#166534", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                {submitting === "go" ? "Guardando…" : "Marcar Go"}
              </button>
              <button type="button" onClick={() => void handleDecision("no_go")} disabled={submitting !== null} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #991b1b", background: "#fff", color: "#991b1b", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                {submitting === "no_go" ? "Guardando…" : "Marcar No-go"}
              </button>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af" }}>Tu rol ({role}) no puede tomar decisiones go/no-go.</p>
        )}
      </section>

      {checklist && (
        <section>
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>
            Checklist de integridad <ResultDot result={checklist.overallStatus} />
          </h2>
          {checklist.items.length === 0 ? (
            <p style={{ fontSize: 13, color: "#6b7280" }}>Todavía no se ha corrido el checklist de esta convocatoria.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {checklist.items.map((item) => (
                <div key={item.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid #f3f4f6", paddingBottom: 6, fontSize: 13 }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 600 }}>{item.dimension}</p>
                    <p style={{ margin: "2px 0 0", color: "#6b7280" }}>{item.notes}</p>
                  </div>
                  <ResultDot result={item.result} />
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>
            Esta ficha solo muestra el último resultado ya corrido --{" "}
            <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}/cierre`} style={{ color: "#111827", fontWeight: 600 }}>
              corre el checklist de nuevo o continúa el cierre aquí
            </Link>
            .
          </p>
        </section>
      )}
    </div>
  );
}
