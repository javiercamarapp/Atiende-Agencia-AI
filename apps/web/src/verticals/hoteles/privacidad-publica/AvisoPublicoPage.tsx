// Aviso de privacidad PUBLICO del hotel (H-30): indexable, sin datos personales, con URL copiable para imprimir/QR y el formulario para
// ejercer derechos ARCO sin login (verificacion por codigo enviado al correo). Todo lo que se muestra sale del servidor: si el hotel
// aun no publica su aviso o la base no tiene la migracion 042, se dice honestamente. No es asesoria legal: el texto del aviso integral
// lo valida un abogado del hotel.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Copy, Printer, ShieldCheck } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, StatusBadge, Textarea } from "@atiende/ui";
import { useMetaPublica } from "../../../lib/meta-publica.ts";
import {
  DERECHO_AYUDA,
  DERECHO_LABELS,
  PrivacidadPublicaError,
  crearClientePrivacidadPublica,
  type ClientePrivacidadPublica,
  type Derecho,
  type RespuestaAviso,
  type SolicitudEnviada,
} from "./cliente.ts";

type Paso = { readonly tipo: "formulario" } | { readonly tipo: "codigo"; readonly envio: SolicitudEnviada } | { readonly tipo: "listo"; readonly folio: string; readonly mensaje: string };

export function AvisoPublicoPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  useMetaPublica({ titulo: "Aviso de privacidad", descripcion: "Aviso de privacidad del hotel y cómo ejercer tus derechos ARCO sobre tus datos personales.", indexable: true });
  const [params] = useSearchParams();
  const propiedad = params.get("property") ?? undefined;
  const cliente = useMemo(() => crearClientePrivacidadPublica(fetch, apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [data, setData] = useState<RespuestaAviso | "cargando" | "no_encontrado" | { error: string }>("cargando");

  useEffect(() => {
    let cancelado = false;
    setData("cargando");
    cliente
      .aviso(propiedad)
      .then((r) => !cancelado && setData(r))
      .catch((e: unknown) => {
        if (cancelado) return;
        if (e instanceof PrivacidadPublicaError && e.status === 404) setData("no_encontrado");
        else setData({ error: e instanceof Error ? e.message : "No pudimos cargar el aviso de privacidad." });
      });
    return () => {
      cancelado = true;
    };
  }, [cliente, propiedad]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:px-6">
          <ShieldCheck className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <h1 className="text-xl font-display font-semibold text-foreground">Aviso de privacidad</h1>
          {typeof data === "object" && "hotel" in data && data.hotel.nombre && <span className="text-sm text-muted-foreground">· {data.hotel.nombre}</span>}
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6" aria-live="polite">
        {data === "cargando" && <EstadoCargando etiqueta="Cargando aviso…" />}
        {data === "no_encontrado" && <EstadoVacio mensaje="No encontramos ese hotel o esa propiedad. Revisa que el enlace esté completo." />}
        {typeof data === "object" && "error" in data && <EstadoError titulo="Ocurrió un problema" mensaje={data.error} onReintentar={() => window.location.reload()} />}
        {typeof data === "object" && "disponible" in data && !data.disponible && (
          <Callout tone="warning" titulo="No disponible aún">
            {data.motivo}
          </Callout>
        )}
        {typeof data === "object" && "disponible" in data && data.disponible && <Contenido data={data} cliente={cliente} orgSlug={orgSlug} propiedadElegida={propiedad} />}
      </main>
    </div>
  );
}

function Contenido({ data, cliente, orgSlug, propiedadElegida }: { data: Extract<RespuestaAviso, { disponible: true }>; cliente: ClientePrivacidadPublica; orgSlug: string; propiedadElegida: string | undefined }) {
  if (data.propiedades.length > 1 && !propiedadElegida) {
    return (
      <Card>
        <CardContent className="p-4 flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">Elige la propiedad</h2>
          <p className="text-sm text-muted-foreground">Cada propiedad del hotel puede tener su propio aviso de privacidad.</p>
          {data.propiedades.map((p) => (
            <Link key={p.propiedad.slug} to={`/hoteles/${orgSlug}/aviso?property=${p.propiedad.slug}`} className="text-sm underline underline-offset-4">
              {p.propiedad.nombre}
              {p.aviso ? "" : " (aún sin aviso publicado)"}
            </Link>
          ))}
        </CardContent>
      </Card>
    );
  }
  const p = data.propiedades[0];
  if (!p) return <EstadoVacio mensaje="Este hotel no tiene propiedades activas." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <AvisoCard p={p} />
        <EnlaceCard orgSlug={orgSlug} slug={p.propiedad.slug} multiples={data.propiedades.length > 1} />
      </div>
      <SolicitudCard cliente={cliente} slug={p.propiedad.slug} multiples={data.propiedades.length > 1} />
    </div>
  );
}

