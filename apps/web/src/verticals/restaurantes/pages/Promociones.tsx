// Promociones (Fase 11) — hallazgo de auditoría (severidad ALTA, "Promociones/
// códigos de descuento (Fase 11) sin UI"): admin-promotions.ts ya implementaba
// GET/POST .../admin/promotions y PATCH .../admin/promotions/:promotionId con
// validación completa (código, tipo, vigencia, días/horas, maxUses, isActive)
// desde Fase 11, pero ningún panel los llamaba todavía. Esta página cierra ese
// hueco: crear un código (con tipo/valor, vigencia y tope de usos opcionales),
// listar los existentes con su uso real, editar vigencia/activo. Sin gate de rol
// del lado del cliente — a diferencia de Staff.tsx, MANAGER_ROLES (owner/admin/
// staff) es el mismo trío amplio que ya puede entrar a este panel por
// RestaurantesShell, así que no hay un "reservado a" real que mostrar (el
// servidor sigue siendo el enforcement — 403 si algún día cambia).
//
// Presentación real desde esta ronda: los dos formularios (crear un código nuevo y
// editar la vigencia de uno existente) pasan a <ModalFormularioLateral> — el shell de
// modal ya existente en apps/web/src/components — y la lista a `Card`/`Badge`/
// `Button` de `@atiende/ui`. Los campos, la validación de cliente, los payloads
// enviados y las llamadas al backend son EXACTAMENTE los mismos que antes: lo único
// que cambia es que los formularios ya no viven siempre abiertos en la página.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label } from "@atiende/ui";
import { CalendarRange, Plus } from "lucide-react";
import { ModalFormularioLateral } from "../../../components/ModalFormularioLateral.tsx";
import {
  createPromotion,
  fetchPromotions,
  setPromotionActive,
  updatePromotion,
} from "../lib/promotions-client.ts";
import type { Promotion, PromotionType } from "../lib/promotions-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const DAY_LABELS: readonly string[] = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

const SELECT_CLASES =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function formatValue(type: PromotionType, value: number): string {
  return type === "percentage" ? `${value}%` : `$${value.toFixed(2)}`;
}

// BUG REAL corregido aquí (revisión de PR #170): `dateInputToIso` construye el
// instante con el constructor LOCAL de `Date` (`new Date("YYYY-MM-DDTHH:mm:ss")`,
// sin sufijo de zona) -- el mismo criterio que "medianoche/23:59:59 local" del
// resto del panel. La ida y vuelta con `formatDateInput` DEBE ser simétrica: leer
// el ISO guardado con `.slice(0, 10)` toma el día UTC, no el día local, así que en
// cualquier zona con offset negativo (América completa, incluida
// America/Mexico_City) el modal "Editar vigencia" precargaba el día SIGUIENTE al
// real. Cada "Guardar" sin tocar nada volvía a convertir esa fecha corrida a ISO
// y corría `endsAt` un día más -- el descuento quedaba vigente días extra en cada
// edición. El fix es leer el ISO con los getters LOCALES de `Date` (mismos que usa
// el constructor de `dateInputToIso` al escribir), nunca con `.slice`.
function formatDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateInputToIso(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString();
}

interface FormState {
  readonly code: string;
  readonly name: string;
  readonly type: PromotionType;
  readonly value: string;
  readonly minOrderTotal: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly maxUses: string;
}

const EMPTY_FORM: FormState = { code: "", name: "", type: "percentage", value: "", minOrderTotal: "", startsAt: "", endsAt: "", maxUses: "" };

