// Disponibilidad del panel de citas (Fase 5, solo lectura) — Fase 10 cierra el gap
// real más grave de esta vertical: sin poder crear/editar `citas.availability_rules`
// desde el panel, un negocio nuevo no podía recibir ni una cita (el motor de
// disponibilidad, availability.ts, nunca encontraba reglas de dónde calcular slots).
// Reusa providers-client.ts (createAvailabilityRule/updateAvailabilityRule/
// deleteAvailabilityRule/fetchAvailabilityOverrides/upsertAvailabilityOverride/
// deleteAvailabilityOverride, ver admin.ts::POST/PATCH/DELETE
// .../availability-rules[/:ruleId] y .../availability-overrides[/:date]).
//
// Presentación real (Fase de diseño): la tabla artesanal y los estilos en línea
// (`inputStyle`/`primaryButtonStyle`/…) se cambian por Card/Table/Input/Label/
// Button/Badge de @atiende/ui. Las llamadas, el estado y las ramas condicionales
// de arriba son exactamente los mismos.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CalendarOff, Plus, Trash2, UserRound } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  createAvailabilityRule,
  deleteAvailabilityOverride,
  deleteAvailabilityRule,
  fetchAvailabilityOverrides,
  fetchProviderDetail,
  fetchProviders,
  updateAvailabilityRule,
  upsertAvailabilityOverride,
} from "../lib/providers-client.ts";
import type { AvailabilityOverrideSummary, AvailabilityRuleSummary, ProviderDetail, ProviderSummary } from "../lib/providers-client.ts";
import { formatDayOfWeek, formatHHMM } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

/** Mismo alto/radio/anillo de foco que el `Input` real de @atiende/ui, para los
 * `<select>` que se quedan nativos (el design system no exporta un Select). */
const SELECT_CLASS =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const DAY_OPTIONS = Array.from({ length: 7 }, (_, i) => i);

/** "09:00" o "09:00:00" -> "09:00" para un <input type="time">, que solo acepta
 * "HH:MM" (nunca segundos) — mismo recorte que `formatHHMM` de format.ts, aquí
 * como valor controlado en vez de texto mostrado. */
function toTimeInputValue(time: string): string {
  return time.slice(0, 5);
}

