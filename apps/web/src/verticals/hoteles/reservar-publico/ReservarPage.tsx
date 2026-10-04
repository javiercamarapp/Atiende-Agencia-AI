// Reserva directa PUBLICA del hotel (H-42), movil primero: fechas y huespedes -> tipos con precio -> cotizacion firmada por el servidor ->
// datos del huesped y aviso -> confirmacion con enlace de estado. TODO lo que se muestra sale del servidor (precio, anticipo, terminos de cancelacion).
// Sin pasarela de tarjeta en esta pantalla: si el hotel pide anticipo, la reserva queda "pago pendiente" y el hotel contacta al huesped (hueco H-23).
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label, StatusBadge } from "@atiende/ui";
import { useMetaPublica } from "../../restaurantes/storefront/meta-publica.ts";
import { ReservarLayout } from "./Layout.tsx";
import {
  ETIQUETA_ESTADO,
  ReservarError,
  crearClienteReservar,
  nuevaClave,
  pesos,
  type ClienteReservar,
  type Cotizacion,
  type DatosHuesped,
  type PropiedadReserva,
  type ReservaCreada,
  type RespuestaConfig,
  type RespuestaDisponibilidad,
} from "./cliente.ts";

const hoyISO = (): string => new Date().toISOString().slice(0, 10);
const masDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface ErroresHuesped {
  nombre?: string;
  telefono?: string;
  correo?: string;
  acepta?: string;
}
/** Validacion previa en el navegador (el servidor valida de nuevo): ahorra un viaje, nunca reemplaza al servidor. */
export function validarHuesped(h: DatosHuesped, acepta: boolean): ErroresHuesped {
  const e: ErroresHuesped = {};
  if (h.nombre.trim().length < 2) e.nombre = "Escribe tu nombre completo.";
  if (h.telefono.replace(/\D/g, "").length < 10) e.telefono = "Escribe un teléfono de 10 dígitos.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h.correo.trim())) e.correo = "Escribe un correo válido.";
  if (!acepta) e.acepta = "Debes aceptar el aviso de privacidad para reservar.";
  return e;
}

export function ReservarPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  useMetaPublica({ titulo: "Reserva directa", descripcion: "Reserva tu estancia directamente con el hotel.", indexable: true });
  const cliente = useMemo(() => crearClienteReservar(fetch, apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [config, setConfig] = useState<RespuestaConfig | "cargando" | "no_encontrado" | { error: string }>("cargando");
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setConfig("cargando");
    cliente
      .config()
      .then((r) => !cancelado && setConfig(r))
      .catch((e: unknown) => {
        if (cancelado) return;
        if (e instanceof ReservarError && e.status === 404) setConfig("no_encontrado");
        else setConfig({ error: e instanceof Error ? e.message : "No pudimos cargar la información del hotel." });
      });
    return () => {
      cancelado = true;
    };
  }, [cliente, intento]);

  const hotel = typeof config === "object" && "hotel" in config ? config.hotel.nombre : null;
  return (
    <ReservarLayout orgSlug={orgSlug} titulo="Reserva directa" hotel={hotel}>
      {config === "cargando" && <EstadoCargando etiqueta="Cargando…" />}
      {config === "no_encontrado" && <EstadoVacio mensaje="No encontramos ese hotel. Revisa que el enlace esté completo." />}
      {typeof config === "object" && "error" in config && <EstadoError titulo="Ocurrió un problema" mensaje={config.error} onReintentar={() => setIntento((n) => n + 1)} />}
      {typeof config === "object" && "disponible" in config && !config.disponible && (
        <Callout tone="warning" titulo="No disponible aún">
          {config.motivo}
        </Callout>
      )}
      {typeof config === "object" && "disponible" in config && config.disponible && <Flujo cliente={cliente} orgSlug={orgSlug} propiedades={config.propiedades} />}
    </ReservarLayout>
  );
}

