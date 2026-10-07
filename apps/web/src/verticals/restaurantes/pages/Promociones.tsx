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
// editar la vigencia de uno existente) pasan a <FormDialog> — el shell de
// modal ya existente en apps/web/src/components — y la lista a `Card`/`Badge`/
// `Button` de `@atiende/ui`. Los campos, la validación de cliente, los payloads
// enviados y las llamadas al backend son EXACTAMENTE los mismos que antes: lo único
// que cambia es que los formularios ya no viven siempre abiertos en la página.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, Label, NativeSelect, PageContainer, StatusBadge, formatMoney } from "@atiende/ui";
import { CalendarRange, Plus } from "lucide-react";
import {
  createPromotion,
  fetchPromotions,
  setPromotionActive,
  updatePromotion,
} from "../lib/promotions-client.ts";
import type { Promotion, PromotionCanal, PromotionType } from "../lib/promotions-client.ts";
import { fetchProducts } from "../lib/catalog-client.ts";
import type { Product } from "../lib/catalog-client.ts";
import { puedeEn } from "../lib/permisos.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const DAY_LABELS: readonly string[] = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function formatValue(type: PromotionType, value: number): string {
  if (type === "bogo") return "2x1";
  if (type === "cortesia") return "Combo de cortesía";
  return type === "percentage" ? `${value}% de descuento` : `$${formatMoney(value)} de descuento`;
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
  /** "" = todos los canales. */
  readonly canal: "" | PromotionCanal;
  readonly autoApply: boolean;
  readonly days: readonly number[];
  readonly productIds: readonly string[];
  readonly courtesyProductIds: readonly string[];
  readonly courtesyQuantity: string;
}

const EMPTY_FORM: FormState = {
  code: "",
  name: "",
  type: "percentage",
  value: "",
  minOrderTotal: "",
  startsAt: "",
  endsAt: "",
  maxUses: "",
  canal: "",
  autoApply: false,
  days: [],
  productIds: [],
  courtesyProductIds: [],
  courtesyQuantity: "2",
};

/** Ids elegidos tras marcar/desmarcar uno: se conserva el orden del catalogo (el mismo que daba una seleccion multiple nativa). */
function alternarProducto(elegidos: readonly string[], id: string, marcado: boolean, catalogo: readonly Product[] | null): string[] {
  const set = new Set(elegidos);
  if (marcado) set.add(id);
  else set.delete(id);
  const ordenados = (catalogo ?? []).filter((p) => set.has(p.id)).map((p) => p.id);
  return ordenados.length === set.size ? ordenados : [...set];
}

/** PL-23: las promociones son de owner/admin. Un staff que llega por URL ve un estado honesto en vez de un 403 del servidor. */
export function PromocionesPage(ctx: RestaurantesShellContext) {
  if (!puedeEn(ctx.role, "promociones.ver")) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Promociones</h1>
        <Callout tone="info">Solo el dueño o un administrador puede ver y gestionar las promociones.</Callout>
      </PageContainer>
    );
  }
  return <PromocionesContenido {...ctx} />;
}

