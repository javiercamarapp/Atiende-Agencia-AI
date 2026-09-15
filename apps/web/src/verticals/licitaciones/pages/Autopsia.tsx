// Autopsia del fallo (Fase 16 pieza propia) — cierra la penúltima porción del
// hallazgo ALTA de auditoría "Post-adjudicación completa (contratos,
// documentos, cobranza, inconformidades, autopsia, renovaciones) = 22 rutas
// sin UI": SOLO autopsia del fallo aquí (falloAutopsy.ts, ver
// lib/autopsia-client.ts) -- generar/ver la autopsia de una convocatoria
// perdida (por qué se perdió, causas raíz comparando la propuesta propia
// contra el fallo) y ver las lecciones aprendidas agregadas de TODAS las
// convocatorias pasadas, vinculadas al perfil de empresa. Se llega aquí
// desde ConvocatoriaDetalle.tsx cuando `tender.status === "lost"` -- mismo
// criterio exacto que el enlace a Contrato.tsx cuando es "won".
//
// Deliberadamente FUERA de esta pieza (alcance de otro agente en paralelo,
// ver README de este vertical): el radar de renovaciones -- no se construye
// ni se referencia desde aquí.
//
// Dos bloques independientes:
//  1. Alta de una autopsia más (el servidor nunca limita a una sola por
//     convocatoria -- pueden registrarse varias revisiones a lo largo del
//     tiempo) + historial de las ya registradas para ESTA convocatoria.
//  2. Lecciones aprendidas ORG-WIDE (todas las convocatorias, no solo esta)
//     -- de solo lectura, el servidor las deriva de las autopsias creadas,
//     nunca se editan aquí directamente.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchTender } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { createFalloAutopsy, fetchFalloAutopsies, fetchLessonsLearned, OWN_PROPOSAL_STATUSES } from "../lib/autopsia-client.ts";
import type { CompanyLessonLearnedRecord, CriteriaComparisonItem, FalloAutopsyRecord, OwnProposalStatus } from "../lib/autopsia-client.ts";
import { formatDate, formatMoney, formatOwnProposalStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Mismo set literal que el resto del vertical (WRITE_ROLES de
// `@atiende/domain-licitaciones::roles.ts`) -- cosmético, oculta lo que el
// servidor rechazaría igual (`assertVerticalRole(c, WRITE_ROLES)` en
// `falloAutopsy.ts`).
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const sectionCardStyle = { border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column" as const, gap: 12 };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, fontFamily: "inherit" };
const primaryButtonStyle = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 };
const secondaryButtonStyle = { padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontSize: 12 };

const OWN_PROPOSAL_STATUS_COLORS: Record<OwnProposalStatus, { bg: string; fg: string }> = {
  ganadora: { bg: "#dcfce7", fg: "#166534" },
  desechada: { bg: "#fee2e2", fg: "#991b1b" },
  no_presentada: { bg: "#fef9c3", fg: "#854d0e" },
  desconocido: { bg: "#f3f4f6", fg: "#4b5563" },
};

function StatusBadge({ status }: { status: OwnProposalStatus }) {
  const colors = OWN_PROPOSAL_STATUS_COLORS[status];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg, fontWeight: 600 }}>{formatOwnProposalStatus(status)}</span>;
}

function emptyCriteriaRow(): CriteriaComparisonItem {
  return { criterio: "", propio: "", ganador: "" };
}

