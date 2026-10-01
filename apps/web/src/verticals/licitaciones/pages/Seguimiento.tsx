// Seguimiento (L-03) -- bandeja de lo que requiere atencion en el tiempo:
// (1) recordatorios de vencimiento del plazo de presentacion de propuestas y
// (2) cambios detectados en una convocatoria (bases, junta de aclaraciones,
// anexos) que invalidan secciones ya redactadas (REQ-151/155). Reconocer
// ("ya lo vi") exige un rol de escritura en el servidor; la UI solo oculta el
// boton para el resto. Las fechas se muestran en hora del centro de Mexico.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge } from "@atiende/ui";
import { acknowledgeDeadlineReminder, acknowledgeTenderChangeNotification, fetchDeadlineReminders, fetchTenderChangeNotifications } from "../lib/seguimiento-client.ts";
import type { DeadlineReminder, TenderChangeNotification } from "../lib/seguimiento-client.ts";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Espejo de WRITE_ROLES (domain-licitaciones/roles.ts) -- cosmetico; el servidor lo exige igual.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);

const DATE_TIME = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

export function SeguimientoPage({ apiBaseUrl, token, propertyId, orgSlug, role }: LicitacionesShellContext) {
  const [reminders, setReminders] = useState<readonly DeadlineReminder[] | null>(null);
  const [changes, setChanges] = useState<readonly TenderChangeNotification[] | null>(null);
  const [tenders, setTenders] = useState<readonly TenderSummary[]>([]);
  const [errors, setErrors] = useState<{ reminders?: string; changes?: string }>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);

  async function load() {
    setLoading(true);
    const [r, c, t] = await Promise.allSettled([
      fetchDeadlineReminders(fetch, apiBaseUrl, token, propertyId),
      fetchTenderChangeNotifications(fetch, apiBaseUrl, token, propertyId),
      fetchTenders(fetch, apiBaseUrl, token, propertyId),
    ]);
    const next: { reminders?: string; changes?: string } = {};
    if (r.status === "fulfilled") setReminders(r.value);
    else next.reminders = r.reason instanceof Error ? r.reason.message : "No se pudieron cargar los recordatorios.";
    if (c.status === "fulfilled") setChanges(c.value);
    else next.changes = c.reason instanceof Error ? c.reason.message : "No se pudieron cargar los cambios de convocatoria.";
    if (t.status === "fulfilled") setTenders(t.value);
    setErrors(next);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  const tenderById = new Map(tenders.map((t) => [t.id, t]));
  const canWrite = WRITE_ROLES.has(role);

  function tenderLink(tenderId: string) {
    const t = tenderById.get(tenderId);
    return t ? (
      <Link to={`/licitaciones/${orgSlug}/convocatorias/${t.id}`} className="font-semibold text-foreground no-underline hover:underline">
        {t.title}
      </Link>
    ) : (
      <span className="text-muted-foreground">Convocatoria {tenderId}</span>
    );
  }

  async function ackReminder(id: string) {
    setActionError(null);
    setBusyId(id);
    try {
      const updated = await acknowledgeDeadlineReminder(fetch, apiBaseUrl, token, propertyId, id);
      setReminders((prev) => (prev ? prev.map((x) => (x.id === id ? updated : x)) : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo reconocer el recordatorio.");
    } finally {
      setBusyId(null);
    }
  }

  async function ackChange(id: string) {
    setActionError(null);
    setBusyId(id);
    try {
      const updated = await acknowledgeTenderChangeNotification(fetch, apiBaseUrl, token, propertyId, id);
      setChanges((prev) => (prev ? prev.map((x) => (x.id === id ? updated : x)) : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo reconocer el cambio.");
    } finally {
      setBusyId(null);
    }
  }

  const visibleReminders = (reminders ?? []).filter((r) => !onlyPending || r.acknowledgedAt === null);
  const visibleChanges = (changes ?? []).filter((c) => !onlyPending || c.acknowledgedAt === null);

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Seguimiento</h1>
        <p className="mt-1 max-w-[720px] text-sm text-muted-foreground">
          Plazos de presentación por vencer y cambios en las bases, junta de aclaraciones o anexos de una convocatoria. Reconocer un aviso significa &quot;ya lo vi&quot;; no cierra ni resuelve nada en la convocatoria.
        </p>
      </header>

      <Checkbox label="Mostrar solo pendientes" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
      {!canWrite && <p className="text-xs text-muted-foreground">Tu rol ({role}) solo puede consultar; reconocer avisos requiere un rol de escritura.</p>}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {loading && !reminders && !changes && <EstadoCargando etiqueta="Cargando seguimiento…" />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plazos de presentación por vencer</CardTitle>
          <CardDescription>Recordatorios generados automáticamente cuando el cierre de propuestas está próximo.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {errors.reminders && <EstadoError mensaje={errors.reminders} onReintentar={() => void load()} />}
          {reminders && visibleReminders.length === 0 && <EstadoVacio mensaje={onlyPending ? "No hay recordatorios pendientes." : "No hay recordatorios."} />}
          {visibleReminders.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0">
                {tenderLink(r.tenderId)}
                <div className="text-xs text-muted-foreground">{r.message}</div>
                <div className="text-xs text-muted-foreground">Cierre: {DATE_TIME.format(new Date(r.submissionDeadline))}</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge tone={r.daysRemaining <= 1 ? "danger" : "neutral"}>{r.daysRemaining === 0 ? "Vence hoy" : `Faltan ${r.daysRemaining} d`}</StatusBadge>
                {r.acknowledgedAt ? (
                  <StatusBadge tone="success">Reconocido</StatusBadge>
                ) : (
                  canWrite && (
                    <Button type="button" size="sm" variant="outline" disabled={busyId === r.id} onClick={() => void ackReminder(r.id)}>
                      {busyId === r.id ? "Reconociendo…" : "Reconocer"}
                    </Button>
                  )
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cambios en convocatorias</CardTitle>
          <CardDescription>Una modificación a las bases puede invalidar secciones de la propuesta ya redactadas; revísalas antes de presentar.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {errors.changes && <EstadoError mensaje={errors.changes} onReintentar={() => void load()} />}
          {changes && visibleChanges.length === 0 && <EstadoVacio mensaje={onlyPending ? "No hay cambios pendientes de revisar." : "No hay cambios registrados."} />}
          {visibleChanges.map((n) => (
            <div key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div className="min-w-0">
                {tenderLink(n.tenderId)} <span className="text-xs text-muted-foreground">versión {n.tenderVersion}</span>
                <div className="text-xs text-muted-foreground">{n.reason}</div>
                {n.changedFieldNames.length > 0 && <div className="text-xs text-muted-foreground">Campos: {n.changedFieldNames.join(", ")}</div>}
                {n.affectedSectionKeys.length > 0 && <div className="text-xs text-muted-foreground">Secciones afectadas: {n.affectedSectionKeys.join(", ")}</div>}
                <div className="text-xs text-muted-foreground">Detectado: {DATE_TIME.format(new Date(n.createdAt))}</div>
              </div>
              {n.acknowledgedAt ? (
                <StatusBadge tone="success">Reconocido</StatusBadge>
              ) : (
                canWrite && (
                  <Button type="button" size="sm" variant="outline" disabled={busyId === n.id} onClick={() => void ackChange(n.id)}>
                    {busyId === n.id ? "Reconociendo…" : "Reconocer"}
                  </Button>
                )
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
