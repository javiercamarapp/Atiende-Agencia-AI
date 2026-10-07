// Pagina PUBLICA de reservas de un negocio de citas (C-19), sin login ni shell de panel: servicio -> profesional (o
// "cualquiera") -> dia -> horario -> datos -> confirmacion. Todo sale del API publico (catalogo y disponibilidad reales) y la
// cita se crea con el POST publico existente. Las fechas se muestran en la zona horaria del NEGOCIO. Un negocio que aun no
// cumple el minimo (C-06) no muestra formulario.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, StatusBadge, ThemeSelector } from "@atiende/ui";
import { useMetaPublica } from "../../../lib/meta-publica.ts";
import {
  crearClienteReserva,
  diasDisponibles,
  etiquetaDia,
  formatoFechaHora,
  formatoHora,
  formatoPrecio,
  ReservaError,
  validarFormulario,
  type CatalogoPublico,
  type CitaCreada,
  type FormularioReserva,
  type HorarioPublico,
} from "./reserva-client.ts";

const DIAS_VISIBLES = 14;
const FORM_VACIO: FormularioReserva = { nombre: "", telefono: "", correo: "", acepta: false };
const CUALQUIERA = "";

type Carga = "cargando" | { error: string; noEncontrado: boolean } | { noListo: true } | CatalogoPublico;

