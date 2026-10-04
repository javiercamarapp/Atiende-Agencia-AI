// Encuestas post-entrega (R-41): satisfaccion de los clientes por sucursal y por repartidor, comentarios recientes y configuracion de la
// encuesta (activa, espera, liga de resenas, umbral). Solo owner/admin. Todo sale de la base: sin dato = "—" con su razon (nunca un 0
// inventado). "Dia" = dia local de la sucursal en que se ENVIO la encuesta; la tasa de respuesta y el promedio se miden sobre esa misma
// cohorte. Los comentarios son texto libre del cliente: se muestran sin telefono ni nombre.
import { useCallback, useEffect, useState } from "react";
import { MessageSquareText, Send, Star, ThumbsDown } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, PageContainer, StatCard, Switch } from "@atiende/ui";
import { enviarEncuestasPendientes, fetchEncuestaConfig, fetchEncuestaResumen, guardarEncuestaConfig } from "../lib/encuesta-client.ts";
import type { EncuestaAlcance, EncuestaComentario, EncuestaConfig, EncuestaPorRepartidor, EncuestaPorSucursal, EncuestaResumenRespuesta, EnvioPendientesRespuesta } from "../lib/encuesta-client.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { desdeError } from "../voz/carga.ts";
import type { Carga } from "../voz/carga.ts";
import { formatoDia, formatoPct } from "../voz/formato-kpi.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ROLES_ENCUESTAS: ReadonlySet<string> = new Set(["owner", "admin"]);
const PERIODOS: readonly { readonly dias: number; readonly etiqueta: string }[] = [
  { dias: 7, etiqueta: "Últimos 7 días" },
  { dias: 30, etiqueta: "Últimos 30 días" },
  { dias: 60, etiqueta: "Últimos 60 días" },
  { dias: 92, etiqueta: "Últimos 92 días" },
];

const promedioTexto = (p: number | null) => (p === null ? "—" : p.toFixed(2));
const estrellas = (n: number) => `${n} ${n === 1 ? "estrella" : "estrellas"}`;
const NO_DISPONIBLE = "La encuesta post-entrega aún no está activa en este negocio (requiere la actualización de base de datos pendiente).";

