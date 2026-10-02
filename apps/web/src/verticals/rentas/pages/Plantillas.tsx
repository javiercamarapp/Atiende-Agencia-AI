// Rn-24 / Rn-25 -- Plantillas de mensajes al huésped y Automatizaciones por evento.
//
// Plantillas: lista, alta y edición del texto (espejo de MENSAJERIA_ESCRITURA_ROLES) con vista previa de variables,
// y la acción "Aprobar plantilla" (solo admin_gestora, con confirmación): la aprobación del tenant es OBLIGATORIA para
// que una plantilla se pueda programar (H-056) y editar el texto la quita. Automatizaciones: por evento (pre-llegada,
// check-in, check-out, reseña) el admin_gestora elige una plantilla aprobada, las horas de offset y activa o apaga.
//
// Los mensajes automáticos NUNCA se envían solos: el cron deja borradores en Aprobaciones. El envío real requiere un
// canal conectado (Rn-16/Rn-28); la pantalla lo dice. El servidor y la RLS vuelven a exigir cada rol (los sets de aquí
// solo ocultan lo que daría 403). Contra una base sin la migración 029, "Automatizaciones" muestra "aún no disponible".
import { useCallback, useEffect, useState } from "react";
import { Info, MessageSquareText } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, StatusBadge, Textarea, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ETIQUETA_ANCLA,
  ETIQUETA_CANAL,
  ETIQUETA_EVENTO,
  ETIQUETA_IDIOMA,
  CANALES,
  EVENTOS_PLANTILLA,
  actualizarPlantilla,
  crearPlantilla,
  estadoPlantilla,
  fetchAutomatizaciones,
  fetchPlantillas,
  guardarAutomatizacion,
  vistaPrevia,
} from "../lib/plantillas-client.ts";
import type { Automatizaciones, CanalPlantilla, EventoAutomatico, EventoPlantilla, IdiomaPlantilla, Plantilla } from "../lib/plantillas-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejos web de MENSAJERIA_ESCRITURA_ROLES y MENSAJERIA_PLANTILLA_APROBACION_ROLES (packages/domain-rentas/src/roles.ts).
const ESCRITURA_ROLES: ReadonlySet<string> = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);
const APROBACION_ROLES: ReadonlySet<string> = new Set(["admin_gestora"]);

interface BorradorFormulario {
  readonly id: string | null;
  readonly evento: EventoPlantilla;
  readonly idioma: IdiomaPlantilla;
  readonly canal: CanalPlantilla | "";
  readonly cuerpo: string;
}

const FORMULARIO_NUEVO: BorradorFormulario = { id: null, evento: "pre_llegada", idioma: "es", canal: "", cuerpo: "" };

interface EdicionAutomatizacion {
  readonly plantillaId: string;
  readonly offset: string;
  readonly activo: boolean;
}

