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
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import {
  createPromotion,
  fetchPromotions,
  setPromotionActive,
  updatePromotion,
} from "../lib/promotions-client.ts";
import type { Promotion, PromotionType } from "../lib/promotions-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const DAY_LABELS: readonly string[] = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function formatValue(type: PromotionType, value: number): string {
  return type === "percentage" ? `${value}%` : `$${value.toFixed(2)}`;
}

function formatDateInput(iso: string | null): string {
  if (!iso) return "";
  // <input type="date"> quiere YYYY-MM-DD.
  return iso.slice(0, 10);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 860 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Promociones</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 }}>
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Crear un código nuevo</p>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            placeholder="CÓDIGO (ej. BIENVENIDA10)"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            required
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, minWidth: 200 }}
          />
          <input
            type="text"
            placeholder="Nombre para el staff"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, minWidth: 200 }}
          />
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PromotionType }))}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
          >
            <option value="percentage">% descuento</option>
            <option value="fixed">$ fijo</option>
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder={form.type === "percentage" ? "Valor (0-100)" : "Valor ($)"}
            value={form.value}
            onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
            required
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: 130 }}
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Pedido mínimo ($, opc.)"
            value={form.minOrderTotal}
            onChange={(e) => setForm((f) => ({ ...f, minOrderTotal: e.target.value }))}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: 160 }}
          />
          <input
            type="number"
            min="1"
            step="1"
            placeholder="Tope de usos (opc.)"
            value={form.maxUses}
            onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, width: 150 }}
          />
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#6b7280" }}>
            Vigente desde
            <input
              type="date"
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#6b7280" }}>
            Vigente hasta
            <input
              type="date"
              value={form.endsAt}
              onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
            />
          </label>
          <button type="submit" disabled={creating} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 13, cursor: "pointer" }}>
            {creating ? "Creando…" : "Crear código"}
          </button>
        </form>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9ca3af" }}>
          El código nace activo. Días y horario de vigencia solo se pueden ajustar por API por ahora — la fecha de inicio/fin y la vigencia sí se editan aquí.
        </p>
      </section>

      <section>
        <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>Códigos existentes</p>
        {!promotions && !error && <EstadoCargando etiqueta="Cargando promociones…" />}
        {promotions && promotions.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna promoción creada." />}
        {promotions && promotions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {promotions.map((p) => (
              <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, opacity: p.isActive ? 1 : 0.6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                      <code style={{ background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>{p.code}</code> · {p.name}
                    </p>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>
                      {formatValue(p.type, p.value)} de descuento
                      {p.minOrderTotal !== null ? ` · pedido mín. $${p.minOrderTotal.toFixed(2)}` : ""}
                      {p.maxUses !== null ? ` · usado ${p.timesUsed}/${p.maxUses}` : ` · usado ${p.timesUsed} veces`}
                      {p.daysOfWeek && p.daysOfWeek.length > 0 ? ` · ${p.daysOfWeek.map((d) => DAY_LABELS[d]).join("/")}` : ""}
                      {p.startTime && p.endTime ? ` · ${p.startTime}-${p.endTime}` : ""}
                    </p>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>
                      Vigencia: {p.startsAt ? new Date(p.startsAt).toLocaleDateString("es-MX") : "sin inicio"} → {p.endsAt ? new Date(p.endsAt).toLocaleDateString("es-MX") : "sin fin"}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}
                    >
                      Editar vigencia
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleActive(p)}
                      disabled={togglingId === p.id}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 8,
                        border: p.isActive ? "1px solid #fecaca" : "1px solid #bbf7d0",
                        background: "#fff",
                        color: p.isActive ? "#b91c1c" : "#15803d",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {togglingId === p.id ? "Guardando…" : p.isActive ? "Desactivar" : "Activar"}
                    </button>
                  </div>
                </div>

                {editingId === p.id && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #f3f4f6", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#6b7280" }}>
                      Vigente desde
                      <input
                        type="date"
                        value={editStartsAt}
                        onChange={(e) => setEditStartsAt(e.target.value)}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#6b7280" }}>
                      Vigente hasta
                      <input
                        type="date"
                        value={editEndsAt}
                        onChange={(e) => setEditEndsAt(e.target.value)}
                        style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit(p.id)}
                      disabled={savingEdit}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 12, cursor: "pointer" }}
                    >
                      {savingEdit ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      disabled={savingEdit}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}
                    >
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
