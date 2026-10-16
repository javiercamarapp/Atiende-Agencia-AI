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
import { Plus, X } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  Checkbox,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  PageContainer,
  PageHeader,
  StatusBadge,
  Textarea,
  notify,
  useConfirm,
} from "@atiende/ui";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
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
  const { pedirTexto, dialogo } = useConfirm();

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

  async function handleCreate() {
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
      notify.success("Pedido tomado.");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el pedido.");
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmarCocina(pedido: FnbPedido) {
    const nota = await pedirTexto({
      titulo: "Confirmar en cocina",
      descripcion: "Confirma que cocina revisó la alergia o restricción declarada de este pedido.",
      confirmar: "Confirmar en cocina",
      campo: { etiqueta: "Nota de confirmación de cocina (opcional)", requerido: false, multilinea: true },
    });
    if (nota === null) return;
    setBusyId(pedido.id);
    setError(null);
    try {
      await confirmarCocinaFnb(fetch, apiBaseUrl, token, propertyId, pedido.id, nota || undefined);
      notify.success("Pedido confirmado en cocina.");
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
      notify.success("Seguridad al huésped asegurada.");
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
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Pedidos F&B"
        descripcion="Guardia de alergias (REQ-AB-004): con alergia o restricción declarada, nadie puede afirmarle al huésped que el platillo es seguro hasta que cocina lo confirme."
        acciones={
          canTomarPedido ? (
            <Button type="button" iconLeft={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => setShowForm(true)}>
              Tomar pedido
            </Button>
          ) : undefined
        }
      />

      {canTomarPedido && (
        <FormDialog
          open={showForm}
          onOpenChange={(o) => {
            setShowForm(o);
            if (!o) setFormError(null);
          }}
          titulo="Tomar pedido"
          subtitulo="Captura los platillos y declara cualquier alergia o restricción."
          onGuardar={() => void handleCreate()}
          guardando={creating}
          textoBotonGuardar="Tomar pedido"
          anchoClase="max-w-2xl"
        >
          <div className="grid gap-4">
            <FormField label="Habitación (opcional)">
              <Input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </FormField>

            <div className="grid gap-2">
              <span className="text-sm font-semibold text-foreground">Platillos</span>
              {draftItems.map((item, index) => (
                <div key={index} className="flex gap-2 items-start">
                  <Input aria-label={`Platillo ${index + 1}`} value={item.nombre} onChange={(e) => updateDraftItem(index, { nombre: e.target.value })} placeholder="Nombre del platillo" className="flex-1" />
                  <Input aria-label={`Notas del platillo ${index + 1}`} value={item.notas} onChange={(e) => updateDraftItem(index, { notas: e.target.value })} placeholder="Notas (opcional)" className="flex-1" />
                  <Button type="button" variant="outline" size="icon" aria-label={`Quitar platillo ${index + 1}`} onClick={() => removeDraftItem(index)} disabled={draftItems.length <= 1}>
                    <X className="size-4" strokeWidth={1.75} />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={addDraftItem}>
                + Agregar platillo
              </Button>
            </div>

            <FormField label="Notas generales (opcional)">
              <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} />
            </FormField>

            <FormField
              label="El huésped declaró una alergia/restricción alimentaria"
              hint="Aunque dejes esto sin marcar, el servidor revisa las notas de texto libre y marca el pedido igual si detecta (o no logra descartar) una alergia — fail-closed, ver fnbAllergyGuard.ts."
            >
              <Checkbox checked={alergiaDeclarada} onChange={(e) => setAlergiaDeclarada(e.target.checked)} />
            </FormField>

            {formError && <Callout tone="danger">{formError}</Callout>}
          </div>
        </FormDialog>
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
                      {p.items.map((it) => it.nombre).join(", ")} · Tomado: {fechaHoraEsMx(p.creadoEn)}
                    </p>
                  </div>
                  {p.alergiaDeclarada && (
                    <StatusBadge tone={pendienteConfirmar ? "danger" : "neutral"} className="self-start">
                      Alergia declarada · {pendienteConfirmar ? "Pendiente de confirmar" : "Confirmada por cocina"}
                    </StatusBadge>
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
                  <p className="mt-1.5 text-xs text-muted-foreground">Origen: {FNB_ALLERGY_VIA_LABELS[p.alergiaDetectadaVia]}</p>
                )}

                <p className={`mt-2 text-sm ${p.seguridadAseguradaEn ? "text-success" : "text-foreground"}`}>{p.mensajeSeguridad}</p>
                {p.seguridadAseguradaEn && <p className="mt-0.5 text-xs text-muted-foreground">Asegurado el {fechaHoraEsMx(p.seguridadAseguradaEn)}</p>}
                {p.cocineroConfirmoEn && <p className="mt-0.5 text-xs text-muted-foreground">Cocina confirmó el {fechaHoraEsMx(p.cocineroConfirmoEn)}</p>}

                {canConfirmarCocina && (
                  <div className="mt-2.5 flex gap-2 flex-wrap">
                    {pendienteConfirmar && (
                      <Button type="button" size="sm" onClick={() => void handleConfirmarCocina(p)} loading={busyId === p.id} disabled={busyId === p.id}>
                        Confirmar en cocina
                      </Button>
                    )}
                    {!p.seguridadAseguradaEn && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleAsegurarSeguridad(p)}
                        loading={busyId === p.id}
                        disabled={busyId === p.id || !p.puedeAsegurarSeguridad}
                        title={!p.puedeAsegurarSeguridad ? "Falta la confirmación de cocina para poder asegurar seguridad." : undefined}
                      >
                        Asegurar seguridad al huésped
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {dialogo}
    </PageContainer>
  );
}
