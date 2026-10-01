// R-12: bandeja de callbacks con estado (nuevo / en curso / resuelto), motivo, canal, sucursal, asignacion y SLA simple.
// Vive como pestana de Conversaciones (R-21): NO es otra bandeja. Contrato: lib/conversaciones-client.ts.
// Base sin la migracion 033: `gestionable: false` -> se ve el listado de siempre (abierto/resuelto) sin botones de estado.
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { Button, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, NativeSelect, StatusBadge, useConfirm } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import {
  CALLBACK_ESTADO_LABEL,
  CALLBACK_RESULTADO_LABEL,
  SLA_LABEL,
  actualizarCallback,
  fetchCallbacks,
  registrarIntento,
  textoMotivoCallback,
} from "../lib/conversaciones-client.ts";
import type { CallbackAccion, CallbackEstado, CallbackResultado, CallbackWire, SlaCallbackEstado } from "../lib/conversaciones-client.ts";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { OrgMember } from "../lib/staff-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const GESTORES: ReadonlySet<string> = new Set(["owner", "admin"]);
const ORIGEN_LABEL: Readonly<Record<string, string>> = { voice: "Llamada", whatsapp: "WhatsApp", web: "Web", admin: "Panel" };
const TONO_ESTADO: Readonly<Record<CallbackEstado, StatusTone>> = { nuevo: "danger", en_curso: "info", resuelto: "success" };
const TONO_SLA: Readonly<Record<SlaCallbackEstado, StatusTone>> = { en_plazo: "success", por_vencer: "warning", vencido: "danger", cumplido: "success", incumplido: "warning", sin_dato: "neutral" };