function AvisoCard({ p }: { p: Extract<RespuestaAviso, { disponible: true }>["propiedades"][number] }) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{p.propiedad.nombre}</h2>
          {p.aviso && <StatusBadge tone="success">Versión {p.aviso.version}</StatusBadge>}
        </div>
        {!p.aviso && <p className="text-sm text-muted-foreground">Este hotel aún no publica su aviso de privacidad en línea. Puedes pedirlo en recepción o ejercer tus derechos con el formulario.</p>}
        {p.aviso && (
          <>
            <p className="text-sm text-foreground whitespace-pre-line">{p.aviso.textoSimplificado}</p>
            <div>
              <p className="text-xs font-medium text-foreground">Finalidades necesarias</p>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {p.aviso.finalidadesObligatorias.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            {p.aviso.finalidadesOpcionales.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground">Finalidades opcionales (puedes negarte)</p>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {p.aviso.finalidadesOpcionales.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {p.aviso.urlIntegral && (
              <a href={p.aviso.urlIntegral} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
                Leer el aviso de privacidad integral
              </a>
            )}
            <p className="text-xs text-muted-foreground">Publicado el {p.aviso.publicadoEn.slice(0, 10)}. Este es un resumen; el aviso integral es el que el hotel publica conforme a la ley aplicable.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EnlaceCard({ orgSlug, slug, multiples }: { orgSlug: string; slug: string; multiples: boolean }) {
  const url = `${typeof window === "undefined" ? "" : window.location.origin}/hoteles/${orgSlug}/aviso${multiples ? `?property=${slug}` : ""}`;
  const [copiado, setCopiado] = useState(false);
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">Enlace para imprimir o compartir</h2>
        <div className="flex gap-2">
          <Input value={url} readOnly aria-label="Enlace del aviso" onFocus={(e) => e.currentTarget.select()} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopiado(true));
            }}
          >
            <Copy className="size-3.5" strokeWidth={1.75} />
            {copiado ? "Copiado" : "Copiar"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="size-3.5" strokeWidth={1.75} />
            Imprimir
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Para un código QR, pega este enlace en cualquier generador de QR: esta pantalla aún no genera códigos QR.</p>
      </CardContent>
    </Card>
  );
}

function SolicitudCard({ cliente, slug, multiples }: { cliente: ClientePrivacidadPublica; slug: string; multiples: boolean }) {
  const [paso, setPaso] = useState<Paso>({ tipo: "formulario" });
  const [derecho, setDerecho] = useState<Derecho>("acceso");
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [sitioWeb, setSitioWeb] = useState("");
  const [codigo, setCodigo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const envio = await cliente.solicitar({ derecho, nombre, correo, descripcion: descripcion.trim() || undefined, propiedad: multiples ? slug : undefined, sitioWeb: sitioWeb || undefined });
      setPaso({ tipo: "codigo", envio });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos registrar tu solicitud.");
    } finally {
      setBusy(false);
    }
  }

  async function verificar(e: FormEvent) {
    e.preventDefault();
    if (paso.tipo !== "codigo") return;
    setBusy(true);
    setError(null);
    try {
      const r = await cliente.verificar(paso.envio.referencia, codigo.trim());
      setPaso({ tipo: "listo", folio: r.folio, mensaje: r.mensaje });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos verificar el código.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Ejerce tus derechos ARCO</h2>
        {paso.tipo === "formulario" && (
          <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-3" aria-label="Solicitud de derechos ARCO">
            <p className="text-xs text-muted-foreground">Acceso, rectificación, cancelación u oposición sobre tus datos personales. Te enviamos un código a tu correo para confirmar que eres tú; hasta entonces la solicitud no se tramita.</p>
            <div>
              <Label htmlFor="arco-pub-derecho">Derecho</Label>
              <NativeSelect id="arco-pub-derecho" value={derecho} onChange={(e) => setDerecho(e.target.value as Derecho)}>
                {(Object.keys(DERECHO_LABELS) as Derecho[]).map((d) => (
                  <option key={d} value={d}>
                    {DERECHO_LABELS[d]}
                  </option>
                ))}
              </NativeSelect>
              <p className="mt-1 text-xs text-muted-foreground">{DERECHO_AYUDA[derecho]}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="arco-pub-nombre">Nombre completo</Label>
                <Input id="arco-pub-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required minLength={2} maxLength={200} autoComplete="name" />
              </div>
              <div>
                <Label htmlFor="arco-pub-correo">Correo</Label>
                <Input id="arco-pub-correo" type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} required maxLength={200} autoComplete="email" />
              </div>
            </div>
            <div>
              <Label htmlFor="arco-pub-desc">Descripción (opcional)</Label>
              <Textarea id="arco-pub-desc" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={3} maxLength={1000} />
            </div>
            {/* Honeypot: fuera de pantalla y fuera del orden de tabulacion; un humano no lo llena. */}
            <div aria-hidden="true" className="absolute -left-[9999px] size-px overflow-hidden">
              <label>
                No llenar este campo
                <input type="text" name="sitioWeb" tabIndex={-1} autoComplete="off" value={sitioWeb} onChange={(e) => setSitioWeb(e.target.value)} />
              </label>
            </div>
            <div>
              <Button type="submit" disabled={busy || nombre.trim().length < 2 || correo.trim() === ""}>
                {busy ? "Enviando…" : "Enviar solicitud"}
              </Button>
            </div>
          </form>
        )}
        {paso.tipo === "codigo" && (
          <form onSubmit={(e) => void verificar(e)} className="flex flex-col gap-3" aria-label="Confirmar solicitud con código">
            <Callout tone="info" titulo="Revisa tu correo">
              {paso.envio.mensaje}
            </Callout>
            {paso.envio.envioDeCorreo === "pendiente_de_configuracion" && (
              <Callout tone="warning" titulo="El envío de correo aún no está activo">
                Este hotel todavía no tiene configurado el envío de correos, así que el código podría no llegar. Si no lo recibes, pide ayuda en recepción.
              </Callout>
            )}
            <div>
              <Label htmlFor="arco-pub-codigo">Código de 6 dígitos (vence en {paso.envio.venceEnMinutos} minutos)</Label>
              <Input id="arco-pub-codigo" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={6} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || codigo.length !== 6}>
                {busy ? "Verificando…" : "Confirmar solicitud"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPaso({ tipo: "formulario" })}>
                Empezar de nuevo
              </Button>
            </div>
          </form>
        )}
        {paso.tipo === "listo" && (
          <Callout tone="success" titulo={`Solicitud confirmada · ${paso.folio}`}>
            {paso.mensaje} Guarda tu folio para cualquier aclaración.
          </Callout>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
