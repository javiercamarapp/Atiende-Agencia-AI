// Panel de agentes (SA-L-08) y bitacora de corridas (SA-L-07). Backend real: apps/api/src/routes/superadmin-agentes.ts
// (ver docs/SUPERADMIN_AGENTES.md). Cada control llama a un endpoint real:
//   * la tabla de 11 columnas sale de GET /superadmin/agentes (catalogo core.agent_definition + corridas + gasto);
//   * la palanca de cada fila es PUT /superadmin/interruptores (core.platform_switch): motivo obligatorio de 20+
//     caracteres, step-up MFA (StepUpDialog, via fetchConStepUp) y confirmacion; Cancelar y Escape NUNCA ejecutan;
//   * las corridas recientes salen de GET /superadmin/agentes/corridas y el detalle de cada una (traza) se abre en un Dialog.
// Base sin migrar: aviso honesto, sin tablas ni controles que no funcionarian. "Insumos" por agente queda fuera de
// alcance en esta fase y se dice asi, no se maqueta.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Power } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EstadoCargando,
  EstadoError,
  FormField,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  notify,
  statusTone,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";
import { AGENTE_ESTADO_TONES, CORRIDA_ESTADO_TONES } from "../lib/status-tones.ts";

type EstadoCorrida = "ok" | "parcial" | "fallo";

interface Interruptor {
  readonly bloqueado: boolean;
  readonly motivo: string | null;
  readonly actualizadoEnMs: number | null;
}

interface AgentePanel {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly canal: string;
  readonly disparador: string;
  readonly estado: string;
  readonly modelo: string | null;
  readonly ultimaCorrida: { readonly en: string; readonly estado: EstadoCorrida | null } | null;
  readonly interruptor: Interruptor | null;
  readonly exito30d: { readonly corridas: number; readonly ok: number; readonly porcentaje: number | null };
  readonly costo30dUsd: number;
  readonly llamadas30d: number;
  readonly presupuestoDiaUsd: number | null;
  readonly insumos: string;
}

interface RespuestaPanel {
  readonly disponible: boolean;
  readonly razon?: string;
  readonly interruptoresDisponible: boolean;
  readonly agentes: readonly AgentePanel[];
}

interface Corrida {
  readonly id: string;
  readonly agente: string;
  readonly vertical: string;
  readonly organizationId: string | null;
  readonly disparo: string;
  readonly estado: EstadoCorrida;
  readonly tareasHechas: number | null;
  readonly tareasTotal: number | null;
  readonly costoUsd: number | null;
  readonly error: string | null;
  readonly iniciadoEn: string;
  readonly terminadoEn: string;
  readonly duracionMs: number;
}

interface RespuestaCorridas {
  readonly disponible: boolean;
  readonly razon?: string;
  readonly corridas: readonly Corrida[];
}

interface CambioPalanca {
  readonly agente: AgentePanel;
  readonly bloquear: boolean;
}

const ETIQUETA_ESTADO_AGENTE: Readonly<Record<string, string>> = { vivo: "Vivo", pausado: "Pausado", disenado: "Diseñado", retirado: "Retirado" };
const ETIQUETA_ESTADO_CORRIDA: Readonly<Record<string, string>> = { ok: "Correcta", parcial: "Parcial", fallo: "Con fallo" };
const ETIQUETA_DISPARO: Readonly<Record<string, string>> = { cron: "Cron", whatsapp: "WhatsApp", voz: "Voz", manual: "Manual" };
const ETIQUETA_CANAL: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", voz: "Voz", cron: "Cron", panel: "Panel", api: "API" };
const MOTIVO_MINIMO = 20;

async function llamar<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

const fecha = (iso: string): string => new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
const usd = (v: number): string => `US$ ${v.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 4 : 2 })}`;
function duracion(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toLocaleString("es-MX", { maximumFractionDigits: 1 })} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function Dato({ etiqueta, children }: { readonly etiqueta: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{etiqueta}</dt>
      <dd className="text-ui text-foreground break-words">{children}</dd>
    </div>
  );
}

