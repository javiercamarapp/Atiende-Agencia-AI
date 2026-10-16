// Aprobaciones humanas (H-03) -- cola de acciones sensibles que PROPONE el agente (descuentos o cambios de tarifa,
// reembolsos, respuestas a reseñas, mensajes masivos, cargos al folio) y que una persona con rol aprueba o rechaza
// CON MOTIVO. Nada se ejecuta sin aprobacion cuando la politica lo exige; cada aprobacion se consume una sola vez.
// Consume apps/api/.../hoteles/agentes.ts. Los botones se muestran segun el rol (cosmetico: el servidor es la unica
// barrera real, 403). Contra una base sin la migracion 035 la pantalla avisa y no rompe (sin 500).
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  Callout,
  DataTable,
  EstadoCargando,
  EstadoError,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  notify,
  useConfirm,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ACCIONES,
  ACCION_LABELS,
  AGENT_AUTHOR_ROLES,
  ESTADO_APROBACION_LABELS,
  MOTIVO_BLOQUEO_LABELS,
  accionesDisponibles,
  decidirAprobacion,
  describirAlcance,
  ejecutarAprobacion,
  fetchAprobacion,
  fetchAprobaciones,
  formatearVigencia,
  minutosParaExpirar,
  nuevaLlave,
  proponerAprobacion,
} from "../lib/agentes-client.ts";
import type { AccionAprobacion, Aprobacion, AprobacionDetalle, AprobacionesResultado, EstadoAprobacion } from "../lib/agentes-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

function estadoTono(e: EstadoAprobacion): "warning" | "success" | "danger" | "neutral" | "info" {
  if (e === "pendiente") return "warning";
  if (e === "aprobada" || e === "ejecutada") return "success";
  if (e === "rechazada" || e === "bloqueada") return "danger";
  return "neutral";
}

const MIN_MOTIVO = 5;
const validarMotivo = (v: string) => (v.trim().length < MIN_MOTIVO ? `Escribe al menos ${MIN_MOTIVO} caracteres.` : null);

