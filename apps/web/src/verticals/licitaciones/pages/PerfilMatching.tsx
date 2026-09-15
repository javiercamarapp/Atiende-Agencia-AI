// Perfil de matching (Fase 8 — cierra el hallazgo ALTA de auditoría: "Perfil
// de matching sin UI: la columna Score/elegibilidad del panel es inservible
// hasta hacer un PUT por curl"). GET/PUT .../matching-profile ya existían
// (Fase 3 pieza 2, matchingProfile.ts) pero sin ninguna pantalla -- son la
// ÚNICA fuente de keywords/estados/presupuesto que alimenta
// MatchingEngine.score (matching-engine.ts): sin perfil configurado, la
// columna Score de Convocatorias.tsx SIEMPRE muestra "no_evaluable". Mismo
// criterio de gating que el resto del vertical (WRITE_ROLES, Convocatorias.tsx)
// -- el enforcement real es SIEMPRE server-side (matchingProfile.ts ya exige
// WRITE_ROLES en el PUT), este `role` solo oculta el formulario para quien de
// todas formas recibiría 403.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { fetchMatchingProfile, saveMatchingProfile } from "../lib/matching-profile-client.ts";
import type { MatchingProfile } from "../lib/matching-profile-client.ts";
import { formatDate } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

interface FormState {
  keywords: string;
  excludedKeywords: string;
  classifierCodes: string;
  entities: string;
  states: string;
  budgetMin: string;
  budgetMax: string;
}

const EMPTY_FORM: FormState = { keywords: "", excludedKeywords: "", classifierCodes: "", entities: "", states: "", budgetMin: "", budgetMax: "" };

/** El servidor solo entiende arreglos de strings no vacíos (parseStringArray
 * en matchingProfile.ts) -- una línea en blanco nunca se manda como "". */
function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function arrayToLines(value: readonly string[]): string {
  return value.join("\n");
}

function profileToForm(profile: MatchingProfile): FormState {
  return {
    keywords: arrayToLines(profile.keywords),
    excludedKeywords: arrayToLines(profile.excludedKeywords),
    classifierCodes: arrayToLines(profile.classifierCodes),
    entities: arrayToLines(profile.entities),
    states: arrayToLines(profile.states),
    budgetMin: profile.budgetMin === null ? "" : String(profile.budgetMin),
    budgetMax: profile.budgetMax === null ? "" : String(profile.budgetMax),
  };
}

const fieldLabelStyle = { display: "flex", flexDirection: "column" as const, gap: 4, fontSize: 13 };
const textareaStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db", fontFamily: "inherit", resize: "vertical" as const };
const inputStyle = { padding: 8, borderRadius: 6, border: "1px solid #d1d5db" };

export function PerfilMatchingPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const [profile, setProfile] = useState<MatchingProfile | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const canWrite = WRITE_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMatchingProfile(fetch, apiBaseUrl, token, propertyId);
      setProfile(data);
      setForm(profileToForm(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el perfil de matching.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (Convocatorias.tsx) -- este
    // proyecto no tiene eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError(null);
    setSavedAt(null);

    const budgetMin = form.budgetMin.trim() ? Number(form.budgetMin) : null;
    const budgetMax = form.budgetMax.trim() ? Number(form.budgetMax) : null;
    if (budgetMin !== null && Number.isNaN(budgetMin)) {
      setSaveError("Presupuesto mínimo: se esperaba un número.");
      return;
    }
    if (budgetMax !== null && Number.isNaN(budgetMax)) {
      setSaveError("Presupuesto máximo: se esperaba un número.");
      return;
    }
    if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
      setSaveError("El presupuesto mínimo no puede ser mayor que el máximo.");
      return;
    }

    setSaving(true);
    try {
      const saved = await saveMatchingProfile(fetch, apiBaseUrl, token, propertyId, {
        keywords: linesToArray(form.keywords),
        excludedKeywords: linesToArray(form.excludedKeywords),
        classifierCodes: linesToArray(form.classifierCodes),
        entities: linesToArray(form.entities),
        states: linesToArray(form.states),
        budgetMin,
        budgetMax,
      });
      setProfile(saved);
      setForm(profileToForm(saved));
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "No se pudo guardar el perfil de matching.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Perfil de matching</h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Estos 7 criterios alimentan el score y la elegibilidad de la columna "Score" en Convocatorias. Sin configurar al menos uno, la elegibilidad de todas las convocatorias es siempre "No evaluable".
        </p>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {loading && !profile && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {profile && (
        <>
          {profile.updatedAt && (
            <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>
              Última actualización: {formatDate(profile.updatedAt)}
              {profile.updatedBy ? ` · por ${profile.updatedBy}` : ""}
            </p>
          )}

          {!canWrite && <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>Tu rol ({role}) no puede editar el perfil de matching. Estos valores se muestran de solo lectura.</p>}

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={fieldLabelStyle}>
              Palabras clave (una por línea)
              <textarea disabled={!canWrite} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} rows={4} placeholder="mantenimiento de flotilla vehicular&#10;servicio de limpieza" style={textareaStyle} />
            </label>

            <label style={fieldLabelStyle}>
              Palabras clave excluyentes (una por línea)
              <textarea disabled={!canWrite} value={form.excludedKeywords} onChange={(e) => setForm({ ...form, excludedKeywords: e.target.value })} rows={3} placeholder="obra pública" style={textareaStyle} />
            </label>

            <label style={fieldLabelStyle}>
              Códigos clasificadores / CPV (uno por línea)
              <textarea disabled={!canWrite} value={form.classifierCodes} onChange={(e) => setForm({ ...form, classifierCodes: e.target.value })} rows={3} placeholder="50111100" style={textareaStyle} />
            </label>

            <label style={fieldLabelStyle}>
              Entidades convocantes de interés (una por línea)
              <textarea disabled={!canWrite} value={form.entities} onChange={(e) => setForm({ ...form, entities: e.target.value })} rows={3} placeholder="Secretaría de Movilidad" style={textareaStyle} />
            </label>

            <label style={fieldLabelStyle}>
              Estados de interés (uno por línea)
              <textarea disabled={!canWrite} value={form.states} onChange={(e) => setForm({ ...form, states: e.target.value })} rows={3} placeholder="Jalisco&#10;Ciudad de México" style={textareaStyle} />
            </label>

            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ ...fieldLabelStyle, flex: 1 }}>
                Presupuesto mínimo (MXN)
                <input disabled={!canWrite} type="number" min="0" value={form.budgetMin} onChange={(e) => setForm({ ...form, budgetMin: e.target.value })} style={inputStyle} />
              </label>
              <label style={{ ...fieldLabelStyle, flex: 1 }}>
                Presupuesto máximo (MXN)
                <input disabled={!canWrite} type="number" min="0" value={form.budgetMax} onChange={(e) => setForm({ ...form, budgetMax: e.target.value })} style={inputStyle} />
              </label>
            </div>

            {saveError && (
              <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
                {saveError}
              </p>
            )}

            {savedAt !== null && !saveError && (
              <p role="status" style={{ color: "#166534", margin: 0, fontSize: 13 }}>
                Perfil guardado.
              </p>
            )}

            {canWrite && (
              <button type="submit" disabled={saving} style={{ padding: 10, borderRadius: 8, border: "none", background: "#111827", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600, alignSelf: "flex-start" }}>
                {saving ? "Guardando…" : "Guardar perfil de matching"}
              </button>
            )}
          </form>
        </>
      )}
    </div>
  );
}
