// Panel de seguimiento de solicitudes de derechos ARCO (acceso, rectificación,
// cancelación, oposición). Presentacional: no hace fetch; la página (apps/web) le
// pasa los datos y las acciones. Muestra el semáforo de plazos, el estado de cada
// solicitud y las acciones que el staff puede tomar. No es asesoría legal.
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, ShieldCheck } from "lucide-react";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { Input } from "../ui/input.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";
import { EstadoVacio } from "../EstadoVacio.js";
import { StatCard } from "../StatCard.js";

export type SolicitudArcoDerecho = "acceso" | "rectificacion" | "cancelacion" | "oposicion";
export type SolicitudArcoEstado = "pendiente_confirmacion" | "recibida" | "en_proceso" | "bloqueada" | "resuelta" | "rechazada" | "cancelada_titular" | "expirada";
export type SolicitudArcoAccion = "en_proceso" | "bloqueada" | "resuelta" | "rechazada";
export type SolicitudArcoPlazo = "en_plazo" | "por_vencer" | "vencida" | null;

export interface SolicitudArcoVista {
  readonly id: string;
  readonly folio: string;
  readonly telefono: string;
  readonly derecho: SolicitudArcoDerecho;
  readonly estado: SolicitudArcoEstado;
  readonly plazo: SolicitudArcoPlazo;
  readonly solicitadaEn: string;
  readonly respuestaVenceEn: string | null;
  readonly ejecucionVenceEn: string | null;
  readonly notaResolucion: string | null;
}

export const SOLICITUD_ARCO_DERECHO_LABEL: Record<SolicitudArcoDerecho, string> = {
  acceso: "Acceso",
  rectificacion: "Rectificación",
  cancelacion: "Cancelación",
  oposicion: "Oposición",
};

export const SOLICITUD_ARCO_ESTADO_LABEL: Record<SolicitudArcoEstado, string> = {
  pendiente_confirmacion: "Esperando confirmación del titular",
  recibida: "Recibida",
  en_proceso: "En proceso",
  bloqueada: "Datos bloqueados",
  resuelta: "Resuelta",
  rechazada: "Rechazada",
  cancelada_titular: "Retirada por el titular",
  expirada: "Expirada sin confirmar",
};

const PLAZO_LABEL: Record<Exclude<SolicitudArcoPlazo, null>, string> = {
  en_plazo: "En plazo",
  por_vencer: "Por vencer",
  vencida: "Vencida",
};

/** Acciones que el staff puede tomar según el estado y el derecho (espeja la
 * función SQL `citas.update_data_rights_request_status`; el servidor siempre
 * revalida). */
export function accionesDisponibles(estado: SolicitudArcoEstado, derecho: SolicitudArcoDerecho): readonly SolicitudArcoAccion[] {
  if (estado === "recibida") return derecho === "cancelacion" ? ["en_proceso", "bloqueada", "resuelta", "rechazada"] : ["en_proceso", "resuelta", "rechazada"];
  if (estado === "en_proceso") return derecho === "cancelacion" ? ["bloqueada", "resuelta", "rechazada"] : ["resuelta", "rechazada"];
  if (estado === "bloqueada") return ["resuelta", "rechazada"];
  return [];
}

const ACCION_LABEL: Record<SolicitudArcoAccion, string> = {
  en_proceso: "Iniciar",
  bloqueada: "Bloquear datos",
  resuelta: "Resolver",
  rechazada: "Rechazar",
};

function formatearFecha(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-MX", { dateStyle: "medium" });
  } catch {
    return iso;
  }
}

function plazoVariant(plazo: SolicitudArcoPlazo): "destructive" | "secondary" | "outline" {
  if (plazo === "vencida") return "destructive";
  if (plazo === "por_vencer") return "secondary";
  return "outline";
}

export interface SolicitudesArcoPanelProps {
  readonly solicitudes: readonly SolicitudArcoVista[];
  /** `false` cuando la migración todavía no está aplicada: nunca se muestra como una lista vacía real. */
  readonly disponible: boolean;
  readonly puedeGestionar: boolean;
  readonly respuestaDias: number;
  readonly ejecucionDias: number;
  /** Se invoca al confirmar una acción; la nota es obligatoria al rechazar. */
  readonly onCambiarEstado: (id: string, accion: SolicitudArcoAccion, nota: string | null) => Promise<void>;
}

