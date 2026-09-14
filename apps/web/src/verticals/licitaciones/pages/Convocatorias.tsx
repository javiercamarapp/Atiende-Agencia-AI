// Lista de convocatorias del panel de licitaciones (Fase 7) — combina el
// `TenderRecord` real (título/fecha límite/entidad, GET .../tenders, Fase 7
// tenders.ts) con el score de matching en vivo (GET .../tenders/matching, Fase 3
// pieza 2) para que el equipo vea, de un vistazo, QUÉ convocatorias existen y
// CUÁLES conviene perseguir -- sin esta pantalla, matching/go-no-go solo eran
// alcanzables vía curl (ver el gap que originó esta fase). También ofrece el alta
// manual (POST .../tenders, Fase 3 pieza 1) -- el único camino de escritura
// productivo mientras la ingesta automática siga bloqueada (B-02, ver
// docs/BLOQUEOS.md y el README de apps/api/.../licitaciones).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { createOrUpdateTender, fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchMatchingList } from "../lib/matching-client.ts";
import type { MatchResult } from "../lib/matching-client.ts";
import { formatDeadline, formatEligibility, formatTenderStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const ELIGIBILITY_COLORS: Record<string, { bg: string; fg: string }> = {
  cumple: { bg: "#dcfce7", fg: "#166534" },
  no_cumple: { bg: "#fee2e2", fg: "#991b1b" },
  no_evaluable: { bg: "#f3f4f6", fg: "#4b5563" },
};

function ScoreBadge({ match }: { match: MatchResult | undefined }) {
  if (!match) return <span style={{ fontSize: 12, color: "#9ca3af" }}>Sin score</span>;
  const colors = ELIGIBILITY_COLORS[match.eligibility.status] ?? ELIGIBILITY_COLORS.no_evaluable!;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <strong style={{ fontSize: 14 }}>{match.score}</strong>
      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: colors.bg, color: colors.fg }}>{formatEligibility(match.eligibility.status)}</span>
    </span>
  );
}

interface NewTenderFormState {
  title: string;
  externalId: string;
  contractingBody: string;
  submissionDeadline: string; // datetime-local, se convierte a ISO con offset local al enviar
  budgetAmount: string;
}

const EMPTY_FORM: NewTenderFormState = { title: "", externalId: "", contractingBody: "", submissionDeadline: "", budgetAmount: "" };

/** `<input type="datetime-local">` no trae offset -- se lo agregamos con el offset
 * real del navegador (nunca asumimos UTC ni un huso fijo, REQ-LIC-001 exige
 * offset explícito en todo el vertical). */
function toIsoWithOffset(localValue: string): string {
  const d = new Date(localValue);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
}

export function ConvocatoriasPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const [tenders, setTenders] = useState<readonly TenderSummary[] | null>(null);
  const [matching, setMatching] = useState<readonly MatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewTenderFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [tenderList, matchList] = await Promise.all([fetchTenders(fetch, apiBaseUrl, token, propertyId), fetchMatchingList(fetch, apiBaseUrl, token, propertyId)]);
      setTenders(tenderList);
      setMatching(matchList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las convocatorias.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (Agenda.tsx de citas) -- este
    // proyecto no tiene eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  const matchByTenderId = new Map(matching.map((m) => [m.tenderId, m]));
  const sorted = tenders ? [...tenders].sort((a, b) => (matchByTenderId.get(b.id)?.score ?? -1) - (matchByTenderId.get(a.id)?.score ?? -1)) : [];

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!form.title.trim()) {
      setFormError("El título es obligatorio.");
      return;
    }
    setSubmitting(true);
    try {
      await createOrUpdateTender(fetch, apiBaseUrl, token, propertyId, {
        title: form.title.trim(),
        externalId: form.externalId.trim() || null,
        contractingBody: form.contractingBody.trim() || null,
        submissionDeadline: form.submissionDeadline ? toIsoWithOffset(form.submissionDeadline) : null,
        budgetAmount: form.budgetAmount ? Number(form.budgetAmount) : null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo dar de alta la convocatoria.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Convocatorias</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>Alta manual mientras la ingesta automática siga bloqueada (ver README).</p>
        </div>
        {WRITE_ROLES.has(role) && (
          <button onClick={() => setShowForm((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", cursor: "pointer", fontSize: 13 }}>
            {showForm ? "Cancelar" : "+ Nueva convocatoria"}
          </button>
        )}
      </header>

      {showForm && (
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, maxWidth: 480 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Título *
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Folio / número de referencia (externalId)
            <input value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} placeholder="p. ej. LA-01/2026" style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Entidad convocante
            <input value={form.contractingBody} onChange={(e) => setForm({ ...form, contractingBody: e.target.value })} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Fecha límite de presentación
            <input type="datetime-local" value={form.submissionDeadline} onChange={(e) => setForm({ ...form, submissionDeadline: e.target.value })} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Presupuesto estimado (MXN)
            <input type="number" min="0" value={form.budgetAmount} onChange={(e) => setForm({ ...form, budgetAmount: e.target.value })} style={{ padding: 8, borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={submitting} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {submitting ? "Guardando…" : "Guardar convocatoria"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {loading && !tenders && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {tenders && tenders.length === 0 && !loading && <p style={{ color: "#6b7280" }}>Todavía no hay ninguna convocatoria dada de alta.</p>}

      {sorted.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", color: "#6b7280" }}>
                <th style={{ padding: "6px 8px" }}>Título</th>
                <th style={{ padding: "6px 8px" }}>Entidad</th>
                <th style={{ padding: "6px 8px" }}>Fecha límite</th>
                <th style={{ padding: "6px 8px" }}>Estatus</th>
                <th style={{ padding: "6px 8px" }}>Score</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px" }}>
                    <Link to={`/licitaciones/${orgSlug}/convocatorias/${t.id}`} style={{ color: "#111827", fontWeight: 600, textDecoration: "none" }}>
                      {t.title}
                    </Link>
                    {t.externalId && <div style={{ fontSize: 11, color: "#9ca3af" }}>{t.externalId}</div>}
                  </td>
                  <td style={{ padding: "8px", color: "#374151" }}>{t.contractingBody ?? "—"}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatDeadline(t.submissionDeadline)}</td>
                  <td style={{ padding: "8px", color: "#374151" }}>{formatTenderStatus(t.status)}</td>
                  <td style={{ padding: "8px" }}>
                    <ScoreBadge match={matchByTenderId.get(t.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
