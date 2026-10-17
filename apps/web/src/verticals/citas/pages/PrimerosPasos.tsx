// C-06 -- "Primeros pasos": checklist de onboarding de un negocio de citas. El estado de cada paso lo DERIVA el servidor
// de datos reales (GET .../onboarding); esta pagina solo lo pinta, con barra de progreso, enlace directo a cada pantalla
// y el panel "Listo para recibir citas" (la reserva publica por la web se abre cuando los pasos requeridos estan hechos).
// Descartar/posponer solo aplica a pasos opcionales y vive en este navegador (lib/onboarding-client.ts). Solo owner/admin
// (el servidor revalida con 403: este gate es UX).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, MinusCircle } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, StatusBadge } from "@atiende/ui";
import {
  PREFERENCIAS_VACIAS,
  claveDePreferencias,
  descartarPaso,
  fetchOnboarding,
  guardarPreferencias,
  leerPreferencias,
  ocultoComo,
  posponerPaso,
  reactivarPaso,
  rutaDelPaso,
  DIAS_POSPONER,
} from "../lib/onboarding-client.ts";
import type { ChecklistOnboarding, PasoOnboarding, PreferenciasOnboarding } from "../lib/onboarding-client.ts";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";
import type { CitasShellContext } from "../CitasShell.tsx";

const ROLES = new Set(["owner", "admin"]);

