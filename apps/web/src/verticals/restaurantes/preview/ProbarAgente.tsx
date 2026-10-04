// «Probar agente» (cuenta real): conversa con el agente de WhatsApp REAL en modo preview. El servidor corre las mismas herramientas pero
// SIN efectos (pedido simulado PRUEBA-xxxx; nada se escribe ni se avisa a nadie) y no guarda la conversacion: el historial vive aqui.
// Prueba el BORRADOR del formulario (sin guardar) cuando el dueno lo pide. Sin proveedor de IA el servidor responde 503 y esta pantalla dice
// "No disponible: requiere OPENROUTER_API_KEY": nunca hay respuestas por palabras clave. Componentes de @atiende/ui, sin estilos propios.
import { useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw, Send } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, FormField, Input, NativeSelect } from "@atiende/ui";
import { enviarMensajePrueba } from "../lib/agente-whatsapp-client.ts";
import type { ConfigAgenteForm, MensajePrueba } from "../lib/agente-whatsapp-client.ts";
import { fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerSummary } from "../lib/customers-client.ts";
import { pedidoSimuladoDe } from "../lib/voz-client.ts";
import type { PedidoSimulado } from "../lib/voz-client.ts";
import { TarjetaPedidoSimulado } from "./TarjetaPedidoSimulado.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Configuracion del formulario (sin guardar): se usa solo si el dueno marca «Probar con los cambios sin guardar». */
  readonly borrador: ConfigAgenteForm;
}

function nuevaSesion(): string {
  return crypto.randomUUID();
}

export function ProbarAgente({ apiBaseUrl, token, propertyId, borrador }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [sesionId, setSesionId] = useState(nuevaSesion);
  const [mensajes, setMensajes] = useState<readonly MensajePrueba[]>([]);
  const [pedido, setPedido] = useState<PedidoSimulado | null>(null);
  const [texto, setTexto] = useState("");
  const [escribiendo, setEscribiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usarBorrador, setUsarBorrador] = useState(false);
  const [clientes, setClientes] = useState<readonly CustomerSummary[]>([]);
  const [clienteId, setClienteId] = useState("");
  const fin = useRef<HTMLDivElement | null>(null);

  // Clientes de la organizacion para «simular cliente conocido» (solo se piden al abrir el panel).
  useEffect(() => {
    if (!abierto) return;
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { limit: 25 })
      .then((p) => {
        if (!cancelado) setClientes(p.customers);
      })
      .catch(() => {
        if (!cancelado) setClientes([]);
      });
    return () => {
      cancelado = true;
    };
  }, [abierto, apiBaseUrl, token, propertyId]);

  useEffect(() => {
    fin.current?.scrollIntoView?.({ block: "end" });
  }, [mensajes, escribiendo]);

  function reiniciar() {
    setSesionId(nuevaSesion());
    setMensajes([]);
    setPedido(null);
    setError(null);
    setTexto("");
  }

  async function enviar() {
    const limpio = texto.trim();
    if (!limpio || escribiendo) return;
    const historial: readonly MensajePrueba[] = [...mensajes, { rol: "usuario", texto: limpio }];
    setMensajes(historial);
    setTexto("");
    setEscribiendo(true);
    setError(null);
    try {
      const r = await enviarMensajePrueba(fetch, apiBaseUrl, token, propertyId, { sesionId, mensajes: historial, clienteSimuladoId: clienteId || null, borrador: usarBorrador ? borrador : null });
      setMensajes([...historial, { rol: "agente", texto: r.respuesta }]);
      const simulado = pedidoSimuladoDe({ order: r.pedidoSimulado });
      if (simulado) setPedido(simulado);
    } catch (err) {
      // El mensaje del usuario se quita para que pueda reenviarlo: el servidor no guardo nada de este turno.
      setMensajes(mensajes);
      setTexto(limpio);
      setError(err instanceof Error ? err.message : "No se pudo probar el agente.");
    } finally {
      setEscribiendo(false);
    }
  }

  if (!abierto) {
    return (
      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" strokeWidth={1.75} />
            Probar agente
          </CardTitle>
          <CardDescription>Converse con su agente como lo haría un cliente. Prueba: no se crean pedidos ni se avisa a nadie.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <Button type="button" data-testid="abrir-probar-agente" onClick={() => setAbierto(true)}>
            Abrir prueba
          </Button>
        </CardContent>
      </Card>
    );
  }

  const noDisponible = error?.startsWith("No disponible") ?? false;
  return (
    <Card data-testid="probar-agente">
      <CardHeader className="flex flex-row items-start justify-between gap-2 p-4 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4" strokeWidth={1.75} />
            Probar agente
          </CardTitle>
          <CardDescription>Prueba: no se crean pedidos ni se avisa a nadie.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" data-testid="reiniciar-prueba" onClick={reiniciar} disabled={escribiendo}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
            Reiniciar conversación
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setAbierto(false)}>
            Cerrar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Simular cliente">
            <NativeSelect value={clienteId} onChange={(e) => setClienteId(e.target.value)} disabled={mensajes.length > 0}>
              <option value="">Cliente nuevo</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? "Sin nombre"} · {c.orderCount} {c.orderCount === 1 ? "pedido" : "pedidos"}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <div className="flex items-end pb-2">
            <Checkbox label="Probar con los cambios sin guardar" checked={usarBorrador} onChange={(e) => setUsarBorrador(e.target.checked)} />
          </div>
        </div>

        <div role="log" aria-label="Conversación de prueba" className="flex max-h-80 min-h-32 flex-col gap-2 overflow-y-auto rounded-card border border-border bg-muted/30 p-3">
          {mensajes.length === 0 && <p className="m-0 text-sm text-muted-foreground">Escriba un mensaje para empezar, por ejemplo «Hola, quiero 3 tacos al pastor para recoger».</p>}
          {mensajes.map((m, i) => (
            <div key={i} className={m.rol === "usuario" ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" : "mr-auto max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-sm"}>
              {m.texto}
            </div>
          ))}
          {escribiendo && (
            <div role="status" className="mr-auto rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              Escribiendo…
            </div>
          )}
          <div ref={fin} />
        </div>

        {error && (
          <Callout tone={noDisponible ? "warning" : "danger"} role="alert" data-testid="error-prueba">
            {error}
          </Callout>
        )}

        {pedido && <TarjetaPedidoSimulado pedido={pedido} />}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
        >
          <Input aria-label="Mensaje de prueba" className="flex-1" maxLength={1000} value={texto} placeholder="Escriba como cliente…" onChange={(e) => setTexto(e.target.value)} disabled={escribiendo} />
          <Button type="submit" disabled={escribiendo || texto.trim() === ""} aria-label="Enviar">
            <Send className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
