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
// `DataTable` de @atiende/ui, el pill de elegibilidad a `StatusBadge`, el alta manual al
// `FormDialog` (mismo estado `showForm`, misma llamada a
// createOrUpdateTender) y el botón ad-hoc a `Button`. Cero cambios de lógica.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, statusTone } from "@atiende/ui";
import { saludoConNombre } from "../../../lib/greeting.ts";
import { createOrUpdateTender, fetchTendersPage } from "../lib/tenders-client.ts";
import { ELEGIBILIDAD_TONES } from "../lib/status-tones.ts";
import type { TenderStatus, TenderSummary } from "../lib/tenders-client.ts";
import { fetchSourceConnectors } from "../lib/sources-client.ts";
import type { SourceConnectorInfo } from "../lib/sources-client.ts";
import { fetchMatchingList } from "../lib/matching-client.ts";
import type { MatchResult } from "../lib/matching-client.ts";
import { formatDeadline, formatEligibility, formatTenderStatus, TENDER_STATUS_LABELS } from "../lib/format.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

/** Filas por pagina del listado (el servidor admite hasta 200). */
const PAGE_SIZE = 25;
/** Espera tras la ultima tecla antes de buscar en el servidor. */
const BUSQUEDA_DEBOUNCE_MS = 300;

function ScoreBadge({ match }: { match: MatchResult | undefined }) {
  if (!match) return <span className="text-xs text-muted-foreground">Sin score</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <strong className="text-sm tabular-nums text-foreground">{match.score}</strong>
      <StatusBadge tone={statusTone(ELEGIBILIDAD_TONES, match.eligibility.status)}>{formatEligibility(match.eligibility.status)}</StatusBadge>
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

export function ConvocatoriasPage({ apiBaseUrl, token, propertyId, orgSlug, role, staffFullName, staffEmail }: LicitacionesShellContext) {
  const [tenders, setTenders] = useState<readonly TenderSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [texto, setTexto] = useState("");
  const [q, setQ] = useState("");
  const [estado, setEstado] = useState<TenderStatus | "">("");
  const [fuente, setFuente] = useState("");
  const [fuentes, setFuentes] = useState<readonly SourceConnectorInfo[]>([]);
  const [matching, setMatching] = useState<readonly MatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<NewTenderFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** Descarta la respuesta de una consulta vieja si el usuario ya pidio otra pagina o filtro. */
  const consulta = useRef(0);

  async function load() {
    const mia = ++consulta.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchTendersPage(fetch, apiBaseUrl, token, propertyId, {
        limit: PAGE_SIZE,
        offset: (pagina - 1) * PAGE_SIZE,
        q,
        status: estado || undefined,
        source: fuente || undefined,
      });
      if (mia !== consulta.current) return;
      setTenders(page.items);
      setTotal(page.total);
      // El score es opcional: si falla, la tabla se pinta igual (sin score) en vez de fallar toda la pantalla.
      const ids = page.items.map((t) => t.id);
      const scores = ids.length > 0 ? await fetchMatchingList(fetch, apiBaseUrl, token, propertyId, { ids, limit: ids.length }).catch(() => []) : [];
      if (mia !== consulta.current) return;
      setMatching(scores);
    } catch (err) {
      if (mia !== consulta.current) return;
      setError(err instanceof Error ? err.message : "No se pudieron cargar las convocatorias.");
    } finally {
      if (mia === consulta.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint: mismo criterio que el resto del panel (Agenda.tsx de citas) -- este
    // proyecto no tiene eslint-plugin-react-hooks configurado.
  }, [apiBaseUrl, token, propertyId, pagina, q, estado, fuente]);

  // Buscar al dejar de escribir; una busqueda nueva vuelve a la primera pagina.
  useEffect(() => {
    const t = setTimeout(() => {
      if (texto.trim() !== q) {
        setQ(texto.trim());
        setPagina(1);
      }
    }, BUSQUEDA_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [texto, q]);

  // Fuentes del filtro: las del registro real de conectores; si no se pueden leer, el filtro de fuente se oculta.
  useEffect(() => {
    let vivo = true;
    fetchSourceConnectors(fetch, apiBaseUrl, token, propertyId)
      .then((list) => {
        if (vivo) setFuentes(list);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId]);

  const matchByTenderId = new Map(matching.map((m) => [m.tenderId, m]));
  const filtrado = q !== "" || estado !== "" || fuente !== "";

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
    <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{saludoConNombre(staffFullName, staffEmail)}</p>
          <h1 className="font-display text-xl font-semibold text-foreground">Convocatorias</h1>
          <p className="mt-1 text-sm text-muted-foreground">Alta manual mientras la ingesta automática siga bloqueada (ver README).</p>
        </div>
        {WRITE_ROLES.has(role) && (
          <Button type="button" size="sm" onClick={() => setShowForm(true)}>
            <Plus />
            Nueva convocatoria
          </Button>
        )}
      </header>

      <FormDialog
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
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      </FormDialog>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="conv-buscar">Buscar</Label>
          <Input id="conv-buscar" type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Título, folio o entidad" maxLength={200} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="conv-estado">Estatus</Label>
          <NativeSelect
            id="conv-estado"
            value={estado}
            onChange={(e) => {
              setEstado(e.target.value as TenderStatus | "");
              setPagina(1);
            }}
          >
            <option value="">Todos</option>
            {Object.entries(TENDER_STATUS_LABELS).map(([valor, etiqueta]) => (
              <option key={valor} value={valor}>
                {etiqueta}
              </option>
            ))}
          </NativeSelect>
        </div>
        {fuentes.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="conv-fuente">Fuente</Label>
            <NativeSelect
              id="conv-fuente"
              value={fuente}
              onChange={(e) => {
                setFuente(e.target.value);
                setPagina(1);
              }}
            >
              <option value="">Todas</option>
              {fuentes.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      {loading && !tenders && <EstadoCargando etiqueta="Cargando convocatorias…" />}

      {tenders && total === 0 && !loading && !error && (
        <EstadoVacio mensaje={filtrado ? "Ninguna convocatoria coincide con la búsqueda." : "Todavía no hay ninguna convocatoria dada de alta."} />
      )}

      {tenders && tenders.length > 0 && (
        <DataTable
          etiqueta="Convocatorias"
          obtenerId={(t) => t.id}
          filas={tenders}
          paginacion={{ tamano: PAGE_SIZE, pagina, total, onPaginaChange: setPagina }}
          estado={loading ? "loading" : undefined}
          columnas={[
            {
              id: "titulo",
              encabezado: "Título",
              principal: true,
              celda: (t) => (
                <>
                  <Link to={`/licitaciones/${orgSlug}/convocatorias/${t.id}`} className="font-semibold text-foreground no-underline hover:underline">
                    {t.title}
                  </Link>
                  {t.externalId && <div className="text-xs font-normal text-muted-foreground">{t.externalId}</div>}
                </>
              ),
            },
            { id: "entidad", encabezado: "Entidad", celda: (t) => <span className="text-muted-foreground">{t.contractingBody ?? "—"}</span> },
            { id: "fecha", encabezado: "Fecha límite", celda: (t) => <span className="text-muted-foreground">{formatDeadline(t.submissionDeadline)}</span> },
            { id: "estatus", encabezado: "Estatus", celda: (t) => <span className="text-muted-foreground">{formatTenderStatus(t.status)}</span> },
            { id: "score", encabezado: "Score", celda: (t) => <ScoreBadge match={matchByTenderId.get(t.id)} /> },
          ]}
        />
      )}
    </PageContainer>
  );
}