export function PlantillasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const rol = org?.rol ?? "";
  const puedeEscribir = ESCRITURA_ROLES.has(rol);
  const puedeAprobar = APROBACION_ROLES.has(rol);
  const { confirmar, dialogo } = useConfirm();

  const [plantillas, setPlantillas] = useState<readonly Plantilla[] | null>(null);
  const [auto, setAuto] = useState<Automatizaciones | null>(null);
  const [edicion, setEdicion] = useState<Readonly<Record<string, EdicionAutomatizacion>>>({});
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [formulario, setFormulario] = useState<BorradorFormulario | null>(null);
  const [errorFormulario, setErrorFormulario] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setError(null);
    (async () => {
      try {
        const [lista, automatizaciones] = await Promise.all([fetchPlantillas(fetch, apiBaseUrl, token, propertyId), fetchAutomatizaciones(fetch, apiBaseUrl, token, propertyId)]);
        if (cancelado) return;
        setPlantillas(lista);
        setAuto(automatizaciones);
        setEdicion(Object.fromEntries(automatizaciones.eventos.map((e) => [e.evento, { plantillaId: e.plantillaId ?? "", offset: String(e.offsetHoras), activo: e.activo }])));
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las plantillas.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, recarga]);

  const variables = auto?.variables ?? [];

  const ejecutar = useCallback(async (clave: string, fn: () => Promise<string>) => {
    setOcupado(clave);
    setError(null);
    setAviso(null);
    try {
      setAviso(await fn());
      setRecarga((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(null);
    }
  }, []);

  async function guardarFormulario() {
    if (!formulario) return;
    if (!formulario.cuerpo.trim()) {
      setErrorFormulario("Escribe el texto del mensaje.");
      return;
    }
    setErrorFormulario(null);
    setOcupado("formulario");
    try {
      if (formulario.id === null) {
        await crearPlantilla(fetch, apiBaseUrl, token, propertyId, { evento: formulario.evento, idioma: formulario.idioma, canal: formulario.canal === "" ? null : formulario.canal, cuerpo: formulario.cuerpo });
        setAviso("Plantilla creada. Queda pendiente de aprobación hasta que un administrador la apruebe.");
      } else {
        await actualizarPlantilla(fetch, apiBaseUrl, token, propertyId, formulario.id, { cuerpo: formulario.cuerpo });
        setAviso("Plantilla guardada. Si estaba aprobada, vuelve a quedar pendiente de aprobación.");
      }
      setFormulario(null);
      setRecarga((n) => n + 1);
    } catch (err) {
      setErrorFormulario(err instanceof Error ? err.message : "No se pudo guardar la plantilla.");
    } finally {
      setOcupado(null);
    }
  }

  async function aprobar(p: Plantilla) {
    const { texto } = vistaPrevia(p.cuerpo, variables);
    const ok = await confirmar({
      titulo: `Aprobar la plantilla «${ETIQUETA_EVENTO[p.evento]}»`,
      descripcion: (
        <>
          Una plantilla aprobada se puede programar para enviarse automáticamente (los mensajes siempre quedan en Aprobaciones antes de salir). Si la editas después, deja de estar aprobada.
          <span className="mt-2 block rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{texto}</span>
        </>
      ),
      confirmar: "Aprobar plantilla",
    });
    if (!ok) return;
    await ejecutar(`aprobar:${p.id}`, async () => {
      await actualizarPlantilla(fetch, apiBaseUrl, token, propertyId, p.id, { aprobadaPorTenant: true });
      return "Plantilla aprobada.";
    });
  }

  async function cambiarActiva(p: Plantilla) {
    await ejecutar(`activa:${p.id}`, async () => {
      await actualizarPlantilla(fetch, apiBaseUrl, token, propertyId, p.id, { activa: !p.activa });
      return p.activa ? "Plantilla desactivada." : "Plantilla activada.";
    });
  }

  async function guardarEvento(evento: EventoAutomatico) {
    const e = edicion[evento];
    if (!e || !e.plantillaId) return;
    const offsetHoras = Number(e.offset);
    if (!Number.isInteger(offsetHoras)) {
      setError("Las horas de offset deben ser un número entero.");
      return;
    }
    await ejecutar(`evento:${evento}`, async () => {
      await guardarAutomatizacion(fetch, apiBaseUrl, token, propertyId, evento, { activo: e.activo, offsetHoras, plantillaId: e.plantillaId });
      return e.activo ? `Automatización de «${ETIQUETA_EVENTO[evento]}» activada. Los mensajes llegarán a Aprobaciones.` : `Automatización de «${ETIQUETA_EVENTO[evento]}» guardada y apagada.`;
    });
  }

  const columnas: readonly DataTableColumna<Plantilla>[] = [
      { id: "evento", encabezado: "Evento", principal: true, valorOrden: (p) => ETIQUETA_EVENTO[p.evento], celda: (p) => <span className="font-medium text-foreground">{ETIQUETA_EVENTO[p.evento]}</span> },
      { id: "canal", encabezado: "Idioma y canal", ocultarEnTarjeta: false, celda: (p) => `${ETIQUETA_IDIOMA[p.idioma]} · ${p.canal ? ETIQUETA_CANAL[p.canal] : "Todos los canales"}` },
      {
        id: "estado",
        encabezado: "Estado",
        valorOrden: (p) => estadoPlantilla(p).etiqueta,
        celda: (p) => {
          const est = estadoPlantilla(p);
          return <StatusBadge tone={est.tono}>{est.etiqueta}</StatusBadge>;
        },
      },
      { id: "texto", encabezado: "Texto", celda: (p) => <span className="line-clamp-2 max-w-md text-xs text-muted-foreground">{p.cuerpo}</span> },
      {
        id: "acciones",
        encabezado: "Acciones",
        ocultarEnTarjeta: false,
        alinear: "right",
        celda: (p) => (
          <div className="flex flex-wrap justify-end gap-1.5">
            {puedeEscribir && (
              <Button type="button" size="sm" variant="outline" disabled={ocupado !== null} onClick={() => { setErrorFormulario(null); setFormulario({ id: p.id, evento: p.evento, idioma: p.idioma, canal: p.canal ?? "", cuerpo: p.cuerpo }); }}>
                Editar
              </Button>
            )}
            {puedeAprobar && !p.aprobadaPorTenant && p.activa && (
              <Button type="button" size="sm" disabled={ocupado !== null} onClick={() => void aprobar(p)}>
                {ocupado === `aprobar:${p.id}` ? "Aprobando…" : "Aprobar plantilla"}
              </Button>
            )}
            {puedeEscribir && (
              <Button type="button" size="sm" variant="ghost" disabled={ocupado !== null} onClick={() => void cambiarActiva(p)}>
                {p.activa ? "Desactivar" : "Activar"}
              </Button>
            )}
          </div>
        ),
      },
  ];

  const previaFormulario = formulario ? vistaPrevia(formulario.cuerpo, variables) : null;

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Plantillas de mensajes</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Redacta los mensajes al huésped por evento y apruébalos. Solo una plantilla aprobada puede programarse en las automatizaciones, y editar su texto le quita la aprobación.
        </p>
      </header>

      <p className="m-0 flex items-start gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Los mensajes automáticos nunca se envían solos: quedan como borradores en <strong>Aprobaciones</strong> para que una persona los revise. El envío real al huésped requiere un canal conectado (Rn-16 / Rn-28); mientras tanto el
          borrador queda pendiente. Solo las reservas de Airbnb, Vrbo y Booking generan borrador (las reservas directas no tienen hilo de mensajería).
        </span>
      </p>

      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {aviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{aviso}</p>}
      {plantillas === null && !error && <EstadoCargando lineas={4} />}

      {plantillas !== null && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">Plantillas ({plantillas.length})</CardTitle>
            {puedeEscribir && (
              <Button type="button" size="sm" disabled={ocupado !== null} onClick={() => { setErrorFormulario(null); setFormulario(FORMULARIO_NUEVO); }}>
                Nueva plantilla
              </Button>
            )}
          </CardHeader>
          <CardContent className={plantillas.length > 0 ? "p-0" : undefined}>
            <DataTable
              etiqueta="Plantillas de mensajes"
              columnas={columnas}
              filas={plantillas}
              obtenerId={(p) => p.id}
              vacio={{ titulo: "Sin plantillas", mensaje: puedeEscribir ? "Crea la primera plantilla con «Nueva plantilla»." : "Todavía no hay plantillas. Pide a un operador o administrador que cree la primera." }}
            />
          </CardContent>
        </Card>
      )}

      {auto !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Automatizaciones</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!auto.disponible ? (
              <EstadoVacio icon={MessageSquareText} titulo="Aún no disponible" mensaje="Las automatizaciones todavía no están habilitadas en esta base de datos (falta aplicar la migración 029 de rentas). Las plantillas ya se pueden redactar y aprobar." />
            ) : (
              <>
                <p className="m-0 text-xs text-muted-foreground">
                  El borrador se genera cuando llega la hora indicada (hora de la propiedad) y hasta {auto.ventanaGraciaHoras} h después; una reserva creada más tarde no recibe un mensaje ya obsoleto.
                  {!puedeAprobar && " Solo un administrador puede cambiar las automatizaciones."}
                </p>
                {auto.eventos.map((ev) => {
                  const e = edicion[ev.evento] ?? { plantillaId: "", offset: String(ev.offsetHoras), activo: false };
                  const elegibles = (plantillas ?? []).filter((p) => p.evento === ev.evento && p.aprobadaPorTenant && p.activa);
                  const offset = Number(e.offset);
                  return (
                    <div key={ev.evento} className="flex flex-col gap-2 rounded-lg border border-border p-3" data-evento={ev.evento}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{ETIQUETA_EVENTO[ev.evento]}</span>
                        <StatusBadge tone={ev.programada && ev.activo ? "success" : "neutral"}>{ev.programada && ev.activo ? "Activa" : "Apagada"}</StatusBadge>
                      </div>
                      {elegibles.length === 0 && !ev.plantillaId ? (
                        <p className="m-0 text-xs text-muted-foreground">Aprueba una plantilla de «{ETIQUETA_EVENTO[ev.evento]}» para poder activar este envío.</p>
                      ) : (
                        <div className="flex flex-wrap items-end gap-3">
                          <Label className="flex min-w-48 flex-col gap-1.5 text-xs text-foreground">
                            Plantilla aprobada
                            <NativeSelect disabled={!puedeAprobar} value={e.plantillaId} onChange={(x) => setEdicion({ ...edicion, [ev.evento]: { ...e, plantillaId: x.target.value } })}>
                              <option value="">Selecciona una plantilla…</option>
                              {elegibles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {`${ETIQUETA_IDIOMA[p.idioma]} · ${p.canal ? ETIQUETA_CANAL[p.canal] : "Todos los canales"} · ${p.cuerpo.slice(0, 40)}`}
                                </option>
                              ))}
                            </NativeSelect>
                          </Label>
                          <Label className="flex w-40 flex-col gap-1.5 text-xs text-foreground">
                            Horas respecto a {ETIQUETA_ANCLA[ev.ancla]}
                            <Input type="number" disabled={!puedeAprobar} min={auto.offsetMin} max={auto.offsetMax} step={1} value={e.offset} onChange={(x) => setEdicion({ ...edicion, [ev.evento]: { ...e, offset: x.target.value } })} />
                          </Label>
                          <Checkbox disabled={!puedeAprobar} checked={e.activo} onChange={(x) => setEdicion({ ...edicion, [ev.evento]: { ...e, activo: x.target.checked } })} label="Activa" />
                          {puedeAprobar && (
                            <Button type="button" size="sm" disabled={ocupado !== null || !e.plantillaId} onClick={() => void guardarEvento(ev.evento)}>
                              {ocupado === `evento:${ev.evento}` ? "Guardando…" : "Guardar"}
                            </Button>
                          )}
                        </div>
                      )}
                      {Number.isInteger(offset) && (
                        <p className="m-0 text-xs text-muted-foreground">
                          Se genera {offset === 0 ? "a las 00:00 de" : `${Math.abs(offset)} h ${offset < 0 ? "antes de" : "después de las 00:00 de"}`} {ETIQUETA_ANCLA[ev.ancla]}.
                        </p>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <FormDialog
        open={formulario !== null}
        onOpenChange={(abierto) => {
          if (!abierto && ocupado !== "formulario") setFormulario(null);
        }}
        titulo={formulario?.id === null ? "Nueva plantilla" : "Editar plantilla"}
        subtitulo={formulario?.id === null ? "Nace pendiente de aprobación." : "Si cambias el texto, la plantilla deja de estar aprobada."}
        anchoClase="max-w-3xl"
        onGuardar={() => void guardarFormulario()}
        guardando={ocupado === "formulario"}
        textoBotonGuardar={formulario?.id === null ? "Crear plantilla" : "Guardar cambios"}
        bloquearCierre={ocupado === "formulario"}
      >
        {formulario && previaFormulario && (
          <div className="flex flex-col gap-3">
            {errorFormulario && <EstadoError compacto mensaje={errorFormulario} />}
            <div className="flex flex-wrap gap-3">
              <Label className="flex min-w-48 flex-col gap-1.5 text-sm text-foreground">
                Evento
                <NativeSelect disabled={formulario.id !== null} value={formulario.evento} onChange={(e) => setFormulario({ ...formulario, evento: e.target.value as EventoPlantilla })}>
                  {EVENTOS_PLANTILLA.map((ev) => (
                    <option key={ev} value={ev}>
                      {ETIQUETA_EVENTO[ev]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
              <Label className="flex w-36 flex-col gap-1.5 text-sm text-foreground">
                Idioma
                <NativeSelect disabled={formulario.id !== null} value={formulario.idioma} onChange={(e) => setFormulario({ ...formulario, idioma: e.target.value as IdiomaPlantilla })}>
                  <option value="es">{ETIQUETA_IDIOMA.es}</option>
                  <option value="en">{ETIQUETA_IDIOMA.en}</option>
                </NativeSelect>
              </Label>
              <Label className="flex min-w-40 flex-col gap-1.5 text-sm text-foreground">
                Canal
                <NativeSelect disabled={formulario.id !== null} value={formulario.canal} onChange={(e) => setFormulario({ ...formulario, canal: e.target.value as CanalPlantilla | "" })}>
                  <option value="">Todos los canales</option>
                  {CANALES.map((c) => (
                    <option key={c} value={c}>
                      {ETIQUETA_CANAL[c]}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            </div>
            <Label className="flex flex-col gap-1.5 text-sm text-foreground">
              Texto del mensaje
              <Textarea value={formulario.cuerpo} maxLength={4000} rows={5} onChange={(e) => setFormulario({ ...formulario, cuerpo: e.target.value })} />
            </Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Insertar variable:</span>
              {variables.map((v) => (
                <Button key={v.nombre} type="button" size="sm" variant="outline" title={v.descripcion} onClick={() => setFormulario({ ...formulario, cuerpo: `${formulario.cuerpo}{{${v.nombre}}}` })}>
                  {`{{${v.nombre}}}`}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-2.5 py-2" aria-label="Vista previa">
              <span className="text-xs font-medium text-foreground">Vista previa (con valores de ejemplo)</span>
              <p className="m-0 whitespace-pre-wrap text-xs text-foreground">{previaFormulario.texto || "—"}</p>
              {previaFormulario.desconocidas.length > 0 && (
                <p className="m-0 text-xs text-destructive">
                  Variable desconocida: {previaFormulario.desconocidas.join(", ")}. El sistema no sabe llenarla, así que la plantilla no se podrá aprobar.
                </p>
              )}
            </div>
          </div>
        )}
      </FormDialog>
      {dialogo}
    </PageContainer>
  );
}
