// Idiomas del agente de VOZ de la sucursal (portado del selector del repo suelto, `SelectorIdiomasAgente`): idioma principal,
// idiomas adicionales (hasta el tope que dice el servidor) y deteccion automatica del idioma del cliente. Guarda contra el
// backend propio (#712, migracion 181), no contra ElevenLabs. Catalogo y tope vienen del GET: el panel no repite la lista.
// Sin el backend o sin la migracion: aviso honesto y nada editable. Solo voz: el agente de WhatsApp no usa este ajuste.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Languages, X } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Selector, Switch, useI18n } from "@atiende/ui";
import { vozIdiomas } from "@atiende/ui/i18n/vozIdiomas";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { conAdicional, conPrincipal, fetchIdiomasVoz, guardarIdiomasVoz, mismosIdiomas, sinAdicional } from "../lib/voz-idiomas-client.ts";
import type { ConfigIdiomasVoz, IdiomasVoz } from "../lib/voz-idiomas-client.ts";

export interface IdiomasAgenteVozProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Solo para pruebas. */
  readonly fetchImpl?: typeof fetch;
}

type Estado = { readonly fase: "cargando" } | { readonly fase: "no_disponible" } | { readonly fase: "error" } | { readonly fase: "listo"; readonly datos: IdiomasVoz };

/** Nombre del idioma en el idioma de la interfaz; en espanol (o sin Intl.DisplayNames) el del catalogo del servidor. */
function nombreEnInterfaz(codigo: string, nombreServidor: string, idioma: string, locale: string): string {
  if (idioma === "es" || typeof Intl.DisplayNames !== "function") return nombreServidor;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(codigo) ?? nombreServidor;
  } catch {
    return nombreServidor;
  }
}

