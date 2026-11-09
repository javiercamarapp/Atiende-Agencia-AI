// Reglas del autopiloto por sucursal (solo owner/admin; el servidor lo exige). Valores seguros por omision: cancelacion automatica y aceptacion
// automatica APAGADAS (las decide el dueno). Tambien muestra, sin fingir, lo que todavia no esta disponible: plantillas de WhatsApp sin aprobar en
// Meta (los avisos fuera de la ventana de 24 h no saldran) y el avance desde el POS (requiere la API de SoftRestaurant).
import { useEffect, useState } from "react";
import { Button, Callout, Checkbox, EstadoError, FormDialog, FormField, Input, notify, useT } from "@atiende/ui";
import { restaurantesAutopiloto } from "@atiende/ui/i18n/restaurantes/autopiloto";
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
  const t = useT(restaurantesAutopiloto);
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
      <FormDialog open={open} onOpenChange={onOpenChange} titulo={t("restaurantes.autopiloto.reglas.titulo")} anchoClase="max-w-2xl" footer={<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("restaurantes.autopiloto.reglas.cerrar")}</Button>}>
        {error ? <EstadoError mensaje={error} onReintentar={onReintentar ? () => void onReintentar() : undefined} /> : <p className="text-sm text-muted-foreground">{t("restaurantes.autopiloto.reglas.cargando")}</p>}
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
    if (aprobacion === null) e.aprobacionMinutos = t("restaurantes.autopiloto.reglas.rango.1a240min");
    if (handoff === null) e.handoffRegresoMinutos = t("restaurantes.autopiloto.reglas.rango.1a240min");
    if (noRecogido === null) e.noRecogidoMinutos = t("restaurantes.autopiloto.reglas.rango.5a720min");
    if (completado === null) e.completadoHoras = t("restaurantes.autopiloto.reglas.rango.1a72h");
    if (tope === null) e.compensacionTopePct = t("restaurantes.autopiloto.reglas.rango.1a100");
    if (extra === null) e.saturacionExtraMinutos = t("restaurantes.autopiloto.reglas.rango.5a120min");
    if (form.saturacionUmbral1.trim() !== "" && u1 === null) e.saturacionUmbral1 = t("restaurantes.autopiloto.reglas.rango.umbral1");
    if (form.saturacionUmbral2.trim() !== "" && (u2 === null || u1 === null || u2 <= u1)) e.saturacionUmbral2 = t("restaurantes.autopiloto.reglas.rango.umbral2");
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
      notify.success(t("restaurantes.autopiloto.reglas.guardadas"));
      await onGuardado();
      onOpenChange(false);
    } catch (err) {
      setErrorServidor(err instanceof Error ? err.message : t("restaurantes.autopiloto.reglas.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  const sinAprobar = datos.plantillas.filter((p) => !p.aprobada);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={t("restaurantes.autopiloto.reglas.titulo")}
      subtitulo={t("restaurantes.autopiloto.reglas.subtitulo")}
      anchoClase="max-w-2xl"
      onGuardar={() => void guardar()}
      guardando={guardando}
      textoBotonGuardar={t("restaurantes.autopiloto.reglas.guardar")}
      bloquearCierre={guardando}
    >
      <div className="grid gap-3">
        {errorServidor && <Callout tone="danger">{errorServidor}</Callout>}
        {!datos.disponible && <Callout tone="warning">{t("restaurantes.autopiloto.reglas.noDisponible")}</Callout>}
        <Checkbox
          label={t("restaurantes.autopiloto.reglas.cancelacionAgente")}
          checked={form.cancelacionAgente}
          onChange={(e) => set("cancelacionAgente", e.target.checked)}
        />
        <Checkbox
          label={t("restaurantes.autopiloto.reglas.cancelacionAuto")}
          checked={form.cancelacionAuto}
          onChange={(e) => set("cancelacionAuto", e.target.checked)}
        />
        <Callout tone="info">{t("restaurantes.autopiloto.reglas.porAprobarInfo")}</Callout>
        <Checkbox
          label={t("restaurantes.autopiloto.reglas.aceptacionAuto")}
          checked={form.aceptacionAuto}
          onChange={(e) => set("aceptacionAuto", e.target.checked)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t("restaurantes.autopiloto.reglas.aprobacionMinutos")} error={errores.aprobacionMinutos} hint={t("restaurantes.autopiloto.reglas.aprobacionAyuda")}>
            <Input inputMode="numeric" value={form.aprobacionMinutos} onChange={(e) => set("aprobacionMinutos", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.handoffMinutos")} error={errores.handoffRegresoMinutos} hint={t("restaurantes.autopiloto.reglas.handoffAyuda")}>
            <Input inputMode="numeric" value={form.handoffRegresoMinutos} onChange={(e) => set("handoffRegresoMinutos", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.noRecogidoMinutos")} error={errores.noRecogidoMinutos} hint={t("restaurantes.autopiloto.reglas.noRecogidoAyuda")}>
            <Input inputMode="numeric" value={form.noRecogidoMinutos} onChange={(e) => set("noRecogidoMinutos", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.completadoHoras")} error={errores.completadoHoras}>
            <Input inputMode="numeric" value={form.completadoHoras} onChange={(e) => set("completadoHoras", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.topeDescuento")} error={errores.compensacionTopePct}>
            <Input inputMode="numeric" value={form.compensacionTopePct} onChange={(e) => set("compensacionTopePct", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.extraMinutos")} error={errores.saturacionExtraMinutos}>
            <Input inputMode="numeric" value={form.saturacionExtraMinutos} onChange={(e) => set("saturacionExtraMinutos", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.umbral1")} error={errores.saturacionUmbral1} hint={t("restaurantes.autopiloto.reglas.vacioApagado")}>
            <Input inputMode="numeric" value={form.saturacionUmbral1} onChange={(e) => set("saturacionUmbral1", e.target.value)} />
          </FormField>
          <FormField label={t("restaurantes.autopiloto.reglas.umbral2")} error={errores.saturacionUmbral2} hint={t("restaurantes.autopiloto.reglas.vacioApagado")}>
            <Input inputMode="numeric" value={form.saturacionUmbral2} onChange={(e) => set("saturacionUmbral2", e.target.value)} />
          </FormField>
        </div>
        {form.saturacionUmbral2.trim() !== "" && (
          <Callout tone="info">{t("restaurantes.autopiloto.reglas.pausaNoDisponible")}</Callout>
        )}
        {sinAprobar.length > 0 && (
          <Callout tone="warning">
            {t("restaurantes.autopiloto.reglas.plantillasSinAprobar", { lista: sinAprobar.map((p) => p.nombre).join(", ") })}
          </Callout>
        )}
        {!datos.posReal && <Callout tone="info">{t("restaurantes.autopiloto.reglas.posNoDisponible")}</Callout>}

      </div>
    </FormDialog>
  );
}
