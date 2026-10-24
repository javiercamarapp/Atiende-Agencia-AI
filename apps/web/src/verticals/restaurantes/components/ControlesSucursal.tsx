// Controles de una sucursal en la lista (paridad con el repo suelto): interruptores del agente de VOZ y de WHATSAPP y «Copiar ID».
// Backend real, sin maqueta: voz = PUT .../admin/voz/config (reemplaza la config completa: se reenvia la guardada con `habilitado` nuevo);
// WhatsApp = PUT .../admin/config/sucursales/:id/agente-whatsapp (interruptor duro 053). Ambos exigen owner/admin en el servidor y dejan
// bitacora de auditoria; aqui el interruptor se deshabilita para quien no puede (cosmetico) y se explica por que.
import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Button, Switch, notify, useConfirm } from "@atiende/ui";
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
        (e) => setWa({ fase: "error", mensaje: e instanceof Error ? e.message : "No se pudo leer el agente de WhatsApp." }),
      ),
      fetchVozConfig(fetch, apiBaseUrl, token, branchId).then(
        (v) => setVoz({ fase: "listo", valor: v }),
        (e) => setVoz({ fase: "error", mensaje: e instanceof Error ? e.message : "No se pudo leer el agente de voz." }),
      ),
    ]);
  }, [apiBaseUrl, token, propertyId, branchId, puedeCambiar]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cambiarWhatsapp(activo: boolean) {
    if (!activo) {
      const ok = await confirmar({
        titulo: `Apagar el agente de WhatsApp de ${branchName}`,
        descripcion: "El agente dejará de contestar los mensajes de esta sucursal: el cliente recibirá un aviso de que lo atenderá una persona y su conversación llegará a Conversaciones. ¿Apagarlo?",
        tono: "danger",
        confirmar: "Apagar agente",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    setGuardando("wa");
    try {
      const v = await updateInterruptorAgenteWhatsapp(fetch, apiBaseUrl, token, propertyId, branchId, activo);
      setWa({ fase: "listo", valor: { disponible: v.disponible, activo: v.agenteActivo } });
      notify.success(activo ? `Agente de WhatsApp encendido en ${branchName}.` : `Agente de WhatsApp apagado en ${branchName}.`);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "No se pudo cambiar el agente de WhatsApp.");
    } finally {
      setGuardando(null);
    }
  }

  async function cambiarVoz(habilitado: boolean) {
    if (voz.fase !== "listo" || voz.valor === null) return;
    const actual = voz.valor;
    if (!habilitado) {
      const ok = await confirmar({
        titulo: `Apagar el agente de voz de ${branchName}`,
        descripcion: "El agente dejará de contestar las llamadas de esta sucursal. ¿Apagarlo?",
        tono: "danger",
        confirmar: "Apagar agente",
        cancelar: "Volver",
      });
      if (!ok) return;
    }
    setGuardando("voz");
    try {
      const nueva = await updateVozConfig(fetch, apiBaseUrl, token, branchId, { ...actual, habilitado });
      setVoz({ fase: "listo", valor: nueva });
      notify.success(habilitado ? `Agente de voz encendido en ${branchName}.` : `Agente de voz apagado en ${branchName}.`);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "No se pudo cambiar el agente de voz.");
    } finally {
      setGuardando(null);
    }
  }

  async function copiarId() {
    try {
      await navigator.clipboard.writeText(branchId);
      notify.success("ID de la sucursal copiado.");
    } catch {
      notify.error("No se pudo copiar el ID. Selecciónalo y cópialo a mano.");
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
          aria-label={`Agente de voz activo, ${branchName}`}
          checked={voz.fase === "listo" && voz.valor !== null && voz.valor.habilitado}
          disabled={!puedeCambiar || voz.fase !== "listo" || vozSinConfig || guardando !== null}
          onCheckedChange={(v) => void cambiarVoz(v)}
        />
        <label htmlFor={`ctrl-voz-${branchId}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Voz
        </label>
        {voz.fase === "error" && <span className="text-xs text-danger">No se pudo leer</span>}
        {vozSinConfig && <span className="text-xs text-muted-foreground">Sin configurar</span>}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`ctrl-wa-${branchId}`}
          aria-label={`Agente de WhatsApp activo, ${branchName}`}
          checked={wa.fase === "listo" && wa.valor.activo}
          disabled={!puedeCambiar || wa.fase !== "listo" || waNoDisponible || guardando !== null}
          onCheckedChange={(v) => void cambiarWhatsapp(v)}
        />
        <label htmlFor={`ctrl-wa-${branchId}`} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          WhatsApp
        </label>
        {wa.fase === "error" && <span className="text-xs text-danger">No se pudo leer</span>}
        {waNoDisponible && <span className="text-xs text-muted-foreground">No disponible aún</span>}
      </div>
      {(wa.fase === "error" || voz.fase === "error") && (
        <Button type="button" variant="link" size="xs" onClick={() => void cargar()}>
          Volver a leer agentes
        </Button>
      )}
      </>)}
      <Button type="button" variant="ghost" size="xs" onClick={() => void copiarId()} aria-label={`Copiar ID de ${branchName}`}>
        <Copy aria-hidden="true" />
        Copiar ID
      </Button>
      {dialogo}
    </div>
  );
}
