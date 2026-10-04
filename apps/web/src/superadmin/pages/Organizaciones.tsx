// Organizaciones / Clientes (SA-L-20): la composicion de "Flotas / Clientes" de Likida con los colores de Atiende.
//   * odometro con el total de organizaciones;
//   * DataTable: Organizacion, Vertical, Estado, Plan, Operaciones y Costo de IA a 30 dias, Margen del mes, Onboarding x/y, "Entrar" y "Ficha";
//   * HBars "Top por costo de IA" (30 dias);
//   * pestana "Gestion": el GestionOrganizaciones de siempre (alta, suspender, reactivar, plan; doble control y step-up intactos).
// Cada cifra sale de un endpoint real (GET /superadmin/organizaciones/resumen y /margen; apps/api/src/routes/superadmin-organizaciones-ficha.ts).
// Un dato que no se pudo medir se pinta "—" con su razon, nunca 0. El margen es de la zona CFO (step-up y bitacora): se pide APARTE y, si se
// rechaza, solo esa columna queda en blanco. Base sin la migracion 0052: aviso honesto y las columnas nuevas en "—".
// Un solo <h1> (PageHeader). La barra de pagina (icono + nombre) la pone el shell.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DoorOpen, FileText } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  HBars,
  Odometro,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  statusTone,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchJson } from "../lib/fetch-json.ts";
import { ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { NOMBRE_ESTADO_ORG, NOMBRE_VERTICAL, entero, mxn, usd } from "../lib/organizaciones.ts";
import type { CampoOrg, FilaOrganizacion, MargenOrg, RespuestaMargen, RespuestaResumen } from "../lib/organizaciones.ts";
import { useEntrarOrganizacion } from "../components/EntrarOrganizacion.tsx";
import { SuperAdminGestionOrganizacionesPage } from "./GestionOrganizaciones.tsx";

type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "ok"; readonly data: T };

/** Celda de un dato medible: la cifra, o "—" con la razon en el tooltip y como texto accesible. */
export function CeldaCampo<T>({ campo, formato }: { readonly campo: CampoOrg<T> | undefined; readonly formato: (v: T) => string }) {
  if (!campo) return <span className="text-muted-foreground">—</span>;
  if (campo.valor === null) {
    return (
      <span className="text-muted-foreground" title={campo.razon ?? undefined}>
        —<span className="sr-only"> {campo.razon ?? "sin dato"}</span>
      </span>
    );
  }
  return <span className="tabular-nums">{formato(campo.valor)}</span>;
}

export function SuperAdminOrganizacionesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "gestion" ? "gestion" : "clientes";
  const [resumen, setResumen] = useState<Carga<RespuestaResumen>>({ estado: "cargando" });
  const [margen, setMargen] = useState<Carga<RespuestaMargen>>({ estado: "cargando" });
  const { entrar, dialogo } = useEntrarOrganizacion(apiBaseUrl, token);

  const cargar = useCallback(async () => {
    setResumen({ estado: "cargando" });
    setMargen({ estado: "cargando" });
    // Cada fuente por separado: el rechazo del step-up del margen no tumba la tabla.
    const pedirResumen = fetchJson<RespuestaResumen>(apiBaseUrl, token, "/superadmin/organizaciones/resumen")
      .then((data) => setResumen({ estado: "ok", data }))
      .catch(() => setResumen({ estado: "error", mensaje: "No se pudieron cargar las organizaciones." }));
    const pedirMargen = fetchJson<RespuestaMargen>(apiBaseUrl, token, "/superadmin/organizaciones/margen")
      .then((data) => setMargen({ estado: "ok", data }))
      .catch((err: unknown) => setMargen({ estado: "error", mensaje: err instanceof Error ? err.message : "No se pudo leer el margen." }));
    await Promise.all([pedirResumen, pedirMargen]);
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const filas = resumen.estado === "ok" ? resumen.data.organizaciones : [];
  const margenDe = (id: string): CampoOrg<MargenOrg> | undefined => {
    if (margen.estado === "ok") return margen.data.margenes[id] ?? { valor: null, razon: margen.data.mensaje ?? "Sin margen para esta organización." };
    if (margen.estado === "error") return { valor: null, razon: margen.mensaje };
    return undefined;
  };

  const topCosto = useMemo(
    () =>
      filas
        .filter((f) => f.costoIa30dUsd.valor !== null && f.costoIa30dUsd.valor > 0)
        .sort((a, b) => (b.costoIa30dUsd.valor ?? 0) - (a.costoIa30dUsd.valor ?? 0))
        .slice(0, 6)
        .map((f) => ({ etiqueta: f.nombre, valor: f.costoIa30dUsd.valor ?? 0 })),
    [filas],
  );

  const columnas: readonly DataTableColumna<FilaOrganizacion>[] = [
    {
      id: "organizacion",
      encabezado: "Organización",
      principal: true,
      valorOrden: (f) => f.nombre,
      celda: (f) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-foreground">{f.nombre}</span>
          <span className="block truncate text-xs text-muted-foreground">{f.slug}</span>
        </span>
      ),
    },
    { id: "vertical", encabezado: "Vertical", valorOrden: (f) => NOMBRE_VERTICAL[f.vertical] ?? f.vertical, celda: (f) => NOMBRE_VERTICAL[f.vertical] ?? f.vertical },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (f) => f.estado,
      celda: (f) => <StatusBadge tone={statusTone(ORG_STATUS_TONES, f.estado)}>{NOMBRE_ESTADO_ORG[f.estado] ?? f.estado}</StatusBadge>,
    },
    { id: "plan", encabezado: "Plan", valorOrden: (f) => f.plan.valor?.nombre ?? null, celda: (f) => <CeldaCampo campo={f.plan} formato={(p) => p.nombre} /> },
    {
      id: "operaciones",
      encabezado: "Operaciones 30 d",
      alinear: "right",
      valorOrden: (f) => f.operaciones30d.valor,
      celda: (f) => <CeldaCampo campo={f.operaciones30d} formato={entero} />,
    },
    {
      id: "costoIa",
      encabezado: "Costo IA 30 d",
      alinear: "right",
      valorOrden: (f) => f.costoIa30dUsd.valor,
      celda: (f) => <CeldaCampo campo={f.costoIa30dUsd} formato={usd} />,
    },
    {
      id: "margen",
      encabezado: "Margen",
      alinear: "right",
      valorOrden: (f) => margenDe(f.id)?.valor?.mxn ?? null,
      celda: (f) => <CeldaCampo campo={margenDe(f.id)} formato={(m) => `${mxn(m.mxn)} · ${Math.round(m.pct)}%`} />,
    },
    {
      id: "onboarding",
      encabezado: "Onboarding",
      alinear: "right",
      valorOrden: (f) => (f.onboarding.valor && f.onboarding.valor.total > 0 ? f.onboarding.valor.hechos / f.onboarding.valor.total : null),
      celda: (f) => (
        <CeldaCampo
          campo={f.onboarding}
          formato={(o) => `${o.hechos}/${o.total}${o.noMedibles > 0 ? ` (${o.noMedibles} sin medir)` : ""}`}
        />
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      etiqueta: "Acciones",
      alinear: "right",
      ocultarEnTarjeta: false,
      celda: (f) => (
        <span className="inline-flex items-center justify-end gap-1.5">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => entrar({ id: f.id, nombre: f.nombre })}>
            <DoorOpen className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            Entrar
            <span className="sr-only"> a {f.nombre}</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to={`/superadmin/organizaciones/${f.id}`}>
              <FileText className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Ficha
              <span className="sr-only"> de {f.nombre}</span>
            </Link>
          </Button>
        </span>
      ),
    },
  ];

  const total = resumen.estado === "ok" ? resumen.data.organizaciones.length : null;
  const noDisponible = resumen.estado === "ok" && !resumen.data.disponible;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader
        titulo="Organizaciones"
        descripcion="Clientes de las 6 verticales de Atiende: uso, costo de IA, margen y avance de onboarding."
        acciones={<Odometro valor={total} digitos={3} etiqueta="ORGANIZACIONES" sinDato={resumen.estado === "error" ? resumen.mensaje : "Cargando…"} tamano="md" />}
      />
      {total !== null && (
        <p className="text-ui text-muted-foreground sm:hidden">
          Organizaciones <span className="font-medium tabular-nums text-foreground">{total}</span>
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setParams(v === "gestion" ? { tab: "gestion" } : {}, { replace: true })} className="grid gap-2.5">
        <TabsList aria-label="Secciones de Organizaciones">
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="gestion">Gestión</TabsTrigger>
        </TabsList>

        <TabsContent value="clientes" className="mt-0 grid gap-2.5">
          {noDisponible && (
            <Callout tone="warning" role="status">
              {resumen.data.mensaje ?? "Las métricas por organización todavía no están disponibles en este despliegue."} La lista sigue completa; las columnas de uso, costo y onboarding quedan en “—”.
            </Callout>
          )}
          {margen.estado === "ok" && !margen.data.disponible && (
            <Callout tone="info" role="status">
              {margen.data.mensaje ?? "El margen todavía no está disponible."}
            </Callout>
          )}
          {margen.estado === "error" && (
            <Callout tone="info" role="status">
              Margen no disponible: {margen.mensaje}
            </Callout>
          )}

          <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Todas las organizaciones</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  etiqueta="Organizaciones"
                  columnas={columnas}
                  filas={filas}
                  obtenerId={(f) => f.id}
                  estado={resumen.estado === "cargando" ? "loading" : resumen.estado === "error" ? "error" : filas.length === 0 ? "empty" : "ok"}
                  vacio={{ mensaje: "Todavía no hay organizaciones dadas de alta en ninguna vertical." }}
                  error={{ mensaje: resumen.estado === "error" ? resumen.mensaje : undefined, onReintentar: () => void cargar() }}
                  atributosFila={(f) => ({ "data-org-id": f.id })}
                  paginacion={{ tamano: 10 }}
                />
              </CardContent>
            </Card>

            <Card className="min-w-0 self-start">
              <CardHeader>
                <CardTitle>Top por costo de IA</CardTitle>
              </CardHeader>
              <CardContent>
                {resumen.estado === "cargando" ? (
                  <p className="text-ui text-muted-foreground">Cargando…</p>
                ) : (
                  <HBars datos={topCosto} formato="usd" sinDatos={noDisponible ? "Sin dato: las métricas por organización no están disponibles aún." : "Ninguna organización registra costo de IA en los últimos 30 días."} />
                )}
                <p className="mt-3 text-xs text-faint">Últimos 30 días, por organización.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="gestion" className="mt-0">
          <SuperAdminGestionOrganizacionesPage apiBaseUrl={apiBaseUrl} token={token} embebida />
        </TabsContent>
      </Tabs>
      {dialogo}
    </PageContainer>
  );
}

