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
import { Button, Callout, Card, CardContent, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, Label, Selector, PageContainer, StatusBadge, formatMoney, localeActivo, useT } from "@atiende/ui";
import type { Traductor } from "@atiende/ui";
import { restaurantesPromociones } from "@atiende/ui/i18n/restaurantes/promociones";
import { restaurantesReglas } from "@atiende/ui/i18n/restaurantes/reglas";
import { NOMBRES_DIAS } from "../lib/modelo-pm-client.ts";
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

/** Dom..Sáb en el idioma activo (mismas etiquetas que el horario de la sucursal). */
const DAY_LABELS: readonly string[] = NOMBRES_DIAS;

function formatValue(t: Traductor, type: PromotionType, value: number): string {
  if (type === "bogo") return t("restaurantes.promociones.valor.bogo");
  if (type === "cortesia") return t("restaurantes.promociones.valor.cortesia");
  return type === "percentage" ? t("restaurantes.promociones.valor.porcentaje", { valor: value }) : t("restaurantes.promociones.valor.fijo", { valor: formatMoney(value) });
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
  const t = useT(restaurantesPromociones);
  if (!puedeEn(ctx.role, "promociones.ver")) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">{t("restaurantes.promociones.titulo")}</h1>
        <Callout tone="info">{t("restaurantes.promociones.soloDueno")}</Callout>
      </PageContainer>
    );
  }
  return <PromocionesContenido {...ctx} />;
}