export function ReservarPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteReserva(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [carga, setCarga] = useState<Carga>("cargando");

  const cargar = useCallback(() => {
    setCarga("cargando");
    cliente
      .catalogo()
      .then((c) => setCarga(c.lista ? c : { noListo: true }))
      .catch((e: unknown) => setCarga({ error: e instanceof Error ? e.message : "No pudimos cargar el negocio.", noEncontrado: e instanceof ReservaError && e.status === 404 }));
  }, [cliente]);
  useEffect(cargar, [cargar]);
  const noListo = useCallback(() => setCarga({ noListo: true }), []);

  const catalogo = typeof carga === "object" && "servicios" in carga ? carga : null;
  useMetaPublica({
    titulo: catalogo ? `${catalogo.nombre} · Reservar cita` : "Reservar cita",
    descripcion: catalogo ? `Reserva tu cita en línea en ${catalogo.nombre}: elige servicio, profesional y horario.` : "Reserva tu cita en línea.",
    indexable: catalogo !== null,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <span className="text-base font-semibold tracking-tight">{catalogo?.nombre ?? "Reservar cita"}</span>
          <ThemeSelector tamano="compacto" />
        </div>
      </header>
      <main id="contenido" className="mx-auto max-w-3xl px-4 py-6">
        {carga === "cargando" && <EstadoCargando etiqueta="Cargando…" />}
        {typeof carga === "object" && "error" in carga && (carga.noEncontrado ? <EstadoVacio titulo="No encontramos este negocio" mensaje="Revisa el enlace que te compartieron." /> : <EstadoError mensaje={carga.error} onReintentar={cargar} />)}
        {typeof carga === "object" && "noListo" in carga && <EstadoVacio titulo="Este negocio aún no recibe reservas en línea" mensaje="Vuelve a intentarlo más tarde o comunícate directamente con el negocio." />}
        {catalogo && (catalogo.servicios.length === 0 ? <EstadoVacio titulo="Sin servicios disponibles" mensaje="Por ahora no hay servicios para reservar en línea." /> : <Flujo cliente={cliente} catalogo={catalogo} onNoListo={noListo} />)}
      </main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 pt-4 text-xs text-muted-foreground">
        <Link to="/privacidad" className="underline underline-offset-2">
          Aviso de privacidad
        </Link>
      </footer>
    </div>
  );
}

function Flujo({ cliente, catalogo, onNoListo }: { cliente: ReturnType<typeof crearClienteReserva>; catalogo: CatalogoPublico; onNoListo: () => void }) {
  const zona = catalogo.zonaHoraria;
  const dias = useMemo(() => diasDisponibles(zona, DIAS_VISIBLES), [zona]);
  const [servicioId, setServicioId] = useState<string | null>(catalogo.servicios.length === 1 ? catalogo.servicios[0]!.id : null);
  const [profesionalId, setProfesionalId] = useState<string | null>(null);
  const [dia, setDia] = useState<string | null>(null);
  const [horarios, setHorarios] = useState<"cargando" | { error: string } | { lista: readonly HorarioPublico[]; zona: string } | null>(null);
  const [horario, setHorario] = useState<HorarioPublico | null>(null);
  const [form, setForm] = useState<FormularioReserva>(FORM_VACIO);
  const [errores, setErrores] = useState<ReturnType<typeof validarFormulario>>({});
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: "warning" | "danger"; texto: string } | null>(null);
  const [creada, setCreada] = useState<{ cita: CitaCreada; servicio: string; profesional: string; zona: string } | null>(null);
  const [recarga, setRecarga] = useState(0);
  const claveIdempotencia = useRef<string | null>(null);

  const servicio = catalogo.servicios.find((s) => s.id === servicioId) ?? null;
  const profesionales = useMemo(() => catalogo.profesionales.filter((p) => servicioId !== null && p.servicioIds.includes(servicioId)), [catalogo, servicioId]);

  // Horarios del dia elegido (reales: el servidor descuenta citas y bloqueos). Se recarga tras un 409.
  useEffect(() => {
    if (!servicioId || profesionalId === null || !dia) {
      setHorarios(null);
      return;
    }
    let cancelado = false;
    setHorarios("cargando");
    cliente
      .disponibilidad(servicioId, profesionalId === CUALQUIERA ? null : profesionalId, dia)
      .then((r) => {
        if (cancelado) return;
        if ("faltan" in r) return onNoListo();
        setHorarios({ lista: r.horarios, zona: r.zonaHoraria });
      })
      .catch((e: unknown) => !cancelado && setHorarios({ error: e instanceof Error ? e.message : "No pudimos cargar los horarios." }));
    return () => {
      cancelado = true;
    };
  }, [cliente, servicioId, profesionalId, dia, recarga, onNoListo]);

  const elegirServicio = (id: string) => {
    setServicioId(id);
    setProfesionalId(null);
    setDia(null);
    setHorario(null);
    setAviso(null);
  };
  const elegirProfesional = (id: string) => {
    setProfesionalId(id);
    setHorario(null);
    setAviso(null);
  };
  const elegirDia = (d: string) => {
    setDia(d);
    setHorario(null);
    setAviso(null);
  };
  const nombreProfesional = (id: string) => catalogo.profesionales.find((p) => p.id === id)?.nombre ?? "";

  async function enviar(ev: React.FormEvent) {
    ev.preventDefault();
    if (!servicio || !horario || enviando) return;
    const e = validarFormulario(form);
    setErrores(e);
    if (Object.keys(e).length > 0) return;
    setEnviando(true);
    setAviso(null);
    claveIdempotencia.current ??= crypto.randomUUID();
    try {
      const cita = await cliente.reservar({ serviceId: servicio.id, providerId: horario.providerId, startsAt: horario.startsAt, nombre: form.nombre, telefono: form.telefono, correo: form.correo, idempotencyKey: claveIdempotencia.current });
      setCreada({ cita, servicio: servicio.nombre, profesional: nombreProfesional(horario.providerId), zona });
    } catch (err) {
      claveIdempotencia.current = null;
      if (err instanceof ReservaError && err.status === 409) {
        // Horario tomado (o negocio que dejo de estar listo): se recargan los horarios reales y se explica.
        setAviso({ tono: "warning", texto: "Ese horario acaba de ocuparse. Elige otro de la lista actualizada." });
        setHorario(null);
        setRecarga((n) => n + 1);
      } else {
        setAviso({ tono: "danger", texto: err instanceof Error ? err.message : "No pudimos registrar tu cita." });
      }
    } finally {
      setEnviando(false);
    }
  }

  if (creada) {
    return (
      <section aria-labelledby="titulo-confirmacion" className="flex flex-col gap-4">
        <Callout tone="success" titulo="¡Tu cita quedó registrada!">
          {creada.cita.status === "confirmed" ? "Quedó confirmada." : "El negocio la confirmará y te avisará."} Guarda estos datos.
        </Callout>
        <h1 id="titulo-confirmacion" className="text-lg font-semibold">
          Resumen de tu cita
        </h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-card p-4 text-sm">
          <dt className="text-muted-foreground">Servicio</dt>
          <dd>{creada.servicio}</dd>
          <dt className="text-muted-foreground">Con</dt>
          <dd>{creada.profesional}</dd>
          <dt className="text-muted-foreground">Cuándo</dt>
          <dd>{formatoFechaHora(creada.cita.startsAt, creada.zona)}</dd>
          <dt className="text-muted-foreground">Zona horaria</dt>
          <dd>{creada.zona}</dd>
        </dl>
        <Button type="button" variant="outline" className="self-start" onClick={() => window.location.reload()}>
          Reservar otra cita
        </Button>
      </section>
    );
  }

  return (
    <form onSubmit={enviar} noValidate className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reserva tu cita</h1>
        <p className="mt-1 text-sm text-muted-foreground">Elige servicio, profesional y horario. No necesitas crear una cuenta.</p>
      </div>

      <section aria-labelledby="paso-servicio" className="flex flex-col gap-2">
        <h2 id="paso-servicio" className="text-sm font-semibold">
          1. Servicio
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {catalogo.servicios.map((s) => (
            <Opcion key={s.id} activa={s.id === servicioId} onClick={() => elegirServicio(s.id)}>
              <span className="font-medium">{s.nombre}</span>
              <span className="text-xs text-muted-foreground">
                {s.duracionMinutos} min{formatoPrecio(s.precioCentavos) ? ` · ${formatoPrecio(s.precioCentavos)}` : ""}
              </span>
            </Opcion>
          ))}
        </div>
      </section>

      {servicio && (
        <section aria-labelledby="paso-profesional" className="flex flex-col gap-2">
          <h2 id="paso-profesional" className="text-sm font-semibold">
            2. Profesional
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Opcion activa={profesionalId === CUALQUIERA} onClick={() => elegirProfesional(CUALQUIERA)}>
              <span className="font-medium">Cualquiera disponible</span>
              <span className="text-xs text-muted-foreground">Te asignamos a quien tenga el horario.</span>
            </Opcion>
            {profesionales.map((p) => (
              <Opcion key={p.id} activa={p.id === profesionalId} onClick={() => elegirProfesional(p.id)}>
                <span className="font-medium">{p.nombre}</span>
              </Opcion>
            ))}
          </div>
        </section>
      )}

      {servicio && profesionalId !== null && (
        <section aria-labelledby="paso-dia" className="flex flex-col gap-2">
          <h2 id="paso-dia" className="text-sm font-semibold">
            3. Día
          </h2>
          <div className="flex flex-wrap gap-2">
            {dias.map((d) => (
              <Opcion key={d} activa={d === dia} onClick={() => elegirDia(d)} compacta aria-label={etiquetaDia(d).larga}>
                {etiquetaDia(d).corta}
              </Opcion>
            ))}
          </div>
        </section>
      )}

      {dia && (
        <section aria-labelledby="paso-horario" className="flex flex-col gap-2">
          <h2 id="paso-horario" className="text-sm font-semibold">
            4. Horario
          </h2>
          {aviso && <Callout tone={aviso.tono}>{aviso.texto}</Callout>}
          {horarios === "cargando" && <EstadoCargando etiqueta="Buscando horarios…" />}
          {horarios && typeof horarios === "object" && "error" in horarios && <EstadoError mensaje={horarios.error} onReintentar={() => setRecarga((n) => n + 1)} />}
          {horarios && typeof horarios === "object" && "lista" in horarios && horarios.lista.length === 0 && <EstadoVacio titulo="Sin horarios este día" mensaje="Prueba con otro día u otro profesional." />}
          {horarios && typeof horarios === "object" && "lista" in horarios && horarios.lista.length > 0 && (
            <>
              <p className="m-0 text-xs text-muted-foreground">Horarios en hora de {horarios.zona}.</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Horarios disponibles">
                {horarios.lista.map((h) => (
                  <Opcion key={h.startsAt} activa={horario?.startsAt === h.startsAt} onClick={() => setHorario(h)} compacta>
                    {formatoHora(h.startsAt, horarios.zona)}
                  </Opcion>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {horario && servicio && (
        <section aria-labelledby="paso-datos" className="flex flex-col gap-3">
          <h2 id="paso-datos" className="text-sm font-semibold">
            5. Tus datos
          </h2>
          <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge tone="neutral">{servicio.nombre}</StatusBadge>
            <span>
              {nombreProfesional(horario.providerId)} · {formatoFechaHora(horario.startsAt, zona)}
            </span>
          </p>
          <FormField label="Nombre" required error={errores.nombre}>
            <Input autoComplete="name" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} maxLength={160} />
          </FormField>
          <FormField label="Teléfono" required hint="10 dígitos, para avisarte de tu cita." error={errores.telefono}>
            <Input type="tel" inputMode="tel" autoComplete="tel" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} maxLength={20} />
          </FormField>
          <FormField label="Correo (opcional)" hint="Solo si quieres la confirmación por correo." error={errores.correo}>
            <Input type="email" autoComplete="email" value={form.correo} onChange={(e) => setForm({ ...form, correo: e.target.value })} maxLength={320} />
          </FormField>
          <FormField label="Aviso de privacidad" error={errores.acepta}>
            {(p) => (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox {...p} checked={form.acepta} onChange={(e) => setForm({ ...form, acepta: e.target.checked })} />
                <span>
                  Leí el{" "}
                  <a href="/privacidad" target="_blank" rel="noreferrer" className="underline">
                    aviso de privacidad
                  </a>
                  .
                </span>
              </label>
            )}
          </FormField>
          <Button type="submit" disabled={enviando} className="self-start">
            {enviando ? "Reservando…" : "Confirmar reserva"}
          </Button>
        </section>
      )}
    </form>
  );
}

function Opcion({ activa, onClick, children, compacta = false, ...rest }: { activa: boolean; onClick: () => void; children: React.ReactNode; compacta?: boolean; "aria-label"?: string }) {
  return (
    <button
      type="button"
      aria-pressed={activa}
      onClick={onClick}
      {...rest}
      className={`flex rounded-lg border text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${compacta ? "min-h-11 items-center px-3 py-2" : "min-h-11 flex-col gap-0.5 px-3 py-2.5"} ${
        activa ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}