function hora(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

/** "Faltan 12 min" / "Vencido hace 5 min" mientras nadie lo ha contactado. */
function textoSla(cb: CallbackWire): string {
  const { sla } = cb;
  if (sla.minutosRestantes === null) return SLA_LABEL[sla.estado];
  return sla.minutosRestantes >= 0 ? `${SLA_LABEL[sla.estado]}: faltan ${sla.minutosRestantes} min (objetivo ${sla.objetivoMin} min)` : `${SLA_LABEL[sla.estado]}: hace ${-sla.minutosRestantes} min (objetivo ${sla.objetivoMin} min)`;
}

export function CallbacksPanel({ ctx }: { ctx: RestaurantesShellContext }) {
  const { apiBaseUrl, token, propertyId, role } = ctx;
  const esGestor = GESTORES.has(role);
  const { pedirTexto, dialogo } = useConfirm();
  const [filtro, setFiltro] = useState<"abiertos" | CallbackEstado | "todos">("abiertos");
  const [items, setItems] = useState<readonly CallbackWire[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const [miembros, setMiembros] = useState<readonly OrgMember[]>([]);
  const [asignando, setAsignando] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let cancelado = false;
    setItems(null);
    (async () => {
      try {
        const r = await fetchCallbacks(fetch, apiBaseUrl, token, propertyId, {
          soloAbiertos: filtro === "abiertos",
          estado: filtro === "abiertos" || filtro === "todos" ? "" : filtro,
        });
        if (cancelado) return;
        setDisponible(r.disponible);
        setItems(r.items);
        setError(null);
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudieron cargar los callbacks."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, filtro, version]);

  // Solo owner/admin asignan: la lista de personas se pide una vez, y su falta nunca bloquea la bandeja.
  useEffect(() => {
    if (!esGestor) return;
    let cancelado = false;
    fetchOrgMembers(fetch, apiBaseUrl, token, propertyId)
      .then((m) => {
        if (!cancelado) setMiembros(m.filter((x) => x.verticalRole !== "repartidor" && (x.propertyIds === null || x.propertyIds.includes(propertyId))));
      })
      .catch(() => {
        if (!cancelado) setMiembros([]);
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, esGestor]);

  async function intento(cb: CallbackWire, resultado: CallbackResultado) {
    setAviso(null);
    try {
      await registrarIntento(fetch, apiBaseUrl, token, propertyId, cb.id, { resultado });
      setVersion((n) => n + 1);
    } catch (err) {
      setAviso(mensaje(err, "No se pudo registrar el intento."));
    }
  }

  async function cambiar(cb: CallbackWire, accion: CallbackAccion, extra: { asignadoA?: string; nota?: string } = {}) {
    setAviso(null);
    try {
      await actualizarCallback(fetch, apiBaseUrl, token, propertyId, cb.id, { accion, ...extra });
      setVersion((n) => n + 1);
    } catch (err) {
      setAviso(mensaje(err, "No se pudo actualizar el callback."));
      setVersion((n) => n + 1);
    }
  }

  async function resolver(cb: CallbackWire) {
    const nota = await pedirTexto({
      titulo: `Resolver el callback de ${cb.nombre}`,
      descripcion: "Anote cómo quedó (opcional). Queda guardado junto con quién lo resolvió y cuándo.",
      confirmar: "Marcar como resuelto",
      campo: { etiqueta: "Nota de resolución", multilinea: true, requerido: false, maxLength: 1000 },
    });
    if (nota === null) return;
    await cambiar(cb, "resolver", nota ? { nota } : {});
  }

  if (error) return <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />;
  if (items === null) return <EstadoCargando lineas={3} />;
  if (!disponible) return <EstadoVacio icon={MessageSquare} titulo="Callbacks no disponibles aún" mensaje="El registro de callbacks todavía no está habilitado en esta base de datos." />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="callbacks-filtro" className="text-[13px] text-muted-foreground">
          Mostrar
        </label>
        <NativeSelect id="callbacks-filtro" size="sm" wrapperClassName="w-auto" value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)}>
          <option value="abiertos">Pendientes (nuevos y en curso)</option>
          <option value="nuevo">Solo nuevos</option>
          <option value="en_curso">Solo en curso</option>
          <option value="resuelto">Resueltos</option>
          <option value="todos">Todos</option>
        </NativeSelect>
      </div>
      {aviso && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {aviso}
        </p>
      )}
      {items.length === 0 && <EstadoVacio icon={MessageSquare} titulo="Sin callbacks" mensaje="No hay llamadas por devolver con este filtro." />}
      {items.map((cb) => {
        const persona = asignando[cb.id] ?? "";
        return (
          <Card key={cb.id}>
            <CardContent className="flex flex-col gap-2 pt-4 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {cb.nombre} · {cb.telefono}
                </strong>
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone={TONO_SLA[cb.sla.estado]}>{textoSla(cb)}</StatusBadge>
                  <StatusBadge tone={TONO_ESTADO[cb.estado]}>{cb.gestionable ? CALLBACK_ESTADO_LABEL[cb.estado] : cb.resuelto ? "Resuelto" : "Pendiente"}</StatusBadge>
                </span>
              </div>
              <p className="m-0 text-muted-foreground">
                {hora(cb.creadoEn)} · {ORIGEN_LABEL[cb.origen] ?? cb.origen} · {cb.sucursalId ? "Esta sucursal" : "Sin sucursal asignada"}
                {textoMotivoCallback(cb.motivo) ? ` · ${textoMotivoCallback(cb.motivo)}` : ""}
              </p>
              {cb.gestionable && cb.asignadoNombre && <p className="m-0">Asignado a {cb.asignadoNombre}</p>}
              {cb.gestionable && cb.estado === "resuelto" && (
                <p className="m-0 text-muted-foreground">
                  Resuelto {cb.resueltoEn ? hora(cb.resueltoEn) : ""} {cb.resueltoPor ? `por ${cb.resueltoPor}` : ""}
                  {cb.notaResolucion ? ` — ${cb.notaResolucion}` : ""}
                </p>
              )}
              {cb.mensaje && <p className="m-0">{cb.mensaje}</p>}
              {cb.intentos.map((i) => (
                <p key={i.id} className="m-0 text-muted-foreground">
                  {hora(i.creadoEn)} · {CALLBACK_RESULTADO_LABEL[i.resultado]}
                  {i.autor ? ` · ${i.autor}` : ""}
                  {i.nota ? ` — ${i.nota}` : ""}
                </p>
              ))}
              {cb.estado !== "resuelto" && !cb.resuelto && (
                <div className="flex flex-wrap gap-2">
                  {cb.gestionable && cb.estado === "nuevo" && (
                    <Button size="sm" onClick={() => void cambiar(cb, "tomar")}>
                      Tomar
                    </Button>
                  )}
                  {cb.gestionable && cb.estado === "en_curso" && (
                    <>
                      <Button size="sm" onClick={() => void resolver(cb)}>
                        Resolver
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void cambiar(cb, "liberar")}>
                        Liberar
                      </Button>
                    </>
                  )}
                  {(Object.keys(CALLBACK_RESULTADO_LABEL) as CallbackResultado[]).map((r) => (
                    <Button key={r} size="sm" variant="outline" onClick={() => void intento(cb, r)}>
                      {CALLBACK_RESULTADO_LABEL[r]}
                    </Button>
                  ))}
                </div>
              )}
              {cb.gestionable && esGestor && cb.estado !== "resuelto" && miembros.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect aria-label={`Asignar el callback de ${cb.nombre}`} size="sm" wrapperClassName="w-auto" value={persona} onChange={(e) => setAsignando((p) => ({ ...p, [cb.id]: e.target.value }))}>
                    <option value="">Asignar a…</option>
                    {miembros.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.fullName}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button size="sm" variant="outline" disabled={persona === ""} onClick={() => void cambiar(cb, "asignar", { asignadoA: persona })}>
                    Asignar
                  </Button>
                </div>
              )}
              {cb.gestionable && esGestor && cb.estado === "resuelto" && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void cambiar(cb, "reabrir")}>
                    Reabrir
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      {dialogo}
    </div>
  );
}
