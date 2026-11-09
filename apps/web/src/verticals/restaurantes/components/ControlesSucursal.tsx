// Controles de una sucursal en la lista (paridad con el repo suelto): interruptores del agente de VOZ y de WHATSAPP y «Copiar ID».
// Backend real, sin maqueta: voz = PUT .../admin/voz/config (reemplaza la config completa: se reenvia la guardada con `habilitado` nuevo);
// WhatsApp = PUT .../admin/config/sucursales/:id/agente-whatsapp (interruptor duro 053). Ambos exigen owner/admin en el servidor y dejan
// bitacora de auditoria; aqui el interruptor se deshabilita para quien no puede (cosmetico) y se explica por que.
import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Button, Switch, notify, useConfirm, useT } from "@atiende/ui";
import { restaurantesSucursales } from "@atiende/ui/i18n/restaurantes/sucursales";
import { fetchInterruptorAgenteWhatsapp, updateInterruptorAgenteWhatsapp } from "../lib/conocimiento-client.ts";
import { fetchVozConfig, updateVozConfig } from "../lib/voz-client.ts";
import type { VozConfig } from "../lib/voz-client.ts";

type Estado<T> = { readonly fase: "cargando" } | { readonly fase: "error"; readonly mensaje: string } | { readonly fase: "listo"; readonly valor: T };

export interface ControlesSucursalProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Organizacion (propertyId del shell): ruta del interruptor de WhatsApp. */
  readonly propertyId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly puedeCambiar: boolean;
}

