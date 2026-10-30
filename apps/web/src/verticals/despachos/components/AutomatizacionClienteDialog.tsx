// Automatizacion de un cliente (paridad3 D-31 / D-P3-21): correo de contacto, dia y plantilla de la solicitud mensual de documentos, opt-in de la entrega
// de reportes al cerrar (apagado por omision) y el estado de lo que se le ha pedido (con «no aplica» y reabrir). Todo llama a endpoints reales
// (apps/api/.../despachos/piloto.ts); sin la migracion 027 muestra «no disponible aun» y no ofrece controles que el servidor rechazaria.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Checkbox, ConfirmDialog, EstadoCargando, EstadoError, FormDialog, Input, Label, StatusBadge, Textarea } from "@atiende/ui";
import {
  erroresAutomatizacion,
  ETIQUETA_ESTADO_RENGLON,
  fetchAutomatizacion,
  fetchSolicitudes,
  guardarAutomatizacion,
  marcarNoAplica,
  pedirDocumentos,
  periodoAnterior,
  reabrirRenglon,
  resumenRenglones,
  textoACuentas,
  TONO_ESTADO_RENGLON,
} from "../lib/piloto-client.ts";
import type { AutomatizacionCliente, RenglonSolicitud, SolicitudDocumentos } from "../lib/piloto-client.ts";

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (abierto: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly nombre: string;
  readonly puedeGestionar: boolean;
  /** Se llama tras cualquier cambio (para que la Cartera recargue su semaforo). */
  readonly onCambio: () => void;
  /** «Hoy» de negocio (AAAA-MM-DD); inyectable para pruebas. */
  readonly hoy?: string;
}

const FORM_ID = "form-automatizacion-cliente";

function plantillaMarcada(a: AutomatizacionCliente, clave: "xmlEmitidos" | "xmlRecibidos" | "nomina" | "otros"): boolean {
  return a.plantilla[clave] ?? (clave === "xmlEmitidos" || clave === "xmlRecibidos");
}

