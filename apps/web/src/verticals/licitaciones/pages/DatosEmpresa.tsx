// Datos de la empresa (Fase 16) — cierra el hallazgo de auditoría "las
// propuestas técnica y económica nunca pueden salir de PENDIENTE porque no
// existen endpoints para escribir/actualizar los datos de la empresa que
// esas propuestas necesitan". `CompanyDataService`
// (domain-licitaciones/src/company-data.ts) resuelve documentos/tarifas/
// capacidades/experiencia/firmantes contra estas 5 tablas -- sin esta
// pantalla, el único camino para capturarlas era un INSERT manual a la base
// de datos. Org-wide (sin `tenderId`), mismo alcance que PerfilMatching.tsx:
// una organización de licitaciones tiene UNA sola empresa (§2.1 del diseño).
//
// Aprobar/rechazar un dato es corrección de captura (mismo criterio que el
// servidor, `companyData.ts`: WRITE_ROLES, nunca DECISION_ROLES) -- la
// decisión de riesgo real es a qué requisito se mapea ese dato
// (`PropuestaTecnica.tsx::requirement-mappings`, DECISION_ROLES).
import { useEffect, useState } from "react";
import {
  createApprovedRate,
  createCompanyCapability,
  createCompanyDocument,
  createCompanyExperience,
  createCompanySigner,
  fetchApprovedRates,
  fetchCompanyCapabilities,
  fetchCompanyDocuments,
  fetchCompanyExperience,
  fetchCompanySigners,
  updateApprovedRate,
  updateCompanyCapability,
  updateCompanyDocument,
  updateCompanyExperience,
  updateCompanySigner,
} from "../lib/company-data-client.ts";
import type { ApprovedRate, CompanyCapability, CompanyDataApprovalStatus, CompanyDocument, CompanyExperienceItem, CompanySigner } from "../lib/company-data-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const APPROVAL_COLORS: Record<CompanyDataApprovalStatus, { bg: string; fg: string; label: string }> = {
  aprobado: { bg: "#dcfce7", fg: "#166534", label: "Aprobado" },
  pendiente_aprobacion: { bg: "#fef9c3", fg: "#854d0e", label: "Pendiente de aprobación" },
  rechazado: { bg: "#fee2e2", fg: "#991b1b", label: "Rechazado" },
};

function ApprovalBadge({ status }: { status: CompanyDataApprovalStatus }) {
  const c = APPROVAL_COLORS[status];
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, whiteSpace: "nowrap" }}>{c.label}</span>;
}

/** `<input type="date">` no trae hora ni offset -- se completa con medianoche
 * y el offset real del navegador (mismo criterio EXACTO que
 * `Convocatorias.tsx::toIsoWithOffset`, REQ-LIC-001: nunca un huso asumido). */
function dateOnlyToIsoWithOffset(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00`);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dateOnly}T00:00:00${sign}${hh}:${mm}`;
}

