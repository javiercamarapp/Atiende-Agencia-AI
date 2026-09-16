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
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza
// botones/tarjetas/inputs de estilos inline por Button/Card/Badge/Input/Label
// reales — mismo criterio ya aplicado en HotelesShell.tsx/Login.tsx. Ningún cambio
// de lógica: mismos props, mismo estado, mismas llamadas de red, misma condición
// de cada rama.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Badge, Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label } from "@atiende/ui";
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
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-display font-semibold text-foreground">Pedidos F&amp;B</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Guardia de alergias (REQ-AB-004): con alergia/restricción declarada, nadie puede afirmarle al huésped que el platillo es seguro hasta que cocina lo confirme.
          </p>
        </div>
        {canTomarPedido && (
          <Button type="button" variant={showForm ? "outline" : "default"} onClick={() => setShowForm((v) => !v)}>
            {!showForm && <Plus className="w-4 h-4" strokeWidth={1.75} />}
            {showForm ? "Cancelar" : "Tomar pedido"}
          </Button>
        )}
      </header>

      {showForm && canTomarPedido && (
        <Card className="max-w-lg">
          <CardContent className="p-4">
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <div>
                <Label htmlFor="fnb-room">Habitación (opcional)</Label>
                <Input id="fnb-room" value={roomId} onChange={(e) => setRoomId(e.target.value)} className="mt-1" />
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-foreground">Platillos</span>
                {draftItems.map((item, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <Input value={item.nombre} onChange={(e) => updateDraftItem(index, { nombre: e.target.value })} placeholder="Nombre del platillo" className="flex-1" />
                    <Input value={item.notas} onChange={(e) => updateDraftItem(index, { notas: e.target.value })} placeholder="Notas (opcional)" className="flex-1" />
                    <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={() => removeDraftItem(index)} disabled={draftItems.length <= 1}>
                      <X className="w-4 h-4" strokeWidth={1.75} />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={addDraftItem}>
                  + Agregar platillo
                </Button>
              </div>

              <div>
                <Label htmlFor="fnb-notas">Notas generales (opcional)</Label>
                <textarea
                  id="fnb-notas"
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  className="mt-1 flex w-full min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={alergiaDeclarada} onChange={(e) => setAlergiaDeclarada(e.target.checked)} className="accent-primary" />
                El huésped declaró una alergia/restricción alimentaria
              </label>
              <p className="text-[11px] text-muted-foreground">
                Aunque dejes esto sin marcar, el servidor revisa las notas de texto libre y marca el pedido igual si detecta (o no logra descartar) una alergia — fail-closed, ver fnbAllergyGuard.ts.
              </p>

              {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" disabled={creating}>
                {creating ? "Enviando…" : "Tomar pedido"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {!pedidos && !error && <EstadoCargando etiqueta="Cargando pedidos…" />}
      {pedidos && pedidos.length === 0 && <EstadoVacio mensaje="Todavía no hay pedidos de F&B." />}

      <div className="flex flex-col gap-3">
        {pedidos?.map((p) => {
          const pendienteConfirmar = p.alergiaDeclarada && !p.cocineroConfirmoPor;
          return (
            <Card key={p.id}>
              <CardContent className="p-4">
                <div className="flex justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-semibold text-foreground">{p.roomId ? `Habitación ${p.roomId}` : "Sin habitación"}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.items.map((it) => it.nombre).join(", ")} · Tomado: {new Date(p.creadoEn).toLocaleString("es-MX")}
                    </p>
                  </div>
                  {p.alergiaDeclarada && (
                    <Badge variant={pendienteConfirmar ? "destructive" : "secondary"} className="self-start">
                      Alergia declarada · {pendienteConfirmar ? "Pendiente de confirmar" : "Confirmada por cocina"}
                    </Badge>
                  )}
                </div>

                {p.notas && <p className="mt-2 text-sm text-foreground">Notas: {p.notas}</p>}
                {p.items.some((it) => it.notas) && (
                  <ul className="mt-1.5 pl-4 text-xs text-muted-foreground list-disc">
                    {p.items.filter((it) => it.notas).map((it, i) => (
                      <li key={i}>
                        {it.nombre}: {it.notas}
                      </li>
                    ))}
                  </ul>
                )}

                {p.alergiaDeclarada && p.alergiaDetectadaVia && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">Origen: {FNB_ALLERGY_VIA_LABELS[p.alergiaDetectadaVia]}</p>
                )}

                <p className={`mt-2 text-sm ${p.seguridadAseguradaEn ? "text-green-700 dark:text-green-500" : "text-foreground"}`}>{p.mensajeSeguridad}</p>
                {p.seguridadAseguradaEn && <p className="mt-0.5 text-[11px] text-muted-foreground">Asegurado el {new Date(p.seguridadAseguradaEn).toLocaleString("es-MX")}</p>}
                {p.cocineroConfirmoEn && <p className="mt-0.5 text-[11px] text-muted-foreground">Cocina confirmó el {new Date(p.cocineroConfirmoEn).toLocaleString("es-MX")}</p>}

                {canConfirmarCocina && (
                  <div className="mt-2.5 flex gap-2 flex-wrap">
                    {pendienteConfirmar && (
                      <Button type="button" size="sm" onClick={() => void handleConfirmarCocina(p)} disabled={busyId === p.id}>
                        {busyId === p.id ? "…" : "Confirmar en cocina"}
                      </Button>
                    )}
                    {!p.seguridadAseguradaEn && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleAsegurarSeguridad(p)}
                        disabled={busyId === p.id || !p.puedeAsegurarSeguridad}
                        title={!p.puedeAsegurarSeguridad ? "Falta la confirmación de cocina para poder asegurar seguridad." : undefined}
                      >
                        {busyId === p.id ? "…" : "Asegurar seguridad al huésped"}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
