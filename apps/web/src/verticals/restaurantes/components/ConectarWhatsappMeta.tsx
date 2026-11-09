// «Conectar mi número con Meta» (WhatsApp Embedded Signup) para una sucursal. Detras de configuracion: si el servidor dice que no
// esta disponible, se muestra el estado honesto «no disponible aún» con lo que falta (nombres de variables, sin valores) y nada mas.
import { useEffect, useState } from "react";
import { Button, Callout } from "@atiende/ui";
import { conectarEmbeddedSignup, correrEmbeddedSignup, fetchConfigEmbeddedSignup } from "../lib/whatsapp-embedded-signup.ts";
import type { ConfigEmbeddedSignup, ResultadoEmbeddedSignup } from "../lib/whatsapp-embedded-signup.ts";

export interface ConectarWhatsappMetaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly branchId: string;
  readonly fetchImpl?: typeof fetch;
  /** Inyectable en pruebas (abre el flujo de Meta). */
  readonly correrFlujo?: typeof correrEmbeddedSignup;
  /** Al conectar: la pantalla recarga el numero guardado. */
  readonly onConectado: (phoneNumberId: string) => void;
}

export function ConectarWhatsappMeta({ apiBaseUrl, token, propertyId, branchId, fetchImpl = fetch, correrFlujo = correrEmbeddedSignup, onConectado }: ConectarWhatsappMetaProps) {
  const [cfg, setCfg] = useState<ConfigEmbeddedSignup | null>(null);
  const [errorCfg, setErrorCfg] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoEmbeddedSignup | null>(null);

  useEffect(() => {
    let vivo = true;
    fetchConfigEmbeddedSignup(fetchImpl, apiBaseUrl, token, propertyId, branchId)
      .then((c) => vivo && setCfg(c))
      .catch(() => vivo && setErrorCfg(true));
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId, branchId, fetchImpl]);

  async function conectar() {
    if (!cfg?.appId || !cfg.configId) return;
    setTrabajando(true);
    setError(null);
    try {
      const datos = await correrFlujo({ appId: cfg.appId, configId: cfg.configId, graphApiVersion: cfg.graphApiVersion });
      const r = await conectarEmbeddedSignup(fetchImpl, apiBaseUrl, token, propertyId, branchId, datos);
      setResultado(r);
      onConectado(r.phoneNumberId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar el número.");
    } finally {
      setTrabajando(false);
    }
  }

  if (errorCfg) return null;
  if (!cfg) return null;
  if (!cfg.disponible) {
    return (
      <Callout tone="neutral" data-testid={`es-no-disponible-${branchId}`}>
        Conectar tu propio número desde aquí no está disponible aún: requiere configurar la app de Meta de la plataforma ({cfg.faltantes.join(", ")}). Mientras tanto, pide a soporte que conecte tu número.
      </Callout>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid={`es-${branchId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void conectar()} disabled={trabajando} loading={trabajando}>
          Conectar mi número con Meta
        </Button>
        <span className="text-xs text-muted-foreground">Abre una ventana de Meta para elegir o crear tu cuenta de WhatsApp Business y tu número.</span>
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {resultado && (
        <Callout tone="success" titulo="Número conectado">
          {resultado.numero ?? resultado.phoneNumberId}
          {resultado.nombreVerificado ? ` (${resultado.nombreVerificado})` : ""} ya recibe y envía mensajes de esta sucursal. Guarda este PIN de verificación en dos pasos de tu número: <strong>{resultado.pin}</strong>. No lo volveremos a mostrar.
        </Callout>
      )}
    </div>
  );
}
