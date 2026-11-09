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
  StatusBadge,
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
  NativeSelect,
  Checkbox,
  useT,
} from "@atiende/ui";
import { citasComun } from "@atiende/ui/i18n/citas/comun";
import { citasDisponibilidad } from "@atiende/ui/i18n/citas/disponibilidad";
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

const DAY_OPTIONS = Array.from({ length: 7 }, (_, i) => i);

/** "09:00" o "09:00:00" -> "09:00" para un <input type="time">, que solo acepta
 * "HH:MM" (nunca segundos) — mismo recorte que `formatHHMM` de format.ts, aquí
 * como valor controlado en vez de texto mostrado. */
function toTimeInputValue(time: string): string {
  return time.slice(0, 5);
}

export function DisponibilidadPage({ apiBaseUrl, token, propertyId }: CitasShellContext) {
  const t = useT(citasComun, citasDisponibilidad);
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
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorDisponibilidad")));
  }

  function loadOverrides() {
    if (!selectedProviderId) return;
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then(setOverrides)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorExcepciones")));
  }

  useEffect(() => {
    fetchProviders(fetch, apiBaseUrl, token, propertyId)
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setSelectedProviderId(list[0]!.id);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorProveedores")));
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!selectedProviderId) return;
    let cancelado = false;
    setDetail(null);
    setOverrides(null);
    setEditingRuleId(null);
    fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorDisponibilidad")));
    fetchAvailabilityOverrides(fetch, apiBaseUrl, token, propertyId, selectedProviderId)
      .then((list) => !cancelado && setOverrides(list))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorExcepciones")));
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
      setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorCrearHorario"));
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
      setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorGuardarHorario"));
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
      setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorQuitarHorario"));
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
      setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorGuardarExcepcion"));
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
      setError(err instanceof Error ? err.message : t("citas.disponibilidad.errorQuitarExcepcion"));
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
      <h1 className="font-display text-xl font-semibold text-foreground">{t("citas.disponibilidad.titulo")}</h1>

      {error && <EstadoError mensaje={error} />}

      {providers && providers.length === 0 && <EstadoVacio icon={UserRound} mensaje={t("citas.disponibilidad.sinProveedores")} />}

      {providers && providers.length > 0 && (
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor="citas-disponibilidad-proveedor">{t("citas.disponibilidad.proveedor")}</Label>
          <NativeSelect id="citas-disponibilidad-proveedor" value={selectedProviderId} onChange={(e) => setSelectedProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {!detail && selectedProviderId && !error && <EstadoCargando etiqueta={t("citas.disponibilidad.cargando")} />}

      {detail && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">{t("citas.disponibilidad.horarioSemanal")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">{t("citas.disponibilidad.dia")}</TableHead>
                  <TableHead>{t("citas.disponibilidad.horario")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DAY_OPTIONS.map((dayOfWeek) => {
                  const rules = rulesByDay.get(dayOfWeek) ?? [];
                  return (
                    <TableRow key={dayOfWeek} className="align-top">
                      <TableCell className="py-3 font-medium text-foreground">{formatDayOfWeek(dayOfWeek)}</TableCell>
                      <TableCell className={`py-3 ${rules.length === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                        {rules.length === 0 && t("citas.disponibilidad.cerrado")}
                        {rules.map((r) =>
                          editingRuleId === r.id ? (
                            <form key={r.id} onSubmit={handleSaveRule} className="mb-2 flex flex-wrap items-center gap-2">
                              <Label htmlFor={`citas-regla-inicio-${r.id}`} className="sr-only">
                                {t("citas.disponibilidad.horaInicio")}
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
                                {t("citas.disponibilidad.horaFin")}
                              </Label>
                              <Input id={`citas-regla-fin-${r.id}`} type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} className="h-9 w-auto" required />
                              <Checkbox checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} label={t("citas.disponibilidad.activo")} />
                              <Button type="submit" size="sm" className="h-9" disabled={savingRule}>
                                {savingRule ? t("citas.disponibilidad.guardando") : t("citas.disponibilidad.guardar")}
                              </Button>
                              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setEditingRuleId(null)} disabled={savingRule}>
                                {t("citas.cancelar")}
                              </Button>
                            </form>
                          ) : (
                            <div key={r.id} className="mb-1 flex flex-wrap items-center gap-2">
                              <span className={r.isActive ? undefined : "opacity-50"}>
                                {formatHHMM(r.startTime)} – {formatHHMM(r.endTime)}
                              </span>
                              {!r.isActive && <StatusBadge tone="neutral">{t("citas.disponibilidad.inactivo")}</StatusBadge>}
                              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => startEditingRule(r)}>
                                {t("citas.disponibilidad.editar")}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => void handleDeleteRule(r.id)}
                                disabled={deletingRuleId === r.id}
                              >
                                <Trash2 aria-hidden />
                                {deletingRuleId === r.id ? t("citas.disponibilidad.quitando") : t("citas.disponibilidad.quitar")}
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
                <Label htmlFor="citas-nuevo-horario-dia">{t("citas.disponibilidad.dia")}</Label>
                <NativeSelect id="citas-nuevo-horario-dia" value={newDayOfWeek} onChange={(e) => setNewDayOfWeek(Number(e.target.value))}>
                  {DAY_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {formatDayOfWeek(d)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-nuevo-horario-inicio">{t("citas.disponibilidad.desde")}</Label>
                <Input id="citas-nuevo-horario-inicio" type="time" value={newStartTime} onChange={(e) => setNewStartTime(e.target.value)} className="w-auto" required />
              </div>
              <span aria-hidden className="pb-3">
                –
              </span>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-nuevo-horario-fin">{t("citas.disponibilidad.hasta")}</Label>
                <Input id="citas-nuevo-horario-fin" type="time" value={newEndTime} onChange={(e) => setNewEndTime(e.target.value)} className="w-auto" required />
              </div>
              <Button type="submit" disabled={creatingRule}>
                <Plus aria-hidden />
                {creatingRule ? t("citas.disponibilidad.agregando") : t("citas.disponibilidad.agregarHorario")}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {detail && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">{t("citas.disponibilidad.excepciones")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!overrides && <EstadoCargando lineas={2} etiqueta={t("citas.disponibilidad.cargandoExcepciones")} />}
            {overrides && overrides.length === 0 && <EstadoVacio icon={CalendarOff} mensaje={t("citas.disponibilidad.sinExcepciones")} />}
            {overrides && overrides.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {overrides.map((o) => (
                  <div key={o.overrideDate} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{o.overrideDate}</span>
                    {o.isClosed ? (
                      <StatusBadge tone="danger">{t("citas.disponibilidad.cerrado")}</StatusBadge>
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
                      className="h-8 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() => void handleDeleteOverride(o.overrideDate)}
                      disabled={deletingOverrideDate === o.overrideDate}
                    >
                      <Trash2 aria-hidden />
                      {deletingOverrideDate === o.overrideDate ? t("citas.disponibilidad.quitando") : t("citas.disponibilidad.quitar")}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleSaveOverride} className="flex flex-col gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="citas-excepcion-fecha">{t("citas.disponibilidad.fecha")}</Label>
                  <Input id="citas-excepcion-fecha" type="date" value={newOverrideDate} onChange={(e) => setNewOverrideDate(e.target.value)} className="w-auto" required />
                </div>
                <Checkbox checked={newOverrideClosed} onChange={(e) => setNewOverrideClosed(e.target.checked)} label={t("citas.disponibilidad.cerradoTodoElDia")} wrapperClassName="h-11 items-center" />
                {!newOverrideClosed && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="citas-excepcion-inicio">{t("citas.disponibilidad.desde")}</Label>
                      <Input id="citas-excepcion-inicio" type="time" value={newOverrideStart} onChange={(e) => setNewOverrideStart(e.target.value)} className="w-auto" required />
                    </div>
                    <span aria-hidden className="pb-3">
                      –
                    </span>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="citas-excepcion-fin">{t("citas.disponibilidad.hasta")}</Label>
                      <Input id="citas-excepcion-fin" type="time" value={newOverrideEnd} onChange={(e) => setNewOverrideEnd(e.target.value)} className="w-auto" required />
                    </div>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                  <Label htmlFor="citas-excepcion-motivo">{t("citas.disponibilidad.motivo")}</Label>
                  <Input
                    id="citas-excepcion-motivo"
                    placeholder={t("citas.disponibilidad.motivoPlaceholder")}
                    value={newOverrideReason}
                    onChange={(e) => setNewOverrideReason(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={savingOverride}>
                  {savingOverride ? t("citas.disponibilidad.guardando") : t("citas.disponibilidad.guardarExcepcion")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