function isoToDateOnly(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

const sectionStyle = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column" as const, gap: 10 };
const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottom: "1px solid #f3f4f6", paddingBottom: 8, fontSize: 13 };
const inputStyle = { padding: 7, borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 };
const smallButton = (variant: "aprobar" | "rechazar") => ({
  padding: "4px 10px",
  borderRadius: 6,
  border: variant === "aprobar" ? "1px solid #166534" : "1px solid #991b1b",
  background: "#fff",
  color: variant === "aprobar" ? "#166534" : "#991b1b",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
});
const addButtonStyle = { padding: "8px 14px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, alignSelf: "flex-start" };

export function DatosEmpresaPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const canWrite = WRITE_ROLES.has(role);

  const [documents, setDocuments] = useState<readonly CompanyDocument[]>([]);
  const [rates, setRates] = useState<readonly ApprovedRate[]>([]);
  const [capabilities, setCapabilities] = useState<readonly CompanyCapability[]>([]);
  const [experience, setExperience] = useState<readonly CompanyExperienceItem[]>([]);
  const [signers, setSigners] = useState<readonly CompanySigner[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [docForm, setDocForm] = useState({ type: "", label: "", expiresAt: "" });
  const [rateForm, setRateForm] = useState({ concept: "", unitPrice: "" });
  const [capabilityForm, setCapabilityForm] = useState({ name: "", description: "" });
  const [experienceForm, setExperienceForm] = useState({ description: "", evidenceDocId: "" });
  const [signerForm, setSignerForm] = useState({ name: "", role: "" });
  const [submittingSection, setSubmittingSection] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [d, r, c, e, s] = await Promise.all([
        fetchCompanyDocuments(fetch, apiBaseUrl, token, propertyId),
        fetchApprovedRates(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyCapabilities(fetch, apiBaseUrl, token, propertyId),
        fetchCompanyExperience(fetch, apiBaseUrl, token, propertyId),
        fetchCompanySigners(fetch, apiBaseUrl, token, propertyId),
      ]);
      setDocuments(d);
      setRates(r);
      setCapabilities(c);
      setExperience(e);
      setSigners(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los datos de la empresa.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (Convocatorias.tsx) -- este
    // proyecto no tiene eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  async function withAction(section: string, action: () => Promise<void>) {
    setActionError(null);
    setSubmittingSection(section);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo completar la operación.");
    } finally {
      setSubmittingSection(null);
    }
  }

  if (loading && documents.length === 0 && rates.length === 0) return <p style={{ color: "#6b7280" }}>Cargando…</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Datos de la empresa</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Documentos, tarifas aprobadas, capacidades, experiencia y firmantes autorizados. Las propuestas técnica y económica solo usan lo que aquí está en estado "Aprobado" y vigente -- un dato ausente o sin aprobar queda "PENDIENTE" en la propuesta, nunca inventado.
        </p>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {actionError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {actionError}
        </p>
      )}
      {!canWrite && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede capturar ni aprobar datos de empresa. Se muestran de solo lectura.</p>}

      {/* ---- Documentos ---- */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Documentos</h2>
        {documents.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin documentos capturados todavía.</p>}
        {documents.map((d) => (
          <div key={d.id} style={rowStyle}>
            <div>
              <strong>{d.type}</strong> — {d.label}
              {d.expiresAt && <span style={{ color: "#6b7280" }}> · vence {isoToDateOnly(d.expiresAt)}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ApprovalBadge status={d.approvalStatus} />
              {canWrite && d.approvalStatus !== "aprobado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("aprobar")} onClick={() => void withAction(`doc-${d.id}`, () => updateCompanyDocument(fetch, apiBaseUrl, token, propertyId, d.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                  Aprobar
                </button>
              )}
              {canWrite && d.approvalStatus !== "rechazado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("rechazar")} onClick={() => void withAction(`doc-${d.id}`, () => updateCompanyDocument(fetch, apiBaseUrl, token, propertyId, d.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                  Rechazar
                </button>
              )}
            </div>
          </div>
        ))}
        {canWrite && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void withAction("doc-new", async () => {
                await createCompanyDocument(fetch, apiBaseUrl, token, propertyId, { type: docForm.type, label: docForm.label, expiresAt: docForm.expiresAt ? dateOnlyToIsoWithOffset(docForm.expiresAt) : null });
                setDocForm({ type: "", label: "", expiresAt: "" });
              });
            }}
          >
            <input required placeholder="Tipo (p. ej. opinion_cumplimiento)" value={docForm.type} onChange={(e) => setDocForm({ ...docForm, type: e.target.value })} style={{ ...inputStyle, minWidth: 200 }} />
            <input required placeholder="Etiqueta" value={docForm.label} onChange={(e) => setDocForm({ ...docForm, label: e.target.value })} style={{ ...inputStyle, minWidth: 200 }} />
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#6b7280" }}>
              Vigencia (opcional)
              <input type="date" value={docForm.expiresAt} onChange={(e) => setDocForm({ ...docForm, expiresAt: e.target.value })} style={inputStyle} />
            </label>
            <button type="submit" disabled={submittingSection !== null} style={addButtonStyle}>
              {submittingSection === "doc-new" ? "Guardando…" : "Agregar documento"}
            </button>
          </form>
        )}
      </section>

      {/* ---- Tarifas aprobadas ---- */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tarifas aprobadas</h2>
        {rates.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin tarifas capturadas todavía -- la propuesta económica no puede generar ningún total sin al menos una.</p>}
        {rates.map((r) => (
          <div key={r.id} style={rowStyle}>
            <div>
              <strong>{r.concept}</strong> — ${r.unitPrice} {r.currency}
              <span style={{ color: "#6b7280" }}>
                {" "}
                · vigente desde {isoToDateOnly(r.validFrom)}
                {r.validUntil ? ` hasta ${isoToDateOnly(r.validUntil)}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ApprovalBadge status={r.approvalStatus} />
              {canWrite && r.approvalStatus !== "aprobado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("aprobar")} onClick={() => void withAction(`rate-${r.id}`, () => updateApprovedRate(fetch, apiBaseUrl, token, propertyId, r.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                  Aprobar
                </button>
              )}
              {canWrite && r.approvalStatus !== "rechazado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("rechazar")} onClick={() => void withAction(`rate-${r.id}`, () => updateApprovedRate(fetch, apiBaseUrl, token, propertyId, r.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                  Rechazar
                </button>
              )}
            </div>
          </div>
        ))}
        {canWrite && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void withAction("rate-new", async () => {
                await createApprovedRate(fetch, apiBaseUrl, token, propertyId, { concept: rateForm.concept, unitPrice: rateForm.unitPrice });
                setRateForm({ concept: "", unitPrice: "" });
              });
            }}
          >
            <input required placeholder="Concepto (p. ej. consultoria_hora)" value={rateForm.concept} onChange={(e) => setRateForm({ ...rateForm, concept: e.target.value })} style={{ ...inputStyle, minWidth: 220 }} />
            <input required placeholder="Precio unitario (p. ej. 500.00)" value={rateForm.unitPrice} onChange={(e) => setRateForm({ ...rateForm, unitPrice: e.target.value })} style={{ ...inputStyle, minWidth: 160 }} />
            <button type="submit" disabled={submittingSection !== null} style={addButtonStyle}>
              {submittingSection === "rate-new" ? "Guardando…" : "Agregar tarifa"}
            </button>
          </form>
        )}
      </section>

      {/* ---- Capacidades ---- */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Capacidades</h2>
        {capabilities.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin capacidades capturadas todavía.</p>}
        {capabilities.map((cap) => (
          <div key={cap.id} style={rowStyle}>
            <div>
              <strong>{cap.name}</strong> — {cap.description}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ApprovalBadge status={cap.approvalStatus} />
              {canWrite && cap.approvalStatus !== "aprobado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("aprobar")} onClick={() => void withAction(`cap-${cap.id}`, () => updateCompanyCapability(fetch, apiBaseUrl, token, propertyId, cap.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                  Aprobar
                </button>
              )}
              {canWrite && cap.approvalStatus !== "rechazado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("rechazar")} onClick={() => void withAction(`cap-${cap.id}`, () => updateCompanyCapability(fetch, apiBaseUrl, token, propertyId, cap.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                  Rechazar
                </button>
              )}
            </div>
          </div>
        ))}
        {canWrite && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void withAction("cap-new", async () => {
                await createCompanyCapability(fetch, apiBaseUrl, token, propertyId, { name: capabilityForm.name, description: capabilityForm.description });
                setCapabilityForm({ name: "", description: "" });
              });
            }}
          >
            <input required placeholder="Nombre" value={capabilityForm.name} onChange={(e) => setCapabilityForm({ ...capabilityForm, name: e.target.value })} style={{ ...inputStyle, minWidth: 180 }} />
            <input required placeholder="Descripción" value={capabilityForm.description} onChange={(e) => setCapabilityForm({ ...capabilityForm, description: e.target.value })} style={{ ...inputStyle, minWidth: 260 }} />
            <button type="submit" disabled={submittingSection !== null} style={addButtonStyle}>
              {submittingSection === "cap-new" ? "Guardando…" : "Agregar capacidad"}
            </button>
          </form>
        )}
      </section>

      {/* ---- Experiencia ---- */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Experiencia</h2>
        {experience.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin experiencia capturada todavía.</p>}
        {experience.map((exp) => (
          <div key={exp.id} style={rowStyle}>
            <div>
              {exp.description} <span style={{ color: "#9ca3af" }}>· evidencia: {exp.evidenceDocId}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ApprovalBadge status={exp.approvalStatus} />
              {canWrite && exp.approvalStatus !== "aprobado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("aprobar")} onClick={() => void withAction(`exp-${exp.id}`, () => updateCompanyExperience(fetch, apiBaseUrl, token, propertyId, exp.id, { approvalStatus: "aprobado" }).then(() => undefined))}>
                  Aprobar
                </button>
              )}
              {canWrite && exp.approvalStatus !== "rechazado" && (
                <button type="button" disabled={submittingSection !== null} style={smallButton("rechazar")} onClick={() => void withAction(`exp-${exp.id}`, () => updateCompanyExperience(fetch, apiBaseUrl, token, propertyId, exp.id, { approvalStatus: "rechazado" }).then(() => undefined))}>
                  Rechazar
                </button>
              )}
            </div>
          </div>
        ))}
        {canWrite && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void withAction("exp-new", async () => {
                await createCompanyExperience(fetch, apiBaseUrl, token, propertyId, { description: experienceForm.description, evidenceDocId: experienceForm.evidenceDocId });
                setExperienceForm({ description: "", evidenceDocId: "" });
              });
            }}
          >
            <input required placeholder="Descripción del proyecto/experiencia" value={experienceForm.description} onChange={(e) => setExperienceForm({ ...experienceForm, description: e.target.value })} style={{ ...inputStyle, minWidth: 260 }} />
            <input required placeholder="ID del documento de evidencia" value={experienceForm.evidenceDocId} onChange={(e) => setExperienceForm({ ...experienceForm, evidenceDocId: e.target.value })} style={{ ...inputStyle, minWidth: 220 }} />
            <button type="submit" disabled={submittingSection !== null} style={addButtonStyle}>
              {submittingSection === "exp-new" ? "Guardando…" : "Agregar experiencia"}
            </button>
          </form>
        )}
        <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>El ID de evidencia debe corresponder a un documento ya capturado arriba -- sin uno real, la experiencia queda bloqueada como "evidencia_no_verificable" al generar la propuesta.</p>
      </section>

      {/* ---- Firmantes autorizados ---- */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Firmantes autorizados</h2>
        {signers.length === 0 && <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>Sin firmantes capturados todavía.</p>}
        {signers.map((s) => (
          <div key={s.id} style={rowStyle}>
            <div>
              <strong>{s.name}</strong> — {s.role}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: s.authorized ? "#dcfce7" : "#fee2e2", color: s.authorized ? "#166534" : "#991b1b" }}>{s.authorized ? "Autorizado" : "No autorizado"}</span>
              {canWrite && (
                <button
                  type="button"
                  disabled={submittingSection !== null}
                  style={smallButton(s.authorized ? "rechazar" : "aprobar")}
                  onClick={() => void withAction(`signer-${s.id}`, () => updateCompanySigner(fetch, apiBaseUrl, token, propertyId, s.id, { authorized: !s.authorized }).then(() => undefined))}
                >
                  {s.authorized ? "Revocar" : "Autorizar"}
                </button>
              )}
            </div>
          </div>
        ))}
        {canWrite && (
          <form
            style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              void withAction("signer-new", async () => {
                await createCompanySigner(fetch, apiBaseUrl, token, propertyId, { name: signerForm.name, role: signerForm.role, authorized: true });
                setSignerForm({ name: "", role: "" });
              });
            }}
          >
            <input required placeholder="Nombre" value={signerForm.name} onChange={(e) => setSignerForm({ ...signerForm, name: e.target.value })} style={{ ...inputStyle, minWidth: 200 }} />
            <input required placeholder="Rol (p. ej. representante_legal)" value={signerForm.role} onChange={(e) => setSignerForm({ ...signerForm, role: e.target.value })} style={{ ...inputStyle, minWidth: 220 }} />
            <button type="submit" disabled={submittingSection !== null} style={addButtonStyle}>
              {submittingSection === "signer-new" ? "Guardando…" : "Agregar firmante (autorizado)"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