function PromocionesContenido({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [promotions, setPromotions] = useState<readonly Promotion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Los errores de crear/editar se pintan DENTRO de su dialogo (QA-restaurantes-R1-botones-17): el estado de la pagina queda
  // detras del overlay y el boton parecia muerto.
  const [errorCrear, setErrorCrear] = useState<string | null>(null);
  const [errorEdicion, setErrorEdicion] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  // Solo controla si el <FormDialog> de alta está abierto — el formulario
  // y su validación son los mismos de siempre.
  const [modalCrearAbierto, setModalCrearAbierto] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStartsAt, setEditStartsAt] = useState("");
  const [editEndsAt, setEditEndsAt] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Catalogo para elegir productos del 2x1 / combo de cortesia. Si falla, el formulario sigue sirviendo para
  // los demas tipos y avisa por que no hay lista.
  const [products, setProducts] = useState<readonly Product[] | null>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  useEffect(() => {
    fetchProducts(fetch, apiBaseUrl, token, propertyId).then(setProducts, (err) => setProductsError(err instanceof Error ? err.message : "No se pudo cargar el catálogo."));
  }, [apiBaseUrl, token, propertyId]);

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
    const sinValor = form.type === "bogo" || form.type === "cortesia";
    const value = sinValor ? 1 : Number(form.value);
    // QA-restaurantes-R2-botones-07: cada rechazo local explica por que no se creo (antes el boton parecia muerto).
    if (!form.code.trim() || !form.name.trim()) {
      setErrorCrear("Escribe el código y el nombre para el staff: no pueden quedar vacíos ni solo con espacios.");
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      setErrorCrear(form.type === "percentage" ? "El valor del descuento debe ser mayor que 0 (y hasta 100)." : "El valor del descuento debe ser mayor que 0.");
      return;
    }
    // Mismas reglas que el servidor (que re-valida): automatica exige canal; cortesia exige listas y cantidad.
    if (form.autoApply && form.canal === "") {
      setErrorCrear("Una promoción automática necesita un canal (por ejemplo, solo recoger).");
      return;
    }
    if (form.type === "cortesia" && (form.productIds.length === 0 || form.courtesyProductIds.length === 0 || !(Number(form.courtesyQuantity) >= 1))) {
      setErrorCrear("El combo de cortesía necesita los productos que lo disparan, los productos de cortesía y las piezas por producto.");
      return;
    }
    setCreating(true);
    setErrorCrear(null);
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
        ...(form.canal !== "" ? { channels: [form.canal] } : {}),
        ...(form.autoApply ? { autoApply: true } : {}),
        ...(form.days.length > 0 ? { daysOfWeek: form.days } : {}),
        ...((form.type === "bogo" || form.type === "cortesia") && form.productIds.length > 0 ? { productIds: form.productIds } : {}),
        ...(form.type === "cortesia" ? { courtesyProductIds: form.courtesyProductIds, courtesyQuantity: Number(form.courtesyQuantity) } : {}),
      });
      setForm(EMPTY_FORM);
      setModalCrearAbierto(false);
      await load();
    } catch (err) {
      setErrorCrear(err instanceof Error ? err.message : "No se pudo crear la promoción.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(p: Promotion) {
    setErrorEdicion(null);
    setEditingId(p.id);
    setEditStartsAt(formatDateInput(p.startsAt));
    setEditEndsAt(formatDateInput(p.endsAt));
  }

  async function handleSaveEdit(promotionId: string) {
    setSavingEdit(true);
    setErrorEdicion(null);
    try {
      await updatePromotion(fetch, apiBaseUrl, token, propertyId, promotionId, {
        startsAt: dateInputToIso(editStartsAt, false),
        endsAt: dateInputToIso(editEndsAt, true),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setErrorEdicion(err instanceof Error ? err.message : "No se pudo actualizar la vigencia.");
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
    <PageContainer padding="none">
      <header className="flex flex-wrap items-center justify-end gap-3">
        <h1 className="sr-only">Promociones</h1>
        <Button
          type="button"
          onClick={() => {
            setErrorCrear(null);
            setModalCrearAbierto(true);
          }}
        >
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
                    <div className="m-0 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{p.code}</code>
                      <span>· {p.name}</span>
                      {p.autoApply && <StatusBadge tone="neutral" dot={false}>Automática</StatusBadge>}
                      {p.channels && p.channels.length > 0 && <StatusBadge tone="neutral" dot={false}>{p.channels.map((c) => (c === "recoger" ? "Solo recoger" : "Solo domicilio")).join(" / ")}</StatusBadge>}
                      {!p.isActive && (
                        <StatusBadge tone="neutral" dot={false} className="text-muted-foreground">
                          Inactiva
                        </StatusBadge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatValue(p.type, p.value)}
                      {p.minOrderTotal !== null ? ` · pedido mín. $${formatMoney(p.minOrderTotal)}` : ""}
                      {p.maxUses !== null ? ` · usado ${p.timesUsed}/${p.maxUses}` : ` · usado ${p.timesUsed} veces`}
                      {p.daysOfWeek && p.daysOfWeek.length > 0 ? ` · ${p.daysOfWeek.map((d) => DAY_LABELS[d]).join("/")}` : ""}
                      {p.startTime && p.endTime ? ` · ${p.startTime}-${p.endTime}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Vigencia: {p.startsAt ? new Date(p.startsAt).toLocaleDateString("es-MX") : "sin inicio"} → {p.endsAt ? new Date(p.endsAt).toLocaleDateString("es-MX") : "sin fin"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => startEdit(p)}>
                      <CalendarRange />
                      Editar vigencia
                    </Button>
                    <Button
                      type="button"
                      variant={p.isActive ? "danger" : "outline"}
                      size="sm"
                      onClick={() => void handleToggleActive(p)}
                      loading={togglingId === p.id}
                    >
                      {p.isActive ? "Desactivar" : "Activar"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <FormDialog
        open={modalCrearAbierto}
        onOpenChange={setModalCrearAbierto}
        titulo="Crear un código nuevo"
        subtitulo="El código nace activo. El horario (hora de inicio/fin) solo se ajusta por API por ahora; los días, el canal y las fechas de vigencia sí se eligen aquí."
        anchoClase="max-w-3xl"
        footer={
          <Button type="submit" form="restaurantes-promocion-nueva" className="w-full md:w-auto" loading={creating}>
            Crear código
          </Button>
        }
      >
        <form id="restaurantes-promocion-nueva" onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {errorCrear && (
            <div className="sm:col-span-2">
              <EstadoError titulo="No se pudo crear el código" mensaje={errorCrear} compacto />
            </div>
          )}
          <FormField label="Código">
            <Input
              id="promocion-codigo"
              type="text"
              placeholder="CÓDIGO (ej. BIENVENIDA10)"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              required
            />
          </FormField>
          <FormField label="Nombre para el staff">
            <Input
              id="promocion-nombre"
              type="text"
              placeholder="Nombre para el staff"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>
          <FormField label="Tipo de descuento">
            <NativeSelect
              id="promocion-tipo"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionType }))}
            >
              <option value="percentage">% descuento</option>
              <option value="fixed">$ fijo</option>
              <option value="bogo">2x1</option>
              <option value="cortesia">Combo de cortesía</option>
            </NativeSelect>
          </FormField>
          {form.type !== "bogo" && form.type !== "cortesia" && (
            <FormField label="Valor">
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
            </FormField>
          )}
          <FormField label="Canal">
            <NativeSelect id="promocion-canal" value={form.canal} onChange={(e) => setForm((f) => ({ ...f, canal: e.target.value as "" | PromotionCanal }))}>
              <option value="">Todos los canales</option>
              <option value="recoger">Solo recoger</option>
              <option value="domicilio">Solo domicilio</option>
            </NativeSelect>
          </FormField>
          <Checkbox
            id="promocion-auto"
            checked={form.autoApply}
            onChange={(e) => setForm((f) => ({ ...f, autoApply: e.target.checked }))}
            label="Aplicar automáticamente (sin código, según día y canal). Exige elegir un canal."
            wrapperClassName="sm:col-span-2"
          />
          <fieldset className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <legend className="text-xs text-muted-foreground">Días (vacío = todos)</legend>
            {DAY_LABELS.map((label, d) => (
              <Checkbox
                key={d}
                data-testid={`promocion-dia-${d}`}
                label={label}
                wrapperClassName="text-xs"
                checked={form.days.includes(d)}
                onChange={(e) => setForm((f) => ({ ...f, days: e.target.checked ? [...f.days, d].sort() : f.days.filter((x) => x !== d) }))}
              />
            ))}
          </fieldset>
          {(form.type === "bogo" || form.type === "cortesia") && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label id="promocion-productos-etiqueta" className="text-xs text-muted-foreground">
                {form.type === "bogo" ? "Productos del 2x1 (vacío = todos)" : "Productos que disparan el combo"}
              </Label>
              <div id="promocion-productos" role="group" aria-labelledby="promocion-productos-etiqueta" className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-field border border-input p-3">
                {products?.map((pr) => (
                  <Checkbox
                    key={pr.id}
                    label={pr.name}
                    wrapperClassName="text-sm"
                    checked={form.productIds.includes(pr.id)}
                    onChange={(e) => setForm((f) => ({ ...f, productIds: alternarProducto(f.productIds, pr.id, e.target.checked, products) }))}
                  />
                ))}
              </div>
              {productsError && <p className="m-0 text-xs text-destructive">No se pudo cargar el catálogo: {productsError}</p>}
            </div>
          )}
          {form.type === "cortesia" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label id="promocion-cortesia-etiqueta" className="text-xs text-muted-foreground">
                  Productos de cortesía (el cliente elige)
                </Label>
                <div id="promocion-cortesia" role="group" aria-labelledby="promocion-cortesia-etiqueta" className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-field border border-input p-3">
                  {products?.map((pr) => (
                    <Checkbox
                      key={pr.id}
                      label={pr.name}
                      wrapperClassName="text-sm"
                      checked={form.courtesyProductIds.includes(pr.id)}
                      onChange={(e) => setForm((f) => ({ ...f, courtesyProductIds: alternarProducto(f.courtesyProductIds, pr.id, e.target.checked, products) }))}
                    />
                  ))}
                </div>
              </div>
              <FormField label="Piezas de cortesía por producto">
                <Input id="promocion-cortesia-cantidad" type="number" min="1" max="10" step="1" value={form.courtesyQuantity} onChange={(e) => setForm((f) => ({ ...f, courtesyQuantity: e.target.value }))} />
              </FormField>
            </>
          )}
          <FormField label="Pedido mínimo ($, opc.)">
            <Input
              id="promocion-minimo"
              type="number"
              min="0"
              step="0.01"
              placeholder="Pedido mínimo ($, opc.)"
              value={form.minOrderTotal}
              onChange={(e) => setForm((f) => ({ ...f, minOrderTotal: e.target.value }))}
            />
          </FormField>
          <FormField label="Tope de usos (opc.)">
            <Input
              id="promocion-tope"
              type="number"
              min="1"
              step="1"
              placeholder="Tope de usos (opc.)"
              value={form.maxUses}
              onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            />
          </FormField>
          <FormField label="Vigente desde">
            <Input id="promocion-desde" type="date" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
          </FormField>
          <FormField label="Vigente hasta">
            <Input id="promocion-hasta" type="date" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
          </FormField>
        </form>
      </FormDialog>

      <FormDialog
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
          {errorEdicion && (
            <div className="sm:col-span-2">
              <EstadoError titulo="No se pudo actualizar la vigencia" mensaje={errorEdicion} compacto />
            </div>
          )}
          <FormField label="Vigente desde">
            <Input id="promocion-edit-desde" type="date" value={editStartsAt} onChange={(e) => setEditStartsAt(e.target.value)} />
          </FormField>
          <FormField label="Vigente hasta">
            <Input id="promocion-edit-hasta" type="date" value={editEndsAt} onChange={(e) => setEditEndsAt(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>
    </PageContainer>
  );
}