export function AutomatizacionClienteDialog({ open, onOpenChange, apiBaseUrl, token, propertyId, nombre, puedeGestionar, onCambio, hoy }: Props) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [form, setForm] = useState<AutomatizacionCliente | null>(null);
  const [cuentasTexto, setCuentasTexto] = useState("");
  const [solicitudes, setSolicitudes] = useState<readonly SolicitudDocumentos[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [intento, setIntento] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [noAplica, setNoAplica] = useState<RenglonSolicitud | null>(null);

  const periodo = periodoAnterior(hoy ?? new Date().toISOString().slice(0, 10));

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const [a, s] = [await fetchAutomatizacion(fetch, apiBaseUrl, token, propertyId), await fetchSolicitudes(fetch, apiBaseUrl, token, propertyId)];
      setDisponible(a.disponible && s.disponible);
      setForm(a.automatizacion);
      setCuentasTexto((a.automatizacion?.plantilla.estadosCuenta ?? []).join("\n"));
      setSolicitudes(s.solicitudes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la automatización del cliente.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setAviso(null);
    setErrorAccion(null);
    setIntento(false);
    void cargar();
  }, [open, apiBaseUrl, token, propertyId]);

  const set = <K extends keyof AutomatizacionCliente>(k: K, v: AutomatizacionCliente[K]) => setForm((prev) => (prev ? { ...prev, [k]: v } : prev));
  const setPlantilla = (clave: "xmlEmitidos" | "xmlRecibidos" | "nomina" | "otros", v: boolean) => setForm((prev) => (prev ? { ...prev, plantilla: { ...prev.plantilla, [clave]: v } } : prev));

  function armar(): AutomatizacionCliente | null {
    if (!form) return null;
    const cuentas = textoACuentas(cuentasTexto);
    const { estadosCuenta: _viejas, ...resto } = form.plantilla;
    return { ...form, contactoCorreo: (form.contactoCorreo ?? "").trim() === "" ? null : form.contactoCorreo!.trim(), plantilla: { ...resto, ...(cuentas.length > 0 ? { estadosCuenta: cuentas } : {}) } };
  }
  const listo = armar();
  const errores = listo ? erroresAutomatizacion(listo) : {};

  async function guardar(e?: FormEvent) {
    e?.preventDefault();
    setIntento(true);
    if (!listo || Object.keys(errores).length > 0 || guardando) return;
    setGuardando(true);
    setErrorAccion(null);
    try {
      setForm(await guardarAutomatizacion(fetch, apiBaseUrl, token, propertyId, listo));
      setAviso("Automatización guardada.");
      onCambio();
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  async function accion(clave: string, fn: () => Promise<string | null>) {
    setOcupado(clave);
    setErrorAccion(null);
    setAviso(null);
    try {
      const mensaje = await fn();
      if (mensaje) setAviso(mensaje);
      onCambio();
      await cargar();
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo completar la acción.");
      throw err;
    } finally {
      setOcupado(null);
    }
  }

  const textoCorreo: Record<string, string> = {
    enviado: " Se envió el aviso al cliente.",
    sin_contacto: " El cliente no tiene correo de contacto: la solicitud queda en su portal.",
    no_enviado: " No se pudo encolar el aviso por correo.",
    ya_existia: " Ya estaba pedida.",
  };

  const verError = (campo: string) =>
    intento && errores[campo] ? (
      <p role="alert" className="text-xs text-destructive">
        {errores[campo]}
      </p>
    ) : null;

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={(abrir) => !abrir && !guardando && onOpenChange(false)}
        titulo="Automatización del cliente"
        subtitulo={nombre}
        anchoClase="max-w-3xl"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={guardando}>
              Cerrar
            </Button>
            {puedeGestionar && disponible && form && (
              <Button type="submit" form={FORM_ID} className="rounded-full px-6" disabled={guardando}>
                {guardando ? "Guardando…" : "Guardar"}
              </Button>
            )}
          </>
        }
      >
        {cargando && !form && <EstadoCargando etiqueta="Cargando automatización…" />}
        {error && <EstadoError mensaje={error} onReintentar={() => void cargar()} />}
        {!cargando && !error && !disponible && (
          <Callout tone="warning" role="status">
            No disponible aún: la automatización por cliente requiere aplicar la migración 027 en este ambiente.
          </Callout>
        )}

        {form && disponible && (
          <div className="flex flex-col gap-5">
            <form id={FORM_ID} onSubmit={(e) => void guardar(e)} className="flex flex-col gap-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${FORM_ID}-correo`}>Correo de contacto del cliente</Label>
                  <Input id={`${FORM_ID}-correo`} type="email" value={form.contactoCorreo ?? ""} maxLength={254} disabled={!puedeGestionar} onChange={(e) => set("contactoCorreo", e.target.value)} placeholder="contacto@cliente.mx" />
                  <p className="text-xs text-muted-foreground">A este correo salen la solicitud de documentos, sus recordatorios y, si lo activas, los reportes del cierre.</p>
                  {verError("contactoCorreo")}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${FORM_ID}-dia`}>Día del mes en que se piden los documentos</Label>
                  <Input id={`${FORM_ID}-dia`} type="number" min={1} max={28} value={String(form.solicitudDia)} disabled={!puedeGestionar} onChange={(e) => set("solicitudDia", Number(e.target.value))} />
                  {verError("solicitudDia")}
                </div>
              </div>

              <Checkbox checked={form.solicitudActiva} disabled={!puedeGestionar} onChange={(e) => set("solicitudActiva", e.target.checked)} label="Pedir los documentos del mes automáticamente" descripcion="Se crea la solicitud del mes anterior en el día indicado y se recuerda a los 3, 7 y 10 días mientras falten documentos." />

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-foreground">Qué se le pide cada mes</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <Checkbox checked={plantillaMarcada(form, "xmlEmitidos")} disabled={!puedeGestionar} onChange={(e) => setPlantilla("xmlEmitidos", e.target.checked)} label="CFDI emitidos (XML)" />
                  <Checkbox checked={plantillaMarcada(form, "xmlRecibidos")} disabled={!puedeGestionar} onChange={(e) => setPlantilla("xmlRecibidos", e.target.checked)} label="CFDI recibidos (XML)" />
                  <Checkbox checked={plantillaMarcada(form, "nomina")} disabled={!puedeGestionar} onChange={(e) => setPlantilla("nomina", e.target.checked)} label="Nómina" />
                  <Checkbox checked={plantillaMarcada(form, "otros")} disabled={!puedeGestionar} onChange={(e) => setPlantilla("otros", e.target.checked)} label="Otros documentos" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${FORM_ID}-cuentas`}>Cuentas bancarias (una por línea; vacío = las que ya tengan movimientos importados)</Label>
                  <Textarea id={`${FORM_ID}-cuentas`} rows={3} value={cuentasTexto} disabled={!puedeGestionar} onChange={(e) => setCuentasTexto(e.target.value)} placeholder="0123456789012345" />
                  {verError("estadosCuenta")}
                </div>
              </fieldset>

              <div className="rounded-md border border-border p-3">
                <Checkbox
                  checked={form.envioReportesCierre}
                  disabled={!puedeGestionar}
                  onChange={(e) => set("envioReportesCierre", e.target.checked)}
                  label="Enviar al cliente sus reportes al cerrar el periodo"
                  descripcion="Apagado por omisión. Al cerrar, se publican el PDF de impuestos, la DIOT y la balanza en su portal y se le manda un correo con el enlace. Se respeta la lista de supresión de correo."
                />
                {verError("envioReportesCierre")}
              </div>
            </form>

            {errorAccion && (
              <p role="alert" className="text-sm text-destructive">
                {errorAccion}
              </p>
            )}
            {aviso && (
              <p role="status" className="text-sm text-success">
                {aviso}
              </p>
            )}

            <section aria-labelledby="documentos-pedidos" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="documentos-pedidos" className="font-display text-base font-semibold text-foreground">
                  Documentos pedidos al cliente
                </h3>
                {puedeGestionar && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={ocupado !== null || solicitudes.some((s) => `${s.ejercicio}-${String(s.mes).padStart(2, "0")}` === periodo)}
                    onClick={() => void accion("pedir", async () => `Documentos de ${periodo} pedidos.${textoCorreo[(await pedirDocumentos(fetch, apiBaseUrl, token, propertyId, periodo)).correo] ?? ""}`).catch(() => undefined)}
                  >
                    {ocupado === "pedir" ? "Pidiendo…" : `Pedir documentos de ${periodo}`}
                  </Button>
                )}
              </div>
              {solicitudes.length === 0 && <p className="text-sm text-muted-foreground">Todavía no se le ha pedido nada a este cliente.</p>}
              {solicitudes.map((s) => (
                <div key={s.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-foreground">
                      {s.ejercicio}-{String(s.mes).padStart(2, "0")}
                    </strong>
                    <StatusBadge tone={s.estado === "completa" ? "success" : "warning"}>{s.estado === "completa" ? "Completa" : "Abierta"}</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{resumenRenglones(s)}</p>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {s.renglones.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="text-foreground">
                          {r.etiqueta}
                          {r.motivoNoAplica && <span className="ml-2 text-xs text-muted-foreground">({r.motivoNoAplica})</span>}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge tone={TONO_ESTADO_RENGLON[r.estado]}>{ETIQUETA_ESTADO_RENGLON[r.estado]}</StatusBadge>
                          {puedeGestionar && (r.estado === "pendiente" || r.estado === "en_revision") && (
                            <Button type="button" size="sm" variant="ghost" disabled={ocupado !== null} onClick={() => setNoAplica(r)}>
                              No aplica
                            </Button>
                          )}
                          {puedeGestionar && r.estado === "no_aplica" && (
                            <Button type="button" size="sm" variant="ghost" disabled={ocupado !== null} onClick={() => void accion(`reabrir-${r.id}`, async () => (await reabrirRenglon(fetch, apiBaseUrl, token, propertyId, r.id), "Documento reabierto.")).catch(() => undefined)}>
                              Reabrir
                            </Button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          </div>
        )}
      </FormDialog>

      <ConfirmDialog
        open={noAplica !== null}
        onOpenChange={(abierto) => !abierto && setNoAplica(null)}
        titulo="Marcar como «no aplica»"
        descripcion={noAplica ? `${noAplica.etiqueta}: explica por qué no se necesita este mes. Queda registrado en la solicitud.` : undefined}
        confirmar="Marcar como no aplica"
        campo={{ etiqueta: "Motivo", multilinea: true, minLength: 3, maxLength: 300, placeholder: "Por ejemplo: no emitió facturas este mes" }}
        onConfirm={async (motivo) => {
          const r = noAplica;
          if (!r) return;
          await accion(`noaplica-${r.id}`, async () => (await marcarNoAplica(fetch, apiBaseUrl, token, propertyId, r.id, motivo ?? ""), "Marcado como «no aplica».")).catch((err: unknown) => {
            throw err;
          });
          setNoAplica(null);
        }}
      />
    </>
  );
}