export function AutopsiaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const { tenderId } = useParams<{ tenderId: string }>();
  const [tender, setTender] = useState<TenderSummary | null>(null);
  const [autopsies, setAutopsies] = useState<readonly FalloAutopsyRecord[]>([]);
  const [lessons, setLessons] = useState<readonly CompanyLessonLearnedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Formulario de alta.
  const [ownProposalStatus, setOwnProposalStatus] = useState<OwnProposalStatus>("desconocido");
  const [disqualificationReason, setDisqualificationReason] = useState("");
  const [ownScore, setOwnScore] = useState("");
  const [winnerScore, setWinnerScore] = useState("");
  const [ownPrice, setOwnPrice] = useState("");
  const [winnerPrice, setWinnerPrice] = useState("");
  const [winnerName, setWinnerName] = useState("");
  const [criteria, setCriteria] = useState<CriteriaComparisonItem[]>([emptyCriteriaRow()]);
  const [lessonsText, setLessonsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function load(id: string) {
    setLoading(true);
    setLoadError(null);
    try {
      const [tenderData, autopsiesData, lessonsData] = await Promise.all([
        fetchTender(fetch, apiBaseUrl, token, propertyId, id),
        fetchFalloAutopsies(fetch, apiBaseUrl, token, propertyId, id),
        fetchLessonsLearned(fetch, apiBaseUrl, token, propertyId),
      ]);
      setTender(tenderData);
      setAutopsies(autopsiesData);
      setLessons(lessonsData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar la autopsia del fallo.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (tenderId) void load(tenderId);
  }, [apiBaseUrl, token, propertyId, tenderId]);

  function parseOptionalNumber(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  function updateCriteriaRow(index: number, patch: Partial<CriteriaComparisonItem>) {
    setCriteria((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeCriteriaRow(index: number) {
    setCriteria((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenderId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const lessonsList = lessonsText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const criteriaComparison = criteria.filter((row) => row.criterio.trim().length > 0);
      await createFalloAutopsy(fetch, apiBaseUrl, token, propertyId, tenderId, {
        ownProposalStatus,
        disqualificationReason: disqualificationReason.trim().length > 0 ? disqualificationReason.trim() : null,
        ownScore: parseOptionalNumber(ownScore),
        winnerScore: parseOptionalNumber(winnerScore),
        ownPrice: parseOptionalNumber(ownPrice),
        winnerPrice: parseOptionalNumber(winnerPrice),
        winnerName: winnerName.trim().length > 0 ? winnerName.trim() : null,
        criteriaComparison,
        lessons: lessonsList,
      });
      setOwnProposalStatus("desconocido");
      setDisqualificationReason("");
      setOwnScore("");
      setWinnerScore("");
      setOwnPrice("");
      setWinnerPrice("");
      setWinnerName("");
      setCriteria([emptyCriteriaRow()]);
      setLessonsText("");
      await load(tenderId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "No se pudo registrar la autopsia.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!tenderId) return <p role="alert" style={{ color: "#b91c1c" }}>Falta el id de la convocatoria en la URL.</p>;
  if (loading && !tender) return <p style={{ color: "#6b7280" }}>Cargando…</p>;
  if (loadError) return <p role="alert" style={{ color: "#b91c1c" }}>{loadError}</p>;
  if (!tender) return null;

  const canWrite = WRITE_ROLES.has(role);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      <div>
        <Link to={`/licitaciones/${orgSlug}/convocatorias/${tenderId}`} style={{ fontSize: 13, color: "#6b7280", textDecoration: "none" }}>
          ← {tender.title}
        </Link>
        <h1 style={{ fontSize: 20, margin: "4px 0 0" }}>Autopsia del fallo</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Por qué se perdió esta convocatoria y qué lección deja -- las lecciones quedan vinculadas al perfil de la empresa, consultables en cualquier convocatoria futura.
        </p>
      </div>

      {canWrite ? (
        <section style={sectionCardStyle}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Registrar autopsia</h2>
          <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Estatus de nuestra propuesta
              <select value={ownProposalStatus} onChange={(e) => setOwnProposalStatus(e.target.value as OwnProposalStatus)} style={inputStyle}>
                {OWN_PROPOSAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {formatOwnProposalStatus(s)}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Motivo de desechamiento (si aplica)
              <textarea value={disqualificationReason} onChange={(e) => setDisqualificationReason(e.target.value)} rows={2} placeholder="Se deja «no disponible» si no se capturó nada" style={inputStyle} />
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Nuestro puntaje
                <input type="number" min={0} value={ownScore} onChange={(e) => setOwnScore(e.target.value)} placeholder="Sin declarar" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Puntaje del ganador
                <input type="number" min={0} value={winnerScore} onChange={(e) => setWinnerScore(e.target.value)} placeholder="Sin declarar" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Nuestro precio
                <input type="number" min={0} value={ownPrice} onChange={(e) => setOwnPrice(e.target.value)} placeholder="Sin declarar" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Precio del ganador
                <input type="number" min={0} value={winnerPrice} onChange={(e) => setWinnerPrice(e.target.value)} placeholder="Sin declarar" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>
                Nombre del ganador (si el fallo es público)
                <input value={winnerName} onChange={(e) => setWinnerName(e.target.value)} placeholder="Sin declarar" style={inputStyle} />
              </label>
            </div>

            <div>
              <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>Comparación por criterio (opcional)</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {criteria.map((row, index) => (
                  <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
                    <input value={row.criterio} onChange={(e) => updateCriteriaRow(index, { criterio: e.target.value })} placeholder="Criterio" style={inputStyle} />
                    <input value={row.propio} onChange={(e) => updateCriteriaRow(index, { propio: e.target.value })} placeholder="Nuestro resultado" style={inputStyle} />
                    <input value={row.ganador} onChange={(e) => updateCriteriaRow(index, { ganador: e.target.value })} placeholder="Resultado del ganador" style={inputStyle} />
                    <button type="button" onClick={() => removeCriteriaRow(index)} disabled={criteria.length <= 1} style={secondaryButtonStyle}>
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setCriteria((prev) => [...prev, emptyCriteriaRow()])} style={{ ...secondaryButtonStyle, marginTop: 8 }}>
                + Agregar criterio
              </button>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Lecciones aprendidas (una por línea)
              <textarea value={lessonsText} onChange={(e) => setLessonsText(e.target.value)} rows={3} placeholder={"Ej.: pedir la constancia de cumplimiento con 2 semanas de anticipación"} style={inputStyle} />
            </label>

            {submitError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {submitError}
              </p>
            )}
            <button type="submit" disabled={submitting} style={{ ...primaryButtonStyle, alignSelf: "flex-start" }}>
              {submitting ? "Guardando…" : "Guardar autopsia"}
            </button>
          </form>
        </section>
      ) : (
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede registrar una autopsia del fallo.</p>
      )}

      <section style={sectionCardStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Autopsias registradas ({autopsies.length})</h2>
        {autopsies.length === 0 ? (
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no se ha registrado ninguna autopsia para esta convocatoria.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {autopsies
              .slice()
              .reverse()
              .map((a) => (
                <div key={a.id} style={{ border: "1px solid #f3f4f6", borderRadius: 8, padding: 10, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <StatusBadge status={a.ownProposalStatus} />
                    <span style={{ color: "#9ca3af", fontSize: 11 }}>{formatDate(a.createdAt)}</span>
                  </div>
                  <p style={{ margin: "6px 0 0", color: "#374151" }}>
                    <strong>Motivo:</strong> {a.disqualificationReason}
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 6, margin: "6px 0 0" }}>
                    <p style={{ margin: 0, color: "#6b7280" }}>
                      Puntaje: {a.ownScore ?? "s/d"} vs {a.winnerScore ?? "s/d"}
                    </p>
                    <p style={{ margin: 0, color: "#6b7280" }}>
                      Precio: {a.ownPrice !== null ? formatMoney(a.ownPrice, null) : "s/d"} vs {a.winnerPrice !== null ? formatMoney(a.winnerPrice, null) : "s/d"}
                    </p>
                    <p style={{ margin: 0, color: "#6b7280" }}>Ganador: {a.winnerName}</p>
                  </div>
                  {a.criteriaComparison.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: "#374151" }}>Comparación por criterio</p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {a.criteriaComparison.map((c, i) => (
                          <div key={i} style={{ fontSize: 12, color: "#4b5563" }}>
                            <strong>{c.criterio}:</strong> nosotros «{c.propio}» · ganador «{c.ganador}»
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        )}
      </section>

      <section style={sectionCardStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Lecciones aprendidas de la empresa ({lessons.length})</h2>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Agregadas de TODAS las convocatorias de esta organización, no solo esta -- de solo lectura.</p>
        {lessons.length === 0 ? (
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Todavía no hay lecciones registradas.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {lessons
              .slice()
              .reverse()
              .map((l) => (
                <li key={l.id} style={{ fontSize: 13, color: "#374151" }}>
                  {l.lessonText}
                  <span style={{ color: "#9ca3af", fontSize: 11 }}> — {formatDate(l.createdAt)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
