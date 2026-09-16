// Panel "Chatea con tus datos" — puerto del panel real de atiende-restaurantes
// (AdminDashboard.tsx, sección `activeSection === 'pregunta'`, líneas
// 3810-4022/4315-4364 de la investigación adjunta a esta fase): MISMO nivel de
// pulido visual (CampoPixeles de fondo, wordmark animado, hilo de conversación,
// panel de historial lateral, sugerencias por categoría, indicador "pensando"
// con `atiende-respira`) — componente compartido, reusable en las 6 verticales
// (sin ninguna dependencia de un vertical concreto).
//
// Diferencia deliberada con la referencia (honestidad de backend, ver
// BotonChatDatos.tsx): `responderPreguntaLocal` de restaurantes YA es
// keyword-matching sin LLM, pero SÍ contesta con cifras reales porque recibe
// `orders`/`products` ya cargados por ese dashboard concreto. Este componente
// compartido no recibe ningún dato de dominio (no hay un `orders`/`products`
// genérico que sirva para las 6 verticales) — inventar una cifra aquí SERÍA una
// respuesta de IA falsa. Se verificó primero que este monorepo no tiene ningún
// backend de RAG/chat-con-datos en apps/api (sin ruta `/pregunta`, sin endpoint
// de embeddings — mismo hallazgo que ya documentaba BotonChatDatos.tsx), así que
// TODA pregunta recibe la MISMA respuesta honesta de roadmap — nunca una
// respuesta fabricada, ni siquiera por coincidencia de palabra clave.
//
// A diferencia de la referencia (que reemplaza `activeSection` dentro del MISMO
// AdminDashboard), este componente se monta como overlay de pantalla completa
// (ver BotonChatDatos.tsx) — ningún Shell necesita conocer un estado de sección
// nuevo para usarlo.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Edit, History, Paperclip, PanelRightClose, Search, X } from "lucide-react";
import { AtiendeMark, AtiendeWordmark, Button, toast } from "@atiende/ui";
import { CampoPixeles } from "./CampoPixeles.tsx";

interface MensajeChat {
  readonly rol: "usuario" | "asistente";
  readonly texto: string;
}

interface CategoriaPregunta {
  readonly titulo: string;
  readonly preguntas: readonly string[];
}

// Genéricas a propósito (a diferencia de `categoriasPreguntasRestaurante` de la
// referencia, específica de pedidos de restaurante): sirven igual para hoteles,
// rentas, citas, despachos o licitaciones — ninguna asume una entidad de dominio
// concreta, y de cualquier forma TODAS resuelven en la misma respuesta honesta.
const CATEGORIAS: readonly CategoriaPregunta[] = [
  { titulo: "Operación", preguntas: ["¿Qué tengo pendiente hoy?", "¿Cómo va mi operación esta semana?"] },
  { titulo: "Clientes", preguntas: ["¿Cuántos clientes tengo registrados?", "¿Quién es mi cliente más frecuente?"] },
  { titulo: "Negocio", preguntas: ["¿Cómo van mis números este mes?", "¿Qué debería revisar primero?"] },
];

const PREGUNTAS_SUELTAS: readonly string[] = CATEGORIAS.flatMap((c) => c.preguntas);

const FASES_PENSANDO: readonly string[] = ["Leyendo tu pregunta…", "Revisando qué hay conectado a tus datos…"];

const RESPUESTA_HONESTA =
  "Esta función está en el roadmap: tu backend de datos reales llega pronto. Por ahora no hay ninguna conexión real a tus datos operativos, así que no puedo responder con cifras reales de tu negocio — todavía no es un motor de lenguaje natural sobre tu operación, es solo la vista previa de cómo se va a ver.";

export interface PanelChateaConTusDatosProps {
  readonly onClose: () => void;
  /** Nombre del negocio activo (organización/property), para el saludo — ej.
   *  "Hotel Sol". Opcional, cae a "tu negocio". */
  readonly nombreNegocio?: string;
}