export function EncuestasPage({ apiBaseUrl, token, propertyId, role, fetchImpl }: RestaurantesShellContext & { readonly fetchImpl?: typeof fetch }) {
  const puedeVer = ROLES_ENCUESTAS.has(role);
  const [dias, setDias] = useState(30);
  const [alcance, setAlcance] = useState<EncuestaAlcance>("organizacion");
  const [datos, setDatos] = useState<Carga<EncuestaResumenRespuesta>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);
  const reintentar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setDatos((previo) => (previo.estado === "listo" ? previo : { estado: "cargando" }));
    (async () => {
      try {
        const r = await fetchEncuestaResumen(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, dias, alcance);
        if (!cancelado) setDatos({ estado: "listo", datos: r });
      } catch (err) {
        if (!cancelado) setDatos(desdeError(err, "No se pudo cargar la satisfacción de los clientes."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, dias, alcance, version, fetchImpl, puedeVer]);

  return (
    <PageContainer padding="none">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl font-semibold">Encuestas</h1>
          <p className="mt-1 truncate text-ui text-muted-foreground">Qué tan satisfechos quedan tus clientes después de recibir su pedido.</p>
        </div>
        {puedeVer ? (
          <div className="flex shrink-0 items-center gap-2">
            <label htmlFor="alcance-encuestas" className="sr-only">
              Alcance
            </label>
            <NativeSelect id="alcance-encuestas" value={alcance} onChange={(e) => setAlcance(e.target.value as EncuestaAlcance)}>
              <option value="organizacion">Todas mis sucursales</option>
              <option value="sucursal">Solo esta sucursal</option>
            </NativeSelect>
            <label htmlFor="periodo-encuestas" className="sr-only">
              Periodo
            </label>
            <NativeSelect id="periodo-encuestas" value={String(dias)} onChange={(e) => setDias(Number(e.target.value))}>
              {PERIODOS.map((p) => (
                <option key={p.dias} value={p.dias}>
                  {p.etiqueta}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </header>

      {!puedeVer ? (
        <Callout tone="info">
          Solo los roles <strong className="text-foreground">owner</strong>/<strong className="text-foreground">admin</strong> ven las encuestas — tu rol actual es <strong className="text-foreground">{role}</strong>.
        </Callout>
      ) : (
        <div className="space-y-2.5">
          {datos.estado === "cargando" ? (
            <EstadoCargando etiqueta="Cargando encuestas…" />
          ) : datos.estado === "no_disponible" ? (
            <EstadoVacio icon={Star} titulo="Encuestas no disponibles todavía" mensaje={`${NO_DISPONIBLE} Cuando lo esté, aquí verás la calificación promedio, la tasa de respuesta y los comentarios de tus clientes.`} />
          ) : datos.estado === "error" ? (
            <EstadoError mensaje={datos.mensaje} onReintentar={reintentar} />
          ) : (
            <Contenido datos={datos.datos} />
          )}
          <ConfiguracionYEnvio apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} onCambio={reintentar} />
        </div>
      )}
    </PageContainer>
  );
}

function Contenido({ datos }: { readonly datos: EncuestaResumenRespuesta }) {
  const r = datos.resumen;
  const total = r.respondidas;
  const bajas = (r.distribucion[0] ?? 0) + (r.distribucion[1] ?? 0);
  const filasDistribucion = [5, 4, 3, 2, 1].map((n) => ({ n, cantidad: r.distribucion[n - 1] ?? 0 }));
  return (
    <div className="space-y-2.5" data-testid="encuestas-resumen">
      <p className="text-xs text-muted-foreground">
        Encuestas enviadas del {formatoDia(datos.desde)} al {formatoDia(datos.hasta)} (zona {datos.zonaHoraria}). El promedio y la tasa de respuesta se miden sobre esas mismas encuestas; una encuesta sin responder no cuenta en el promedio.
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          icon={Star}
          label="Calificación promedio"
          value={promedioTexto(r.promedio)}
          {...(r.promedio === null ? { sinDato: "Sin respuestas en el periodo." } : { nota: `${total} ${total === 1 ? "respuesta" : "respuestas"} de 1 a 5` })}
        />
        <StatCard
          icon={Send}
          label="Tasa de respuesta"
          value={formatoPct(r.tasaRespuestaPct)}
          {...(r.tasaRespuestaPct === null ? { sinDato: "Sin encuestas enviadas en el periodo." } : { nota: `${r.respondidas} de ${r.enviadas} encuestas enviadas` })}
        />
        <StatCard icon={MessageSquareText} label="Encuestas enviadas" value={String(r.enviadas)} nota="Después de cada entrega, por WhatsApp" />
        <StatCard icon={ThumbsDown} label="Calificaciones bajas" value={String(bajas)} nota="1 o 2 estrellas: avisan al owner/admin" />
      </div>

      <div className="grid gap-2.5 lg:grid-cols-2">
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>Distribución de calificaciones</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<{ n: number; cantidad: number }>
              etiqueta="Distribución de calificaciones"
              filas={filasDistribucion}
              obtenerId={(f) => String(f.n)}
              vacio={{ titulo: "Sin respuestas", mensaje: "Todavía no hay respuestas en este periodo." }}
              paginacion={false}
              columnas={[
                { id: "estrellas", encabezado: "Calificación", principal: true, celda: (f) => estrellas(f.n) },
                { id: "cantidad", encabezado: "Respuestas", alinear: "right", className: "tabular-nums", celda: (f) => f.cantidad },
                { id: "pct", encabezado: "% de las respuestas", alinear: "right", className: "tabular-nums", celda: (f) => (total === 0 ? "—" : `${Math.round((f.cantidad * 1000) / total) / 10}%`) },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle>Por sucursal</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<EncuestaPorSucursal>
              etiqueta="Satisfacción por sucursal"
              filas={datos.porSucursal}
              obtenerId={(s) => s.propertyId}
              vacio={{ titulo: "Sin sucursales", mensaje: "No hay sucursales en el alcance elegido." }}
              paginacion={false}
              columnas={[
                { id: "sucursal", encabezado: "Sucursal", principal: true, celda: (s) => s.nombre },
                { id: "promedio", encabezado: "Promedio", alinear: "right", className: "tabular-nums", celda: (s) => promedioTexto(s.promedio) },
                { id: "respuestas", encabezado: "Respuestas", alinear: "right", className: "tabular-nums", celda: (s) => `${s.respondidas} de ${s.enviadas}` },
                { id: "tasa", encabezado: "Tasa", alinear: "right", className: "tabular-nums", celda: (s) => formatoPct(s.tasaRespuestaPct) },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Por repartidor</CardTitle>
          <CardDescription>Según quién tenía asignado el pedido al enviar la encuesta. Los pedidos para recoger no cuentan aquí.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<EncuestaPorRepartidor>
            etiqueta="Satisfacción por repartidor"
            filas={datos.porRepartidor}
            obtenerId={(p) => p.repartidorId}
            vacio={{ titulo: "Sin entregas encuestadas", mensaje: "Ningún pedido con repartidor tiene encuesta enviada en este periodo." }}
            paginacion={false}
            columnas={[
              { id: "repartidor", encabezado: "Repartidor", principal: true, celda: (p) => p.nombre },
              { id: "promedio", encabezado: "Promedio", alinear: "right", className: "tabular-nums", celda: (p) => promedioTexto(p.promedio) },
              { id: "respuestas", encabezado: "Respuestas", alinear: "right", className: "tabular-nums", celda: (p) => `${p.respondidas} de ${p.enviadas}` },
              { id: "tasa", encabezado: "Tasa", alinear: "right", className: "tabular-nums", celda: (p) => formatoPct(p.tasaRespuestaPct) },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle>Comentarios recientes</CardTitle>
          <CardDescription>Texto libre de los clientes, sin su nombre ni teléfono.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<EncuestaComentario>
            etiqueta="Respuestas recientes"
            filas={datos.recientes}
            obtenerId={(c) => c.id}
            vacio={{ titulo: "Sin respuestas", mensaje: "Todavía no hay respuestas en este periodo." }}
            paginacion={false}
            columnas={[
              { id: "cuando", encabezado: "Respondida", principal: true, celda: (c) => fechaHoraEsMx(c.respondidaAt, datos.zonaHoraria) },
              { id: "calificacion", encabezado: "Calificación", celda: (c) => estrellas(c.calificacion) },
              { id: "pedido", encabezado: "Pedido", className: "tabular-nums", celda: (c) => (c.pedido === null ? "—" : `#${c.pedido}`) },
              { id: "sucursal", encabezado: "Sucursal", celda: (c) => c.sucursal },
              { id: "repartidor", encabezado: "Repartidor", celda: (c) => c.repartidor ?? "—" },
              { id: "comentario", encabezado: "Comentario", celda: (c) => c.comentario ?? "Sin comentario" },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ConfiguracionYEnvio({ apiBaseUrl, token, propertyId, fetchImpl, onCambio }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined; readonly onCambio: () => void }) {
  const [config, setConfig] = useState<Carga<EncuestaConfig>>({ estado: "cargando" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    // Al recargar tras guardar se conserva lo ya pintado: el formulario no se desmonta y mantiene su aviso de guardado.
    setConfig((previo) => (previo.estado === "listo" ? previo : { estado: "cargando" }));
    (async () => {
      try {
        const c = await fetchEncuestaConfig(fetchImpl ?? fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setConfig({ estado: "listo", datos: c });
      } catch (err) {
        if (!cancelado) setConfig(desdeError(err, "No se pudo cargar la configuración de la encuesta."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, version, fetchImpl]);

  if (config.estado === "cargando") return <EstadoCargando etiqueta="Cargando configuración…" />;
  if (config.estado === "no_disponible") return <Callout tone="info">{NO_DISPONIBLE}</Callout>;
  if (config.estado === "error") return <EstadoError mensaje={config.mensaje} onReintentar={() => setVersion((v) => v + 1)} />;
  return (
    <>
      <FormularioConfig inicial={config.datos} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} onGuardado={() => { setVersion((v) => v + 1); onCambio(); }} />
      {config.datos.activa ? <EnvioPendientes apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} fetchImpl={fetchImpl} onEnviado={onCambio} /> : null}
    </>
  );
}

function FormularioConfig({ inicial, apiBaseUrl, token, propertyId, fetchImpl, onGuardado }: { readonly inicial: EncuestaConfig; readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined; readonly onGuardado: () => void }) {
  const [activa, setActiva] = useState(inicial.activa);
  const [espera, setEspera] = useState(String(inicial.esperaMin));
  const [url, setUrl] = useState(inicial.resenasUrl ?? "");
  const [umbral, setUmbral] = useState(String(inicial.umbralResena));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState(false);

  async function guardar() {
    setError(null);
    setAviso(false);
    const e = Number(espera);
    const u = Number(umbral);
    if (!Number.isInteger(e) || e < 5 || e > 1440) return setError("La espera debe ser un entero de 5 a 1440 minutos.");
    if (!Number.isInteger(u) || u < 1 || u > 5) return setError("El umbral de reseña debe ser un entero de 1 a 5.");
    setGuardando(true);
    try {
      await guardarEncuestaConfig(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, { activa, esperaMin: e, resenasUrl: url.trim() === "" ? null : url.trim(), umbralResena: u });
      setAviso(true);
      onGuardado();
    } catch (err) {
      setError(err instanceof VozNoDisponibleError ? NO_DISPONIBLE : err instanceof Error ? err.message : "No se pudo guardar la configuración.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuración de esta sucursal</CardTitle>
        <CardDescription>Con la encuesta activa, el cliente recibe por WhatsApp una liga para calificar su entrega. Respeta la lista de bajas de WhatsApp.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch id="encuesta-activa" checked={activa} onCheckedChange={setActiva} />
          <label htmlFor="encuesta-activa" className="text-sm font-medium text-foreground">
            Enviar la encuesta después de cada entrega
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Minutos de espera tras la entrega" hint="De 5 a 1440.">
            <Input inputMode="numeric" value={espera} onChange={(e) => setEspera(e.target.value)} />
          </FormField>
          <FormField label="Liga de reseñas (https)" hint="Opcional: la de Google u otra. Se ofrece solo a quien califica alto.">
            <Input inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://g.page/r/…" />
          </FormField>
          <FormField label="Invitar a reseñar desde (estrellas)" hint="De 1 a 5.">
            <Input inputMode="numeric" value={umbral} onChange={(e) => setUmbral(e.target.value)} />
          </FormField>
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <div className="flex items-center gap-3">
          <Button onClick={guardar} loading={guardando} loadingText>
            Guardar configuración
          </Button>
          {aviso ? (
            <span role="status" className="text-xs text-primary">
              Configuración guardada.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EnvioPendientes({ apiBaseUrl, token, propertyId, fetchImpl, onEnviado }: { readonly apiBaseUrl: string; readonly token: string; readonly propertyId: string; readonly fetchImpl: typeof fetch | undefined; readonly onEnviado: () => void }) {
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<EnvioPendientesRespuesta | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function enviar() {
    setError(null);
    setResultado(null);
    setEnviando(true);
    try {
      setResultado(await enviarEncuestasPendientes(fetchImpl ?? fetch, apiBaseUrl, token, propertyId));
      onEnviado();
    } catch (err) {
      setError(err instanceof VozNoDisponibleError ? NO_DISPONIBLE : err instanceof Error ? err.message : "No se pudieron enviar las encuestas.");
    } finally {
      setEnviando(false);
    }
  }

  const omitidas = resultado ? resultado.omitidas.sin_canal_whatsapp + resultado.omitidas.telefono_invalido : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enviar encuestas pendientes</CardTitle>
        <CardDescription>
          Las encuestas se envían cuando se pulsa este botón: no hay un envío automático programado. Encola la encuesta de los pedidos de toda la organización entregados hace más de la espera configurada y hasta 48 horas, con la encuesta activa y número de WhatsApp. Cada pedido recibe una sola.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {resultado ? (
          <Callout tone={resultado.errores > 0 ? "warning" : "success"} data-testid="resultado-envio">
            {resultado.encoladas} {resultado.encoladas === 1 ? "encuesta encolada" : "encuestas encoladas"} de {resultado.candidatas} {resultado.candidatas === 1 ? "pendiente" : "pendientes"}
            {omitidas > 0 ? ` · ${omitidas} omitidas (sin número de WhatsApp o con teléfono inválido)` : ""}
            {resultado.errores > 0 ? ` · ${resultado.errores} con error (se reintentan al volver a enviar)` : ""}.
          </Callout>
        ) : null}
        <Button variant="outline" onClick={enviar} disabled={enviando}>
          <Send className="mr-2 h-4 w-4" aria-hidden />
          {enviando ? "Enviando…" : "Enviar pendientes ahora"}
        </Button>
      </CardContent>
    </Card>
  );
}
