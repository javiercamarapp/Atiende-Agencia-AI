// CFO-07 · «Ajustes del CFO»: cliente frecuente (N pedidos en N días), promesa de entrega, IVA, comisión de terminal y umbrales de los hallazgos.
// Lee `GET .../admin/cfo/config` y guarda SOLO lo que cambió con `PUT .../admin/cfo/config`. Los rangos válidos vienen del API (los mismos que valida la base).
// Solo el dueño o un admin de toda la organización guarda; un admin acotado la lee. Incluye el aviso de no sustitución.
import { useEffect, useState } from "react";
import type { CfoConfig, ConfigVista } from "@atiende/domain-restaurantes/cfo";
import { Button, Callout, EstadoCargando, EstadoError, FormDialog, FormField, Input, notify } from "@atiende/ui";
import { fetchConfig, guardarConfig, type CambiosConfigCfo, type ContextoCfo } from "./cfo-client.ts";
import { AvisoNoSustitucion } from "./piezas.tsx";
import { useCargaCfo } from "./use-carga-cfo.ts";

type Llave = Exclude<keyof CfoConfig, "srCuadreVerdePct" | "srCuadreAmbarPct" | "srCuadreVerdeCentavos">;
interface Campo {
  readonly llave: Llave;
  readonly etiqueta: string;
  readonly ayuda: string;
  readonly entero: boolean;
  readonly unidad: string;
}

const GRUPOS: ReadonlyArray<{ readonly titulo: string; readonly campos: readonly Campo[] }> = [
  {
    titulo: "Cliente frecuente",
    campos: [
      { llave: "frecuenteN", etiqueta: "Pedidos para ser frecuente", ayuda: "Un cliente es frecuente si hizo al menos este número de pedidos…", entero: true, unidad: "pedidos" },
      { llave: "frecuenteDias", etiqueta: "…dentro de estos días", ayuda: "Ventana en la que se cuentan esos pedidos.", entero: true, unidad: "días" },
      { llave: "activoDias", etiqueta: "Cliente activo si pidió en los últimos", ayuda: "Pasado ese tiempo sin pedir pasa a dormido.", entero: true, unidad: "días" },
      { llave: "perdidoDias", etiqueta: "Cliente perdido tras", ayuda: "Sin pedir durante este tiempo se considera perdido.", entero: true, unidad: "días" },
    ],
  },
  {
    titulo: "Entrega",
    campos: [
      { llave: "promesaMin", etiqueta: "Promesa de entrega", ayuda: "Lo que le prometes al cliente; sobre ella se mide el retraso.", entero: true, unidad: "min" },
      { llave: "entregaP90MaxMin", etiqueta: "Entrega p90 máxima", ayuda: "Si 9 de cada 10 entregas tardan más que esto, se avisa.", entero: true, unidad: "min" },
    ],
  },
  {
    titulo: "Impuestos y comisiones",
    campos: [
      { llave: "ivaPct", etiqueta: "IVA", ayuda: "Se usa para estimar las ventas sin IVA (cifra estimada).", entero: false, unidad: "%" },
      { llave: "comisionTerminalPct", etiqueta: "Comisión de terminal", ayuda: "Sobre las ventas con tarjeta. Déjalo vacío si aún no la capturas: la línea quedará como «captura pendiente».", entero: false, unidad: "%" },
    ],
  },
  {
    titulo: "Umbrales de «Lo más importante»",
    campos: [
      { llave: "caidaPct", etiqueta: "Caída de ventas", ayuda: "Avisa si la venta cae más que esto contra su promedio.", entero: false, unidad: "%" },
      { llave: "ticketBajaPct", etiqueta: "Baja del ticket", ayuda: "Avisa si el ticket baja más que esto.", entero: false, unidad: "%" },
      { llave: "cancelacionXMediana", etiqueta: "Cancelación vs. mediana", ayuda: "Veces la mediana de las sucursales.", entero: false, unidad: "veces" },
      { llave: "descuentoMaxPct", etiqueta: "Descuento máximo", ayuda: "Avisa si el descuento supera este porcentaje de la venta bruta.", entero: false, unidad: "%" },
      { llave: "costoAgenteAlzaPct", etiqueta: "Alza del costo del agente", ayuda: "Avisa si el costo por pedido sube más que esto.", entero: false, unidad: "%" },
      { llave: "cierreBajaPp", etiqueta: "Baja de la tasa de cierre", ayuda: "Puntos porcentuales que debe bajar el cierre del agente.", entero: false, unidad: "pp" },
    ],
  },
];