export function IdiomasAgenteVoz({ apiBaseUrl, token, propertyId, fetchImpl = fetch }: IdiomasAgenteVozProps) {
  const { t, idioma, locale } = useI18n(vozIdiomas);
  const [estado, setEstado] = useState<Estado>({ fase: "cargando" });
  const [borrador, setBorrador] = useState<ConfigIdiomasVoz | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const [aviso, setAviso] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let vigente = true;
    setEstado({ fase: "cargando" });
    fetchIdiomasVoz(fetchImpl, apiBaseUrl, token, propertyId).then(
      (datos) => {
        if (!vigente) return;
        setEstado({ fase: "listo", datos });
        setBorrador(datos.idiomas);
      },
      (err: unknown) => {
        if (vigente) setEstado({ fase: err instanceof VozNoDisponibleError ? "no_disponible" : "error" });
      },
    );
    return () => {
      vigente = false;
    };
  }, [fetchImpl, apiBaseUrl, token, propertyId, version]);

  const datos = estado.fase === "listo" ? estado.datos : null;
  const nombre = useCallback(
    (codigo: string) => nombreEnInterfaz(codigo, datos?.catalogo.find((i) => i.codigo === codigo)?.nombre ?? codigo, idioma, locale),
    [datos, idioma, locale],
  );
  const disponibles = useMemo(() => (datos && borrador ? datos.catalogo.filter((i) => i.codigo !== borrador.principal && !borrador.adicionales.includes(i.codigo)) : []), [datos, borrador]);

  const encabezado = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        {t("vozIdiomas.titulo")}
      </CardTitle>
      <CardDescription>{t("vozIdiomas.descripcion")}</CardDescription>
    </CardHeader>
  );

  if (estado.fase === "cargando") {
    return (
      <Card data-testid="idiomas-voz">
        {encabezado}
        <CardContent>
          <EstadoCargando />
        </CardContent>
      </Card>
    );
  }
  if (estado.fase === "no_disponible") {
    return (
      <Card data-testid="idiomas-voz">
        {encabezado}
        <CardContent>
          <p role="note" data-testid="idiomas-voz-no-disponible" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("vozIdiomas.noDisponible")}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (estado.fase === "error" || !datos || !borrador) {
    return (
      <Card data-testid="idiomas-voz">
        {encabezado}
        <CardContent>
          <EstadoError mensaje={t("vozIdiomas.error.cargar")} onReintentar={() => setVersion((v) => v + 1)} />
        </CardContent>
      </Card>
    );
  }

  const sucio = !mismosIdiomas(borrador, datos.idiomas);
  const enTope = borrador.adicionales.length >= datos.adicionalesMax;
  const cambiar = (c: ConfigIdiomasVoz) => {
    setBorrador(c);
    setAviso(false);
    setErrorGuardado(null);
  };

  async function guardar() {
    if (!borrador || guardando || !sucio) return;
    setGuardando(true);
    setErrorGuardado(null);
    try {
      const nuevo = await guardarIdiomasVoz(fetchImpl, apiBaseUrl, token, propertyId, borrador);
      setEstado({ fase: "listo", datos: nuevo });
      setBorrador(nuevo.idiomas);
      setAviso(true);
    } catch (err) {
      if (err instanceof VozNoDisponibleError) setEstado({ fase: "no_disponible" });
      else setErrorGuardado(err instanceof Error && err.message ? err.message : t("vozIdiomas.error.guardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card data-testid="idiomas-voz">
      {encabezado}
      <CardContent className="space-y-4">
        <div>
          <label htmlFor="voz-idioma-principal" className="mb-1.5 block text-sm font-medium text-foreground">
            {t("vozIdiomas.principal")}
          </label>
          <Selector id="voz-idioma-principal" data-testid="voz-idioma-principal" value={borrador.principal} onValueChange={(v) => cambiar(conPrincipal(borrador, v))}>
            {datos.catalogo.map((i) => (
              <option key={i.codigo} value={i.codigo}>
                {nombre(i.codigo)}
              </option>
            ))}
          </Selector>
        </div>

        <div>
          <p id="voz-idiomas-adicionales" className="mb-1.5 text-sm font-medium text-foreground">
            {t("vozIdiomas.adicionales")}
          </p>
          {borrador.adicionales.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("vozIdiomas.adicionales.vacio")}</p>
          ) : (
            <ul aria-labelledby="voz-idiomas-adicionales" className="flex flex-wrap gap-1.5">
              {borrador.adicionales.map((codigo) => (
                <li key={codigo} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs text-foreground">
                  {nombre(codigo)}
                  <Button type="button" variant="ghost" size="icon-xs" className="h-5 w-5 rounded-full" aria-label={t("vozIdiomas.adicionales.quitar", { idioma: nombre(codigo) })} onClick={() => cambiar(sinAdicional(borrador, codigo))}>
                    <X className="h-3 w-3" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 max-w-xs">
            <Selector
              aria-label={t("vozIdiomas.adicionales.agregar")}
              data-testid="voz-idioma-agregar"
              size="sm"
              value=""
              placeholder={t("vozIdiomas.adicionales.elegir")}
              disabled={enTope || disponibles.length === 0}
              onValueChange={(v) => v && cambiar(conAdicional(borrador, v, datos.adicionalesMax))}
            >
              {disponibles.map((i) => (
                <option key={i.codigo} value={i.codigo}>
                  {nombre(i.codigo)}
                </option>
              ))}
            </Selector>
            <p className="mt-1 text-xs text-muted-foreground">{t("vozIdiomas.adicionales.tope", { count: datos.adicionalesMax })}</p>
          </div>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div>
            <label htmlFor="voz-idiomas-deteccion" className="block text-sm font-medium text-foreground">
              {t("vozIdiomas.deteccion")}
            </label>
            <p className="text-xs text-muted-foreground">{borrador.adicionales.length === 0 ? t("vozIdiomas.deteccion.requiereAdicional") : t("vozIdiomas.deteccion.ayuda")}</p>
          </div>
          <Switch
            id="voz-idiomas-deteccion"
            checked={borrador.deteccionAutomatica}
            disabled={borrador.adicionales.length === 0}
            onCheckedChange={(v) => cambiar({ ...borrador, deteccionAutomatica: v })}
          />
        </div>

        <p className="text-xs text-muted-foreground">{t("vozIdiomas.soloVoz")}</p>

        {errorGuardado ? <Callout tone="danger">{errorGuardado}</Callout> : null}
        {aviso && !sucio ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("vozIdiomas.guardado")}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!sucio || guardando} onClick={() => cambiar(datos.idiomas)}>
            {t("vozIdiomas.descartar")}
          </Button>
          <Button type="button" size="sm" disabled={!sucio || guardando} onClick={() => void guardar()}>
            {guardando ? t("vozIdiomas.guardando") : t("vozIdiomas.guardar")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
