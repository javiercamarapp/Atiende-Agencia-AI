// Cola de cobranza (D-11): gestiones por factura/cliente (promesa de pago, recordatorio, llamada, nota), reporte PDF de
// cartera y antigüedad, y recordatorios por WhatsApp como COLA (opt-in/opt-out) que NO envía nada. Reutiliza la cartera
// ya existente (`cobranza-client.ts`) para elegir la cuenta; todo lo nuevo vive en `cola-cobranza-client.ts`.
// Sin la migración 017 en la base, la API responde `disponible: false` y la pantalla lo dice (nunca una cola vacía engañosa).
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Download, MessageCircle, Plus } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  DataTable,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
  Textarea,
} from "@atiende/ui";
import type { DataTableColumna, StatusTone } from "@atiende/ui";
import { fetchCuentasCobranza } from "../lib/cobranza-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { CuentaCobranza } from "../lib/cobranza-client.ts";
import {
  ETIQUETAS_GESTION_TIPO,
  ETIQUETAS_URGENCIA,
  GESTION_TIPOS,
  crearGestion,
  descargarReporteCartera,
  encolarWhatsApp,
  fetchCola,
  fetchConsentimientos,
  fetchOutbox,
  fijarConsentimiento,
  formatearCentavos,
  pesosTextoACentavos,
  resolverGestion,
} from "../lib/cola-cobranza-client.ts";
import type { ColaCobranza, ConsentimientoWhatsApp, GestionResolucion, GestionTipo, ItemCola, MensajeOutbox, UrgenciaGestion } from "../lib/cola-cobranza-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const GESTIONAR_ROLES = new Set(["admin", "contador"]);
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const URGENCIA_TONES: Readonly<Record<UrgenciaGestion, StatusTone>> = { promesa_vencida: "danger", seguimiento_vencido: "warning", vence_hoy: "info", programada: "neutral" };
const OUTBOX_TONES: Readonly<Record<MensajeOutbox["estado"], StatusTone>> = { pendiente: "info", cancelado: "neutral", enviado: "success", fallido: "danger" };
const OUTBOX_ETIQUETAS: Readonly<Record<MensajeOutbox["estado"], string>> = { pendiente: "En cola (sin enviar)", cancelado: "Cancelado", enviado: "Enviado", fallido: "Fallido" };