function almacenamiento(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function PrimerosPasosPage({ apiBaseUrl, token, propertyId, orgSlug, orgId, role }: CitasShellContext) {
  const puede = ROLES.has(role);
  const clave = claveDePreferencias(orgId, propertyId);
  const [checklist, setChecklist] = useState<ChecklistOnboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PreferenciasOnboarding>(PREFERENCIAS_VACIAS);

  useEffect(() => {
    setPrefs(leerPreferencias(almacenamiento(), clave));
  }, [clave]);

  const [reintento, setReintento] = useState(0);

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    setChecklist(null);
    setError(null);
    fetchOnboarding(fetch, apiBaseUrl, token, propertyId)
      .then((c) => !cancelado && setChecklist(c))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los primeros pasos."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puede, reintento]);

  function actualizar(siguiente: PreferenciasOnboarding) {
    setPrefs(siguiente);
    guardarPreferencias(almacenamiento(), clave, siguiente);
  }

  const ahora = new Date();
  const { visibles, ocultos } = useMemo(() => {
    const v: PasoOnboarding[] = [];
    const o: PasoOnboarding[] = [];
    for (const p of checklist?.pasos ?? []) (ocultoComo(prefs, p, new Date()) ? o : v).push(p);
    return { visibles: v, ocultos: o };
  }, [checklist, prefs]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-semibold text-foreground">Primeros pasos</h1>
      </header>

      {!puede && (
        <p className="m-0 text-sm text-muted-foreground">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> ven esta guía — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </p>
      )}

      {puede && error && <EstadoError mensaje={error} onReintentar={() => setReintento((n) => n + 1)} />}
      {puede && !checklist && !error && <EstadoCargando etiqueta="Cargando primeros pasos…" />}

      {puede && checklist && (
        <>
          <PanelListo checklist={checklist} orgSlug={orgSlug} />

          <section aria-label="Progreso" className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold text-foreground">
                {checklist.completados} de {checklist.total} pasos
              </span>
              <span className="tabular-nums text-muted-foreground">{checklist.progresoPct}%</span>
            </div>
            <BarraProgreso valor={checklist.progresoPct} aria-label="Progreso de los primeros pasos" />
          </section>

          <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Pasos">
            {visibles.map((p) => (
              <li key={p.id}>
                <Paso
                  paso={p}
                  orgSlug={orgSlug}
                  onPosponer={() => actualizar(posponerPaso(prefs, p.id, ahora))}
                  onDescartar={() => actualizar(descartarPaso(prefs, p.id))}
                />
              </li>
            ))}
          </ol>

          {ocultos.length > 0 && (
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-sm">Pasos ocultos ({ocultos.length})</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-4 pt-0">
                {ocultos.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {p.titulo} · {ocultoComo(prefs, p, new Date()) === "descartado" ? "descartado" : "pospuesto"}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => actualizar(reactivarPaso(prefs, p.id))}>
                      Volver a mostrar
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** C-19 -- enlace publico de reservas del negocio con boton Copiar (sin portapapeles disponible: se muestra para copiarlo a mano). */
export function EnlaceReservas({ orgSlug }: { readonly orgSlug: string }) {
  const url = `${typeof window === "undefined" ? "" : window.location.origin}/reservar/${orgSlug}`;
  const [estado, setEstado] = useState<"idle" | "copiado" | "error">("idle");
  async function copiar() {
    try {
      await navigator.clipboard.writeText(url);
      setEstado("copiado");
    } catch {
      setEstado("error");
    }
  }
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <p className="m-0 text-sm font-semibold text-foreground">Tu página de reservas</p>
        <p className="m-0 text-sm text-muted-foreground">Compártela con tus clientes: ahí eligen servicio, profesional y horario sin crear cuenta.</p>
        <div className="flex flex-wrap items-center gap-2">
          <a href={url} target="_blank" rel="noreferrer" className="min-w-0 break-all text-sm text-foreground underline underline-offset-2">
            {url}
          </a>
          <Button type="button" variant="outline" size="sm" onClick={copiar}>
            Copiar
          </Button>
        </div>
        <p role="status" className="m-0 text-xs text-muted-foreground">
          {estado === "copiado" ? "Enlace copiado." : estado === "error" ? "No pudimos copiarlo automáticamente: selecciónalo y cópialo a mano." : ""}
        </p>
      </CardContent>
    </Card>
  );
}

function PanelListo({ checklist, orgSlug }: { readonly checklist: ChecklistOnboarding; readonly orgSlug: string }) {
  if (checklist.listoParaRecibirCitas) {
    return (
      <>
        <Callout tone="success" titulo="Listo para recibir citas">
          Tu negocio tiene lo mínimo: la reserva en línea está abierta para tus clientes.
        </Callout>
        <EnlaceReservas orgSlug={orgSlug} />
      </>
    );
  }
  const faltantes = checklist.pasos.filter((p) => p.requeridoParaPublicar && p.estado !== "completo");
  return (
    <Callout tone="warning" titulo="Aún no estás listo para recibir citas en línea">
      <p className="m-0">La reserva pública por la web está cerrada hasta que completes lo mínimo:</p>
      <ul className="m-0 mt-1 list-disc pl-5">
        {faltantes.map((p) => (
          <li key={p.id}>
            <Link to={rutaDelPaso(orgSlug, p)} className="font-semibold text-foreground hover:underline">
              {p.titulo}
            </Link>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function Paso({ paso, orgSlug, onPosponer, onDescartar }: { readonly paso: PasoOnboarding; readonly orgSlug: string; readonly onPosponer: () => void; readonly onDescartar: () => void }) {
  const completo = paso.estado === "completo";
  const Icono = completo ? CheckCircle2 : paso.estado === "no_disponible" ? MinusCircle : Circle;
  const opcionalPendiente = !paso.requeridoParaPublicar && !completo;
  return (
    <Card data-paso={paso.id} data-estado={paso.estado}>
      <CardContent className="flex flex-wrap items-start gap-3 p-4">
        <Icono className={`mt-0.5 size-5 shrink-0 ${completo ? "text-success" : "text-muted-foreground"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="m-0 text-sm font-semibold text-foreground">{paso.titulo}</p>
            {completo && <StatusBadge tone="success">Listo</StatusBadge>}
            {paso.estado === "no_disponible" && <StatusBadge tone="neutral">No disponible aún</StatusBadge>}
            {paso.requeridoParaPublicar && !completo && <StatusBadge tone="warning">Requerido</StatusBadge>}
          </div>
          <p className="m-0 mt-0.5 text-sm text-muted-foreground">{paso.descripcion}</p>
          {paso.detalle && <p className="m-0 mt-0.5 text-sm text-foreground/80">{paso.detalle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {paso.estado !== "no_disponible" && (
            <Button asChild variant={completo ? "ghost" : "outline"} size="sm">
              <Link to={rutaDelPaso(orgSlug, paso)}>{completo ? "Revisar" : "Ir a configurarlo"}</Link>
            </Button>
          )}
          {opcionalPendiente && paso.estado === "pendiente" && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={onPosponer}>
                Posponer {DIAS_POSPONER} días
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onDescartar}>
                Descartar
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
