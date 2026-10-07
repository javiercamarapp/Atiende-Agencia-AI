// Reglas del autopiloto por sucursal (solo owner/admin; el servidor lo exige). Valores seguros por omision: cancelacion automatica y aceptacion
// automatica APAGADAS (las decide el dueno). Tambien muestra, sin fingir, lo que todavia no esta disponible: plantillas de WhatsApp sin aprobar en
// Meta (los avisos fuera de la ventana de 24 h no saldran) y el avance desde el POS (requiere la API de SoftRestaurant).
import { useEffect, useState } from "react";
import { Button, Callout, Checkbox, EstadoError, FormDialog, FormField, Input, notify } from "@atiende/ui";
import { guardarAutopilotoConfig } from "../lib/autopiloto-client.ts";
import type { AutopilotoConfigRespuesta } from "../lib/autopiloto-client.ts";

interface Form {
  /** Regla de TODA la organizacion: el agente de WhatsApp gestiona las cancelaciones que pide el cliente. */
  cancelacionAgente: boolean;
  cancelacionAuto: boolean;
  aceptacionAuto: boolean;
  aprobacionMinutos: string;
  handoffRegresoMinutos: string;
  noRecogidoMinutos: string;
  completadoHoras: string;
  compensacionTopePct: string;
  saturacionUmbral1: string;
  saturacionUmbral2: string;
  saturacionExtraMinutos: string;
}

function formDesde(r: AutopilotoConfigRespuesta): Form {
  const c = r.config;
  return {
    cancelacionAgente: r.org?.cancelacionAgente ?? false,
    cancelacionAuto: c.cancelacionAuto,
    aceptacionAuto: c.aceptacionAuto,
    aprobacionMinutos: String(c.aprobacionMinutos),
    handoffRegresoMinutos: String(c.handoffRegresoMinutos),
    noRecogidoMinutos: String(c.noRecogidoMinutos),
    completadoHoras: String(c.completadoHoras),
    compensacionTopePct: String(c.compensacionTopePct),
    saturacionUmbral1: c.saturacionUmbral1 === null ? "" : String(c.saturacionUmbral1),
    saturacionUmbral2: c.saturacionUmbral2 === null ? "" : String(c.saturacionUmbral2),
    saturacionExtraMinutos: String(c.saturacionExtraMinutos),
  };
}

function entero(valor: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(valor.trim())) return null;
  const n = Number(valor);
  return n >= min && n <= max ? n : null;
}