export function ControlesSucursal({ apiBaseUrl, token, propertyId, branchId, branchName, puedeCambiar }: ControlesSucursalProps) {
  const t = useT(restaurantesSucursales);
  const { confirmar, dialogo } = useConfirm();
  const [wa, setWa] = useState<Estado<{ disponible: boolean; activo: boolean }>>({ fase: "cargando" });
  const [voz, setVoz] = useState<Estado<VozConfig | null>>({ fase: "cargando" });
  const [guardando, setGuardando] = useState<"voz" | "wa" | null>(null);

  const cargar = useCallback(async () => {
    // El servidor solo deja leer el estado de los agentes a owner/admin: al resto no se le pide (evita un 403 inutil) y no se le muestran los interruptores.
    if (!puedeCambiar) return;
    setWa({ fase: "cargando" });
    setVoz({ fase: "cargando" });
    await Promise.all([
      fetchInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId).then(
        (v) => setWa({ fase: "listo", valor: { disponible: v.disponible, activo: v.agenteActivo } }),
        (e) => setWa({ fase: "error", mensaje: e instanceof Error ? e.message : t("restaurantes.sucursales.ctrl.errorWa") }),
      ),
      fetchVozConfig(fetch, apiBaseUrl, token, branchId).then(
        (v) => setVoz({ fase: "listo", valor: v }),
        (e) => setVoz({ fase: "error", mensaje: e instanceof Error ? e.message : t("restaurantes.sucursales.ctrl.errorVoz") }),
      ),
    ]);
  }, [apiBaseUrl, token, propertyId, branchId, puedeCambiar]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cambiarWhatsapp(activo: boolean) {
    if (!activo) {
      const ok = await confirmar({
        titulo: t("restaurantes.sucursales.ctrl.apagarWaTitulo", { sucursal: branchName }),
        descripcion: t("restaurantes.sucursales.ctrl.apagarWaDesc"),
        tono: "danger",
        confirmar: t("restaurantes.sucursales.ctrl.apagarAgente"),
        cancelar: t("restaurantes.sucursales.ctrl.volver"),
      });
      if (!ok) return;
    }
    setGuardando("wa");
    try {
      const v = await updateInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId, activo);
      setWa({ fase: "listo", valor: { disponible: v.disponible, activo: v.agenteActivo } });
      notify.success(t(activo ? "restaurantes.sucursales.ctrl.waEncendido" : "restaurantes.sucursales.ctrl.waApagado", { sucursal: branchName }));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t("restaurantes.sucursales.ctrl.errorCambiarWa"));
    } finally {
      setGuardando(null);
    }
  }

  async function cambiarVoz(habilitado: boolean) {
    if (voz.fase !== "listo" || voz.valor === null) return;
    if (!habilitado) {
      const ok = await confirmar({
        titulo: t("restaurantes.sucursales.ctrl.apagarVozTitulo", { sucursal: branchName }),
        descripcion: t("restaurantes.sucursales.ctrl.apagarVozDesc"),
        tono: "danger",
        confirmar: t("restaurantes.sucursales.ctrl.apagarAgente"),
        cancelar: t("restaurantes.sucursales.ctrl.volver"),
      });
      if (!ok) return;
    }
    setGuardando("voz");
    try {
      // El PUT reemplaza la config completa: se relee justo antes de escribir para no pisar ediciones hechas desde que se cargo la lista (lost-update).
      const fresca = await fetchVozConfig(fetch, apiBaseUrl, token, branchId);
      if (fresca === null) {
        setVoz({ fase: "listo", valor: null });
        notify.error(t("restaurantes.sucursales.ctrl.vozSinConfig"));
        return;
      }
      // updateVozConfig arma el cuerpo solo con campos editables (habilitado, proveedor, voz, comportamiento, saludo): nada de solo lectura.
      const nueva = await updateVozConfig(fetch, apiBaseUrl, token, branchId, { ...fresca, habilitado });
      setVoz({ fase: "listo", valor: nueva });
      notify.success(t(habilitado ? "restaurantes.sucursales.ctrl.vozEncendido" : "restaurantes.sucursales.ctrl.vozApagado", { sucursal: branchName }));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t("restaurantes.sucursales.ctrl.errorCambiarVoz"));
    } finally {
      setGuardando(null);
    }
  }

  async function copiarId() {
    try {
      await navigator.clipboard.writeText(branchId);
      notify.success(t("restaurantes.sucursales.ctrl.idCopiado"));
    } catch {
      notify.error(t("restaurantes.sucursales.ctrl.errorCopiar"));
    }
  }

  const vozSinConfig = voz.fase === "listo" && voz.valor === null;
  const waNoDisponible = wa.fase === "listo" && !wa.valor.disponible;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid={`controles-sucursal-${branchId}`}>
      {puedeCambiar && (<>
      <div className="flex items-center gap-2">
        <Switch
          id={`ctrl-voz-${branchId}`}
          aria-label={t("restaurantes.sucursales.ctrl.vozActivo", { sucursal: branchName })}
          checked={voz.fase === "listo" && voz.valor !== null && voz.valor.habilitado}
          disabled={voz.fase !== "listo" || vozSinConfig || guardando !== null}
          onCheckedChange={(v) => void cambiarVoz(v)}
        />
        <label htmlFor={`ctrl-voz-${branchId}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("restaurantes.sucursales.ctrl.voz")}
        </label>
        {voz.fase === "error" && <span role="status" aria-live="polite" className="text-xs text-danger">{t("restaurantes.sucursales.ctrl.noSePudoLeer")}</span>}
        {vozSinConfig && <span role="status" aria-live="polite" className="text-xs text-muted-foreground">{t("restaurantes.sucursales.ctrl.sinConfigurar")}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`ctrl-wa-${branchId}`}
          aria-label={t("restaurantes.sucursales.ctrl.waActivo", { sucursal: branchName })}
          checked={wa.fase === "listo" && wa.valor.activo}
          disabled={wa.fase !== "listo" || waNoDisponible || guardando !== null}
          onCheckedChange={(v) => void cambiarWhatsapp(v)}
        />
        <label htmlFor={`ctrl-wa-${branchId}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("restaurantes.sucursales.ctrl.whatsapp")}
        </label>
        {wa.fase === "error" && <span role="status" aria-live="polite" className="text-xs text-danger">{t("restaurantes.sucursales.ctrl.noSePudoLeer")}</span>}
        {waNoDisponible && <span role="status" aria-live="polite" className="text-xs text-muted-foreground">{t("restaurantes.sucursales.ctrl.noDisponible")}</span>}
      </div>
      {(wa.fase === "error" || voz.fase === "error") && (
        <Button type="button" variant="link" size="xs" onClick={() => void cargar()}>
          {t("restaurantes.sucursales.ctrl.volverALeer")}
        </Button>
      )}
      </>)}
      <Button type="button" variant="ghost" size="xs" onClick={() => void copiarId()} aria-label={t("restaurantes.sucursales.ctrl.copiarIdAria", { sucursal: branchName })}>
        <Copy aria-hidden="true" />
        {t("restaurantes.sucursales.ctrl.copiarId")}

      </Button>
      {dialogo}
    </div>
  );
}