function PromocionesContenido({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const t = useT(restaurantesPromociones, restaurantesReglas);
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
    fetchProducts(fetch, apiBaseUrl, token, propertyId).then(setProducts, (err) => setProductsError(err instanceof Error ? err.message : t("restaurantes.promociones.error.catalogo")));
  }, [apiBaseUrl, token, propertyId]);

  async function load() {
    setError(null);
    try {
      setPromotions(await fetchPromotions(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.promociones.error.cargar"));
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
      setErrorCrear(t("restaurantes.promociones.error.codigoNombre"));
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      setErrorCrear(t(form.type === "percentage" ? "restaurantes.promociones.error.valorPct" : "restaurantes.promociones.error.valor"));
      return;
    }
    // Mismas reglas que el servidor (que re-valida): automatica exige canal; cortesia exige listas y cantidad.
    if (form.autoApply && form.canal === "") {
      setErrorCrear(t("restaurantes.promociones.error.canal"));
      return;
    }
    if (form.type === "cortesia" && (form.productIds.length === 0 || form.courtesyProductIds.length === 0 || !(Number(form.courtesyQuantity) >= 1))) {
      setErrorCrear(t("restaurantes.promociones.error.cortesia"));
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
      setErrorCrear(err instanceof Error ? err.message : t("restaurantes.promociones.error.crear"));
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
      setErrorEdicion(err instanceof Error ? err.message : t("restaurantes.promociones.error.vigencia"));
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
      setError(err instanceof Error ? err.message : t("restaurantes.promociones.error.estado"));
    } finally {
      setTogglingId(null);
    }
  }

  const promocionEnEdicion = promotions?.find((p) => p.id === editingId) ?? null;

  return (
    <PageContainer padding="none">
      <header className="flex flex-wrap items-center justify-end gap-3">
        <h1 className="sr-only">{t("restaurantes.promociones.titulo")}</h1>
        <Button
          type="button"
          onClick={() => {
            setErrorCrear(null);
            setModalCrearAbierto(true);
          }}
        >
          <Plus />
          {t("restaurantes.promociones.crearNuevo")}
        </Button>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <section className="flex flex-col gap-2">
        <p className="m-0 text-sm font-semibold text-foreground">{t("restaurantes.promociones.existentes")}</p>
        {!promotions && !error && <EstadoCargando etiqueta={t("restaurantes.promociones.cargando")} />}
        {promotions && promotions.length === 0 && <EstadoVacio mensaje={t("restaurantes.promociones.vacio")} />}
        {promotions && promotions.length > 0 && (
          <div className="flex flex-col gap-2">
            {promotions.map((p) => (
              <Card key={p.id} className={p.isActive ? undefined : "opacity-60"}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div>
                    <div className="m-0 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-foreground">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{p.code}</code>
                      <span>· {p.name}</span>
                      {p.autoApply && <StatusBadge tone="neutral" dot={false}>{t("restaurantes.promociones.automatica")}</StatusBadge>}
                      {p.channels && p.channels.length > 0 && <StatusBadge tone="neutral" dot={false}>{p.channels.map((c) => t(c === "recoger" ? "restaurantes.promociones.soloRecoger" : "restaurantes.promociones.soloDomicilio")).join(" / ")}</StatusBadge>}
                      {!p.isActive && (
                        <StatusBadge tone="neutral" dot={false} className="text-muted-foreground">
                          {t("restaurantes.promociones.inactiva")}
                        </StatusBadge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatValue(t, p.type, p.value)}
                      {p.minOrderTotal !== null ? t("restaurantes.promociones.pedidoMin", { monto: formatMoney(p.minOrderTotal) }) : ""}
                      {p.maxUses !== null ? t("restaurantes.promociones.usadoDe", { usos: p.timesUsed, max: p.maxUses }) : t("restaurantes.promociones.usadoVeces", { usos: p.timesUsed })}
                      {p.daysOfWeek && p.daysOfWeek.length > 0 ? ` · ${p.daysOfWeek.map((d) => DAY_LABELS[d]).join("/")}` : ""}
                      {p.startTime && p.endTime ? ` · ${p.startTime}-${p.endTime}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("restaurantes.promociones.vigencia", {
                        desde: p.startsAt ? new Date(p.startsAt).toLocaleDateString(localeActivo()) : t("restaurantes.promociones.sinInicio"),
                        hasta: p.endsAt ? new Date(p.endsAt).toLocaleDateString(localeActivo()) : t("restaurantes.promociones.sinFin"),
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => startEdit(p)}>
                      <CalendarRange />
                      {t("restaurantes.promociones.editarVigencia")}
                    </Button>
                    <Button
                      type="button"
                      variant={p.isActive ? "danger" : "outline"}
                      size="sm"
                      onClick={() => void handleToggleActive(p)}
                      loading={togglingId === p.id}
                    >
                      {t(p.isActive ? "restaurantes.promociones.desactivar" : "restaurantes.promociones.activar")}
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
        titulo={t("restaurantes.promociones.crearNuevo")}
        subtitulo={t("restaurantes.promociones.crearSub")}
        anchoClase="max-w-3xl"
        footer={
          <Button type="submit" form="restaurantes-promocion-nueva" className="w-full md:w-auto" loading={creating}>
            {t("restaurantes.promociones.crearCodigo")}
          </Button>
        }
      >
        <form id="restaurantes-promocion-nueva" onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {errorCrear && (
            <div className="sm:col-span-2">
              <EstadoError titulo={t("restaurantes.promociones.error.crearCodigo")} mensaje={errorCrear} compacto />
            </div>
          )}
          <FormField label={t("restaurantes.promociones.codigo")}>
            <Input
              id="promocion-codigo"
              type="text"
              placeholder={t("restaurantes.promociones.codigoPh")}
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              required
            />
          </FormField>
          <FormField label={t("restaurantes.promociones.nombreStaff")}>
            <Input
              id="promocion-nombre"
              type="text"
              placeholder={t("restaurantes.promociones.nombreStaff")}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>
          <FormField label={t("restaurantes.promociones.tipo")}>
            <Selector
              id="promocion-tipo"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionType }))}
            >
              <option value="percentage">{t("restaurantes.promociones.tipo.porcentaje")}</option>
              <option value="fixed">{t("restaurantes.promociones.tipo.fijo")}</option>
              <option value="bogo">{t("restaurantes.promociones.valor.bogo")}</option>
              <option value="cortesia">{t("restaurantes.promociones.valor.cortesia")}</option>
            </Selector>
          </FormField>
          {form.type !== "bogo" && form.type !== "cortesia" && (
            <FormField label={t("restaurantes.promociones.valor")}>
              <Input
                id="promocion-valor"
                type="number"
                min="0"
                step="0.01"
                placeholder={t(form.type === "percentage" ? "restaurantes.promociones.valorPctPh" : "restaurantes.promociones.valorFijoPh")}
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                required
              />
            </FormField>
          )}
          <FormField label={t("restaurantes.promociones.canal")}>
            <Selector id="promocion-canal" value={form.canal} onChange={(e) => setForm((f) => ({ ...f, canal: e.target.value as "" | PromotionCanal }))}>
              <option value="">{t("restaurantes.promociones.todosCanales")}</option>
              <option value="recoger">{t("restaurantes.promociones.soloRecoger")}</option>
              <option value="domicilio">{t("restaurantes.promociones.soloDomicilio")}</option>
            </Selector>
          </FormField>
          <Checkbox
            id="promocion-auto"
            checked={form.autoApply}
            onChange={(e) => setForm((f) => ({ ...f, autoApply: e.target.checked }))}
            label={t("restaurantes.promociones.autoAplicar")}
            wrapperClassName="sm:col-span-2"
          />
          <fieldset className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <legend className="text-xs text-muted-foreground">{t("restaurantes.promociones.dias")}</legend>
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
                {t(form.type === "bogo" ? "restaurantes.promociones.productosBogo" : "restaurantes.promociones.productosDisparan")}
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
              {productsError && <p className="m-0 text-xs text-destructive">{t("restaurantes.promociones.error.catalogoDetalle", { detalle: productsError })}</p>}
            </div>
          )}
          {form.type === "cortesia" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label id="promocion-cortesia-etiqueta" className="text-xs text-muted-foreground">
                  {t("restaurantes.promociones.productosCortesia")}
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
              <FormField label={t("restaurantes.promociones.piezasCortesia")}>
                <Input id="promocion-cortesia-cantidad" type="number" min="1" max="10" step="1" value={form.courtesyQuantity} onChange={(e) => setForm((f) => ({ ...f, courtesyQuantity: e.target.value }))} />
              </FormField>
            </>
          )}
          <FormField label={t("restaurantes.promociones.pedidoMinimo")}>
            <Input
              id="promocion-minimo"
              type="number"
              min="0"
              step="0.01"
              placeholder={t("restaurantes.promociones.pedidoMinimo")}
              value={form.minOrderTotal}
              onChange={(e) => setForm((f) => ({ ...f, minOrderTotal: e.target.value }))}
            />
          </FormField>
          <FormField label={t("restaurantes.promociones.topeUsos")}>
            <Input
              id="promocion-tope"
              type="number"
              min="1"
              step="1"
              placeholder={t("restaurantes.promociones.topeUsos")}
              value={form.maxUses}
              onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            />
          </FormField>
          <FormField label={t("restaurantes.promociones.vigenteDesde")}>
            <Input id="promocion-desde" type="date" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
          </FormField>
          <FormField label={t("restaurantes.promociones.vigenteHasta")}>
            <Input id="promocion-hasta" type="date" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
          </FormField>
        </form>
      </FormDialog>

      <FormDialog
        open={editingId !== null}
        onOpenChange={(abierto) => !abierto && setEditingId(null)}
        titulo={t("restaurantes.promociones.editarVigencia")}
        subtitulo={promocionEnEdicion ? `${promocionEnEdicion.code} · ${promocionEnEdicion.name}` : undefined}
        anchoClase="max-w-2xl"
        guardando={savingEdit}
        textoBotonGuardar={t("restaurantes.promociones.guardar")}
        onGuardar={() => {
          if (editingId) void handleSaveEdit(editingId);
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {errorEdicion && (
            <div className="sm:col-span-2">
              <EstadoError titulo={t("restaurantes.promociones.error.vigenciaTitulo")}
 mensaje={errorEdicion} compacto />
            </div>
          )}
          <FormField label={t("restaurantes.promociones.vigenteDesde")}>
            <Input id="promocion-edit-desde" type="date" value={editStartsAt} onChange={(e) => setEditStartsAt(e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.promociones.vigenteHasta")}>
            <Input id="promocion-edit-hasta" type="date" value={editEndsAt} onChange={(e) => setEditEndsAt(e.target.value)} />
          </FormField>
        </div>
      </FormDialog>
    </PageContainer>
  );
}