export function AutopilotoReglasDialogo({
  open,
  onOpenChange,
  datos,
  error = null,
  onReintentar,
  apiBaseUrl,
  token,
  propertyId,
  onGuardado,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly datos: AutopilotoConfigRespuesta | null;
  /** Falla de la carga de las reglas: se muestra con Reintentar en lugar de 'Cargando reglas…'. */
  readonly error?: string | null;
  readonly onReintentar?: () => Promise<void> | void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onGuardado: () => Promise<void>;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [errores, setErrores] = useState<Partial<Record<keyof Form, string>>>({});
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (open && datos) {
      setForm(formDesde(datos));
      setErrores({});
      setErrorServidor(null);
    }
  }, [open, datos]);

  if (!datos || !form) {
    return (
      <FormDialog open={open} onOpenChange={onOpenChange} titulo="Reglas del autopiloto" anchoClase="max-w-2xl" footer={<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>}>
        {error ? <EstadoError mensaje={error} onReintentar={onReintentar ? () => void onReintentar() : undefined} /> : <p className="text-sm text-muted-foreground">Cargando reglas…</p>}
      </FormDialog>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function guardar() {
    if (!form) return;
    const e: Partial<Record<keyof Form, string>> = {};
    const aprobacion = entero(form.aprobacionMinutos, 1, 240);
    const handoff = entero(form.handoffRegresoMinutos, 1, 240);
    const noRecogido = entero(form.noRecogidoMinutos, 5, 720);
    const completado = entero(form.completadoHoras, 1, 72);
    const tope = entero(form.compensacionTopePct, 1, 100);
    const extra = entero(form.saturacionExtraMinutos, 5, 120);
    const u1 = form.saturacionUmbral1.trim() === "" ? null : entero(form.saturacionUmbral1, 1, 500);
    const u2 = form.saturacionUmbral2.trim() === "" ? null : entero(form.saturacionUmbral2, 1, 500);
    if (aprobacion === null) e.aprobacionMinutos = "De 1 a 240 minutos.";
    if (handoff === null) e.handoffRegresoMinutos = "De 1 a 240 minutos.";
    if (noRecogido === null) e.noRecogidoMinutos = "De 5 a 720 minutos.";
    if (completado === null) e.completadoHoras = "De 1 a 72 horas.";
    if (tope === null) e.compensacionTopePct = "De 1 a 100.";
    if (extra === null) e.saturacionExtraMinutos = "De 5 a 120 minutos.";
    if (form.saturacionUmbral1.trim() !== "" && u1 === null) e.saturacionUmbral1 = "De 1 a 500 pedidos, o vacío para apagar.";
    if (form.saturacionUmbral2.trim() !== "" && (u2 === null || u1 === null || u2 <= u1)) e.saturacionUmbral2 = "Debe ser mayor que el primer umbral (y éste debe existir).";
    setErrores(e);
    if (Object.keys(e).length > 0) return;
    setGuardando(true);
    setErrorServidor(null);
    try {
      await guardarAutopilotoConfig(fetch, apiBaseUrl, token, propertyId, {
        cancelacionAgente: form.cancelacionAgente,
        cancelacionAuto: form.cancelacionAuto,
        aceptacionAuto: form.aceptacionAuto,
        aprobacionMinutos: aprobacion!,
        handoffRegresoMinutos: handoff!,
        noRecogidoMinutos: noRecogido!,
        completadoHoras: completado!,
        compensacionTopePct: tope!,
        saturacionUmbral1: u1,
        saturacionUmbral2: u2,
        saturacionExtraMinutos: extra!,
      });
      notify.success("Reglas del autopiloto guardadas.");
      await onGuardado();
      onOpenChange(false);
    } catch (err) {
      setErrorServidor(err instanceof Error ? err.message : "No se pudieron guardar las reglas.");
    } finally {
      setGuardando(false);
    }
  }

  const sinAprobar = datos.plantillas.filter((p) => !p.aprobada);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo="Reglas del autopiloto"
      subtitulo="Aplican a esta sucursal. Lo que mueve dinero, cancela algo ya en cocina o es un pedido grande siempre pide una aprobación con un clic."
      anchoClase="max-w-2xl"
      onGuardar={() => void guardar()}
      guardando={guardando}
      textoBotonGuardar="Guardar reglas"
      bloquearCierre={guardando}
    >
      <div className="grid gap-3">
        {errorServidor && <Callout tone="danger">{errorServidor}</Callout>}
        {!datos.disponible && <Callout tone="warning">Las reglas todavía no están disponibles en esta cuenta (falta aplicar la actualización de base de datos). Se muestran los valores seguros por omisión.</Callout>}
        <Checkbox
          label="Que el agente de WhatsApp gestione las cancelaciones que pide el cliente: avisa a la sucursal y, si el pedido aún no está en cocina y la regla de abajo lo permite, lo cancela (toda la organización; apagado por omisión)"
          checked={form.cancelacionAgente}
          onChange={(e) => set("cancelacionAgente", e.target.checked)}
        />
        <Checkbox
          label="Cancelar solo, sin pedir aprobación, un pedido que el cliente cancela antes de que llegue a cocina (apagado por omisión)"
          checked={form.cancelacionAuto}
          onChange={(e) => set("cancelacionAuto", e.target.checked)}
        />
        <Callout tone="info">Pedidos grandes y cancelaciones por voz: todavía sin efecto, porque el agente aún no los usa (requiere el cableado del umbral de pedido grande y de la voz, en otro PR). Las cancelaciones y las quejas de WhatsApp sí llegan a «Por aprobar».</Callout>
        <Checkbox
          label="Aceptar solo el pedido (de Recibido a Preparando) en cuanto la comanda se imprime o se captura, sin POS (apagado por omisión)"
          checked={form.aceptacionAuto}
          onChange={(e) => set("aceptacionAuto", e.target.checked)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Minutos sin respuesta antes de avisar al dueño" error={errores.aprobacionMinutos} hint="Nunca se aprueba solo.">
            <Input inputMode="numeric" value={form.aprobacionMinutos} onChange={(e) => set("aprobacionMinutos", e.target.value)} />
          </FormField>
          <FormField label="Minutos para devolver una conversación al agente" error={errores.handoffRegresoMinutos} hint="Sin respuesta humana.">
            <Input inputMode="numeric" value={form.handoffRegresoMinutos} onChange={(e) => set("handoffRegresoMinutos", e.target.value)} />
          </FormField>
          <FormField label="Minutos para marcar «No recogido»" error={errores.noRecogidoMinutos} hint="Después de la hora de recogida.">
            <Input inputMode="numeric" value={form.noRecogidoMinutos} onChange={(e) => set("noRecogidoMinutos", e.target.value)} />
          </FormField>
          <FormField label="Horas para pasar Entregado a Completado" error={errores.completadoHoras}>
            <Input inputMode="numeric" value={form.completadoHoras} onChange={(e) => set("completadoHoras", e.target.value)} />
          </FormField>
          <FormField label="Tope del descuento por queja (%)" error={errores.compensacionTopePct}>
            <Input inputMode="numeric" value={form.compensacionTopePct} onChange={(e) => set("compensacionTopePct", e.target.value)} />
          </FormField>
          <FormField label="Minutos extra al prometer por saturación" error={errores.saturacionExtraMinutos}>
            <Input inputMode="numeric" value={form.saturacionExtraMinutos} onChange={(e) => set("saturacionExtraMinutos", e.target.value)} />
          </FormField>
          <FormField label="Pedidos abiertos para alargar el tiempo prometido" error={errores.saturacionUmbral1} hint="Vacío = apagado.">
            <Input inputMode="numeric" value={form.saturacionUmbral1} onChange={(e) => set("saturacionUmbral1", e.target.value)} />
          </FormField>
          <FormField label="Pedidos abiertos para proponer pausar la sucursal" error={errores.saturacionUmbral2} hint="Vacío = apagado.">
            <Input inputMode="numeric" value={form.saturacionUmbral2} onChange={(e) => set("saturacionUmbral2", e.target.value)} />
          </FormField>
        </div>
        {form.saturacionUmbral2.trim() !== "" && (
          <Callout tone="info">Pausar la sucursal desde el sistema todavía no está disponible: el segundo umbral se guarda, pero hoy no genera ninguna acción.</Callout>
        )}
        {sinAprobar.length > 0 && (
          <Callout tone="warning">
            Plantillas de WhatsApp sin aprobar en Meta: {sinAprobar.map((p) => p.nombre).join(", ")}. Sus avisos solo salen dentro de la ventana de 24 h del cliente; fuera de ella no se envían.
          </Callout>
        )}
        {!datos.posReal && <Callout tone="info">El avance de estados desde el POS no está disponible aún: requiere la API de SoftRestaurant.</Callout>}
      </div>
    </FormDialog>
  );
}
