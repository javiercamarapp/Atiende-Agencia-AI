// H-29 -- Mensajeria: configuracion editable del canal de WhatsApp (numero de Meta) y del agente de voz de la propiedad. H-P3-03: ademas, los
// "Mensajes automaticos" al huesped por evento (activar, plantilla del catalogo, horas de pre-llegada, enlace de resena) y su historial de envios. Cada
// control llama a un endpoint real (apps/api/.../hoteles/mensajeria-config.ts, solo owner/gm). SIN SECRETOS EN CLARO: la pantalla
// nunca lee el secreto de voz; solo la rotacion lo entrega, UNA vez, y aqui se muestra sin guardarlo en el navegador. No hay token
// de envio por hotel: la plataforma usa una Meta App compartida.
import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, MessageCircle, Phone } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, FormField, Input, StatusBadge, Switch, useConfirm } from "@atiende/ui";
import { MENSAJERIA_ROLES, cambiarVoz, fetchMensajeria, guardarWhatsApp, rotarSecretoVoz } from "../lib/mensajeria-client.ts";
import type { MensajeriaEstado } from "../lib/mensajeria-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";
import { PruebaAgenteVoz } from "../voz/PruebaAgenteVoz.tsx";
import { MensajesAutomaticosSection } from "../components/mensajes-huesped/MensajesAutomaticosSection.tsx";
import type { EntornoVoz } from "../../../lib/voz/adaptador-gemini-live.ts";