export function PromocionesPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [promotions, setPromotions] = useState<readonly Promotion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  // Solo controla si el <ModalFormularioLateral> de alta está abierto — el formulario
  // y su validación son los mismos de siempre.
  const [modalCrearAbierto, setModalCrearAbierto] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStartsAt, setEditStartsAt] = useState("");
  const [editEndsAt, setEditEndsAt] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setPromotions(await fetchPromotions(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las promociones.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const value = Number(form.value);
    if (!form.code.trim() || !form.name.trim() || !Number.isFinite(value) || value <= 0) return;
    setCreating(true);
    setError(null);
    try {
      const minOrderTotal = form.minOrderTotal.trim() === "" ? undefined : Number(form.minOrderTotal);
      const maxUses = form.maxUses.trim() === "" ? undefined : Number(form.maxUses);
      await createPromotion(fetch, apiBaseUrl, token, propertyId, {
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        value,
        ...(minOrderTotal !== undefined ? { minOrderTotal } : {}),
        ...(maxUses !== undefined ? { maxUses } : {}),
        startsAt: dateInputToIso(form.startsAt, false),
        endsAt: dateInputToIso(form.endsAt, true),
      });
      setForm(EMPTY_FORM);
      setModalCrearAbierto(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la promoción.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(p: Promotion) {
    setEditingId(p.id);
    setEditStartsAt(formatDateInput(p.startsAt));
    setEditEndsAt(formatDateInput(p.endsAt));
  }

  async function handleSaveEdit(promotionId: string) {
    setSavingEdit(true);
    setError(null);
    try {
      await updatePromotion(fetch, apiBaseUrl, token, propertyId, promotionId, {
        startsAt: dateInputToIso(editStartsAt, false),
        endsAt: dateInputToIso(editEndsAt, true),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar la vigencia.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleActive(p: Promotion) {
    setTogglingId(p.id);
    setError(null);
    try {
      await setPromotionActive(fetch, apiBaseUrl, token, propertyId, p.id, !p.isActive);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado de la promoción.");
    } finally {
      setTogglingId(null);
    }
  }

  const promocionEnEdicion = promotions?.find((p) => p.id === editingId) ?? null;

  return (
    <div className="flex max-w-4xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Promociones</h1>
        <Button type="button" onClick={() => setModalCrearAbierto(true)}>
          <Plus />
          Crear un código nuevo
        </Button>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <section className="flex flex-col gap-2">
        <p className="m-0 text-sm font-semibold text-foreground">Códigos existentes</p>
        {!promotions && !error && <EstadoCargando etiqueta="Cargando promociones…" />}
        {promotions && promotions.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna promoción creada." />}
        {promotions && promotions.length > 0 && (
          <div className="flex flex-col gap-2">
            {promotions.map((p) => (
              <Card key={p.id} className={p.isActive ? undefined : "opacity-60"}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <div className="m-0 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-foreground">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{p.code}</code>
                      <span>· {p.name}</span>
                      {!p.isActive && (
                        <Badge variant="outline" className="text-muted-foreground">
                          Inactiva
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatValue(p.type, p.value)} de descuento
                      {p.minOrderTotal !== null ? ` · pedido mín. $${p.minOrderTotal.toFixed(2)}` : ""}
                      {p.maxUses !== null ? ` · usado ${p.timesUsed}/${p.maxUses}` : ` · usado ${p.timesUsed} veces`}
                      {p.daysOfWeek && p.daysOfWeek.length > 0 ? ` · ${p.daysOfWeek.map((d) => DAY_LABELS[d]).join("/")}` : ""}
                      {p.startTime && p.endTime ? ` · ${p.startTime}-${p.endTime}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Vigencia: {p.startsAt ? new Date(p.startsAt).toLocaleDateString("es-MX") : "sin inicio"} → {p.endsAt ? new Date(p.endsAt).toLocaleDateString("es-MX") : "sin fin"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" variant="outline" size="sm" className="h-9 text-xs" onClick={() => startEdit(p)}>
                      <CalendarRange />
                      Editar vigencia
                    </Button>
                    <Button
                      type="button"
                      variant={p.isActive ? "destructive" : "outline"}
                      size="sm"
                      className="h-9 text-xs"
                      onClick={() => void handleToggleActive(p)}
                      disabled={togglingId === p.id}
                    >
                      {togglingId === p.id ? "Guardando…" : p.isActive ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <ModalFormularioLateral
        open={modalCrearAbierto}
        onOpenChange={setModalCrearAbierto}
        titulo="Crear un código nuevo"
        subtitulo="El código nace activo. Días y horario de vigencia solo se pueden ajustar por API por ahora — la fecha de inicio/fin y la vigencia sí se editan desde el panel."
        anchoClase="max-w-3xl"
        footer={
          <Button type="submit" form="restaurantes-promocion-nueva" className="rounded-full px-6" disabled={creating}>
            {creating ? "Creando…" : "Crear código"}
          </Button>
        }
      >
        <form id="restaurantes-promocion-nueva" onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-codigo" className="text-xs text-muted-foreground">
              Código
            </Label>
            <Input
              id="promocion-codigo"
              type="text"
              placeholder="CÓDIGO (ej. BIENVENIDA10)"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-nombre" className="text-xs text-muted-foreground">
              Nombre para el staff
            </Label>
            <Input
              id="promocion-nombre"
              type="text"
              placeholder="Nombre para el staff"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-tipo" className="text-xs text-muted-foreground">
              Tipo de descuento
            </Label>
            <select
              id="promocion-tipo"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionType }))}
              className={SELECT_CLASES}
            >
              <option value="percentage">% descuento</option>
              <option value="fixed">$ fijo</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-valor" className="text-xs text-muted-foreground">
              Valor
            </Label>
            <Input
              id="promocion-valor"
              type="number"
              min="0"
              step="0.01"
              placeholder={form.type === "percentage" ? "Valor (0-100)" : "Valor ($)"}
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-minimo" className="text-xs text-muted-foreground">
              Pedido mínimo ($, opc.)
            </Label>
            <Input
              id="promocion-minimo"
              type="number"
              min="0"
              step="0.01"
              placeholder="Pedido mínimo ($, opc.)"
              value={form.minOrderTotal}
              onChange={(e) => setForm((f) => ({ ...f, minOrderTotal: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-tope" className="text-xs text-muted-foreground">
              Tope de usos (opc.)
            </Label>
            <Input
              id="promocion-tope"
              type="number"
              min="1"
              step="1"
              placeholder="Tope de usos (opc.)"
              value={form.maxUses}
              onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-desde" className="text-xs text-muted-foreground">
              Vigente desde
            </Label>
            <Input id="promocion-desde" type="date" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-hasta" className="text-xs text-muted-foreground">
              Vigente hasta
            </Label>
            <Input id="promocion-hasta" type="date" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
          </div>
        </form>
      </ModalFormularioLateral>

      <ModalFormularioLateral
        open={editingId !== null}
        onOpenChange={(abierto) => !abierto && setEditingId(null)}
        titulo="Editar vigencia"
        subtitulo={promocionEnEdicion ? `${promocionEnEdicion.code} · ${promocionEnEdicion.name}` : undefined}
        anchoClase="max-w-2xl"
        guardando={savingEdit}
        textoBotonGuardar="Guardar"
        onGuardar={() => {
          if (editingId) void handleSaveEdit(editingId);
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-edit-desde" className="text-xs text-muted-foreground">
              Vigente desde
            </Label>
            <Input id="promocion-edit-desde" type="date" value={editStartsAt} onChange={(e) => setEditStartsAt(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promocion-edit-hasta" className="text-xs text-muted-foreground">
              Vigente hasta
            </Label>
            <Input id="promocion-edit-hasta" type="date" value={editEndsAt} onChange={(e) => setEditEndsAt(e.target.value)} />
          </div>
        </div>
      </ModalFormularioLateral>
    </div>
  );
}
