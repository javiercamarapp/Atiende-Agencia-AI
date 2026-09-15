// Pedidos de F&B con guardia de alergias (Fase 15, REQ-AB-004, P0/GOB) — hallazgo de
// auditoría (severidad ALTA, "backend real sin pantalla"): GET/POST
// pedidos-fnb, GET .../:orderId, POST .../confirmar-cocina y POST
// .../asegurar-seguridad ya estaban montados y probados del lado del servidor (ver
// apps/api/src/routes/verticals/hoteles/pedidosFnb.ts) pero el rol `fnb` no tenía
// ninguna superficie en el panel. Tres acciones reales, mismo criterio de esta
// vertical que Mantenimiento.tsx (crear/listar + acción de estado con prompt()
// nativo, sin design system nuevo):
//   1. Tomar un pedido (TOMAR_PEDIDO_ROLES: owner/gm/frontdesk/fnb).
//   2. Confirmar en cocina (CONFIRMAR_COCINA_ROLES: owner/gm/fnb) — ÚNICA forma de
//      que un pedido con alergia declarada deje de estar "pendiente de confirmar".
//   3. Asegurar la guardia de seguridad al huésped (mismos roles que 2) — el botón
//      se deshabilita cuando el servidor la rechazaría de todos modos
//      (`puedeAsegurarSeguridad === false`), para que el staff vea la regla de
//      negocio en vez de descubrirla con un 409.
// El gateo por rol aquí es SIEMPRE cosmético: assertVerticalRole en pedidosFnb.ts es
// el enforcement real, ver el comentario de `role` en HotelesShell.tsx.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  asegurarSeguridadFnb,
  confirmarCocinaFnb,
  crearPedidoFnb,
  fetchPedidosFnb,
  FNB_ALLERGY_VIA_LABELS,
} from "../lib/pedidos-fnb-client.ts";
import type { FnbOrderItem, FnbPedido } from "../lib/pedidos-fnb-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const TOMAR_PEDIDO_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "fnb"]);
const CONFIRMAR_COCINA_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "fnb"]);

interface DraftItem {
  readonly nombre: string;
  readonly notas: string;
}

const EMPTY_DRAFT_ITEM: DraftItem = { nombre: "", notas: "" };