function mensaje(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function MensajeriaPage({ apiBaseUrl, token, propertyId, role, entornoVoz }: HotelesShellContext & { readonly entornoVoz?: EntornoVoz }) {
  const [estado, setEstado] = useState<MensajeriaEstado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [numero, setNumero] = useState("");
  const [waHabilitado, setWaHabilitado] = useState(false);
  const [secreto, setSecreto] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const { confirmar, dialogo } = useConfirm();
  const puede = MENSAJERIA_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      const e = await fetchMensajeria(fetch, apiBaseUrl, token, propertyId);
      setEstado(e);
      setNumero(e.whatsapp.phoneNumberId ?? "");
      setWaHabilitado(e.whatsapp.habilitado);
    } catch (err) {
      setError(mensaje(err, "No se pudo cargar la configuración de mensajería."));
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (puede) void load();
  }, [load, puede]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setAviso(null);
    try {
      await fn();
    } catch (err) {
      setError(mensaje(err, "No se pudo completar la acción."));
    } finally {
      setBusy(null);
    }
  }

  if (!puede) {
    return <Callout tone="info">Solo el dueño o la gerencia pueden ver y cambiar la configuración de WhatsApp y del agente de voz.</Callout>;
  }
  if (error && !estado) return <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />;
  if (!estado) return <EstadoCargando etiqueta="Cargando mensajería…" />;

  const numeroValido = /^[0-9]{5,20}$/.test(numero.trim());
  const cambioWa = numero.trim() !== (estado.whatsapp.phoneNumberId ?? "") || waHabilitado !== estado.whatsapp.habilitado;

  return (
    <div className="flex flex-col gap-4">
      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}

      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <MessageCircle className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
              Canal de WhatsApp
            </p>
            <StatusBadge tone={estado.whatsapp.configurado ? (estado.whatsapp.habilitado ? "success" : "neutral") : "warning"}>
              {estado.whatsapp.configurado ? (estado.whatsapp.habilitado ? "Activo" : "Apagado") : "Sin configurar"}
            </StatusBadge>
          </div>
          <p className="text-xs text-muted-foreground">
            El número de WhatsApp de tu hotel decide a qué propiedad llegan los mensajes de los huéspedes. Usa el identificador de número de teléfono de Meta (solo dígitos, lo ves en tu cuenta de WhatsApp Business), no el teléfono. La plataforma usa una sola aplicación de Meta: no se guarda ningún token de tu cuenta.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
            <FormField label="Identificador de número de teléfono (Meta)" hint="De 5 a 20 dígitos" error={numero && !numeroValido ? "Solo dígitos, de 5 a 20." : undefined}>
              <Input inputMode="numeric" value={numero} maxLength={20} onChange={(e) => setNumero(e.target.value.replace(/\s/g, ""))} />
            </FormField>
            <label className="flex items-center gap-2 text-sm text-foreground pb-2">
              <Switch aria-label="Canal de WhatsApp activo" checked={waHabilitado} onCheckedChange={setWaHabilitado} />
              Activo
            </label>
          </div>
          {estado.whatsapp.actualizadoEn && <p className="text-xs text-muted-foreground">Última actualización: {estado.whatsapp.actualizadoEn.slice(0, 16).replace("T", " ")}</p>}
          <Button
            type="button"
            className="self-start"
            disabled={!numeroValido || !cambioWa || busy === "wa"}
            onClick={() =>
              void run("wa", async () => {
                const cambiaNumero = numero.trim() !== (estado.whatsapp.phoneNumberId ?? "");
                if (cambiaNumero && estado.whatsapp.configurado) {
                  const ok = await confirmar({ titulo: "Cambiar el número de WhatsApp", descripcion: "Los mensajes de los huéspedes dejarán de llegar al número anterior. Confirma que el nuevo identificador es el de tu hotel.", confirmar: "Cambiar número", cancelar: "Volver" });
                  if (!ok) return;
                }
                await guardarWhatsApp(fetch, apiBaseUrl, token, propertyId, { phoneNumberId: numero.trim(), habilitado: waHabilitado });
                setAviso("Canal de WhatsApp guardado.");
                await load();
              })
            }
          >
            {busy === "wa" ? "Guardando…" : "Guardar canal"}
          </Button>
        </CardContent>
      </Card>

      <MensajesAutomaticosSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />

      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <Phone className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
              Agente de voz
            </p>
            <StatusBadge tone={estado.voz.configurado ? (estado.voz.habilitado ? "success" : "neutral") : "warning"}>
              {estado.voz.configurado ? (estado.voz.habilitado ? "Activo" : "Apagado") : "Sin configurar"}
            </StatusBadge>
          </div>
          <p className="text-xs text-muted-foreground">
            Las herramientas de voz de tu agente se autentican con un secreto propio de esta propiedad. El secreto lo genera el servidor, se muestra una sola vez al crearlo o rotarlo y después ya no se puede ver: guárdalo en la configuración de tu agente de voz. Al rotarlo, el anterior deja de funcionar al instante.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                aria-label="Agente de voz activo"
                checked={estado.voz.habilitado}
                disabled={!estado.voz.configurado || busy === "voz"}
                onCheckedChange={(v) =>
                  void run("voz", async () => {
                    await cambiarVoz(fetch, apiBaseUrl, token, propertyId, v);
                    setAviso(v ? "Agente de voz activado." : "Agente de voz apagado.");
                    await load();
                  })
                }
              />
              Activo
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy === "rotar"}
              onClick={() =>
                void run("rotar", async () => {
                  if (estado.voz.secretoConfigurado) {
                    const ok = await confirmar({ titulo: "Rotar el secreto de voz", descripcion: "El secreto actual dejará de funcionar de inmediato y tendrás que actualizarlo en tu agente de voz.", tono: "danger", confirmar: "Rotar secreto", cancelar: "Volver" });
                    if (!ok) return;
                  }
                  const r = await rotarSecretoVoz(fetch, apiBaseUrl, token, propertyId);
                  setSecreto(r.secreto);
                  setCopiado(false);
                  await load();
                })
              }
            >
              <KeyRound className="w-4 h-4" strokeWidth={1.75} />
              {busy === "rotar" ? "Generando…" : estado.voz.secretoConfigurado ? "Rotar secreto" : "Generar secreto"}
            </Button>
          </div>
          {!estado.voz.configurado && <p className="text-xs text-muted-foreground">Genera el secreto para poder activar el agente de voz.</p>}
          {estado.voz.secretoConfigurado && !secreto && <p className="text-xs text-muted-foreground">Secreto configurado (no se puede ver).</p>}
          {secreto && (
            <Callout
              tone="warning"
              titulo="Guarda este secreto ahora"
              accion={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(secreto).then(() => setCopiado(true));
                  }}
                >
                  <Copy className="w-3.5 h-3.5" strokeWidth={1.75} />
                  {copiado ? "Copiado" : "Copiar"}
                </Button>
              }
              onDismiss={() => setSecreto(null)}
            >
              <code className="block break-all font-mono text-xs">{secreto}</code>
              <span className="block mt-1 text-xs">No se vuelve a mostrar. Si lo pierdes, genera uno nuevo.</span>
            </Callout>
          )}
        </CardContent>
      </Card>

      <PruebaAgenteVoz apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} {...(entornoVoz ? { entorno: entornoVoz } : {})} />
      {dialogo}
    </div>
  );
}
