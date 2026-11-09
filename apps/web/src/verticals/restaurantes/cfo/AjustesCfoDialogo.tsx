// CFO-07 · «Ajustes del CFO»: cliente frecuente (N pedidos en N días), promesa de entrega, IVA, comisión de terminal y umbrales de los hallazgos.
// Lee `GET .../admin/cfo/config` y guarda SOLO lo que cambió con `PUT .../admin/cfo/config`. Los rangos válidos vienen del API (los mismos que valida la base).
// Solo el dueño o un admin de toda la organización guarda; un admin acotado la lee. Incluye el aviso de no sustitución.
import { useEffect, useState } from "react";
import type { CfoConfig, ConfigVista } from "@atiende/domain-restaurantes/cfo";
import { Button, Callout, EstadoCargando, EstadoError, FormDialog, FormField, Input, notify, traductorActivo, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesCfoAjustes } from "@atiende/ui/i18n/restaurantes/cfoAjustes";
import { fetchConfig, guardarConfig, type CambiosConfigCfo, type ContextoCfo } from "./cfo-client.ts";
import { AvisoNoSustitucion } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type Llave = keyof CfoConfig;
interface Campo {
  readonly llave: Llave;
  readonly etiqueta: string;
  readonly ayuda: string;
  readonly entero: boolean;
  readonly unidad: string;
  /** El valor se guarda en centavos pero se escribe en pesos. */
  readonly centavos?: boolean;
}

const tr = traductorActivo(restaurantesCfoAjustes);
const UNIDADES: Readonly<Record<string, Clave>> = { pedidos: "restaurantes.cfoAjustes.unidad.pedidos", dias: "restaurantes.cfoAjustes.unidad.dias", veces: "restaurantes.cfoAjustes.unidad.veces" };

/** Campo con sus textos en el idioma activo (cada lectura traduce; en espanol, los de siempre). Las unidades simbolo (min, %, $, pp) no se traducen. */
function campo(llave: Llave, unidad: string, entero: boolean, centavos?: true): Campo {
  return {
    llave,
    get etiqueta() {
      return tr(`restaurantes.cfoAjustes.${llave}.etiqueta` as Clave);
    },
    get ayuda() {
      return tr(`restaurantes.cfoAjustes.${llave}.ayuda` as Clave);
    },
    entero,
    get unidad() {
      const clave = UNIDADES[unidad];
      return clave ? tr(clave) : unidad;
    },
    ...(centavos ? { centavos } : {}),
  };
}

function grupo(clave: Clave, campos: readonly Campo[]): { readonly titulo: string; readonly campos: readonly Campo[] } {
  return {
    get titulo() {
      return tr(clave);
    },
    campos,
  };
}

const GRUPOS: ReadonlyArray<{ readonly titulo: string; readonly campos: readonly Campo[] }> = [
  grupo("restaurantes.cfoAjustes.grupo.frecuente", [
    campo("frecuenteN", "pedidos", true),
    campo("frecuenteDias", "dias", true),
    campo("activoDias", "dias", true),
    campo("perdidoDias", "dias", true),
  ]),
  grupo("restaurantes.cfoAjustes.grupo.entrega", [campo("promesaMin", "min", true), campo("entregaP90MaxMin", "min", true)]),
  grupo("restaurantes.cfoAjustes.grupo.impuestos", [campo("ivaPct", "%", false), campo("comisionTerminalPct", "%", false)]),
  grupo("restaurantes.cfoAjustes.grupo.sr", [campo("srCuadreVerdePct", "%", false), campo("srCuadreVerdeCentavos", "$", false, true), campo("srCuadreAmbarPct", "%", false)]),
  grupo("restaurantes.cfoAjustes.grupo.umbrales", [
    campo("caidaPct", "%", false),
    campo("ticketBajaPct", "%", false),
    campo("cancelacionXMediana", "veces", false),
    campo("descuentoMaxPct", "%", false),
    campo("costoAgenteAlzaPct", "%", false),
    campo("cierreBajaPp", "pp", false),
  ]),
];

const textoDe = (v: number | null, c?: Campo): string => (v === null ? "" : String(c?.centavos ? v / 100 : v));

function interpretar(texto: string, campo: Campo, rango: readonly [number, number] | undefined): { readonly valor: number | null; readonly error: string | null } {
  const t = texto.trim();
  if (t === "") return campo.llave === "comisionTerminalPct" ? { valor: null, error: null } : { valor: null, error: tr("restaurantes.cfoAjustes.error.numero") };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t) || (campo.entero && t.includes("."))) return { valor: null, error: tr(campo.entero ? "restaurantes.cfoAjustes.error.entero" : "restaurantes.cfoAjustes.error.decimales") };
  const escrito = Number(t);
  const n = campo.centavos ? Math.round(escrito * 100) : escrito;
  if (rango && (n < rango[0] || n > rango[1])) {
    const [min, max] = campo.centavos ? [rango[0] / 100, rango[1] / 100] : rango;
    return { valor: null, error: tr("restaurantes.cfoAjustes.error.rango", { min: String(min), max: String(max) }) };
  }
  return { valor: n, error: null };
}

export interface AjustesCfoDialogoProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly api: ContextoCfo;
  readonly onGuardado: () => void;
}

