// Pagina PUBLICA /demo/:orgSlug (R-19): chat estilo WhatsApp conectado al MISMO agente real que atiende el WhatsApp
// de la sucursal, sin Meta. Cada mensaje llama a POST /v1/restaurantes/demo/:orgSlug/mensaje; el pedido que tome el agente se
// crea con el motor real y aparece en el panel de cocina, y una escalacion abre un handoff real en Conversaciones.
// Nunca hay respuestas simuladas: sin agente (o sin demo cargada) el estado es honesto y el chat no se muestra.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MessageCircle, RotateCcw, Send } from "lucide-react";
import { Button, Callout, EstadoCargando, EstadoError, Input, NativeSelect } from "@atiende/ui";
import { crearClienteDemo, DemoError, nuevaSesionDemo, type EstadoDemo } from "./demo-client.ts";
import { useMetaPublica } from "../../../lib/meta-publica.ts";

interface Burbuja {
  readonly id: number;
  readonly de: "cliente" | "agente";
  readonly texto: string;
  readonly hora: string;
  /** Aviso del sistema bajo la burbuja del agente (pedido tomado, handoff abierto). */
  readonly nota?: string;
}

const pesos = (n: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
/** Hasta dos iniciales de las palabras significativas del nombre ("Los Taquitos de PM" -> "TP"). */
export function iniciales(nombre: string): string {
  const palabras = nombre.split(/\s+/).filter((p) => p.length > 0 && !/^(los|las|el|la|de|del|y)$/i.test(p));
  return palabras.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "R";
}
const hora = () => new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Merida" }).format(new Date());

export function DemoWhatsAppPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  useMetaPublica({ titulo: "Demo de WhatsApp", descripcion: "Conversación de demostración con el agente de WhatsApp.", indexable: false });
  const cliente = useMemo(() => crearClienteDemo(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [estado, setEstado] = useState<EstadoDemo | "cargando" | { error: string }>("cargando");
  const [sesion, setSesion] = useState(() => nuevaSesionDemo());
  const [sucursal, setSucursal] = useState("");
  const [burbujas, setBurbujas] = useState<readonly Burbuja[]>([]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviados, setEnviados] = useState(0);
  const siguienteId = useRef(1);
  const fin = useRef<HTMLDivElement | null>(null);

  const cargar = useCallback(() => {
    setEstado("cargando");
    cliente
      .estado()
      .then((e) => {
        setEstado(e);
        // El chat abre en la sucursal de la fase 1 (T7) si el servidor la ofrece; no pisa una eleccion ya hecha.
        const predeterminada = e.sucursales.find((s) => s.slug === e.sucursal_predeterminada)?.slug;
        if (predeterminada) setSucursal((actual) => actual || predeterminada);
      })
      .catch((e: unknown) => setEstado({ error: e instanceof Error ? e.message : "No pudimos consultar la demo." }));
  }, [cliente]);
  useEffect(cargar, [cargar]);

  useEffect(() => {
    fin.current?.scrollIntoView?.({ block: "end" });
  }, [burbujas]);

  const nueva = () => {
    setSesion(nuevaSesionDemo());
    setBurbujas([]);
    setEnviados(0);
    setAviso(null);
  };

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    const mensaje = texto.trim();
    if (!mensaje || enviando || typeof estado !== "object" || !("disponible" in estado)) return;
    setAviso(null);
    setEnviando(true);
    setTexto("");
    setBurbujas((b) => [...b, { id: siguienteId.current++, de: "cliente", texto: mensaje, hora: hora() }]);
    try {
      const r = await cliente.enviar({ sessionId: sesion, mensaje, sucursal: sucursal || undefined });
      setEnviados((n) => n + 1);
      const notas: string[] = [];
      if (r.pedido) notas.push(`Pedido registrado por ${pesos(r.pedido.total)}: ya aparece en el panel de pedidos y en el ticket de cocina.`);
      if (r.escalado) notas.push("Se avisó a una persona del equipo: la conversación aparece en Conversaciones del panel.");
      setBurbujas((b) => [...b, { id: siguienteId.current++, de: "agente", texto: r.respuesta, hora: hora(), ...(notas.length > 0 ? { nota: notas.join(" ") } : {}) }]);
    } catch (err) {
      setAviso(err instanceof DemoError || err instanceof Error ? err.message : "No pudimos enviar su mensaje.");
      // El mensaje no se perdio: vuelve al cuadro para reenviarlo.
      setTexto(mensaje);
      setBurbujas((b) => b.slice(0, -1));
    } finally {
      setEnviando(false);
    }
  };

  const disponible = typeof estado === "object" && "disponible" in estado && estado.disponible ? estado : null;
  const restante = disponible ? Math.max(0, disponible.limites.mensajes_por_sesion - enviados) : null;
  const nombre = typeof estado === "object" && "restaurante" in estado ? estado.restaurante?.nombre : undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <MessageCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-sm font-semibold tracking-tight">Demo de WhatsApp{nombre ? ` · ${nombre}` : ""}</h1>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-4 sm:px-6">
        {estado === "cargando" && <EstadoCargando />}
        {typeof estado === "object" && "error" in estado && <EstadoError mensaje={estado.error} onReintentar={cargar} />}
        {typeof estado === "object" && "disponible" in estado && !estado.disponible && (
          <Callout tone="warning" titulo="Demo no disponible">
            {estado.mensaje}
          </Callout>
        )}
        {disponible && (
          <section aria-label="Conversación de demostración" className="flex h-[calc(100vh-7.5rem)] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-full bg-muted text-xs font-semibold" aria-hidden="true">
                  {iniciales(disponible.restaurante?.nombre ?? "")}
                </span>
                <div>
                  <p className="text-sm font-medium leading-tight">{disponible.restaurante?.nombre ?? "Restaurante"}</p>
                  <p className="text-xs text-muted-foreground">Asistente virtual · agente real, sin Meta</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor="demo-sucursal">
                  Sucursal del chat
                </label>
                <NativeSelect id="demo-sucursal" value={sucursal} onChange={(e) => setSucursal(e.target.value)} disabled={burbujas.length > 0}>
                  <option value="">Número general</option>
                  {disponible.sucursales.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.nombre}
                    </option>
                  ))}
                </NativeSelect>
                <Button type="button" variant="outline" size="sm" onClick={nueva} disabled={enviando}>
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  Nueva conversación
                </Button>
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto bg-muted/40 p-3" aria-live="polite" aria-label="Mensajes">
              {burbujas.length === 0 && <p className="mx-auto max-w-sm pt-6 text-center text-sm text-muted-foreground">Escriba «Hola» para empezar. El agente toma pedidos reales contra el menú real de la sucursal.</p>}
              {burbujas.map((b) => (
                <div key={b.id} className={b.de === "cliente" ? "flex justify-end" : "flex justify-start"}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${b.de === "cliente" ? "bg-primary text-primary-foreground" : "border border-border bg-card"}`}>
                    <p className="whitespace-pre-wrap break-words">{b.texto}</p>
                    {b.nota && <p className="mt-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{b.nota}</p>}
                    <p className={`mt-1 text-right text-2xs ${b.de === "cliente" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{b.hora}</p>
                  </div>
                </div>
              ))}
              {enviando && <p className="text-xs text-muted-foreground">El asistente está escribiendo…</p>}
              <div ref={fin} />
            </div>

            {aviso && (
              <div className="border-t border-border px-3 pt-2">
                <Callout tone="danger" onDismiss={() => setAviso(null)}>
                  {aviso}
                </Callout>
              </div>
            )}
            <form onSubmit={enviar} className="flex items-center gap-2 border-t border-border p-3">
              <label className="sr-only" htmlFor="demo-mensaje">
                Mensaje
              </label>
              <Input id="demo-mensaje" value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={disponible.limites.caracteres_por_mensaje} placeholder="Escriba un mensaje" autoComplete="off" disabled={enviando || restante === 0} />
              <Button type="submit" size="sm" disabled={enviando || !texto.trim() || restante === 0}>
                <Send className="size-3.5" aria-hidden="true" />
                Enviar
              </Button>
            </form>
            <p className="px-3 pb-2 text-2xs text-muted-foreground">
              {restante === 0 ? "Esta conversación alcanzó su tope de mensajes: inicie una nueva." : `Mensajes restantes en esta conversación: ${restante}.`} Nada de esto se envía a WhatsApp.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
