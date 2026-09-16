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
//
// Fase "sistema de diseño real" (contenido) — el formulario inline-styled pasa
// a `Card` + `Label` + `Input`/`Button` de @atiende/ui (los `<textarea>` siguen
// nativos, solo restilados con tokens) y los estados de carga/error a
// `EstadoCargando`/`EstadoError`. Cero cambios de lógica ni de red.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label } from "@atiende/ui";
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

/** `<textarea>` sigue siendo nativo (el sistema no exporta un primitivo
 * propio): solo se restila con los tokens reales, mismo anillo de foco que
 * `Input`. */
const CAMPO_NATIVO =
  "flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

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
    <div className="flex max-w-[680px] flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Perfil de matching</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Estos 7 criterios alimentan el score y la elegibilidad de la columna "Score" en Convocatorias. Sin configurar al menos uno, la elegibilidad de todas las convocatorias es siempre "No evaluable".
        </p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !profile && <EstadoCargando etiqueta="Cargando perfil de matching…" />}

      {profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Criterios de matching</CardTitle>
            {profile.updatedAt && (
              <CardDescription>
                Última actualización: {formatDate(profile.updatedAt)}
                {profile.updatedBy ? ` · por ${profile.updatedBy}` : ""}
              </CardDescription>
            )}
            {!canWrite && (
              <CardDescription>Tu rol ({role}) no puede editar el perfil de matching. Estos valores se muestran de solo lectura.</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-keywords">Palabras clave (una por línea)</Label>
                <textarea
                  id="perfil-keywords"
                  disabled={!canWrite}
                  value={form.keywords}
                  onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                  rows={4}
                  placeholder="mantenimiento de flotilla vehicular&#10;servicio de limpieza"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-excluidas">Palabras clave excluyentes (una por línea)</Label>
                <textarea
                  id="perfil-excluidas"
                  disabled={!canWrite}
                  value={form.excludedKeywords}
                  onChange={(e) => setForm({ ...form, excludedKeywords: e.target.value })}
                  rows={3}
                  placeholder="obra pública"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-codigos">Códigos clasificadores / CPV (uno por línea)</Label>
                <textarea
                  id="perfil-codigos"
                  disabled={!canWrite}
                  value={form.classifierCodes}
                  onChange={(e) => setForm({ ...form, classifierCodes: e.target.value })}
                  rows={3}
                  placeholder="50111100"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-entidades">Entidades convocantes de interés (una por línea)</Label>
                <textarea
                  id="perfil-entidades"
                  disabled={!canWrite}
                  value={form.entities}
                  onChange={(e) => setForm({ ...form, entities: e.target.value })}
                  rows={3}
                  placeholder="Secretaría de Movilidad"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="perfil-estados">Estados de interés (uno por línea)</Label>
                <textarea
                  id="perfil-estados"
                  disabled={!canWrite}
                  value={form.states}
                  onChange={(e) => setForm({ ...form, states: e.target.value })}
                  rows={3}
                  placeholder="Jalisco&#10;Ciudad de México"
                  className={CAMPO_NATIVO}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="perfil-budget-min">Presupuesto mínimo (MXN)</Label>
                  <Input id="perfil-budget-min" disabled={!canWrite} type="number" min="0" value={form.budgetMin} onChange={(e) => setForm({ ...form, budgetMin: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="perfil-budget-max">Presupuesto máximo (MXN)</Label>
                  <Input id="perfil-budget-max" disabled={!canWrite} type="number" min="0" value={form.budgetMax} onChange={(e) => setForm({ ...form, budgetMax: e.target.value })} />
                </div>
              </div>

              {saveError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {saveError}
                </p>
              )}

              {savedAt !== null && !saveError && (
                <p role="status" className="text-[13px] font-medium text-green-600 dark:text-green-500">
                  Perfil guardado.
                </p>
              )}

              {canWrite && (
                <Button type="submit" size="sm" className="self-start" disabled={saving}>
                  {saving ? "Guardando…" : "Guardar perfil de matching"}
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