export function PanelChateaConTusDatos({ onClose, nombreNegocio }: PanelChateaConTusDatosProps) {
  const [pregunta, setPregunta] = useState("");
  const [mensajesChat, setMensajesChat] = useState<readonly MensajeChat[]>([]);
  const [pensando, setPensando] = useState(false);
  const [fasePensando, setFasePensando] = useState("");
  const [mostrarSugerencias, setMostrarSugerencias] = useState(false);
  const [mostrarHistorial, setMostrarHistorial] = useState(false);
  const [historialPreguntas, setHistorialPreguntas] = useState<readonly string[]>([]);
  const [busquedaHistorial, setBusquedaHistorial] = useState("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Cerrar con Escape + bloquear el scroll del fondo mientras el overlay está
  // abierto — mismo criterio de accesibilidad que cualquier diálogo modal real
  // de este design system (ver Dialog/Sheet de @atiende/ui).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", alTeclear);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", alTeclear);
      document.body.style.overflow = overflowPrevio;
    };
  }, []);

  const historialFiltrado = historialPreguntas.filter((h) => h.toLowerCase().includes(busquedaHistorial.toLowerCase()));

  async function responderLocal(qInput: string) {
    const q = qInput.trim();
    if (!q || pensando) return;
    setHistorialPreguntas((h) => [q, ...h.filter((x) => x !== q)].slice(0, 20));
    setMostrarHistorial(false);
    setMostrarSugerencias(false);
    setMensajesChat((m) => [...m, { rol: "usuario", texto: q }]);
    setPregunta("");
    setPensando(true);
    for (const fase of FASES_PENSANDO) {
      setFasePensando(fase);
      await new Promise((r) => setTimeout(r, 260));
    }
    // NUNCA se ramifica por el contenido de `q` -- ver el comentario de cabecera
    // del archivo: sin datos de dominio reales conectados, cualquier respuesta
    // que dependiera de `q` sería una respuesta de IA fabricada.
    setMensajesChat((m) => [...m, { rol: "asistente", texto: RESPUESTA_HONESTA }]);
    setPensando(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pregunta.trim()) {
      setMostrarSugerencias((v) => !v);
      return;
    }
    void responderLocal(pregunta);
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Chatea con tus datos" className="fixed inset-0 z-50 bg-background flex flex-col overflow-hidden">
      <div className="relative flex-1 overflow-hidden">
        <CampoPixeles />

        <div className="relative h-full overflow-y-auto px-4 pt-4 pb-8">
          <div className="flex justify-end gap-2 mb-6">
            <button
              type="button"
              onClick={() => setMostrarHistorial((v) => !v)}
              className="relative flex items-center gap-1.5 text-xs border border-border rounded-full pl-3 pr-2.5 py-1.5 bg-card text-muted-foreground hover:bg-muted transition-colors"
            >
              <History className="w-3.5 h-3.5" />
              Historial
              <span className="font-mono text-[10px] bg-muted rounded-full px-1.5 py-0.5 text-foreground">{historialPreguntas.length}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar chatea con tus datos"
              className="w-8 h-8 rounded-full border border-border flex items-center justify-center bg-card text-muted-foreground hover:bg-muted transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className={`flex flex-col items-center px-4 pb-8 ${mensajesChat.length > 0 ? "min-h-[60vh] justify-end" : "pt-8 md:pt-16"}`}>
            {mensajesChat.length === 0 && (
              <>
                <AtiendeWordmark className="mb-6" markClassName="h-9 w-auto" animado />
                <h1 className="text-2xl font-semibold text-foreground mb-2">Pregunta a tus datos</h1>
                <p className="text-sm text-muted-foreground text-center max-w-md mb-8">
                  Pregunta sobre la operación de {nombreNegocio ?? "tu negocio"} — así se ve, aunque todavía no responde con datos reales.
                </p>
              </>
            )}

            {mensajesChat.length > 0 && (
              <div className="w-full max-w-2xl space-y-5 mb-6">
                {mensajesChat.map((m, i) =>
                  m.rol === "usuario" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] bg-card border border-border rounded-2xl px-4 py-2 text-sm text-foreground shadow-sm">{m.texto}</div>
                    </div>
                  ) : (
                    <div key={i} className="flex items-start gap-2">
                      <AtiendeMark className="h-4 w-auto shrink-0 mt-0.5" />
                      <p className="text-sm text-foreground leading-relaxed">{m.texto}</p>
                    </div>
                  ),
                )}

                {pensando && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AtiendeMark className="h-4 w-auto atiende-respira shrink-0" />
                    <span>{fasePensando}</span>
                  </div>
                )}
              </div>
            )}

            {mostrarSugerencias && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-2xl mb-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
                {CATEGORIAS.map((cat) => (
                  <div key={cat.titulo} className="rounded-xl border border-border bg-card p-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground mb-2">{cat.titulo}</p>
                    <div className="space-y-1">
                      {cat.preguntas.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => void responderLocal(p)}
                          className="w-full text-left text-sm text-foreground rounded-lg px-2 py-1.5 hover:bg-muted transition-colors"
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="w-full max-w-xl bg-card border border-border rounded-3xl shadow-sm p-3 shrink-0"
            >
              <input
                value={pregunta}
                onChange={(e) => setPregunta(e.target.value)}
                placeholder="Pregunta sobre tu operación…"
                className="w-full bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between mt-1">
                <button
                  type="submit"
                  disabled={pensando}
                  className="flex items-center gap-1.5 rounded-full bg-foreground text-background text-xs font-medium pl-3 pr-3.5 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  <Search className="w-3.5 h-3.5" />
                  Consulta
                </button>
                <div className="flex items-center gap-1">
                  {/* Igual criterio que BotonChatDatos.tsx: sin `disabled` nativo
                      (bloquearía el único aviso honesto de por qué no hace nada) —
                      `aria-disabled` + toast al click en vez de fingir un adjunto
                      que nada lee. */}
                  <button
                    type="button"
                    aria-disabled="true"
                    onClick={() =>
                      toast("Adjuntar archivos también está en el roadmap", {
                        description: "Por ahora Chatea con tus datos no lee ni analiza archivos.",
                      })
                    }
                    className="p-2 rounded-full text-muted-foreground hover:bg-muted transition-colors opacity-60"
                  >
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <Button type="submit" size="icon" disabled={pensando} className="rounded-full shrink-0 w-8 h-8">
                    <ArrowUp className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </form>

            {mensajesChat.length === 0 && !mostrarSugerencias && (
              <div className="flex flex-wrap gap-1.5 justify-center mt-4 max-w-xl">
                {PREGUNTAS_SUELTAS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => void responderLocal(p)}
                    className="text-xs rounded-full px-3 py-1 bg-secondary/10 text-secondary border border-secondary/20 hover:bg-secondary/20 transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {mensajesChat.length === 0 && (
              <p className="text-xs text-muted-foreground text-center mt-8 max-w-lg">
                Sin backend real conectado todavía: cualquier pregunta que hagas recibe la misma respuesta honesta de roadmap, nunca una cifra inventada de tu operación.
              </p>
            )}
          </div>
        </div>

        {mostrarHistorial && (
          <div className="absolute right-3 inset-y-3 z-20 w-72 max-w-[85vw] bg-card border border-border rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-3 flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setMensajesChat([]);
                  setMostrarHistorial(false);
                  setMostrarSugerencias(false);
                }}
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-full border border-border/60 hover:bg-muted transition-colors text-sm font-medium text-foreground"
              >
                <Edit className="w-3.5 h-3.5" />
                Nuevo chat
              </button>
              <button
                type="button"
                onClick={() => setMostrarHistorial(false)}
                className="w-8 h-8 rounded-md border border-border/60 flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors shrink-0"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>
            <div className="px-3 pb-3 shrink-0">
              <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-2">
                <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <input
                  value={busquedaHistorial}
                  onChange={(e) => setBusquedaHistorial(e.target.value)}
                  placeholder="Buscar chats"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <p className="px-4 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground shrink-0">Recientes</p>
            <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
              {historialFiltrado.length === 0 ? (
                <p className="text-sm text-muted-foreground px-2 py-2">{historialPreguntas.length === 0 ? "Sin chats recientes." : "Sin resultados."}</p>
              ) : (
                historialFiltrado.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setMostrarHistorial(false);
                      void responderLocal(h);
                    }}
                    className="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-muted transition-colors truncate text-foreground"
                  >
                    {h}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
