// R-38: seccion "Sitio publico" de Configuracion (solo owner/admin; el servidor, admin-sitio-publico.ts + RLS, es el enforcement
// real). Edita la marca que el storefront muestra en su portada: titular, eslogan, descripcion, imagen de portada, logo y redes.
// Las imagenes son enlaces https (no hay subida de archivos aun: ver el PR). La vista previa usa el MISMO componente que la pagina
// publica, asi lo que se ve aqui es lo que ven los clientes. Cada guardado queda en la bitacora de auditoria.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Globe } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, FormField, Input, StatusBadge, Textarea } from "@atiende/ui";
import { PortadaMarca } from "../storefront/MarcaPortada.tsx";
import { FORM_SITIO_VACIO, fetchSitioPublico, formDesdeMarca, guardarSitioPublico, hayCambios, marcaDesdeForm } from "../lib/sitio-publico-client.ts";
import type { FormSitio } from "../lib/sitio-publico-client.ts";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Nombre del restaurante para la vista previa; sin el, la vista previa usa un texto generico. */
  readonly nombreRestaurante?: string;
}

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function SitioPublicoSeccion({ apiBaseUrl, token, propertyId, nombreRestaurante }: Props) {
  const [base, setBase] = useState<FormSitio | null>(null);
  const [form, setForm] = useState<FormSitio>(FORM_SITIO_VACIO);
  const [guardada, setGuardada] = useState(false);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [guardadoOk, setGuardadoOk] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setErrorCarga(null);
    fetchSitioPublico(fetch, apiBaseUrl, token, propertyId)
      .then((r) => {
        if (cancelado) return;
        const f = formDesdeMarca(r.marca);
        setBase(f);
        setForm(f);
        setGuardada(r.guardada);
      })
      .catch((e: unknown) => {
        if (!cancelado) setErrorCarga(mensaje(e, "No pudimos cargar el sitio público."));
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const cambiar = (campo: keyof FormSitio, valor: string) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setGuardadoOk(false);
  };

  async function guardar(ev: FormEvent) {
    ev.preventDefault();
    setErrorGuardado(null);
    setGuardadoOk(false);
    setGuardando(true);
    try {
      const r = await guardarSitioPublico(fetch, apiBaseUrl, token, propertyId, form);
      const f = formDesdeMarca(r.marca);
      setBase(f);
      setForm(f);
      setGuardada(r.guardada);
      setGuardadoOk(true);
    } catch (e) {
      setErrorGuardado(mensaje(e, "No pudimos guardar el sitio público."));
    } finally {
      setGuardando(false);
    }
  }

  const sucio = base !== null && hayCambios(base, form);

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" strokeWidth={1.75} />
          Sitio público
          {base && <StatusBadge tone={guardada ? "success" : "neutral"}>{guardada ? "Publicado" : "Sin personalizar"}</StatusBadge>}
        </CardTitle>
        <CardDescription>
          La portada que ven tus clientes en <span className="font-medium text-foreground">/pedir</span>: titular, eslogan, descripción, imágenes y redes. Las imágenes son enlaces https; si no hay marca, la página usa una portada genérica con el nombre del restaurante.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {!base && !errorCarga && <EstadoCargando etiqueta="Cargando sitio público…" />}
        {errorCarga && <EstadoError mensaje={errorCarga} onReintentar={() => setRecarga((n) => n + 1)} />}
        {base && (
          <div className="grid gap-4 lg:grid-cols-2">
            <form onSubmit={guardar} className="flex flex-col gap-3" aria-label="Editar sitio público">
              <FormField label="Titular" hint="Si lo dejas vacío se usa «Pide en» y el nombre del restaurante.">
                <Input value={form.titular} onChange={(e) => cambiar("titular", e.target.value)} maxLength={120} />
              </FormField>
              <FormField label="Eslogan">
                <Input value={form.eslogan} onChange={(e) => cambiar("eslogan", e.target.value)} maxLength={160} />
              </FormField>
              <FormField label="Descripción corta" hint="Hasta 1200 caracteres.">
                <Textarea rows={3} value={form.about} onChange={(e) => cambiar("about", e.target.value)} maxLength={1200} />
              </FormField>
              <FormField label="Imagen de portada (enlace https)">
                <Input type="url" inputMode="url" value={form.portadaUrl} onChange={(e) => cambiar("portadaUrl", e.target.value)} maxLength={500} placeholder="https://…" />
              </FormField>
              <FormField label="Logo (enlace https)">
                <Input type="url" inputMode="url" value={form.logoUrl} onChange={(e) => cambiar("logoUrl", e.target.value)} maxLength={500} placeholder="https://…" />
              </FormField>
              <FormField label="Instagram">
                <Input type="url" inputMode="url" value={form.instagramUrl} onChange={(e) => cambiar("instagramUrl", e.target.value)} maxLength={300} placeholder="https://instagram.com/tu_restaurante" />
              </FormField>
              <FormField label="Facebook">
                <Input type="url" inputMode="url" value={form.facebookUrl} onChange={(e) => cambiar("facebookUrl", e.target.value)} maxLength={300} placeholder="https://facebook.com/tu_restaurante" />
              </FormField>
              <FormField label="TikTok">
                <Input type="url" inputMode="url" value={form.tiktokUrl} onChange={(e) => cambiar("tiktokUrl", e.target.value)} maxLength={300} placeholder="https://tiktok.com/@tu_restaurante" />
              </FormField>
              {errorGuardado && (
                <Callout tone="danger" titulo="No se guardó">
                  {errorGuardado}
                </Callout>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" loading={guardando} disabled={!sucio}>
                  Guardar sitio público
                </Button>
                {guardadoOk && <StatusBadge tone="success" dot={false}>Guardado</StatusBadge>}
              </div>
            </form>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Vista previa</p>
              <PortadaMarca nombre={nombreRestaurante} marca={marcaDesdeForm(form)} encabezado="h2" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
