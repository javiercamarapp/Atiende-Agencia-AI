// R-43: formulario publico de eventos y catering. Crea una solicitud REAL (POST .../storefront/eventos) que aparece en la bandeja de
// contactos del panel con motivo "evento" y avisa al personal; el restaurante responde por telefono. Sin cuenta ni pago.
// Anti-abuso sin captcha: campo trampa oculto (`sitio_web`) que una persona nunca llena. La validacion de aqui solo anticipa lo que
// el servidor exige (el servidor es la autoridad).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Checkbox, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, Textarea } from "@atiende/ui";
import { PartyPopper } from "lucide-react";
import { crearClienteStorefront, type RestaurantePublico } from "./storefront-client.ts";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";

export interface FormularioEvento {
  readonly nombre: string;
  readonly telefono: string;
  readonly fechaEvento: string;
  readonly personas: string;
  readonly sucursal: string;
  readonly comentario: string;
  readonly acepta: boolean;
}

export const EVENTO_VACIO: FormularioEvento = { nombre: "", telefono: "", fechaEvento: "", personas: "", sucursal: "", comentario: "", acepta: false };

/** Errores por campo (vacio = valido). Mismas reglas que el servidor: nombre, telefono de 10 digitos, fecha de hoy en adelante, 1 a 2000 personas, sucursal y aviso. */
export function validarEvento(f: FormularioEvento, hoy: string): Partial<Record<keyof FormularioEvento, string>> {
  const e: Partial<Record<keyof FormularioEvento, string>> = {};
  if (f.nombre.trim().length < 2) e.nombre = "Escribe tu nombre.";
  const digitos = f.telefono.replace(/\D/g, "");
  if (!(digitos.length === 10 || (digitos.length === 12 && digitos.startsWith("52")) || (digitos.length === 13 && digitos.startsWith("521")))) e.telefono = "Escribe un teléfono de 10 dígitos.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fechaEvento)) e.fechaEvento = "Elige la fecha del evento.";
  else if (f.fechaEvento < hoy) e.fechaEvento = "La fecha del evento ya pasó.";
  const personas = Number(f.personas);
  if (!f.personas.trim() || !Number.isInteger(personas) || personas < 1 || personas > 2000) e.personas = "Indica cuántas personas serán (de 1 a 2000).";
  if (!f.sucursal) e.sucursal = "Elige la sucursal.";
  if (!f.acepta) e.acepta = "Debes aceptar el aviso de privacidad.";
  return e;
}

function hoyLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function EventosPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [datos, setDatos] = useState<RestaurantePublico | "cargando" | { error: string }>("cargando");
  const [form, setForm] = useState<FormularioEvento>(EVENTO_VACIO);
  const [trampa, setTrampa] = useState("");
  const [errores, setErrores] = useState<Partial<Record<keyof FormularioEvento, string>>>({});
  const [errorServidor, setErrorServidor] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);

  const cargar = useCallback(() => {
    setDatos("cargando");
    cliente
      .sucursales()
      .then((r) => {
        setDatos(r);
        if (r.sucursales.length === 1) setForm((f) => ({ ...f, sucursal: r.sucursales[0]!.slug }));
      })
      .catch((e: unknown) => setDatos({ error: e instanceof Error ? e.message : "No pudimos cargar el restaurante." }));
  }, [cliente]);
  useEffect(cargar, [cargar]);

  const nombre = typeof datos === "object" && "restaurante" in datos ? datos.restaurante.nombre : undefined;
  const marca = typeof datos === "object" && "restaurante" in datos ? datos.marca : undefined;
  useMetaPublica({
    titulo: nombre ? `Eventos y catering · ${nombre}` : "Eventos y catering",
    descripcion: nombre ? `Cotiza tu evento o catering con ${nombre}: dinos la fecha y cuántas personas serán y te contactamos.` : "Cotiza tu evento o catering.",
    indexable: true,
    imagen: marca?.portadaUrl ?? marca?.logoUrl,
  });

  const cambiar = <K extends keyof FormularioEvento>(campo: K, valor: FormularioEvento[K]) => setForm((f) => ({ ...f, [campo]: valor }));

  async function enviar(ev: FormEvent) {
    ev.preventDefault();
    setErrorServidor(null);
    const e = validarEvento(form, hoyLocal());
    setErrores(e);
    if (Object.keys(e).length > 0) return;
    setEnviando(true);
    try {
      await cliente.enviarEvento({
        nombre: form.nombre.trim(),
        telefono: form.telefono,
        fechaEvento: form.fechaEvento,
        personas: Number(form.personas),
        sucursal: form.sucursal,
        comentario: form.comentario,
        aceptaAviso: form.acepta,
        sitioWeb: trampa,
      });
      setEnviado(true);
    } catch (err) {
      setErrorServidor(err instanceof Error ? err.message : "No pudimos enviar tu solicitud.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <StorefrontLayout orgSlug={orgSlug} nombre={nombre} marca={marca}>
      <div className="mx-auto max-w-2xl">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <PartyPopper className="size-5 text-primary" aria-hidden="true" />
          Eventos y catering
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Cuéntanos de tu evento y el restaurante te contacta por teléfono para cotizarlo. No se cobra nada por enviar la solicitud.</p>
        <div className="mt-4">
          {datos === "cargando" && <EstadoCargando variante="tarjeta" />}
          {typeof datos === "object" && "error" in datos && <EstadoError mensaje={datos.error} onReintentar={cargar} />}
          {typeof datos === "object" && "sucursales" in datos && datos.sucursales.length === 0 && (
            <EstadoVacio titulo="Sin sucursales disponibles" mensaje="Por ahora este restaurante no recibe solicitudes de eventos en línea." />
          )}
          {enviado && (
            <Callout tone="success" titulo="Recibimos tu solicitud">
              El restaurante la revisará y te contactará al teléfono que nos diste. Gracias por considerarnos para tu evento.
            </Callout>
          )}
          {!enviado && typeof datos === "object" && "sucursales" in datos && datos.sucursales.length > 0 && (
            <form onSubmit={enviar} noValidate className="flex flex-col gap-3" aria-label="Solicitud de evento o catering">
              <FormField label="Nombre" required error={errores.nombre}>
                <Input autoComplete="name" value={form.nombre} onChange={(e) => cambiar("nombre", e.target.value)} maxLength={120} />
              </FormField>
              <FormField label="Teléfono" required hint="10 dígitos, para contactarte." error={errores.telefono}>
                <Input type="tel" inputMode="tel" autoComplete="tel" value={form.telefono} onChange={(e) => cambiar("telefono", e.target.value)} maxLength={20} />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Fecha del evento" required error={errores.fechaEvento}>
                  <Input type="date" min={hoyLocal()} value={form.fechaEvento} onChange={(e) => cambiar("fechaEvento", e.target.value)} />
                </FormField>
                <FormField label="Personas" required error={errores.personas}>
                  <Input type="number" inputMode="numeric" min={1} max={2000} value={form.personas} onChange={(e) => cambiar("personas", e.target.value)} />
                </FormField>
              </div>
              <FormField label="Sucursal" required error={errores.sucursal}>
                <NativeSelect value={form.sucursal} onChange={(e) => cambiar("sucursal", e.target.value)}>
                  <option value="">Elige una sucursal</option>
                  {datos.sucursales.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Comentario (opcional)" hint="Tipo de evento, menú que te interesa, lugar…">
                <Textarea rows={3} value={form.comentario} onChange={(e) => cambiar("comentario", e.target.value)} maxLength={1000} />
              </FormField>
              {/* Campo trampa: fuera de pantalla, sin foco ni autollenado. Una persona no lo ve; un bot que llena todo, si. */}
              <div className="sr-only" aria-hidden="true">
                <label>
                  No llenes este campo
                  <input type="text" name="sitio_web" tabIndex={-1} autoComplete="off" value={trampa} onChange={(e) => setTrampa(e.target.value)} />
                </label>
              </div>
              <FormField label="Aviso de privacidad" error={errores.acepta}>
                {(p) => (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox {...p} checked={form.acepta} onChange={(e) => cambiar("acepta", e.target.checked)} />
                    <span>
                      Leí el{" "}
                      <a href={`/pedir/${orgSlug}/privacidad`} target="_blank" rel="noreferrer" className="underline">
                        aviso de privacidad
                      </a>
                      .
                    </span>
                  </label>
                )}
              </FormField>
              {errorServidor && (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {errorServidor}
                </div>
              )}
              <Button type="submit" loading={enviando}>
                Enviar solicitud
              </Button>
            </form>
          )}
        </div>
      </div>
    </StorefrontLayout>
  );
}