export function SuperAdminAgentesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [panel, setPanel] = useState<RespuestaPanel | null>(null);
  const [errorPanel, setErrorPanel] = useState<string | null>(null);
  const [corridas, setCorridas] = useState<RespuestaCorridas | null>(null);
  const [errorCorridas, setErrorCorridas] = useState<string | null>(null);
  const [filtroAgente, setFiltroAgente] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");
  const [cambio, setCambio] = useState<CambioPalanca | null>(null);
  const [traza, setTraza] = useState<Corrida | null>(null);

  const cargarPanel = useCallback(async () => {
    setErrorPanel(null);
    try {
      setPanel(await llamar<RespuestaPanel>(apiBaseUrl, token, "/superadmin/agentes"));
    } catch {
      setErrorPanel("No se pudo cargar el panel de agentes.");
    }
  }, [apiBaseUrl, token]);

  const cargarCorridas = useCallback(async () => {
    setErrorCorridas(null);
    const q = new URLSearchParams({ limite: "50" });
    if (filtroAgente) q.set("agente", filtroAgente);
    if (filtroEstado) q.set("estado", filtroEstado);
    try {
      setCorridas(await llamar<RespuestaCorridas>(apiBaseUrl, token, `/superadmin/agentes/corridas?${q.toString()}`));
    } catch {
      setErrorCorridas("No se pudieron cargar las corridas.");
    }
  }, [apiBaseUrl, token, filtroAgente, filtroEstado]);

  useEffect(() => {
    void cargarPanel();
  }, [cargarPanel]);
  useEffect(() => {
    void cargarCorridas();
  }, [cargarCorridas]);

  async function aplicarPalanca(motivo: string | undefined): Promise<void> {
    if (!cambio) return;
    try {
      await llamar(apiBaseUrl, token, "/superadmin/interruptores", {
        method: "PUT",
        body: JSON.stringify({ scope: "agente", target: cambio.agente.id, bloqueado: cambio.bloquear, motivo }),
      });
    } catch (err) {
      // El dialogo queda abierto (la promesa se rechaza): nada se ejecuto.
      notify.error(err instanceof Error ? err.message : "No se pudo aplicar el cambio.");
      throw err;
    }
    notify.success(cambio.bloquear ? `Agente detenido: ${cambio.agente.nombre}.` : `Agente reactivado: ${cambio.agente.nombre}.`);
    await cargarPanel();
  }

  const columnas = useMemo<DataTableColumna<AgentePanel>[]>(
    () => [
      {
        id: "agente",
        encabezado: "Agente",
        principal: true,
        valorOrden: (a) => a.nombre,
        celda: (a) => (
          <div className="min-w-[10rem]">
            <div className="font-medium text-foreground">{a.nombre}</div>
            <div className="font-mono text-xs text-muted-foreground">{a.id}</div>
          </div>
        ),
      },
      { id: "vertical", encabezado: "Departamento", valorOrden: (a) => a.vertical, celda: (a) => <span className="capitalize">{a.vertical}</span> },
      {
        id: "estado",
        encabezado: "Estado",
        valorOrden: (a) => a.estado,
        celda: (a) => <StatusBadge tone={statusTone(AGENTE_ESTADO_TONES, a.estado)}>{ETIQUETA_ESTADO_AGENTE[a.estado] ?? a.estado}</StatusBadge>,
      },
      {
        id: "disparador",
        encabezado: "Disparador",
        celda: (a) => (
          <div className="min-w-[9rem]">
            <div>{a.disparador}</div>
            <div className="text-xs text-muted-foreground">{ETIQUETA_CANAL[a.canal] ?? a.canal}</div>
          </div>
        ),
      },
      {
        id: "ultima",
        encabezado: "Última corrida",
        valorOrden: (a) => (a.ultimaCorrida ? new Date(a.ultimaCorrida.en) : null),
        celda: (a) =>
          a.ultimaCorrida ? (
            <div className="grid gap-1">
              <span className="whitespace-nowrap">{fecha(a.ultimaCorrida.en)}</span>
              {a.ultimaCorrida.estado && <StatusBadge tone={statusTone(CORRIDA_ESTADO_TONES, a.ultimaCorrida.estado)}>{ETIQUETA_ESTADO_CORRIDA[a.ultimaCorrida.estado]}</StatusBadge>}
            </div>
          ) : (
            <span className="text-muted-foreground">Sin corridas</span>
          ),
      },
      {
        id: "palanca",
        encabezado: "Kill switch",
        ocultarEnTarjeta: false,
        celda: (a) => {
          const sw = a.interruptor;
          if (sw === null) return <span className="text-muted-foreground">No disponible aún</span>;
          return (
            <div className="grid gap-1">
              <StatusBadge tone={sw.bloqueado ? "danger" : "success"}>{sw.bloqueado ? "Detenido" : "Activo"}</StatusBadge>
              <Button
                type="button"
                size="sm"
                variant={sw.bloqueado ? "default" : "outline"}
                className="gap-1.5"
                aria-label={`${sw.bloqueado ? "Reactivar" : "Detener"} ${a.nombre}`}
                onClick={() => setCambio({ agente: a, bloquear: !sw.bloqueado })}
              >
                <Power className="size-3.5" strokeWidth={1.75} />
                {sw.bloqueado ? "Reactivar" : "Detener"}
              </Button>
            </div>
          );
        },
      },
      { id: "modelo", encabezado: "Modelo", celda: (a) => (a.modelo ? <span className="font-mono text-xs">{a.modelo}</span> : <span className="text-muted-foreground">—</span>) },
      {
        id: "exito",
        encabezado: "Éxito 30d",
        alinear: "right",
        valorOrden: (a) => a.exito30d.porcentaje,
        celda: (a) =>
          a.exito30d.porcentaje === null ? (
            <span className="text-muted-foreground">Sin corridas</span>
          ) : (
            <span title={`${a.exito30d.ok} de ${a.exito30d.corridas} corridas`}>{a.exito30d.porcentaje.toLocaleString("es-MX", { maximumFractionDigits: 1 })} %</span>
          ),
      },
      { id: "costo", encabezado: "Costo 30d", alinear: "right", valorOrden: (a) => a.costo30dUsd, celda: (a) => usd(a.costo30dUsd) },
      {
        id: "presupuesto",
        encabezado: "Presupuesto/día",
        alinear: "right",
        valorOrden: (a) => a.presupuestoDiaUsd,
        celda: (a) => (a.presupuestoDiaUsd === null ? <span className="text-muted-foreground">Sin tope</span> : usd(a.presupuestoDiaUsd)),
      },
      { id: "insumos", encabezado: "Insumos", celda: (a) => <span className="text-muted-foreground capitalize">{a.insumos}</span> },
    ],
    [],
  );

  const columnasCorridas = useMemo<DataTableColumna<Corrida>[]>(
    () => [
      { id: "inicio", encabezado: "Inicio", principal: true, valorOrden: (c) => new Date(c.iniciadoEn), celda: (c) => <span className="whitespace-nowrap">{fecha(c.iniciadoEn)}</span> },
      {
        id: "agente",
        encabezado: "Agente",
        valorOrden: (c) => c.agente,
        celda: (c) => <span className="font-mono text-xs break-all">{c.agente}</span>,
      },
      { id: "disparo", encabezado: "Disparo", celda: (c) => ETIQUETA_DISPARO[c.disparo] ?? c.disparo },
      { id: "estado", encabezado: "Estado", valorOrden: (c) => c.estado, celda: (c) => <StatusBadge tone={statusTone(CORRIDA_ESTADO_TONES, c.estado)}>{ETIQUETA_ESTADO_CORRIDA[c.estado]}</StatusBadge> },
      { id: "duracion", encabezado: "Duración", alinear: "right", valorOrden: (c) => c.duracionMs, celda: (c) => duracion(c.duracionMs) },
      {
        id: "tareas",
        encabezado: "Tareas",
        alinear: "right",
        celda: (c) => (c.tareasHechas === null && c.tareasTotal === null ? <span className="text-muted-foreground">No medido</span> : `${c.tareasHechas ?? "?"} de ${c.tareasTotal ?? "?"}`),
      },
      { id: "costo", encabezado: "Costo", alinear: "right", valorOrden: (c) => c.costoUsd, celda: (c) => (c.costoUsd === null ? <span className="text-muted-foreground">No medido</span> : usd(c.costoUsd)) },
    ],
    [],
  );

  if (errorPanel && !panel) return <EstadoError mensaje={errorPanel} onReintentar={() => void cargarPanel()} />;
  if (!panel) return <EstadoCargando etiqueta="Cargando agentes…" />;

  return (
    <PageContainer>
      <PageHeader
        titulo="Panel de agentes"
        descripcion="Cada agente de la plataforma con su modelo, su última corrida, su éxito y costo de los últimos 30 días y su interruptor. Detener o reactivar un agente exige un motivo de al menos 20 caracteres y verificación MFA."
      />

      {!panel.disponible && (
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          {panel.razon ?? "Falta aplicar la migración 0044_superadmin_corridas_y_panel_agentes."} Mientras tanto los agentes siguen funcionando como antes y sus interruptores siguen disponibles en Interruptores.
        </Callout>
      )}
      {panel.disponible && !panel.interruptoresDisponible && (
        <Callout tone="info" titulo="Interruptores no disponibles aún">
          Falta aplicar la migración 0025_superadmin_mfa_switches_orgs: la columna Kill switch no puede mostrar ni cambiar el estado real.
        </Callout>
      )}

      {panel.disponible && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Agentes</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable<AgentePanel>
                etiqueta="Agentes de la plataforma"
                columnas={columnas}
                filas={panel.agentes}
                obtenerId={(a) => a.id}
                paginacion={{ tamano: 15 }}
                vacio={{ mensaje: "El catálogo de agentes está vacío." }}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                El éxito cuenta corridas registradas en la bitácora: un agente sin corridas registradas aparece «Sin corridas» (no 0 %). El costo suma el gasto de IA del agente y de su variante escalada. Los insumos por agente quedan fuera de alcance en esta fase.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Corridas recientes</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
                <FormField label="Agente">
                  {(p) => (
                    <NativeSelect {...p} value={filtroAgente} onChange={(e) => setFiltroAgente(e.target.value)}>
                      <option value="">Todos</option>
                      {panel.agentes.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.nombre}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
                <FormField label="Estado">
                  {(p) => (
                    <NativeSelect {...p} value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
                      <option value="">Todos</option>
                      <option value="ok">Correcta</option>
                      <option value="parcial">Parcial</option>
                      <option value="fallo">Con fallo</option>
                    </NativeSelect>
                  )}
                </FormField>
              </div>
              {errorCorridas && !corridas ? (
                <EstadoError mensaje={errorCorridas} onReintentar={() => void cargarCorridas()} />
              ) : !corridas ? (
                <EstadoCargando etiqueta="Cargando corridas…" />
              ) : !corridas.disponible ? (
                <Callout tone="warning" titulo="Bitácora no disponible aún">
                  {corridas.razon ?? "Falta aplicar la migración 0044_superadmin_corridas_y_panel_agentes."}
                </Callout>
              ) : (
                <DataTable<Corrida>
                  etiqueta="Corridas recientes de agentes"
                  columnas={columnasCorridas}
                  filas={corridas.corridas}
                  obtenerId={(c) => c.id}
                  onFilaClick={setTraza}
                  paginacion={{ tamano: 10 }}
                  vacio={{ mensaje: "Todavía no hay corridas registradas con estos filtros. Las corridas de cron y de los agentes de WhatsApp aparecen aquí al ejecutarse." }}
                />
              )}
              <p className="text-xs text-muted-foreground">Selecciona una corrida para ver su traza. La bitácora conserva 90 días.</p>
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={cambio !== null}
        onOpenChange={(open) => !open && setCambio(null)}
        titulo={cambio ? `${cambio.bloquear ? "Detener" : "Reactivar"} ${cambio.agente.nombre}` : ""}
        descripcion={
          cambio
            ? cambio.bloquear
              ? "El agente deja de responder en todas las organizaciones (los mensajes se derivan a una persona donde aplica). Puede tardar hasta 10 segundos en todas las instancias. Pedirá tu código MFA y quedará en la bitácora."
              : "El agente vuelve a responder en todas las organizaciones. Pedirá tu código MFA y quedará en la bitácora."
            : undefined
        }
        tono={cambio?.bloquear ? "danger" : "default"}
        confirmar={cambio?.bloquear ? "Detener agente" : "Reactivar agente"}
        campo={{ etiqueta: "Motivo", multilinea: true, minLength: MOTIVO_MINIMO, maxLength: 500, ayuda: `Obligatorio, mínimo ${MOTIVO_MINIMO} caracteres.`, placeholder: "Ej. El proveedor reporta caída; se detiene hasta confirmar." }}
        onConfirm={aplicarPalanca}
      />

      <Dialog open={traza !== null} onOpenChange={(open) => !open && setTraza(null)}>
        <DialogContent className="max-w-xl">
          {traza && (
            <>
              <DialogHeader>
                <DialogTitle>Traza de la corrida</DialogTitle>
                <DialogDescription className="font-mono text-xs break-all">{traza.agente}</DialogDescription>
              </DialogHeader>
              <dl className="grid gap-3 sm:grid-cols-2">
                <Dato etiqueta="Estado">
                  <StatusBadge tone={statusTone(CORRIDA_ESTADO_TONES, traza.estado)}>{ETIQUETA_ESTADO_CORRIDA[traza.estado]}</StatusBadge>
                </Dato>
                <Dato etiqueta="Disparo">{ETIQUETA_DISPARO[traza.disparo] ?? traza.disparo}</Dato>
                <Dato etiqueta="Inicio">{fecha(traza.iniciadoEn)}</Dato>
                <Dato etiqueta="Fin">{fecha(traza.terminadoEn)}</Dato>
                <Dato etiqueta="Duración">{duracion(traza.duracionMs)}</Dato>
                <Dato etiqueta="Departamento">
                  <span className="capitalize">{traza.vertical}</span>
                </Dato>
                <Dato etiqueta="Tareas">{traza.tareasHechas === null && traza.tareasTotal === null ? "No medido" : `${traza.tareasHechas ?? "?"} de ${traza.tareasTotal ?? "?"}`}</Dato>
                <Dato etiqueta="Costo">{traza.costoUsd === null ? "No medido" : usd(traza.costoUsd)}</Dato>
                <Dato etiqueta="Organización">{traza.organizationId ? <span className="font-mono text-xs break-all">{traza.organizationId}</span> : "Plataforma (sin organización)"}</Dato>
              </dl>
              <div className="grid gap-1">
                <p className="text-xs text-muted-foreground">Error (redactado, sin datos personales)</p>
                {traza.error ? <p className="rounded-lg border border-border bg-canvas p-2 text-ui text-foreground break-words">{traza.error}</p> : <p className="text-ui text-muted-foreground">Sin error.</p>}
              </div>
              <div className="flex justify-end">
                <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setTraza(null)}>
                  Cerrar
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