export function SolicitudesArcoPanel({ solicitudes, disponible, puedeGestionar, respuestaDias, ejecucionDias, onCambiarEstado }: SolicitudesArcoPanelProps) {
  const [accionando, setAccionando] = useState<{ id: string; accion: SolicitudArcoAccion } | null>(null);
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  if (!disponible) {
    return (
      <EstadoVacio
        icon={ShieldCheck}
        titulo="Seguimiento ARCO no disponible aún"
        mensaje="El seguimiento de solicitudes de derechos ARCO todavía no está habilitado en esta base de datos. Cuando se habilite, las solicitudes que lleguen por WhatsApp aparecerán aquí."
      />
    );
  }

  const abiertas = solicitudes.filter((s) => s.estado === "recibida" || s.estado === "en_proceso" || s.estado === "bloqueada");
  const porVencer = abiertas.filter((s) => s.plazo === "por_vencer").length;
  const vencidas = abiertas.filter((s) => s.plazo === "vencida").length;

  async function confirmar() {
    if (!accionando) return;
    if (accionando.accion === "rechazada" && nota.trim() === "") {
      setErrorAccion("Indica el motivo del rechazo.");
      return;
    }
    setEnviando(true);
    setErrorAccion(null);
    try {
      await onCambiarEstado(accionando.id, accionando.accion, nota.trim() === "" ? null : nota.trim());
      setAccionando(null);
      setNota("");
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo actualizar la solicitud.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard icon={Clock} label="Abiertas" value={String(abiertas.length)} nota={`Respuesta en ${respuestaDias} días, ejecución ${ejecucionDias} días más`} />
        <StatCard icon={AlertTriangle} label="Por vencer" value={String(porVencer)} nota="Faltan 5 días o menos" />
        <StatCard icon={AlertTriangle} label="Vencidas" value={String(vencidas)} nota="Atiéndelas primero" />
      </div>

      {solicitudes.length === 0 ? (
        <EstadoVacio icon={CheckCircle2} titulo="Sin solicitudes" mensaje="Todavía no hay solicitudes de derechos ARCO con estos filtros." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Folio</TableHead>
                  <TableHead>Derecho</TableHead>
                  <TableHead>Titular</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Vence</TableHead>
                  {puedeGestionar && <TableHead>Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {solicitudes.map((s) => {
                  const acciones = accionesDisponibles(s.estado, s.derecho);
                  const vence = s.estado === "recibida" ? s.respuestaVenceEn : s.ejecucionVenceEn;
                  const editando = accionando?.id === s.id;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.folio}</TableCell>
                      <TableCell className="text-xs">{SOLICITUD_ARCO_DERECHO_LABEL[s.derecho]}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.telefono}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs">{SOLICITUD_ARCO_ESTADO_LABEL[s.estado]}</span>
                          {s.notaResolucion && <span className="text-[11px] text-muted-foreground">{s.notaResolucion}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        <div className="flex flex-col gap-1">
                          <span>{formatearFecha(vence)}</span>
                          {s.plazo && (
                            <Badge variant={plazoVariant(s.plazo)} className="w-fit text-[10px]">
                              {PLAZO_LABEL[s.plazo]}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {puedeGestionar && (
                        <TableCell>
                          {acciones.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : editando ? (
                            <div className="flex flex-col gap-2 min-w-[220px]">
                              <Input
                                aria-label={accionando.accion === "rechazada" ? "Motivo del rechazo" : "Nota (opcional)"}
                                placeholder={accionando.accion === "rechazada" ? "Motivo del rechazo (obligatorio)" : "Nota (opcional)"}
                                value={nota}
                                maxLength={1000}
                                onChange={(e) => setNota(e.target.value)}
                              />
                              {errorAccion && (
                                <span role="alert" className="text-[11px] text-destructive">
                                  {errorAccion}
                                </span>
                              )}
                              <div className="flex gap-2">
                                <Button type="button" size="sm" onClick={confirmar} disabled={enviando}>
                                  {enviando ? "Guardando…" : `Confirmar: ${ACCION_LABEL[accionando.accion]}`}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={enviando}
                                  onClick={() => {
                                    setAccionando(null);
                                    setNota("");
                                    setErrorAccion(null);
                                  }}
                                >
                                  Cancelar
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {acciones.map((accion) => (
                                <Button
                                  key={accion}
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setAccionando({ id: s.id, accion });
                                    setNota("");
                                    setErrorAccion(null);
                                  }}
                                >
                                  {ACCION_LABEL[accion]}
                                </Button>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