function guardarArchivo(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function etiquetaCuenta(c: CuentaCobranza): string {
  return `${c.clienteNombre ?? "Sin nombre"} · ${c.facturaId ? `${c.facturaId.slice(0, 8)}…` : "CFDI"} · ${formatMoney(c.monto)}`;
}

export function ColaCobranzaPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const [cola, setCola] = useState<ColaCobranza | null>(null);
  const [cuentas, setCuentas] = useState<readonly CuentaCobranza[]>([]);
  const [consentimientos, setConsentimientos] = useState<{ disponible: boolean; lista: readonly ConsentimientoWhatsApp[] } | null>(null);
  const [outbox, setOutbox] = useState<{ disponible: boolean; lista: readonly MensajeOutbox[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ texto: string; error: boolean } | null>(null);
  const [descargando, setDescargando] = useState(false);

  const [mostrarGestion, setMostrarGestion] = useState(false);
  const [receivableId, setReceivableId] = useState("");
  const [tipo, setTipo] = useState<GestionTipo>("llamada");
  const [nota, setNota] = useState("");
  const [monto, setMonto] = useState("");
  const [fechaPromesa, setFechaPromesa] = useState("");
  const [fechaSeguimiento, setFechaSeguimiento] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const [rfc, setRfc] = useState("");
  const [telefono, setTelefono] = useState("");
  const [evidencia, setEvidencia] = useState("");
  const [consentError, setConsentError] = useState<string | null>(null);

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [colaRes, cuentasRes, consRes, outRes] = await Promise.all([
        fetchCola(fetch, apiBaseUrl, token, propertyId),
        fetchCuentasCobranza(fetch, apiBaseUrl, token, propertyId, { pendiente: true }),
        fetchConsentimientos(fetch, apiBaseUrl, token, propertyId),
        fetchOutbox(fetch, apiBaseUrl, token, propertyId),
      ]);
      setCola(colaRes);
      setCuentas(cuentasRes);
      setConsentimientos({ disponible: consRes.disponible, lista: consRes.consentimientos });
      setOutbox({ disponible: outRes.disponible, lista: outRes.mensajes });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la cola de cobranza.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  const rfcsConsentibles = useMemo(() => [...new Set((cola?.items ?? []).map((i) => i.cuenta.rfcReceptor).filter((x): x is string => x !== null))], [cola]);

  async function handleDescargar() {
    setDescargando(true);
    setAviso(null);
    try {
      const { blob, nombre } = await descargarReporteCartera(fetch, apiBaseUrl, token, propertyId);
      guardarArchivo(blob, nombre);
    } catch (err) {
      setAviso({ texto: err instanceof Error ? err.message : "No se pudo descargar el reporte.", error: true });
    } finally {
      setDescargando(false);
    }
  }

  async function handleCrear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!receivableId) return setFormError("Elige la cuenta por cobrar.");
    const montoCentavos = tipo === "promesa_pago" ? pesosTextoACentavos(monto) : null;
    if (tipo === "promesa_pago") {
      if (montoCentavos === null) return setFormError("Monto inválido: usa pesos con hasta 2 decimales, mayor a cero.");
      if (!FECHA_RE.test(fechaPromesa)) return setFormError("Indica la fecha prometida de pago.");
    }
    if ((tipo === "llamada" || tipo === "nota") && nota.trim() === "") return setFormError("La nota es obligatoria.");
    setEnviando(true);
    try {
      await crearGestion(fetch, apiBaseUrl, token, propertyId, {
        receivableId,
        tipo,
        nota: nota.trim() || null,
        montoPromesaCentavos: montoCentavos,
        fechaPromesa: tipo === "promesa_pago" ? fechaPromesa : null,
        fechaSeguimiento: FECHA_RE.test(fechaSeguimiento) ? fechaSeguimiento : null,
      });
      setMostrarGestion(false);
      setNota("");
      setMonto("");
      setFechaPromesa("");
      setFechaSeguimiento("");
      setAviso({ texto: "Gestión registrada.", error: false });
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo registrar la gestión.");
    } finally {
      setEnviando(false);
    }
  }

  async function handleResolver(item: ItemCola, estado: GestionResolucion) {
    setAviso(null);
    try {
      await resolverGestion(fetch, apiBaseUrl, token, propertyId, item.gestion.id, estado);
      await load();
    } catch (err) {
      setAviso({ texto: err instanceof Error ? err.message : "No se pudo actualizar la gestión.", error: true });
    }
  }

  async function handleEncolar(item: ItemCola) {
    setAviso(null);
    try {
      const r = await encolarWhatsApp(fetch, apiBaseUrl, token, propertyId, item.cuenta.id);
      setAviso({ texto: r.duplicado ? "Ya había un mensaje en cola para esta etapa hoy." : "Mensaje en cola. El envío por WhatsApp aún no está habilitado: nada se envió al cliente.", error: false });
      await load();
    } catch (err) {
      setAviso({ texto: err instanceof Error ? err.message : "No se pudo encolar el mensaje.", error: true });
    }
  }

  async function handleConsentimiento(estado: "opt_in" | "opt_out") {
    setConsentError(null);
    if (rfc.trim() === "") return setConsentError("Captura el RFC del cliente.");
    if (telefono.trim() === "") return setConsentError("Captura el teléfono del cliente.");
    if (estado === "opt_in" && evidencia.trim() === "") return setConsentError("Para el opt-in indica cómo se obtuvo el consentimiento.");
    try {
      await fijarConsentimiento(fetch, apiBaseUrl, token, propertyId, { rfcReceptor: rfc, telefono, estado, evidencia: evidencia.trim() || null });
      setAviso({ texto: estado === "opt_in" ? "Consentimiento registrado." : "Cliente dado de baja de WhatsApp; se cancelaron sus mensajes en cola.", error: false });
      await load();
    } catch (err) {
      setConsentError(err instanceof Error ? err.message : "No se pudo guardar el consentimiento.");
    }
  }

  const colaNoDisponible = cola !== null && !cola.disponible;

  const columnasConsentimientos: DataTableColumna<ConsentimientoWhatsApp>[] = [
    { id: "rfc", encabezado: "Cliente (RFC)", principal: true, valorOrden: (c) => c.rfcReceptor, celda: (c) => <span className="font-mono text-xs">{c.rfcReceptor}</span> },
    { id: "telefono", encabezado: "Teléfono", celda: (c) => <span className="tabular-nums">{c.telefono}</span> },
    {
      id: "estado",
      encabezado: "Consentimiento",
      valorOrden: (c) => c.estado,
      celda: (c) => <StatusBadge tone={c.estado === "opt_in" ? "success" : "neutral"}>{c.estado === "opt_in" ? "Opt-in" : "Opt-out"}</StatusBadge>,
    },
  ];

  const columnasCola: DataTableColumna<ItemCola>[] = [
    {
      id: "urgencia",
      encabezado: "Urgencia",
      principal: true,
      valorOrden: (item) => item.cuenta.diasVencido,
      celda: (item) => <StatusBadge tone={URGENCIA_TONES[item.urgencia]}>{ETIQUETAS_URGENCIA[item.urgencia]}</StatusBadge>,
    },
    {
      id: "cliente",
      encabezado: "Cliente",
      valorOrden: (item) => item.cuenta.clienteNombre ?? "",
      celda: (item) => (
        <div className="text-muted-foreground">
          {item.cuenta.clienteNombre ?? "Sin nombre"}
          <div className="font-mono text-xs">{item.cuenta.rfcReceptor ?? "—"}</div>
        </div>
      ),
    },
    {
      id: "gestion",
      encabezado: "Gestión",
      celda: (item) => (
        <div className="text-muted-foreground">
          {ETIQUETAS_GESTION_TIPO[item.gestion.tipo]}
          {item.gestion.tipo === "promesa_pago" && (
            <div className="text-xs tabular-nums">
              {formatearCentavos(item.gestion.montoPromesaCentavos)} el {item.gestion.fechaPromesa ? formatFechaSolo(item.gestion.fechaPromesa) : "—"}
            </div>
          )}
          {item.gestion.fechaSeguimiento && <div className="text-xs">Seguimiento: {formatFechaSolo(item.gestion.fechaSeguimiento)}</div>}
          {item.gestion.nota && <div className="max-w-xs whitespace-pre-wrap text-xs">{item.gestion.nota}</div>}
        </div>
      ),
    },
    {
      id: "saldo",
      encabezado: "Saldo",
      alinear: "right",
      valorOrden: (item) => item.cuenta.saldoCentavos,
      celda: (item) => <span className="tabular-nums text-muted-foreground">{formatearCentavos(item.cuenta.saldoCentavos)}</span>,
    },
    {
      id: "vence",
      encabezado: "Vence",
      valorOrden: (item) => item.cuenta.fechaVencimiento,
      celda: (item) => (
        <div className="text-muted-foreground">
          {formatFechaSolo(item.cuenta.fechaVencimiento)}
          <div className="text-xs">{item.cuenta.diasVencido > 0 ? `${item.cuenta.diasVencido} días de atraso` : item.cuenta.diasVencido < 0 ? `vence en ${-item.cuenta.diasVencido} días` : "vence hoy"}</div>
        </div>
      ),
    },
    ...(puedeGestionar
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            celda: (item: ItemCola) => (
              <div className="flex min-w-44 flex-col gap-1.5">
                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleResolver(item, "cumplida")}>
                  Cumplida
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleResolver(item, "incumplida")}>
                  Incumplida
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleResolver(item, "cancelada")}>
                  Cancelar
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={() => void handleEncolar(item)}>
                  <MessageCircle />
                  Encolar WhatsApp
                </Button>
              </div>
            ),
          } satisfies DataTableColumna<ItemCola>,
        ]
      : []),
  ];

  const columnasOutbox: DataTableColumna<MensajeOutbox>[] = [
    { id: "cliente", encabezado: "Cliente", principal: true, valorOrden: (m) => m.rfcReceptor, celda: (m) => <span className="font-mono text-xs text-muted-foreground">{m.rfcReceptor}</span> },
    { id: "mensaje", encabezado: "Mensaje", celda: (m) => <span className="max-w-md whitespace-pre-wrap text-sm text-muted-foreground">{m.cuerpo}</span> },
    { id: "estado", encabezado: "Estado", valorOrden: (m) => m.estado, celda: (m) => <StatusBadge tone={OUTBOX_TONES[m.estado]}>{OUTBOX_ETIQUETAS[m.estado]}</StatusBadge> },
  ];

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Cola de cobranza</h1>
          <p className="mt-1 text-sm text-muted-foreground">Promesas de pago, llamadas y seguimiento por factura; reporte de cartera y recordatorios por WhatsApp en cola.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleDescargar()} disabled={descargando}>
            <Download />
            {descargando ? "Generando…" : "Reporte PDF de cartera"}
          </Button>
          {puedeGestionar && !colaNoDisponible && (
            <Button size="sm" onClick={() => setMostrarGestion(true)}>
              <Plus />
              Registrar gestión
            </Button>
          )}
        </div>
      </header>

      {aviso && (
        <Callout tone={aviso.error ? "danger" : "success"} role={aviso.error ? "alert" : "status"}>
          {aviso.texto}
        </Callout>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {loading && !cola && <EstadoCargando etiqueta="Cargando la cola de cobranza…" />}

      {colaNoDisponible && (
        <Callout tone="warning" titulo="La cola de cobranza aún no está disponible">
          Falta aplicar la migración 017 en esta base de datos. El reporte PDF de cartera sí funciona.
        </Callout>
      )}

      {cola?.disponible && cola.items.length === 0 && !loading && <EstadoVacio mensaje="No hay gestiones pendientes. Registra una promesa de pago o una llamada con fecha de seguimiento para verla aquí." />}

      {cola?.disponible && cola.items.length > 0 && (
        <DataTable etiqueta="Cola de cobranza" columnas={columnasCola} filas={cola.items} obtenerId={(i) => i.gestion.id} atributosFila={(i) => ({ "data-gestion-id": i.gestion.id })} />
      )}

      {consentimientos?.disponible && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <h2 className="font-display text-base font-semibold text-foreground">WhatsApp: consentimiento por cliente</h2>
            <Callout tone="info">Los mensajes quedan en cola y no se envían: el despacho aún no tiene un canal de WhatsApp conectado. Solo se encolan para clientes con opt-in vigente.</Callout>
            {consentimientos.lista.length === 0 ? (
              <EstadoVacio mensaje="Ningún cliente tiene consentimiento registrado todavía." />
            ) : (
<DataTable etiqueta="Consentimientos de WhatsApp por cliente" columnas={columnasConsentimientos} filas={consentimientos.lista} obtenerId={(c) => c.rfcReceptor} />
            )}
            {puedeGestionar && (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cola-rfc">Cliente (RFC)</Label>
                    <Input id="cola-rfc" type="text" list="cola-rfcs" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} maxLength={13} placeholder="RFC del cliente" />
                    <datalist id="cola-rfcs">
                      {[...new Set([...rfcsConsentibles, ...consentimientos.lista.map((c) => c.rfcReceptor)])].map((r) => (
                        <option key={r} value={r} />
                      ))}
                    </datalist>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cola-telefono">Teléfono de WhatsApp</Label>
                    <Input id="cola-telefono" type="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="998 123 4567" />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cola-evidencia">Cómo autorizó el cliente (obligatorio para opt-in)</Label>
                  <Input id="cola-evidencia" type="text" value={evidencia} onChange={(e) => setEvidencia(e.target.value)} maxLength={300} placeholder="Ej. Firmó el aviso en el contrato de servicios" />
                </div>
                {consentError && (
                  <p role="alert" className="text-sm text-destructive">
                    {consentError}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={() => void handleConsentimiento("opt_in")}>
                    Registrar opt-in
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleConsentimiento("opt_out")}>
                    Registrar opt-out
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {outbox?.disponible && outbox.lista.length > 0 && (
        <DataTable etiqueta="Mensajes de WhatsApp en cola" columnas={columnasOutbox} filas={outbox.lista} obtenerId={(m) => m.id} />
      )}

      {mostrarGestion && (
        <FormDialog
          open
          onOpenChange={(abierto) => {
            if (!abierto) setMostrarGestion(false);
          }}
          titulo="Registrar gestión de cobranza"
          subtitulo="Deja constancia de la promesa de pago, la llamada o la nota, y programa el siguiente seguimiento."
          anchoClase="max-w-2xl"
          footer={
            <Button type="submit" form="cola-gestion" disabled={enviando} className="rounded-full px-6">
              {enviando ? "Guardando…" : "Guardar gestión"}
            </Button>
          }
        >
          <form id="cola-gestion" onSubmit={handleCrear} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cola-cuenta">Cuenta por cobrar *</Label>
              <NativeSelect id="cola-cuenta" value={receivableId} onChange={(e) => setReceivableId(e.target.value)} required>
                <option value="">Selecciona una cuenta…</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {etiquetaCuenta(c)}
                  </option>
                ))}
              </NativeSelect>
              {cuentas.length === 0 && <span className="text-xs text-muted-foreground">No hay cuentas por cobrar pendientes. Registra una desde Cobranza.</span>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cola-tipo">Tipo *</Label>
              <NativeSelect id="cola-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as GestionTipo)}>
                {GESTION_TIPOS.map((t) => (
                  <option key={t} value={t}>
                    {ETIQUETAS_GESTION_TIPO[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {tipo === "promesa_pago" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cola-monto">Monto prometido (MXN) *</Label>
                  <Input id="cola-monto" inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder="1,160.00" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cola-fecha-promesa">Fecha prometida *</Label>
                  <Input id="cola-fecha-promesa" type="date" value={fechaPromesa} onChange={(e) => setFechaPromesa(e.target.value)} />
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cola-seguimiento">Fecha de seguimiento (opcional; entra a la cola)</Label>
              <Input id="cola-seguimiento" type="date" value={fechaSeguimiento} onChange={(e) => setFechaSeguimiento(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cola-nota">Nota {tipo === "llamada" || tipo === "nota" ? "*" : "(opcional)"}</Label>
              <Textarea id="cola-nota" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={1000} rows={3} />
            </div>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
          </form>
        </FormDialog>
      )}
    </PageContainer>
  );
}