export function DisponibilidadPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  const [providers, setProviders] = useState<readonly ProviderSummary[] | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [detail, setDetail] = useState<ProviderDetail | null>(null);
  const [overrides, setOverrides] = useState<readonly AvailabilityOverrideSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- alta de regla nueva ----
  const [newDayOfWeek, setNewDayOfWeek] = useState(1);
  const [newStartTime, setNewStartTime] = useState("09:00");
  const [newEndTime, setNewEndTime] = useState("18:00");
  const [creatingRule, setCreatingRule] = useState(false);

  // ---- edición inline de una regla existente ----
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);
  const [savingRule, setSavingRule] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  // ---- alta/edición de una excepción puntual ----
  const [newOverrideDate, setNewOverrideDate] = useState("");
  const [newOverrideClosed, setNewOverrideClosed] = useState(true);
  const [newOverrideStart, setNewOverrideStart] = useState("09:00");
  const [newOverrideEnd, setNewOverrideEnd] = useState("14:00");
  const [newOverrideReason, setNewOverrideReason] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [deletingOverrideDate, setDeletingOverrideDate] = useState<string | null>(null);

  function loadDetail() {
    if (!selectedProviderId) return;
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar la disponibilidad."));
  }

  function loadOverrides() {
    if (!selectedProviderId) return;
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then(setOverrides)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar las excepciones."));
  }

  useEffect(() => {
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setSelectedProviderId(list[0]!.id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores."));
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!selectedProviderId) return;
    let cancelado = false;
    setDetail(null);
    setOverrides(null);
    setEditingRuleId(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar la disponibilidad."));
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((list) => !cancelado && setOverrides(list))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar las excepciones."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, selectedProviderId]);

  async function handleCreateRule(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId) return;
    setCreatingRule(true);
    setError(null);
    try {
      await createAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, { dayOfWeek: newDayOfWeek, startTime: newStartTime, endTime: newEndTime });
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el horario.");
    } finally {
      setCreatingRule(false);
    }
  }

  function startEditingRule(rule: AvailabilityRuleSummary) {
    setEditingRuleId(rule.id);
    setEditStartTime(toTimeInputValue(rule.startTime));
    setEditEndTime(toTimeInputValue(rule.endTime));
    setEditIsActive(rule.isActive);
  }

  async function handleSaveRule(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId || !editingRuleId) return;
    setSavingRule(true);
    setError(null);
    try {
      await updateAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, editingRuleId, { startTime: editStartTime, endTime: editEndTime, isActive: editIsActive });
      setEditingRuleId(null);
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el horario.");
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!selectedProviderId) return;
    setDeletingRuleId(ruleId);
    setError(null);
    try {
      await deleteAvailabilityRule(fetch, apiBaseUrl, token, propertyId, selectedProviderId, ruleId);
      loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar el horario.");
    } finally {
      setDeletingRuleId(null);
    }
  }

  async function handleSaveOverride(e: FormEvent) {
    e.preventDefault();
    if (!selectedProviderId || !newOverrideDate) return;
    setSavingOverride(true);
    setError(null);
    try {
      await upsertAvailabilityOverride(fetch, apiBaseUrl, token, propertyId, selectedProviderId, newOverrideDate, {
        isClosed: newOverrideClosed,
        startTime: newOverrideClosed ? null : newOverrideStart,
        endTime: newOverrideClosed ? null : newOverrideEnd,
        reason: newOverrideReason.trim() || null,
      });
      setNewOverrideDate("");
      setNewOverrideReason("");
      loadOverrides();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la excepción.");
    } finally {
      setSavingOverride(false);
    }
  }

  async function handleDeleteOverride(overrideDate: string) {
    if (!selectedProviderId) return;
    setDeletingOverrideDate(overrideDate);
    setError(null);
    try {
      await deleteAvailabilityOverride(fetch, apiBaseUrl, token, propertyId, selectedProviderId, overrideDate);
      loadOverrides();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar la excepción.");
    } finally {
      setDeletingOverrideDate(null);
    }
  }

  const rulesByDay = new Map<number, AvailabilityRuleSummary[]>();
  if (detail) {
    for (const rule of detail.availabilityRules) {
      const list = rulesByDay.get(rule.dayOfWeek) ?? [];
      list.push(rule);
      rulesByDay.set(rule.dayOfWeek, list);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="font-display text-xl font-semibold text-foreground">Disponibilidad</h1>

      {error && <EstadoError mensaje={error} />}

      {providers && providers.length === 0 && <EstadoVacio icon={UserRound} mensaje="Este negocio todavía no tiene proveedores activos." />}

      {providers && providers.length > 0 && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="citas-disponibilidad-proveedor">Proveedor</Label>
          <select id="citas-disponibilidad-proveedor" value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)} className={SELECT_CLASS}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>
      )}

      {!detail && selectedProviderId && !error && <EstadoCargando etiqueta="Cargando disponibilidad…" />}

      {detail && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Horario semanal</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Día</TableHead>
                  <TableHead>Horario</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DAY_OPTIONS.map((dayOfWeek) => {
                  const rules = rulesByDay.get(dayOfWeek) ?? [];
                  return (
                    <TableRow key={dayOfWeek} className="align-top">
                      <TableCell className="py-3 font-medium text-foreground">{formatDayOfWeek(dayOfWeek)}</TableCell>
                      <TableCell className={`py-3 ${rules.length === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                        {rules.length === 0 && "Cerrado"}
                        {rules.map((r) =>
                          editingRuleId === r.id ? (
                            <form key={r.id} onSubmit={handleSaveRule} className="mb-2 flex flex-wrap items-center gap-2">
                              <Label htmlFor={`citas-regla-inicio-${r.id}`} className="sr-only">
                                Hora de inicio
                              </Label>
                              <Input
                                id={`citas-regla-inicio-${r.id}`}
                                type="time"
                                value={editStartTime}
                                onChange={(e) => setEditStartTime(e.target.value)}
                                className="h-9 w-auto"
                                required
                              />
                              <span aria-hidden>–</span>
                              <Label htmlFor={`citas-regla-fin-${r.id}`} className="sr-only">
                                Hora de fin
                              </Label>
                              <Input id={`citas-regla-fin-${r.id}`} type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} className="h-9 w-auto" required />
                              <label className="flex items-center gap-1.5 text-[12px] text-foreground">
                                <input
                                  type="checkbox"
                                  checked={editIsActive}
                                  onChange={(e) => setEditIsActive(e.target.checked)}
                                  className="size-4 rounded border-border accent-primary"
                                />
                                Activo
                              </label>
                              <Button type="submit" size="sm" className="h-9" disabled={savingRule}>
                                {savingRule ? "Guardando…" : "Guardar"}
                              </Button>
                              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditingRuleId(null)} disabled={savingRule}>
                                Cancelar
                              </Button>
                            </form>
                          ) : (
                            <div key={r.id} className="mb-1 flex flex-wrap items-center gap-2">
                              <span className={r.isActive ? undefined : "opacity-50"}>
                                {formatHHMM(r.startTime)} – {formatHHMM(r.endTime)}
                              </span>
                              {!r.isActive && <Badge variant="outline">inactivo</Badge>}
                              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-[12px]" onClick={() => startEditingRule(r)}>
                                Editar
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-[12px] text-destructive hover:text-destructive"
                                onClick={() => void handleDeleteRule(r.id)}
                                disabled={deletingRuleId === r.id}
                              >
                                <Trash2 aria-hidden />
                                {deletingRuleId === r.id ? "Quitando…" : "Quitar"}
                              </Button>
                            </div>
                          ),
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <form onSubmit={handleCreateRule} className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-nuevo-horario-dia">Día</Label>
                <select id="citas-nuevo-horario-dia" value={newDayOfWeek} onChange={(e) => setNewDayOfWeek(Number(e.target.value))} className={SELECT_CLASS}>
                  {DAY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {formatDayOfWeek(d)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-nuevo-horario-inicio">Desde</Label>
                <Input id="citas-nuevo-horario-inicio" type="time" value={newStartTime} onChange={(e) => setNewStartTime(e.target.value)} className="w-auto" required />
              </div>
              <span aria-hidden className="pb-3">
                –
              </span>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-nuevo-horario-fin">Hasta</Label>
                <Input id="citas-nuevo-horario-fin" type="time" value={newEndTime} onChange={(e) => setNewEndTime(e.target.value)} className="w-auto" required />
              </div>
              <Button type="submit" disabled={creatingRule}>
                <Plus aria-hidden />
                {creatingRule ? "Agregando…" : "Agregar horario"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {detail && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Excepciones (días específicos)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!overrides && <EstadoCargando lineas={2} etiqueta="Cargando excepciones…" />}
            {overrides && overrides.length === 0 && <EstadoVacio icon={CalendarOff} mensaje="Sin excepciones próximas — este proveedor sigue su horario semanal normal." />}
            {overrides && overrides.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {overrides.map((o) => (
                  <div key={o.overrideDate} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{o.overrideDate}</span>
                    {o.isClosed ? (
                      <Badge variant="destructive">Cerrado</Badge>
                    ) : (
                      <span className="text-foreground">
                        {formatHHMM(o.startTime ?? "")} – {formatHHMM(o.endTime ?? "")}
                      </span>
                    )}
                    {o.reason && <span className="text-muted-foreground">({o.reason})</span>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-[12px] text-destructive hover:text-destructive"
                      onClick={() => void handleDeleteOverride(o.overrideDate)}
                      disabled={deletingOverrideDate === o.overrideDate}
                    >
                      <Trash2 aria-hidden />
                      {deletingOverrideDate === o.overrideDate ? "Quitando…" : "Quitar"}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleSaveOverride} className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="citas-excepcion-fecha">Fecha</Label>
                  <Input id="citas-excepcion-fecha" type="date" value={newOverrideDate} onChange={(e) => setNewOverrideDate(e.target.value)} className="w-auto" required />
                </div>
                <label className="flex h-11 items-center gap-2 text-[13px] text-foreground">
                  <input
                    type="checkbox"
                    checked={newOverrideClosed}
                    onChange={(e) => setNewOverrideClosed(e.target.checked)}
                    className="size-4 rounded border-border accent-primary"
                  />
                  Cerrado todo el día
                </label>
                {!newOverrideClosed && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="citas-excepcion-inicio">Desde</Label>
                      <Input id="citas-excepcion-inicio" type="time" value={newOverrideStart} onChange={(e) => setNewOverrideStart(e.target.value)} className="w-auto" required />
                    </div>
                    <span aria-hidden className="pb-3">
                      –
                    </span>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="citas-excepcion-fin">Hasta</Label>
                      <Input id="citas-excepcion-fin" type="time" value={newOverrideEnd} onChange={(e) => setNewOverrideEnd(e.target.value)} className="w-auto" required />
                    </div>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="citas-excepcion-motivo">Motivo (opcional)</Label>
                  <Input
                    id="citas-excepcion-motivo"
                    placeholder="Motivo (opcional, ej. Vacaciones)"
                    value={newOverrideReason}
                    onChange={(e) => setNewOverrideReason(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={savingOverride}>
                  {savingOverride ? "Guardando…" : "Guardar excepción"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