export function AjustesCfoDialogo({ abierto, onCerrar, api, onGuardado }: AjustesCfoDialogoProps) {
  const t = useT(restaurantesCfoAjustes);
  const { carga, recargar } = useCargaCfo(() => (abierto ? fetchConfig(api) : Promise.reject(new Error("cerrado"))), [abierto, api.propertyId, api.token]);
  return (
    <FormDialog open={abierto} onOpenChange={(o) => !o && onCerrar()} titulo={t("restaurantes.cfoAjustes.titulo")} subtitulo={t("restaurantes.cfoAjustes.subtitulo")} anchoClase="max-w-3xl" anchoRiel="200px" footer={<span />}>
      <div className="space-y-3 pr-1" data-testid="ajustes-cfo">
        {!abierto ? null : carga.estado === "cargando" ? (
          <EstadoCargando etiqueta={t("restaurantes.cfoAjustes.cargando")} />
        ) : carga.estado === "error" ? (
          <EstadoError mensaje={carga.mensaje} onReintentar={recargar} />
        ) : carga.estado === "no_disponible" ? (
          <Callout tone="info">{t("restaurantes.cfoAjustes.noDisponible")}</Callout>
        ) : carga.estado === "sin_acceso" ? (
          <Callout tone="warning">{t("restaurantes.cfoAjustes.sinAcceso")}</Callout>
        ) : (
          <Formulario config={carga.datos} api={api} onCerrar={onCerrar} onGuardado={onGuardado} />
        )}
        <AvisoNoSustitucion />
      </div>
    </FormDialog>
  );
}

function Formulario({ config, api, onCerrar, onGuardado }: { readonly config: ConfigVista; readonly api: ContextoCfo; readonly onCerrar: () => void; readonly onGuardado: () => void }) {
  const t = useT(restaurantesCfoAjustes);
  const campos = GRUPOS.flatMap((g) => g.campos);
  const [valores, setValores] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(campos.map((c) => [c.llave, textoDe(config.config[c.llave], c)])));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValores(Object.fromEntries(campos.map((c) => [c.llave, textoDe(config.config[c.llave], c)])));
  }, [config]);

  const lectura = !config.puedeGuardar;
  const base = campos.map((c) => ({ campo: c, ...interpretar(valores[c.llave] ?? "", c, config.rangos[c.llave]) }));
  // Regla cruzada (la base la exige): un cliente es «perdido» después de dejar de ser «activo».
  const activo = base.find((i) => i.campo.llave === "activoDias")?.valor ?? null;
  const perdido = base.find((i) => i.campo.llave === "perdidoDias")?.valor ?? null;
  const cruzado = activo !== null && perdido !== null && activo >= perdido;
  // Regla cruzada (la base la exige): lo que cuadra no puede superar a lo que se revisa.
  const verde = base.find((i) => i.campo.llave === "srCuadreVerdePct")?.valor ?? null;
  const ambar = base.find((i) => i.campo.llave === "srCuadreAmbarPct")?.valor ?? null;
  const cruzadoSr = verde !== null && ambar !== null && verde > ambar;
  const interpretados = base.map((i) =>
    cruzado && i.campo.llave === "perdidoDias" && i.error === null
      ? { ...i, error: t("restaurantes.cfoAjustes.error.perdido") }
      : cruzadoSr && i.campo.llave === "srCuadreAmbarPct" && i.error === null
        ? { ...i, error: t("restaurantes.cfoAjustes.error.ambar") }
        : i,
  );
  const cambios: Record<string, number | null> = {};
  for (const i of interpretados) {
    if (i.error === null && i.valor !== config.config[i.campo.llave]) cambios[i.campo.llave] = i.valor;
  }
  const hayErrores = interpretados.some((i) => i.error !== null);
  const nCambios = Object.keys(cambios).length;

  async function guardar() {
    if (lectura || hayErrores || nCambios === 0) return;
    setGuardando(true);
    setError(null);
    try {
      await guardarConfig(api, cambios as CambiosConfigCfo);
      notify.success(t("restaurantes.cfoAjustes.guardados"));
      onGuardado();
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.cfoAjustes.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guardar();
      }}
    >
      {lectura && <Callout tone="info">{t("restaurantes.cfoAjustes.soloLectura")}</Callout>}
      {!config.configurada && <Callout tone="neutral">{t("restaurantes.cfoAjustes.deFabrica")}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}
      {GRUPOS.map((g) => (
        <fieldset key={g.titulo} className="space-y-3">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.titulo}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {g.campos.map((c) => {
              const i = interpretados.find((x) => x.campo.llave === c.llave);
              return (
                <FormField key={c.llave} label={`${c.etiqueta} (${c.unidad})`} hint={c.ayuda} {...(i?.error ? { error: i.error } : {})}>
                  <Input inputMode="decimal" value={valores[c.llave] ?? ""} disabled={lectura} onChange={(e) => setValores((v) => ({ ...v, [c.llave]: e.target.value }))} data-testid={`ajuste-${c.llave}`} />
                </FormField>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end">
        <Button type="submit" loading={guardando} disabled={lectura || guardando || hayErrores || nCambios === 0}>
          {nCambios === 0 ? t("restaurantes.cfoAjustes.sinCambios") : t("restaurantes.cfoAjustes.guardarN", { count: nCambios })}
        </Button>
      </div>
    </form>
  );
}
