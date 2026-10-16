// Chat de WhatsApp de DEMOSTRACIÓN del panel: réplica del widget del repo original (components/WidgetWhatsApp.tsx) —botón flotante verde «Iniciar
// chat» abajo a la derecha que abre un panel con forma de WhatsApp (encabezado con avatar/nombre/estado, burbujas del cliente a la derecha y del
// agente a la izquierda con hora y palomitas, mensajes de sistema, «escribiendo…», barra de entrada)— pero conectado al agente REAL en modo preview:
//  · el servidor corre las mismas herramientas SIN efectos: `crear_pedido` devuelve un pedido simulado PRUEBA-xxxx (el original sí creaba pedidos
//    reales; aquí NO), nada se escribe y a nadie se le avisa; el historial vive solo en el navegador;
//  · sin proveedor de IA el servidor contesta 503/429 y el chat lo dice tal cual en una burbuja del agente con el detalle del servidor: nunca hay respuestas por palabras clave.
// Lo que el original no tenía y el monorepo conserva (Simular cliente, probar con los cambios sin guardar, Reiniciar conversación) vive en el
// encabezado: «Reiniciar» como icono y «Opciones de prueba» como bandeja que se despliega bajo él.
// Las animaciones son CSS (apps/web no usa framer-motion) y se apagan con prefers-reduced-motion. Estilos: widget-whatsapp.css.
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, Send, SlidersHorizontal, X } from "lucide-react";
import { Checkbox, FormField, Selector } from "@atiende/ui";
import { hora24EsMx } from "../../../lib/formato-fecha.ts";
import { enviarMensajePrueba } from "../lib/agente-whatsapp-client.ts";
import type { ConfigAgenteForm, MensajePrueba } from "../lib/agente-whatsapp-client.ts";
import { fetchBranchTimezone } from "../lib/config-client.ts";
import { fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerSummary } from "../lib/customers-client.ts";
import { pedidoSimuladoDe } from "../lib/voz-client.ts";
import type { PedidoSimulado } from "../lib/voz-client.ts";
import { TarjetaPedidoSimulado } from "./TarjetaPedidoSimulado.tsx";
import "./widget-whatsapp.css";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Nombre que se muestra en el encabezado (sucursal activa). */
  readonly nombreNegocio?: string;
  /** Configuración del formulario (sin guardar): si se pasa, aparece «Probar con los cambios sin guardar» en las opciones. */
  readonly borrador?: ConfigAgenteForm;
}

type Mensaje =
  | { readonly id: string; readonly rol: "cliente" | "agente"; readonly texto: string; readonly hora: Date }
  | { readonly id: string; readonly rol: "sistema"; readonly texto: string; readonly hora: Date; readonly pedido: PedidoSimulado };

const MS_ANIMACION = 200;
/** Tope del servidor (AGENTE_PREVIEW_LIMITES.maxMensajes). */
const LIMITE_MENSAJES = 40;
/** Mensaje del agente cuando algo falla, como en el original; el detalle honesto del servidor va debajo. */
const TEXTO_FALLO = "Ahorita no pude procesar tu mensaje — intenta de nuevo en un momento.";

/** Reconstrucción del glifo de WhatsApp (burbuja verde con el teléfono blanco recortado): icono inline propio, no el asset oficial. */
function GlifoWhatsApp({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="6" fill="var(--wa-verde)" />
      <path
        d="M12.04 4.4C7.83 4.4 4.4 7.83 4.4 12.04c0 1.42.38 2.79 1.09 4l-1.16 4.24 4.34-1.14a7.6 7.6 0 0 0 3.37.79h.01c4.21 0 7.64-3.43 7.64-7.64s-3.43-7.89-7.65-7.89Zm0 13.95h-.01a6.31 6.31 0 0 1-3.22-.88l-.23-.14-2.4.63.64-2.34-.15-.24a6.3 6.3 0 0 1-.97-3.34c0-3.48 2.83-6.31 6.32-6.31 1.69 0 3.27.66 4.47 1.85a6.28 6.28 0 0 1 1.85 4.47c0 3.48-2.83 6.3-6.3 6.3Z"
        fill="currentColor"
        className="wa-glifo-blanco"
      />
      <path
        d="M9.99 8.2c-.16-.36-.33-.37-.48-.37l-.42-.01c-.14 0-.38.05-.58.27-.2.22-.75.73-.75 1.78s.77 2.06.88 2.2c.1.15 1.49 2.39 3.68 3.25 1.82.71 2.19.57 2.58.53.4-.04 1.28-.52 1.46-1.02.18-.5.18-.94.12-1.03-.06-.09-.2-.14-.42-.25-.22-.11-1.28-.63-1.48-.7-.2-.08-.34-.11-.49.1-.14.22-.56.7-.69.85-.13.14-.26.16-.48.05-.22-.1-.91-.34-1.74-1.07-.64-.57-1.08-1.28-1.2-1.5-.13-.22-.01-.34.1-.45.1-.1.22-.26.33-.38.1-.13.14-.22.21-.36.08-.15.04-.28-.02-.38-.05-.1-.48-1.2-.68-1.64Z"
        fill="var(--wa-verde)"
      />
    </svg>
  );
}

