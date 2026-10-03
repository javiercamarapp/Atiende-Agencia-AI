// Prueba del agente de voz de HOTELES dentro de la configuracion del agente (Mensajeria): estado honesto de la escalera y llamada de prueba real con el
// orbe compartido (packages/ui). Sin credenciales NO se simula nada: se dice que falta y el boton no aparece. La llamada de prueba usa el prompt del agente de
// hoteles y el microfono del navegador; NO consulta disponibilidad ni aparta habitaciones (el token efimero fija voz y comportamiento, sin herramientas).
import { useEffect, useMemo, useState } from "react";
import { Mic } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, StatusBadge, VistaPreviaLlamada } from "@atiende/ui";
import { crearFabricaGeminiLive } from "../../../lib/voz/adaptador-gemini-live.ts";
import type { EntornoVoz } from "../../../lib/voz/adaptador-gemini-live.ts";
import { entornoNavegador } from "../../../lib/voz/entorno-navegador.ts";
import { useSesionVoz } from "../../../lib/voz/useSesionVoz.ts";
import { NOMBRE_ESCALON, crearSesionPreviewVoz, fetchEstadoVoz, formatoUsdPorMinuto } from "../lib/voz-client.ts";
import type { EstadoVozHoteles } from "../lib/voz-client.ts";

export interface PruebaAgenteVozProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Solo pruebas: entorno de navegador falso (WebSocket, microfono, audio). */
  readonly entorno?: EntornoVoz;
}

export function PruebaAgenteVoz({ apiBaseUrl, token, propertyId, entorno }: PruebaAgenteVozProps) {
  const [estado, setEstado] = useState<EstadoVozHoteles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState(false);

  useEffect(() => {
    let cancelado = false;
    setEstado(null);
    setError(null);
    (async () => {
      try {
        const e = await fetchEstadoVoz(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setEstado(e);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo comprobar el estado de la voz.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <>
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <Mic className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
              Probar el agente de voz
            </p>
            {estado && <StatusBadge tone={estado.escalera.operativa ? "success" : "warning"}>{estado.escalera.operativa ? "Voz operativa" : "Requiere credenciales"}</StatusBadge>}
          </div>
          {!estado && !error && <EstadoCargando etiqueta="Comprobando el servicio de voz…" />}
          {error && <Callout tone="warning">No se pudo comprobar el servicio de voz: {error}</Callout>}
          {estado && (
            <>
              <p className="text-xs text-muted-foreground">
                Tu agente corre sobre la misma plataforma de voz que el resto de los negocios: Gemini Live como principal y, si falla o no hay llave, una cascada de respaldo; si ninguna responde, la llamada pasa a una persona de tu hotel con callback.
              </p>
              <ul className="flex flex-col gap-1.5" data-testid="escalera-voz">
                {estado.escalera.escalones.map((e) => (
                  <li key={e.escalon} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-foreground">{NOMBRE_ESCALON[e.escalon]}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {e.configurado ? `${formatoUsdPorMinuto(estado.precioMicroUsdPorMinuto[e.escalon])} por minuto (estimado)` : e.detalle}
                      </span>
                      <StatusBadge tone={e.configurado ? "success" : "neutral"}>{e.configurado ? "Configurado" : "Falta"}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
              {estado.preview.disponible ? (
                <>
                  <Button type="button" className="self-start" onClick={() => setAbierta(true)}>
                    <Mic className="h-4 w-4 mr-1.5" strokeWidth={1.75} />
                    Hacer llamada de prueba
                  </Button>
                  <p className="text-xs text-muted-foreground">Es una llamada real de prueba con el comportamiento de tu agente. No consulta disponibilidad ni aparta habitaciones, y usa tu micrófono: el navegador te pedirá permiso.</p>
                </>
              ) : (
                <Callout tone="info" data-testid="preview-no-disponible">
                  No disponible aún: {estado.preview.motivo ?? "el servicio de voz no está activo para este negocio."}
                </Callout>
              )}
            </>
          )}
        </CardContent>
      </Card>
      {abierta && <LlamadaDePrueba apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} entorno={entorno ?? entornoNavegador} onCerrar={() => setAbierta(false)} />}
    </>
  );
}

interface LlamadaDePruebaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly entorno: EntornoVoz;
  readonly onCerrar: () => void;
}

function LlamadaDePrueba({ apiBaseUrl, token, propertyId, entorno, onCerrar }: LlamadaDePruebaProps) {
  const fabrica = useMemo(() => crearFabricaGeminiLive({ entorno, crearSesion: () => crearSesionPreviewVoz(fetch, apiBaseUrl, token, propertyId) }), [entorno, apiBaseUrl, token, propertyId]);
  const controller = useSesionVoz(fabrica);
  return (
    <div className="fixed inset-0 z-40 bg-background" data-testid="llamada-de-prueba">
      <div className="relative h-full">
        <VistaPreviaLlamada
          controller={controller}
          nombreAgente="Agente de voz"
          nombreSucursal="Llamada de prueba"
          onCerrar={onCerrar}
          videoSrc={`${import.meta.env.BASE_URL}media/orbe-agente.mp4`}
        />
      </div>
    </div>
  );
}