export function PedidosFnbPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const canTomarPedido = TOMAR_PEDIDO_ROLES.has(role);
  const canConfirmarCocina = CONFIRMAR_COCINA_ROLES.has(role);

  const [pedidos, setPedidos] = useState<readonly FnbPedido[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [notas, setNotas] = useState("");
  const [alergiaDeclarada, setAlergiaDeclarada] = useState(false);
  const [draftItems, setDraftItems] = useState<readonly DraftItem[]>([EMPTY_DRAFT_ITEM]);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      // Más reciente primero — mismo criterio que Reservas.tsx/Mantenimiento.tsx.
      const list = await fetchPedidosFnb(fetch, apiBaseUrl, token, propertyId);
      setPedidos([...list].sort((a, b) => b.creadoEn.localeCompare(a.creadoEn)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos de F&B.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  function updateDraftItem(index: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addDraftItem() {
    setDraftItems((prev) => [...prev, EMPTY_DRAFT_ITEM]);
  }

  function removeDraftItem(index: number) {
    setDraftItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function resetForm() {
    setRoomId("");
    setNotas("");
    setAlergiaDeclarada(false);
    setDraftItems([EMPTY_DRAFT_ITEM]);
    setFormError(null);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const items: FnbOrderItem[] = draftItems
      .map((it) => ({ nombre: it.nombre.trim(), notas: it.notas.trim() }))
      .filter((it) => it.nombre.length > 0)
      .map((it) => (it.notas ? it : { nombre: it.nombre }));
    if (items.length === 0) return setFormError("Agrega al menos un platillo con nombre.");

    setCreating(true);
    try {
      await crearPedidoFnb(fetch, apiBaseUrl, token, propertyId, {
        roomId: roomId.trim() || undefined,
        items,
        notas: notas.trim() || undefined,
        alergiaDeclarada,
      });
      resetForm();
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el pedido.");
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmarCocina(pedido: FnbPedido) {
    const nota = window.prompt("Nota de confirmación de cocina (opcional):") ?? undefined;
    setBusyId(pedido.id);
    setError(null);
    try {
      await confirmarCocinaFnb(fetch, apiBaseUrl, token, propertyId, pedido.id, nota || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar en cocina.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleAsegurarSeguridad(pedido: FnbPedido) {
    setBusyId(pedido.id);
    setError(null);
    try {
      await asegurarSeguridadFnb(fetch, apiBaseUrl, token, propertyId, pedido.id);
      await load();
    } catch (err) {
      // El servidor responde 409 (fail-closed) si intenta asegurar sin confirmación
      // de cocina — mostramos el mensaje real, nunca lo silenciamos ni lo
      // reinterpretamos como éxito.
      setError(err instanceof Error ? err.message : "No se pudo asegurar la guardia de seguridad.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>Pedidos F&amp;B</h1>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>
            Guardia de alergias (REQ-AB-004): con alergia/restricción declarada, nadie puede afirmarle al huésped que el platillo es seguro hasta que cocina lo confirme.
          </p>
        </div>
        {canTomarPedido && (
          <button
            onClick={() => setShowForm((v) => !v)}
            style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #111827", background: showForm ? "#fff" : "#111827", color: showForm ? "#111827" : "#fff", fontSize: 13, cursor: "pointer" }}
          >
            {showForm ? "Cancelar" : "+ Tomar pedido"}
          </button>
        )}
      </header>

      {showForm && canTomarPedido && (
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10, border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, maxWidth: 480 }}>
          <label style={{ fontSize: 13 }}>
            Habitación (opcional)
            <input value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }} />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Platillos</span>
            {draftItems.map((item, index) => (
              <div key={index} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  value={item.nombre}
                  onChange={(e) => updateDraftItem(index, { nombre: e.target.value })}
                  placeholder="Nombre del platillo"
                  style={{ flex: 1, padding: 8 }}
                />
                <input
                  value={item.notas}
                  onChange={(e) => updateDraftItem(index, { notas: e.target.value })}
                  placeholder="Notas (opcional)"
                  style={{ flex: 1, padding: 8 }}
                />
                <button type="button" onClick={() => removeDraftItem(index)} disabled={draftItems.length <= 1} style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={addDraftItem} style={{ alignSelf: "flex-start", padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}>
              + Agregar platillo
            </button>
          </div>

          <label style={{ fontSize: 13 }}>
            Notas generales (opcional)
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} style={{ display: "block", width: "100%", padding: 8, marginTop: 4, minHeight: 60 }} />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={alergiaDeclarada} onChange={(e) => setAlergiaDeclarada(e.target.checked)} />
            El huésped declaró una alergia/restricción alimentaria
          </label>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>
            Aunque dejes esto sin marcar, el servidor revisa las notas de texto libre y marca el pedido igual si detecta (o no logra descartar) una alergia — fail-closed, ver fnbAllergyGuard.ts.
          </p>

          {formError && (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 13 }}>
              {formError}
            </p>
          )}
          <button type="submit" disabled={creating} style={{ padding: 10, fontWeight: 600, borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", cursor: "pointer" }}>
            {creating ? "Enviando…" : "Tomar pedido"}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!pedidos && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {pedidos && pedidos.length === 0 && <p style={{ color: "#6b7280" }}>Todavía no hay pedidos de F&amp;B.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {pedidos?.map((p) => {
          const pendienteConfirmar = p.alergiaDeclarada && !p.cocineroConfirmoPor;
          return (
            <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{p.roomId ? `Habitación ${p.roomId}` : "Sin habitación"}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                    {p.items.map((it) => it.nombre).join(", ")} · Tomado: {new Date(p.creadoEn).toLocaleString("es-MX")}
                  </p>
                </div>
                {p.alergiaDeclarada && (
                  <span
                    style={{
                      alignSelf: "flex-start",
                      fontSize: 12,
                      padding: "3px 10px",
                      borderRadius: 999,
                      background: pendienteConfirmar ? "#fee2e2" : "#dcfce7",
                      color: pendienteConfirmar ? "#991b1b" : "#166534",
                    }}
                  >
                    Alergia declarada · {pendienteConfirmar ? "Pendiente de confirmar" : "Confirmada por cocina"}
                  </span>
                )}
              </div>

              {p.notas && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#374151" }}>Notas: {p.notas}</p>}
              {p.items.some((it) => it.notas) && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "#6b7280" }}>
                  {p.items.filter((it) => it.notas).map((it, i) => (
                    <li key={i}>
                      {it.nombre}: {it.notas}
                    </li>
                  ))}
                </ul>
              )}

              {p.alergiaDeclarada && p.alergiaDetectadaVia && (
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "#9ca3af" }}>Origen: {FNB_ALLERGY_VIA_LABELS[p.alergiaDetectadaVia]}</p>
              )}

              <p style={{ margin: "8px 0 0", fontSize: 13, color: p.seguridadAseguradaEn ? "#166534" : "#374151" }}>{p.mensajeSeguridad}</p>
              {p.seguridadAseguradaEn && (
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>Asegurado el {new Date(p.seguridadAseguradaEn).toLocaleString("es-MX")}</p>
              )}
              {p.cocineroConfirmoEn && (
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>Cocina confirmó el {new Date(p.cocineroConfirmoEn).toLocaleString("es-MX")}</p>
              )}

              {canConfirmarCocina && (
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {pendienteConfirmar && (
                    <button
                      onClick={() => void handleConfirmarCocina(p)}
                      disabled={busyId === p.id}
                      style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 12, cursor: "pointer" }}
                    >
                      {busyId === p.id ? "…" : "Confirmar en cocina"}
                    </button>
                  )}
                  {!p.seguridadAseguradaEn && (
                    <button
                      onClick={() => void handleAsegurarSeguridad(p)}
                      disabled={busyId === p.id || !p.puedeAsegurarSeguridad}
                      title={!p.puedeAsegurarSeguridad ? "Falta la confirmación de cocina para poder asegurar seguridad." : undefined}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 8,
                        border: "1px solid #111827",
                        background: "#fff",
                        color: p.puedeAsegurarSeguridad ? "#111827" : "#9ca3af",
                        fontSize: 12,
                        cursor: p.puedeAsegurarSeguridad ? "pointer" : "not-allowed",
                      }}
                    >
                      {busyId === p.id ? "…" : "Asegurar seguridad al huésped"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
