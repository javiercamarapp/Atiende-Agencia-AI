// Voz y saludo de ESTA sucursal dentro de la pantalla de ajustes: el catalogo de 30 voces de Gemini con muestra y la frase de saludo. Usa la configuracion de voz
// por sucursal que ya existe (lib/voz-client.ts): el PUT reemplaza la config completa, asi que se guarda sobre lo vigente (habilitado y comportamiento no se tocan).
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Textarea, useT } from "@atiende/ui";
import { restaurantesAjustesAgente } from "@atiende/ui/i18n/restaurantes/ajustesAgente";
import { VozNoDisponibleError, fetchVozConfig, updateVozConfig } from "../lib/voz-client.ts";
import type { VozConfig } from "../lib/voz-client.ts";
import { SelectorVoz } from "../voz/SelectorVoz.tsx";
import type { MuestraAudio } from "../voz/SelectorVoz.tsx";

type Estado =
  | { readonly fase: "cargando" }
  | { readonly fase: "listo"; readonly config: VozConfig | null }
  | { readonly fase: "no_disponible" }
  | { readonly fase: "error"; readonly mensaje: string };

/** Regla de transparencia: el saludo debe presentarse como asistente virtual. */
export function mencionaAsistenteVirtual(texto: string): boolean {
  return /asistente\s+virtual/i.test(texto);
}

export interface VozYSaludoProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly crearAudio?: (url: string) => MuestraAudio;
}

export function VozYSaludo({ apiBaseUrl, token, propertyId, crearAudio }: VozYSaludoProps) {
  const t = useT(restaurantesAjustesAgente);
  const [estado, setEstado] = useState<Estado>({ fase: "cargando" });
  const [vozId, setVozId] = useState<string | null>(null);
  const [saludo, setSaludo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setEstado({ fase: "cargando" });
    (async () => {
      try {
        const c = await fetchVozConfig(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setEstado({ fase: "listo", config: c });
        setVozId(c?.vozId ?? null);
        setSaludo(c?.mensajeInicial ?? "");
      } catch (err) {
        if (cancelado) return;
        setEstado(err instanceof VozNoDisponibleError ? { fase: "no_disponible" } : { fase: "error", mensaje: err instanceof Error ? err.message : t("restaurantes.ajustesAgente.saludo.error.cargar") });
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const reintentar = useCallback(() => setRecarga((v) => v + 1), []);
  const vigente = estado.fase === "listo" ? estado.config : null;
  const sucio = estado.fase === "listo" && (vozId !== (vigente?.vozId ?? null) || saludo !== (vigente?.mensajeInicial ?? ""));

  async function guardar() {
    if (estado.fase !== "listo" || guardando || vozId === null) return;
    setGuardando(true);
    setError(null);
    setGuardado(false);
    try {
      const c = await updateVozConfig(fetch, apiBaseUrl, token, propertyId, {
        vozId,
        mensajeInicial: saludo,
        mensajeInicialInterrumpible: vigente?.mensajeInicialInterrumpible ?? true,
        promptSistema: vigente?.promptSistema ?? "",
        habilitado: vigente?.habilitado ?? false,
      });
      setEstado({ fase: "listo", config: c });
      setGuardado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.ajustesAgente.saludo.error.guardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card data-testid="seccion-voz-saludo">
      <CardHeader className="p-4 pb-2">
        <CardTitle>{t("restaurantes.ajustesAgente.saludo.titulo")}</CardTitle>
        <CardDescription>{t("restaurantes.ajustesAgente.saludo.descripcion")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {estado.fase === "cargando" ? <EstadoCargando etiqueta={t("restaurantes.ajustesAgente.saludo.cargando")} /> : null}
        {estado.fase === "error" ? <EstadoError mensaje={estado.mensaje} onReintentar={reintentar} /> : null}
        {estado.fase === "no_disponible" ? (
          <p role="status" data-testid="voz-no-disponible" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("restaurantes.ajustesAgente.saludo.noDisponible")}
          </p>
        ) : null}
        {estado.fase === "listo" ? (
          <>
            <SelectorVoz vozId={vozId} onElegir={setVozId} baseUrl={import.meta.env.BASE_URL} {...(crearAudio ? { crearAudio } : {})} />
            <div>
              <label htmlFor="ajustes-saludo" className="block text-sm font-medium text-foreground mb-1.5">
                {t("restaurantes.ajustesAgente.saludo.frase")}
              </label>
              {/* // i18n-ignorar: ejemplo del saludo que la voz le dice al cliente; va en espanol en los dos idiomas. */}
              <Textarea id="ajustes-saludo" value={saludo} onChange={(e) => setSaludo(e.target.value)} rows={3} placeholder="Hola, le atiende el asistente virtual de …" />
            </div>
            {saludo.trim() !== "" && !mencionaAsistenteVirtual(saludo) ? (
              <Callout tone="warning" role="alert" data-testid="alerta-sin-asistente-virtual">
                {t("restaurantes.ajustesAgente.saludo.alerta")}
              </Callout>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <Button type="button" onClick={() => void guardar()} disabled={!sucio || vozId === null} loading={guardando}>
                {t("restaurantes.ajustesAgente.saludo.guardar")}
              </Button>
              {vozId === null ? <span className="text-xs text-muted-foreground">{t("restaurantes.ajustesAgente.saludo.elegirVoz")}</span> : null}
              {guardado && !sucio ? (
                <span role="status" className="text-xs text-primary">
                  {t("restaurantes.ajustesAgente.saludo.guardados")}
                </span>
              ) : null}
              {error ? (
                <span role="alert" className="text-xs text-destructive">
                  {error}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