export function AprobacionesAgentesPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [abiertas, setAbiertas] = useState<AprobacionesResultado | null>(null);
  const [historial, setHistorial] = useState<AprobacionesResultado | null>(null);
  const [detalle, setDetalle] = useState<AprobacionDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"abiertas" | "historial">("abiertas");
  const [proponiendo, setProponiendo] = useState(false);
  const [nueva, setNueva] = useState({ accion: "descuento_tarifa" as AccionAprobacion, resumen: "", valor: "", contenido: "" });
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const { pedirTexto, confirmar, dialogo } = useConfirm();

  const puedeProponer = AGENT_AUTHOR_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAbiertas(await fetchAprobaciones(fetch, apiBaseUrl, token, propertyId, { abiertas: true }));
      setHistorial(await fetchAprobaciones(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la cola de aprobaciones.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      notify.success(okMessage);
      setDetalle(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  async function decidir(a: Aprobacion, accion: "aprobar" | "rechazar" | "cancelar") {
    const titulo = { aprobar: "Aprobar la solicitud", rechazar: "Rechazar la solicitud", cancelar: "Cancelar la solicitud" }[accion];
    const motivo = await pedirTexto({
      titulo,
      descripcion: `${ACCION_LABELS[a.accion]}: ${a.resumen} (${describirAlcance(a)}). El motivo queda en la bitácora.`,
      tono: accion === "aprobar" ? "default" : "danger",
      confirmar: { aprobar: "Aprobar", rechazar: "Rechazar", cancelar: "Cancelar solicitud" }[accion],
      cancelar: "Volver",
      campo: { etiqueta: "Motivo", multilinea: true, minLength: MIN_MOTIVO, maxLength: 500, validar: validarMotivo },
    });
    if (motivo === null) return;
    await run(a.id, () => decidirAprobacion(fetch, apiBaseUrl, token, propertyId, a.id, accion, motivo), { aprobar: "Solicitud aprobada.", rechazar: "Solicitud rechazada.", cancelar: "Solicitud cancelada." }[accion]);
  }

  async function ejecutar(a: Aprobacion) {
    let referencia: string | undefined;
    if (a.accion === "respuesta_resena") {
      const ok = await confirmar({ titulo: "Publicar la respuesta a la reseña", descripcion: "Se registra la respuesta aprobada en la reseña. Solo se ejecuta una vez.", confirmar: "Ejecutar", cancelar: "Volver" });
      if (!ok) return;
    } else {
      const ref = await pedirTexto({
        titulo: "Registrar la ejecución",
        descripcion: `Aplica el cambio (${ACCION_LABELS[a.accion]}) desde su pantalla y registra aquí la referencia. Solo se ejecuta una vez.`,
        confirmar: "Marcar ejecutada",
        cancelar: "Volver",
        campo: { etiqueta: "Referencia (folio, tarifa, envío…)", minLength: MIN_MOTIVO, maxLength: 200, validar: validarMotivo },
      });
      if (ref === null) return;
      referencia = ref;
    }
    await run(a.id, () => ejecutarAprobacion(fetch, apiBaseUrl, token, propertyId, a.id, referencia), "Ejecución registrada.");
  }

  async function verDetalle(a: Aprobacion) {
    try {
      setDetalle(await fetchAprobacion(fetch, apiBaseUrl, token, propertyId, a.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle.");
    }
  }

  async function handleProponer() {
    const valor = Number(nueva.valor);
    const sinValor = needsValue(nueva.accion) && !(Number.isFinite(valor) && valor > 0);
    const sinContenido = (nueva.accion === "mensaje_masivo" || nueva.accion === "respuesta_resena") && nueva.contenido.trim().length < 1;
    if (nueva.resumen.trim().length < 1 || sinValor || sinContenido) {
      setErrorForm("Completa el resumen, el valor y el texto (si aplica) de la solicitud.");
      return;
    }
    setErrorForm(null);
    const input = {
      accion: nueva.accion,
      resumen: nueva.resumen.trim(),
      llaveIdempotencia: nuevaLlave(),
      ...(nueva.accion === "descuento_tarifa" ? { porcentaje: valor } : {}),
      ...(nueva.accion === "reembolso" || nueva.accion === "cargo_folio" ? { montoCentavos: Math.round(valor * 100) } : {}),
      ...(nueva.accion === "mensaje_masivo" ? { destinatarios: Math.round(valor) } : {}),
      ...(nueva.accion === "mensaje_masivo" || nueva.accion === "respuesta_resena" ? { contenido: nueva.contenido.trim() } : {}),
    };
    await run("proponer", async () => {
      await proponerAprobacion(fetch, apiBaseUrl, token, propertyId, input);
      setNueva({ ...nueva, resumen: "", valor: "", contenido: "" });
      setProponiendo(false);
      setTab("abiertas");
    }, "Solicitud enviada a revisión: otra persona con rol de aprobador debe decidirla.");
  }

  const columnas: DataTableColumna<Aprobacion>[] = [
    { id: "accion", encabezado: "Acción", principal: true, valorOrden: (a) => a.accion, celda: (a) => <span className="font-medium">{ACCION_LABELS[a.accion]}</span> },
    {
      id: "detalle",
      encabezado: "Solicitud",
      celda: (a) => (
        <div className="flex flex-col gap-0.5">
          <span>{a.resumen}</span>
          <span className="text-xs text-muted-foreground">{describirAlcance(a)}</span>
          {a.motivoBloqueo && <span className="text-xs text-destructive">{MOTIVO_BLOQUEO_LABELS[a.motivoBloqueo] ?? a.motivoBloqueo}</span>}
        </div>
      ),
    },
    { id: "origen", encabezado: "Origen", valorOrden: (a) => a.agente, celda: (a) => (a.propuestaPorAgente ? <StatusBadge tone="info" dot={false}>Agente: {a.agente}</StatusBadge> : <StatusBadge tone="neutral" dot={false}>Persona</StatusBadge>) },
    {
      id: "vence",
      encabezado: "Vigencia",
      valorOrden: (a) => a.expiraEn,
      celda: (a) => (a.estado === "pendiente" || a.estado === "aprobada" ? formatearVigencia(minutosParaExpirar(a.expiraEn, (abiertas ?? historial)?.ahora ?? new Date().toISOString())) : "—"),
    },
    { id: "estado", encabezado: "Estado", valorOrden: (a) => a.estado, celda: (a) => <StatusBadge tone={estadoTono(a.estado)}>{ESTADO_APROBACION_LABELS[a.estado]}{a.autoaprobada ? " (auto)" : ""}</StatusBadge> },
    {
      id: "acciones",
      encabezado: "Acciones",
      ocultarEnTarjeta: false,
      celda: (a) => (
        <div className="flex flex-wrap gap-2">
          {accionesDisponibles(a, role, null).map((acc) => (
            <Button
              key={acc}
              type="button"
              size="sm"
              variant={acc === "aprobar" || acc === "ejecutar" ? "default" : "outline"}
              disabled={busy === a.id}
              onClick={() => void (acc === "ejecutar" ? ejecutar(a) : decidir(a, acc))}
            >
              {{ aprobar: "Aprobar", rechazar: "Rechazar", cancelar: "Cancelar", ejecutar: "Ejecutar" }[acc]}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => void verDetalle(a)}>
            Bitácora
          </Button>
        </div>
      ),
    },
  ];

  const cargando = !abiertas && !error;
  const noDisponible = abiertas && !abiertas.disponible;

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Aprobaciones"
        descripcion="Acciones sensibles que propone el agente y que una persona con rol aprueba o rechaza con motivo."
        meta={abiertas?.disponible ? <span>{abiertas.aprobaciones.filter((a) => a.estado === "pendiente").length} pendientes · {abiertas.aprobaciones.filter((a) => a.estado === "aprobada").length} aprobadas sin ejecutar</span> : undefined}
        acciones={
          puedeProponer && abiertas?.disponible ? (
            <Button
              type="button"
              iconLeft={<Plus className="size-4" strokeWidth={1.75} />}
              onClick={() => {
                setErrorForm(null);
                setProponiendo(true);
              }}
            >
              Nueva solicitud
            </Button>
          ) : undefined
        }
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {cargando && <EstadoCargando etiqueta="Cargando aprobaciones…" />}

      {noDisponible && (
        <Callout tone="info">
          Las aprobaciones humanas aún no están activas en esta base de datos: se activan cuando se aplique la actualización pendiente. Mientras tanto el agente no ejecuta acciones sensibles por su cuenta.
        </Callout>
      )}

      {abiertas?.disponible && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="abiertas">Por decidir</TabsTrigger>
            <TabsTrigger value="historial">Historial</TabsTrigger>
          </TabsList>

          <TabsContent value="abiertas" className="mt-4">
            <DataTable
              etiqueta="Solicitudes por decidir"
              columnas={columnas}
              filas={abiertas.aprobaciones}
              obtenerId={(a) => a.id}
              vacio={{ mensaje: "No hay solicitudes por decidir. Cuando un agente proponga una acción sensible aparecerá aquí." }}
            />
          </TabsContent>

          <TabsContent value="historial" className="mt-4">
            <DataTable
              etiqueta="Historial de solicitudes"
              columnas={columnas}
              filas={historial?.aprobaciones ?? []}
              obtenerId={(a) => a.id}
              estado={historial ? undefined : "loading"}
              vacio={{ mensaje: "Todavía no hay solicitudes." }}
            />
          </TabsContent>

        </Tabs>
      )}

      <FormDialog
        open={proponiendo}
        onOpenChange={(abierto) => {
          if (!abierto && busy !== "proponer") setProponiendo(false);
        }}
        titulo="Nueva solicitud"
        subtitulo="Una solicitud tuya la decide otra persona con rol de aprobador (nadie aprueba lo que propuso). Por encima de los topes configurados queda bloqueada."
        anchoClase="max-w-3xl"
        onGuardar={() => void handleProponer()}
        guardando={busy === "proponer"}
        textoBotonGuardar="Enviar a revisión"
        bloquearCierre={busy === "proponer"}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {errorForm && <Callout tone="danger" className="sm:col-span-2">{errorForm}</Callout>}
          <FormField label="Acción">
            <NativeSelect value={nueva.accion} onChange={(e) => setNueva({ ...nueva, accion: e.target.value as AccionAprobacion })}>
              {ACCIONES.map((a) => (
                <option key={a} value={a}>
                  {ACCION_LABELS[a]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          {needsValue(nueva.accion) && (
            <FormField label={valorEtiqueta(nueva.accion)} required>
              <Input type="number" min={0} step="any" value={nueva.valor} onChange={(e) => setNueva({ ...nueva, valor: e.target.value })} />
            </FormField>
          )}
          <FormField label="Resumen" required className="sm:col-span-2">
            <Input value={nueva.resumen} maxLength={300} onChange={(e) => setNueva({ ...nueva, resumen: e.target.value })} placeholder="Ej. Descuento por baja ocupación el fin de semana" />
          </FormField>
          {(nueva.accion === "mensaje_masivo" || nueva.accion === "respuesta_resena") && (
            <FormField label="Texto que se enviará" required className="sm:col-span-2">
              <Textarea value={nueva.contenido} maxLength={4000} onChange={(e) => setNueva({ ...nueva, contenido: e.target.value })} rows={4} />
            </FormField>
          )}
        </div>
      </FormDialog>

      {detalle && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">Bitácora — {ACCION_LABELS[detalle.accion]}</h2>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDetalle(null)}>
                Cerrar
              </Button>
            </div>
            {detalle.contenido && <p className="text-sm text-foreground whitespace-pre-wrap">{detalle.contenido}</p>}
            {detalle.motivoDecision && <p className="text-xs text-muted-foreground">Motivo de la decisión: {detalle.motivoDecision}</p>}
            {!detalle.bitacoraVisible && <p className="text-xs text-muted-foreground">La bitácora completa solo la ven dirección y gerencia.</p>}
            <ul className="text-sm flex flex-col gap-1">
              {detalle.bitacora.map((ev) => (
                <li key={ev.id} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">{fechaHoraEsMx(ev.creadoEn)}</span>
                  <span>{ev.tipo}</span>
                  <span className="text-muted-foreground">{ev.sistema ? "(sistema)" : ""}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {dialogo}
    </PageContainer>
  );
}

function needsValue(a: AccionAprobacion): boolean {
  return a === "descuento_tarifa" || a === "reembolso" || a === "cargo_folio" || a === "mensaje_masivo";
}
function valorEtiqueta(a: AccionAprobacion): string {
  if (a === "descuento_tarifa") return "Descuento (%)";
  if (a === "mensaje_masivo") return "Destinatarios";
  return "Monto (MXN)";
}