function Flujo({ cliente, orgSlug, propiedades }: { cliente: ClienteReservar; orgSlug: string; propiedades: readonly PropiedadReserva[] }) {
  const [slug, setSlug] = useState(propiedades.length === 1 ? (propiedades[0]?.slug ?? "") : "");
  const propiedad = propiedades.find((p) => p.slug === slug) ?? null;
  const [llegada, setLlegada] = useState(masDias(hoyISO(), 1));
  const [salida, setSalida] = useState(masDias(hoyISO(), 2));
  const [huespedes, setHuespedes] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disp, setDisp] = useState<RespuestaDisponibilidad | null>(null);
  const [cot, setCot] = useState<Cotizacion | null>(null);
  const [creada, setCreada] = useState<ReservaCreada | null>(null);

  if (creada) return <Confirmacion orgSlug={orgSlug} reserva={creada} />;

  async function buscar(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCot(null);
    try {
      setDisp(await cliente.disponibilidad({ llegada, salida, huespedes, propiedad: propiedades.length > 1 ? slug : undefined }));
    } catch (err) {
      setDisp(null);
      setError(err instanceof Error ? err.message : "No pudimos consultar la disponibilidad.");
    } finally {
      setBusy(false);
    }
  }

  async function elegir(tipoHabitacionId: string) {
    setBusy(true);
    setError(null);
    try {
      setCot(await cliente.cotizar({ llegada, salida, huespedes, tipoHabitacionId, propiedad: propiedades.length > 1 ? slug : undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos cotizar tu estancia.");
    } finally {
      setBusy(false);
    }
  }

  if (propiedades.length === 0) return <EstadoVacio mensaje="Este hotel no tiene propiedades activas." />;
  const enLinea = propiedad?.reservaEnLinea !== false;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="p-4">
            <form onSubmit={buscar} className="flex flex-col gap-3" aria-label="Buscar disponibilidad">
              <h2 className="text-sm font-semibold text-foreground">Tu estancia</h2>
              {propiedades.length > 1 && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rp-propiedad">Propiedad</Label>
                  <select id="rp-propiedad" className="h-9 rounded-md border border-border bg-card px-2 text-sm" value={slug} onChange={(e) => { setSlug(e.target.value); setDisp(null); setCot(null); }} required>
                    <option value="" disabled>Elige una propiedad</option>
                    {propiedades.map((p) => (
                      <option key={p.slug} value={p.slug}>{p.nombre}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rp-llegada">Llegada</Label>
                  <Input id="rp-llegada" type="date" min={hoyISO()} value={llegada} onChange={(e) => { setLlegada(e.target.value); setDisp(null); setCot(null); }} required />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rp-salida">Salida</Label>
                  <Input id="rp-salida" type="date" min={llegada} value={salida} onChange={(e) => { setSalida(e.target.value); setDisp(null); setCot(null); }} required />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rp-huespedes">Huéspedes</Label>
                <Input id="rp-huespedes" type="number" min={1} max={propiedad?.maxHuespedes ?? 10} value={huespedes} onChange={(e) => { setHuespedes(Number(e.target.value)); setDisp(null); setCot(null); }} required />
              </div>
              {propiedad && !enLinea && <Callout tone="info" titulo="Reserva en línea no habilitada">Este hotel aún no recibe reservas en línea. Contáctalo directamente.</Callout>}
              <Button type="submit" size="sm" disabled={busy || !propiedad || !enLinea}>
                Ver disponibilidad
              </Button>
            </form>
          </CardContent>
        </Card>
        {error && <Callout tone="danger" titulo="No pudimos continuar">{error}</Callout>}
        {disp && "disponible" in disp && !disp.disponible && <Callout tone="warning" titulo="No disponible aún">{disp.motivo}</Callout>}
        {disp && disp.disponible && !disp.reservaEnLinea && <Callout tone="info" titulo="Reserva en línea no habilitada">{disp.motivo}</Callout>}
        {disp && disp.disponible && disp.reservaEnLinea && (
          <Card>
            <CardContent className="p-4 flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-foreground">
                {disp.propiedad.nombre} · {disp.noches} {disp.noches === 1 ? "noche" : "noches"}
              </h2>
              {disp.opciones.length === 0 && <EstadoVacio mensaje="No hay tipos de habitación para esas fechas." />}
              {disp.opciones.map((o) => (
                <div key={o.tipoHabitacionId} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{o.nombre}</p>
                    <p className="text-xs text-muted-foreground">
                      {o.disponible && o.desdePorNocheCentavos !== null ? `Desde ${pesos(o.desdePorNocheCentavos)} por noche` : (o.motivo ?? "No disponible para esas fechas")} · hasta {o.maxOcupacion} huéspedes
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={busy || !o.disponible || huespedes > o.maxOcupacion} onClick={() => void elegir(o.tipoHabitacionId)}>
                    Cotizar
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
      {cot && <Cotizado key={cot.quoteToken} cliente={cliente} cot={cot} orgSlug={orgSlug} onCreada={setCreada} onVencida={() => { setCot(null); setError("Tu cotización cambió o venció. Vuelve a elegir tu habitación para ver el precio vigente."); }} />}
    </div>
  );
}

function Cotizado({ cliente, cot, orgSlug, onCreada, onVencida }: { cliente: ClienteReservar; cot: Cotizacion; orgSlug: string; onCreada: (r: ReservaCreada) => void; onVencida: () => void }) {
  const [huesped, setHuesped] = useState<DatosHuesped>({ nombre: "", telefono: "", correo: "" });
  const [acepta, setAcepta] = useState(false);
  const [sitioWeb, setSitioWeb] = useState("");
  const [errores, setErrores] = useState<ErroresHuesped>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clave = useRef(nuevaClave());
  const c = cot.cotizacion;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const v = validarHuesped(huesped, acepta);
    setErrores(v);
    if (Object.keys(v).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      onCreada(await cliente.confirmar({ quoteToken: cot.quoteToken, huesped, sitioWeb: sitioWeb || undefined }, clave.current));
    } catch (err) {
      if (err instanceof ReservarError && (err.code === "precio_cambio" || err.code === "cotizacion_vencida" || err.code === "sin_disponibilidad")) {
        onVencida();
        return;
      }
      setError(err instanceof Error ? err.message : "No pudimos registrar tu reserva.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={enviar} className="flex flex-col gap-3" aria-label="Confirmar reserva" noValidate>
          <h2 className="text-sm font-semibold text-foreground">
            {cot.tipoHabitacion.nombre} · {cot.llegada} a {cot.salida}
          </h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Hospedaje</dt>
            <dd className="text-right">{pesos(c.netoCentavos)}</dd>
            <dt className="text-muted-foreground">IVA</dt>
            <dd className="text-right">{pesos(c.ivaCentavos)}</dd>
            <dt className="text-muted-foreground">Impuesto al hospedaje</dt>
            <dd className="text-right">{pesos(c.ishCentavos)}</dd>
            <dt className="font-medium text-foreground">Total</dt>
            <dd className="text-right font-medium text-foreground">{pesos(c.totalCentavos)}</dd>
          </dl>
          {cot.anticipo.requerido ? (
            <p className="text-sm text-muted-foreground">
              Anticipo requerido: <span className="font-medium text-foreground">{pesos(cot.anticipo.centavos)}</span> ({Math.round(cot.anticipo.porcentaje * 100)}%). Tu reserva queda apartada como pago pendiente y el hotel te contacta para registrar el anticipo.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Este hotel no pide anticipo: el hotel revisa y confirma tu reserva.</p>
          )}
          {cot.cancelacion.penalidadPct !== null && cot.cancelacion.penalidadPct > 0 && cot.cancelacion.gratisHasta && (
            <p className="text-xs text-muted-foreground">
              Cancelación sin costo hasta el {cot.cancelacion.gratisHasta.slice(0, 16).replace("T", " ")} (UTC); después, penalidad de {Math.round(cot.cancelacion.penalidadPct * 100)}% del total.
            </p>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="rp-nombre">Nombre completo</Label>
            <Input id="rp-nombre" value={huesped.nombre} onChange={(e) => setHuesped({ ...huesped, nombre: e.target.value })} autoComplete="name" maxLength={120} />
            {errores.nombre && <p className="text-xs text-destructive">{errores.nombre}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rp-telefono">Teléfono</Label>
              <Input id="rp-telefono" type="tel" value={huesped.telefono} onChange={(e) => setHuesped({ ...huesped, telefono: e.target.value })} autoComplete="tel" />
              {errores.telefono && <p className="text-xs text-destructive">{errores.telefono}</p>}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rp-correo">Correo</Label>
              <Input id="rp-correo" type="email" value={huesped.correo} onChange={(e) => setHuesped({ ...huesped, correo: e.target.value })} autoComplete="email" />
              {errores.correo && <p className="text-xs text-destructive">{errores.correo}</p>}
            </div>
          </div>
          {/* Honeypot: un humano nunca lo ve ni lo llena. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>
              Sitio web
              <input tabIndex={-1} autoComplete="off" value={sitioWeb} onChange={(e) => setSitioWeb(e.target.value)} />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-0.5" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} />
            <span>
              He leído el{" "}
              <Link to={`/hoteles/${orgSlug}/aviso`} target="_blank" className="underline underline-offset-4">
                aviso de privacidad
              </Link>{" "}
              y acepto el tratamiento de mis datos para gestionar esta reserva.
            </span>
          </label>
          {errores.acepta && <p className="text-xs text-destructive">{errores.acepta}</p>}
          {error && <Callout tone="danger" titulo="No pudimos reservar">{error}</Callout>}
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Reservando…" : "Reservar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Confirmacion({ orgSlug, reserva }: { orgSlug: string; reserva: ReservaCreada }) {
  const etiqueta = ETIQUETA_ESTADO[reserva.estado] ?? { texto: reserva.estado, tono: "info" as const };
  const enlace = `/hoteles/${orgSlug}/reservar/estado/${encodeURIComponent(reserva.rastreoToken)}`;
  const absoluto = `${typeof window === "undefined" ? "" : window.location.origin}${enlace}`;
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{reserva.estado === "confirmada" ? "Reserva confirmada" : "Reserva apartada"}</h2>
          <StatusBadge tone={etiqueta.tono}>{etiqueta.texto}</StatusBadge>
        </div>
        <p className="text-sm text-foreground">
          {reserva.hotel} · {reserva.tipoHabitacion} · {reserva.llegada} a {reserva.salida} · total {pesos(reserva.totalCentavos)}
        </p>
        {reserva.code && <Callout tone="warning" titulo="Cobro no completado">{reserva.message}</Callout>}
        {reserva.pago.requiereAccion && <Callout tone="info" titulo="Siguiente paso">{reserva.pago.requiereAccion}</Callout>}
        <p className="text-sm text-muted-foreground">
          Guarda este enlace: es la única forma de consultar o cancelar tu reserva.
        </p>
        <Link to={enlace} className="break-all text-sm underline underline-offset-4">
          {absoluto}
        </Link>
      </CardContent>
    </Card>
  );
}
