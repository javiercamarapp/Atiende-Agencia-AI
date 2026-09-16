// Lista de convocatorias del panel de licitaciones (Fase 7) — combina el
// `TenderRecord` real (título/fecha límite/entidad, GET .../tenders, Fase 7
// tenders.ts) con el score de matching en vivo (GET .../tenders/matching, Fase 3
// pieza 2) para que el equipo vea, de un vistazo, QUÉ convocatorias existen y
// CUÁLES conviene perseguir -- sin esta pantalla, matching/go-no-go solo eran
// alcanzables vía curl (ver el gap que originó esta fase). También ofrece el alta
// manual (POST .../tenders, Fase 3 pieza 1) -- el único camino de escritura
// productivo mientras la ingesta automática siga bloqueada (B-02, ver
// docs/BLOQUEOS.md y el README de apps/api/.../licitaciones).
//
// Fase "sistema de diseño real" (contenido) — la tabla inline-styled pasa a
// `Table` de @atiende/ui, el pill de elegibilidad a `Badge`, el alta manual al
// shell real `ModalFormularioLateral` (mismo estado `showForm`, misma llamada a
// createOrUpdateTender) y el botón ad-hoc a `Button`. Cero cambios de lógica.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { Badge, Button, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import { createOrUpdateTender, fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import { fetchMatchingList } from "../lib/matching-client.ts";
import type { MatchResult } from "../lib/matching-client.ts";
import { formatDeadline, formatEligibility, formatTenderStatus } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

/** Mismo mapeo semántico que antes (verde/rojo/gris), ahora sobre las variantes
 * reales de `Badge` en vez de hex hardcodeados. */
const ELIGIBILITY_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  cumple: "default",
  no_cumple: "destructive",
  no_evaluable: "secondary",
};

function ScoreBadge({ match }: { match: MatchResult | undefined }) {
  if (!match) return <span className="text-xs text-muted-foreground">Sin score</span>;
  const variant = ELIGIBILITY_VARIANTS[match.eligibility.status] ?? "secondary";
  return (
    <span className="inline-flex items-center gap-2">
      <strong className="text-sm tabular-nums text-foreground">{match.score}</strong>
      <Badge variant={variant}>{formatEligibility(match.eligibility.status)}</Badge>
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
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Convocatorias</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Alta manual mientras la ingesta automática siga bloqueada (ver README).</p>
        </div>
        {WRITE_ROLES.has(role) && (
          <Button type="button" size="sm" onClick={() => setShowForm(true)}>
            <Plus />
            Nueva convocatoria
          </Button>
        )}
      </header>

      <ModalFormularioLateral
        open={showForm}
        onOpenChange={setShowForm}
        titulo="Nueva convocatoria"
        subtitulo="Alta manual mientras la ingesta automática siga bloqueada."
        anchoClase="max-w-3xl"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setShowForm(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" form="form-nueva-convocatoria" className="rounded-full px-6" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar convocatoria"}
            </Button>
          </>
        }
      >
        <form id="form-nueva-convocatoria" onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nueva-titulo">Título *</Label>
            <Input id="nueva-titulo" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nueva-external-id">Folio / número de referencia (externalId)</Label>
            <Input id="nueva-external-id" value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} placeholder="p. ej. LA-01/2026" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nueva-entidad">Entidad convocante</Label>
            <Input id="nueva-entidad" value={form.contractingBody} onChange={(e) => setForm({ ...form, contractingBody: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nueva-deadline">Fecha límite de presentación</Label>
            <Input id="nueva-deadline" type="datetime-local" value={form.submissionDeadline} onChange={(e) => setForm({ ...form, submissionDeadline: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nueva-presupuesto">Presupuesto estimado (MXN)</Label>
            <Input id="nueva-presupuesto" type="number" min="0" value={form.budgetAmount} onChange={(e) => setForm({ ...form, budgetAmount: e.target.value })} />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !tenders && <EstadoCargando etiqueta="Cargando convocatorias…" />}

      {tenders && tenders.length === 0 && !loading && (
        <EstadoVacio mensaje="Todavía no hay ninguna convocatoria dada de alta." />
      )}

      {sorted.length > 0 && (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Entidad</TableHead>
                <TableHead>Fecha límite</TableHead>
                <TableHead>Estatus</TableHead>
                <TableHead>Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="p-3">
                    <Link to={`/licitaciones/${orgSlug}/convocatorias/${t.id}`} className="font-semibold text-foreground no-underline hover:underline">
                      {t.title}
                    </Link>
                    {t.externalId && <div className="text-[11px] text-muted-foreground">{t.externalId}</div>}
                  </TableCell>
                  <TableCell className="p-3 text-muted-foreground">{t.contractingBody ?? "—"}</TableCell>
                  <TableCell className="p-3 text-muted-foreground">{formatDeadline(t.submissionDeadline)}</TableCell>
                  <TableCell className="p-3 text-muted-foreground">{formatTenderStatus(t.status)}</TableCell>
                  <TableCell className="p-3">
                    <ScoreBadge match={matchByTenderId.get(t.id)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