const textoDe = (v: number | null): string => (v === null ? "" : String(v));

function interpretar(texto: string, campo: Campo, rango: readonly [number, number] | undefined): { readonly valor: number | null; readonly error: string | null } {
  const t = texto.trim();
  if (t === "") return campo.llave === "comisionTerminalPct" ? { valor: null, error: null } : { valor: null, error: "Escribe un número." };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t) || (campo.entero && t.includes("."))) return { valor: null, error: campo.entero ? "Escribe un número entero." : "Escribe un número (máximo 2 decimales)." };
  const n = Number(t);
  if (rango && (n < rango[0] || n > rango[1])) return { valor: null, error: `Debe estar entre ${rango[0]} y ${rango[1]}.` };
  return { valor: n, error: null };
}

export interface AjustesCfoDialogoProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly api: ContextoCfo;
  readonly onGuardado: () => void;
}

export function AjustesCfoDialogo({ abierto, onCerrar, api, onGuardado }: AjustesCfoDialogoProps) {
  const { carga, recargar } = useCargaCfo(() => (abierto ? fetchConfig(api) : Promise.reject(new Error("cerrado"))), [abierto, api.propertyId, api.token]);
  return (
    <FormDialog open={abierto} onOpenChange={(o) => !o && onCerrar()} titulo="Ajustes del CFO" subtitulo="Definiciones y umbrales con los que se calculan los indicadores y los hallazgos." anchoClase="max-w-3xl" anchoRiel="200px" footer={<span />}>
      <div className="space-y-3 pr-1" data-testid="ajustes-cfo">
        {!abierto ? null : carga.estado === "cargando" ? (
          <EstadoCargando etiqueta="Cargando los ajustes…" />
        ) : carga.estado === "error" ? (
          <EstadoError mensaje={carga.mensaje} onReintentar={recargar} />
        ) : carga.estado === "no_disponible" ? (
          <Callout tone="info">Los ajustes del CFO todavía no están disponibles en este negocio (falta aplicar la actualización de base de datos).</Callout>
        ) : carga.estado === "sin_acceso" ? (
          <Callout tone="warning">Tu rol no tiene acceso al CFO.</Callout>
        ) : (
          <Formulario config={carga.datos} api={api} onCerrar={onCerrar} onGuardado={onGuardado} />
        )}
        <AvisoNoSustitucion />
      </div>
    </FormDialog>
  );
}

function Formulario({ config, api, onCerrar, onGuardado }: { readonly config: ConfigVista; readonly api: ContextoCfo; readonly onCerrar: () => void; readonly onGuardado: () => void }) {
  const campos = GRUPOS.flatMap((g) => g.campos);
  const [valores, setValores] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(campos.map((c) => [c.llave, textoDe(config.config[c.llave])])));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValores(Object.fromEntries(campos.map((c) => [c.llave, textoDe(config.config[c.llave])])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const lectura = !config.puedeGuardar;
  const interpretados = campos.map((c) => ({ campo: c, ...interpretar(valores[c.llave] ?? "", c, config.rangos[c.llave]) }));
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
      notify.success("Ajustes del CFO guardados.");
      onGuardado();
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los ajustes.");
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
      {lectura && <Callout tone="info">Solo el dueño o un administrador de toda la organización puede cambiar estos ajustes. Tú puedes verlos.</Callout>}
      {!config.configurada && <Callout tone="neutral">Todavía no guardas tu configuración: se usan los valores de fábrica.</Callout>}
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
          {nCambios === 0 ? "Sin cambios" : `Guardar ${nCambios} ${nCambios === 1 ? "cambio" : "cambios"}`}
        </Button>
      </div>
    </form>
  );
}