function Palomitas() {
  return (
    <svg viewBox="0 0 16 11" className="wa-palomitas" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M1 5.5 4.2 8.7 9.4 2" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 5.5 8.7 8.7 15 1.4" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mantiene montado un elemento mientras dura su animación de salida. */
function usePresencia(visible: boolean) {
  const [conservar, setConservar] = useState(visible);
  useEffect(() => {
    if (visible) {
      setConservar(true);
      return undefined;
    }
    const t = setTimeout(() => setConservar(false), MS_ANIMACION);
    return () => clearTimeout(t);
  }, [visible]);
  return { montado: visible || conservar, saliendo: !visible && conservar };
}

const nuevaSesion = (): string => crypto.randomUUID();

export function WidgetWhatsApp({ apiBaseUrl, token, propertyId, nombreNegocio = "Agente de WhatsApp", borrador }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [opcionesAbiertas, setOpcionesAbiertas] = useState(false);
  const [sesionId, setSesionId] = useState(nuevaSesion);
  const [mensajes, setMensajes] = useState<readonly Mensaje[]>([]);
  const [borradorTexto, setBorradorTexto] = useState("");
  const [escribiendo, setEscribiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [usarBorrador, setUsarBorrador] = useState(false);
  const [clientes, setClientes] = useState<readonly CustomerSummary[]>([]);
  const [clienteId, setClienteId] = useState("");
  // Zona horaria de la sucursal para la hora de las burbujas; sin ella (o si falla) rige la de la plataforma (America/Mexico_City).
  const [zona, setZona] = useState<string | undefined>(undefined);
  const fin = useRef<HTMLDivElement | null>(null);
  const campo = useRef<HTMLInputElement | null>(null);
  const botonFlotante = useRef<HTMLButtonElement | null>(null);
  const yaAbrio = useRef(false);
  const idOpciones = useId();
  const boton = usePresencia(!abierto);
  const panel = usePresencia(abierto);

  // Clientes de la organización para «Simular cliente»: se piden en cada apertura del panel.
  useEffect(() => {
    if (!abierto) return undefined;
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
    if (!abierto) return undefined;
    let cancelado = false;
    fetchBranchTimezone(fetch, apiBaseUrl, token, propertyId)
      .then((c) => {
        if (!cancelado && c.zonaHoraria) setZona(c.zonaHoraria);
      })
      .catch(() => undefined);
    return () => {
      cancelado = true;
    };
  }, [abierto, apiBaseUrl, token, propertyId]);

  // Scroll automático al último mensaje (suave, salvo con movimiento reducido).
  useEffect(() => {
    const reducido = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    fin.current?.scrollIntoView?.({ behavior: reducido ? "auto" : "smooth", block: "end" });
  }, [mensajes, escribiendo, error]);

  // El foco entra al campo al abrir y vuelve al botón flotante al cerrar.
  useEffect(() => {
    if (abierto) {
      yaAbrio.current = true;
      campo.current?.focus();
    } else if (yaAbrio.current) {
      botonFlotante.current?.focus();
    }
  }, [abierto]);

  function reiniciar() {
    setSesionId(nuevaSesion());
    setMensajes([]);
    setError(null);
    setAviso(null);
    setBorradorTexto("");
  }

  async function enviar() {
    const limpio = borradorTexto.trim();
    if (!limpio || escribiendo) return;
    // El servidor acepta hasta 40 mensajes por prueba: antes de rebasarlos se reinicia sola la conversación (sin esperar un 400 técnico).
    if (mensajes.filter((m) => m.rol !== "sistema").length + 1 > LIMITE_MENSAJES) {
      reiniciar();
      setBorradorTexto(limpio);
      setAviso(`La conversación de prueba llegó al límite de ${LIMITE_MENSAJES} mensajes y se reinició. Vuelve a enviar tu mensaje.`);
      return;
    }
    setAviso(null);
    const mio: Mensaje = { id: crypto.randomUUID(), rol: "cliente", texto: limpio, hora: new Date() };
    const antes = mensajes;
    const historial: readonly MensajePrueba[] = [...antes, mio].flatMap((m): MensajePrueba[] => (m.rol === "sistema" ? [] : [{ rol: m.rol === "cliente" ? "usuario" : "agente", texto: m.texto }]));
    setMensajes([...antes, mio]);
    setBorradorTexto("");
    setEscribiendo(true);
    setError(null);
    try {
      const r = await enviarMensajePrueba(fetch, apiBaseUrl, token, propertyId, { sesionId, mensajes: historial, clienteSimuladoId: clienteId || null, borrador: usarBorrador && borrador ? borrador : null });
      const nuevos: Mensaje[] = [mio, { id: crypto.randomUUID(), rol: "agente", texto: r.respuesta, hora: new Date() }];
      const simulado = pedidoSimuladoDe({ order: r.pedidoSimulado });
      if (simulado) nuevos.push({ id: crypto.randomUUID(), rol: "sistema", texto: `Pedido simulado · ${simulado.folio} · Prueba`, hora: new Date(), pedido: simulado });
      setMensajes([...antes, ...nuevos]);
    } catch (err) {
      // El mensaje del cliente se quita para que pueda reenviarlo: el servidor no guardó nada de este turno.
      setMensajes(antes);
      setBorradorTexto(limpio);
      setError(err instanceof Error ? err.message : "No se pudo probar el agente.");
    } finally {
      setEscribiendo(false);
    }
  }

  function alTeclear(e: KeyboardEvent<HTMLDivElement>) {
    // La lista de Simular cliente vive en un portal pero sus eventos de React suben hasta este panel: Escape dentro de ella cierra solo la lista.
    if ((e.target as HTMLElement).closest('[role="listbox"]')) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setAbierto(false);
    }
  }

  const noDisponible = error?.startsWith("No disponible") ?? false;
  const estado = escribiendo ? "escribiendo…" : "En línea";

  return createPortal(
    <div className="wa-widget">
      {boton.montado ? (
        <button
          ref={botonFlotante}
          type="button"
          className="wa-boton"
          data-testid="abrir-chat-whatsapp"
          data-saliendo={boton.saliendo ? "true" : undefined}
          aria-hidden={boton.saliendo ? true : undefined}
          tabIndex={boton.saliendo ? -1 : 0}
          aria-label="Iniciar chat de prueba con el agente de WhatsApp"
          onClick={() => setAbierto(true)}
        >
          <GlifoWhatsApp className="wa-boton__glifo" />
          <span>Iniciar chat</span>
        </button>
      ) : null}

      {panel.montado ? (
        <div role="dialog" aria-modal="false" aria-label={`Chat de prueba con el agente de WhatsApp de ${nombreNegocio}`} className="wa-panel" data-testid="chat-whatsapp" data-saliendo={panel.saliendo ? "true" : undefined} onKeyDown={alTeclear}>
          <div className="wa-cabecera">
            <div className="wa-avatar">
              <GlifoWhatsApp />
            </div>
            <div className="wa-cabecera__texto">
              <p className="wa-cabecera__nombre">{nombreNegocio}</p>
              <p className="wa-cabecera__estado">{estado} · Prueba</p>
            </div>
            <div className="wa-cabecera__acciones">
              <button type="button" className="wa-icono" onClick={reiniciar} disabled={escribiendo} aria-label="Reiniciar conversación" title="Reiniciar conversación" data-testid="reiniciar-prueba">
                <RotateCcw aria-hidden="true" strokeWidth={1.75} />
              </button>
              <button type="button" className="wa-icono" onClick={() => setOpcionesAbiertas((v) => !v)} aria-expanded={opcionesAbiertas} aria-controls={idOpciones} aria-label="Opciones de prueba" title="Opciones de prueba">
                <SlidersHorizontal aria-hidden="true" strokeWidth={1.75} />
              </button>
              <button type="button" className="wa-icono wa-icono--cerrar" onClick={() => setAbierto(false)} aria-label="Cerrar chat" title="Cerrar chat">
                <X aria-hidden="true" strokeWidth={2} />
              </button>
            </div>
          </div>

          {opcionesAbiertas ? (
            <div id={idOpciones} className="wa-opciones" role="group" aria-label="Opciones de prueba">
              <FormField label="Simular cliente" {...(mensajes.length > 0 ? { hint: "Reinicia la conversación para cambiar de cliente." } : {})}>
                <Selector value={clienteId} onChange={(e) => setClienteId(e.target.value)} disabled={mensajes.length > 0}>
                  <option value="">Cliente nuevo</option>
                  {clientes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name ?? "Sin nombre"} · {c.orderCount} {c.orderCount === 1 ? "pedido" : "pedidos"}
                    </option>
                  ))}
                </Selector>
              </FormField>
              {borrador ? <Checkbox label="Probar con los cambios sin guardar" checked={usarBorrador} onChange={(e) => setUsarBorrador(e.target.checked)} /> : null}
            </div>
          ) : null}

          <div className="wa-cuerpo" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversación de prueba">
            {mensajes.length === 0 && !error ? (
              <div className="wa-vacio">
                <p>
                  Escríbele al agente de WhatsApp de {nombreNegocio} como lo haría un cliente. Puede tomar un pedido de principio a fin, pero es una prueba: no se crean pedidos ni se avisa a nadie.
                </p>
              </div>
            ) : null}

            {mensajes.map((m) =>
              m.rol === "sistema" ? (
                <div key={m.id} className="wa-sistema">
                  <span className="wa-sistema__pildora">{m.texto}</span>
                  <div className="wa-sistema__tarjeta">
                    <TarjetaPedidoSimulado pedido={m.pedido} compacta />
                  </div>
                </div>
              ) : (
                <div key={m.id} className={`wa-fila wa-fila--${m.rol}`}>
                  <div className={`wa-burbuja wa-burbuja--${m.rol}`}>
                    <span className="wa-solo-lectores">{m.rol === "cliente" ? "Cliente: " : "Agente: "}</span>
                    <span>{m.texto}</span>
                    <span className="wa-hora">
                      {hora24EsMx(m.hora, zona)}
                      {m.rol === "cliente" ? <Palomitas /> : null}
                    </span>
                  </div>
                </div>
              ),
            )}

            {escribiendo ? (
              <div className="wa-fila wa-fila--agente" role="status">
                <span className="wa-solo-lectores">El agente está escribiendo…</span>
                <div className="wa-escribiendo" aria-hidden="true">
                  <span className="wa-punto" />
                  <span className="wa-punto" />
                  <span className="wa-punto" />
                </div>
              </div>
            ) : null}

            {aviso ? (
              <div className="wa-sistema" role="status" data-testid="aviso-limite">
                <span className="wa-sistema__pildora">{aviso}</span>
              </div>
            ) : null}

            {error ? (
              <div className="wa-fila wa-fila--agente" role="alert" data-testid="error-prueba">
                <div className="wa-burbuja wa-burbuja--agente wa-burbuja--error">
                  <span>{noDisponible ? "Por ahora no puedo contestar." : TEXTO_FALLO}</span>
                  <span className="wa-burbuja__detalle">{error}</span>
                </div>
              </div>
            ) : null}
            <div ref={fin} />
          </div>

          <form
            className="wa-barra"
            onSubmit={(e) => {
              e.preventDefault();
              void enviar();
            }}
          >
            <input ref={campo} className="wa-campo" aria-label="Mensaje de prueba" maxLength={1000} value={borradorTexto} placeholder="Escribe un mensaje" onChange={(e) => setBorradorTexto(e.target.value)} disabled={escribiendo} autoComplete="off" />
            <button type="submit" className="wa-enviar" aria-label="Enviar mensaje" disabled={escribiendo || borradorTexto.trim() === ""}>
              <Send aria-hidden="true" strokeWidth={2} />
            </button>
          </form>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
