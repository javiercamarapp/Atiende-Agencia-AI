// Agentes (H-03) -- catalogo de agentes de la property (estado, presupuesto mensual, costo acumulado, kill switch),
// guardrails (topes de monto, palabras bloqueadas, horario de envio), politicas de aprobacion por accion y
// plantillas de WhatsApp versionadas con aprobacion. Consume apps/api/.../hoteles/agentes.ts. Los botones se muestran
// segun el rol (cosmetico: el servidor es la unica barrera real, 403). Contra una base sin la migracion 035 la
// pantalla avisa y no rompe (sin 500).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Bot } from "lucide-react";
import { Button, Callout, Card, CardContent, DataTable, EstadoCargando, EstadoError, Input, NativeSelect, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useConfirm } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  ACCION_LABELS,
  AGENTE_CLAVES,
  AGENT_AUTHOR_ROLES,
  AGENT_MANAGE_ROLES,
  ESTADO_AGENTE_LABELS,
  ESTADO_PLANTILLA_LABELS,
  accionPlantilla,
  actualizarAgente,
  crearPlantilla,
  fetchAgentes,
  fetchGuardrails,
  fetchPlantillas,
  fetchPoliticas,
  formatearCentavos,
  guardarGuardrails,
  guardarPolitica,
} from "../lib/agentes-client.ts";
import type { AccionAprobacion, AgenteCatalogo, AgenteClave, AgenteEstado, CatalogoAgentes, EstadoPlantilla, Guardrails, ModoPolitica, Plantilla, PlantillasResultado, Politica, PoliticasResultado } from "../lib/agentes-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const MIN_MOTIVO = 5;
const validarMotivo = (v: string) => (v.trim().length < MIN_MOTIVO ? `Escribe al menos ${MIN_MOTIVO} caracteres.` : null);

function estadoAgenteTono(e: AgenteEstado): "success" | "danger" | "warning" {
  return e === "activo" ? "success" : e === "pausado" ? "danger" : "warning";
}
function estadoPlantillaTono(e: EstadoPlantilla): "neutral" | "warning" | "success" | "danger" {
  return e === "pendiente" ? "warning" : e === "aprobada" ? "success" : e === "rechazada" ? "danger" : "neutral";
}

interface GuardrailsForm {
  maxDescuentoPct: string;
  maxReembolso: string;
  maxCargoFolio: string;
  maxDestinatarios: string;
  palabras: string;
  inicio: string;
  fin: string;
}
function formDeGuardrails(g: Guardrails): GuardrailsForm {
  return {
    maxDescuentoPct: String(g.maxDescuentoPct),
    maxReembolso: String(g.maxReembolsoCentavos / 100),
    maxCargoFolio: String(g.maxCargoFolioCentavos / 100),
    maxDestinatarios: String(g.maxDestinatariosMasivo),
    palabras: g.palabrasBloqueadas.join("\n"),
    inicio: g.ventanaEnvioInicio,
    fin: g.ventanaEnvioFin,
  };
}

export function AgentesPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [catalogo, setCatalogo] = useState<CatalogoAgentes | null>(null);
  const [guardrails, setGuardrails] = useState<Guardrails | null>(null);
  const [politicas, setPoliticas] = useState<PoliticasResultado | null>(null);
  const [plantillas, setPlantillas] = useState<PlantillasResultado | null>(null);
  const [form, setForm] = useState<GuardrailsForm | null>(null);
  const [edicion, setEdicion] = useState<{ accion: AccionAprobacion; modo: ModoPolitica; umbral: string; vigencia: string } | null>(null);
  const [nuevaPlantilla, setNuevaPlantilla] = useState({ agente: "recepcion_whatsapp" as AgenteClave, nombre: "", cuerpo: "" });
  const [tab, setTab] = useState<"agentes" | "guardrails" | "politicas" | "plantillas">("agentes");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { pedirTexto, dialogo } = useConfirm();

  const gestiona = AGENT_MANAGE_ROLES.has(role);
  const redacta = AGENT_AUTHOR_ROLES.has(role);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCatalogo(await fetchAgentes(fetch, apiBaseUrl, token, propertyId));
      const g = await fetchGuardrails(fetch, apiBaseUrl, token, propertyId);
      setGuardrails(g);
      setForm(formDeGuardrails(g));
      setPoliticas(await fetchPoliticas(fetch, apiBaseUrl, token, propertyId));
      setPlantillas(await fetchPlantillas(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo de agentes.");
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, okMessage: string) {
    setBusy(key);
    setError(null);
    setAviso(null);
    try {
      await fn();
      setAviso(okMessage);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  async function alternarAgente(a: AgenteCatalogo) {
    if (a.activo) {
      const motivo = await pedirTexto({
        titulo: `Pausar a ${a.nombre}`,
        descripcion: a.gobernado ? "El agente deja de actuar de inmediato; los casos se derivan a una persona." : "Atención: hoy ningún proceso consulta este interruptor, el agente sigue operando sin cambios.",
        tono: "danger",
        confirmar: "Pausar",
        cancelar: "Volver",
        campo: { etiqueta: "Motivo de la pausa", multilinea: true, minLength: MIN_MOTIVO, maxLength: 300, validar: validarMotivo },
      });
      if (motivo === null) return;
      await run(a.clave, () => actualizarAgente(fetch, apiBaseUrl, token, propertyId, a.clave, { activo: false, motivo }), `${a.nombre} pausado.`);
    } else {
      await run(a.clave, () => actualizarAgente(fetch, apiBaseUrl, token, propertyId, a.clave, { activo: true }), `${a.nombre} reanudado.`);
    }
  }

  async function fijarPresupuesto(a: AgenteCatalogo) {
    const texto = await pedirTexto({
      titulo: `Presupuesto mensual de ${a.nombre}`,
      descripcion: "Al llegar al tope el agente se detiene hasta el mes siguiente y los casos pasan a una persona.",
      confirmar: "Guardar",
      cancelar: "Volver",
      campo: {
        etiqueta: "Tope mensual (USD)",
        valorInicial: a.presupuestoUsd === null ? "" : String(a.presupuestoUsd),
        validar: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1_000_000 ? null : "Escribe un monto mayor a 0 y hasta 1,000,000."),
      },
    });
    if (texto === null) return;
    await run(a.clave, () => actualizarAgente(fetch, apiBaseUrl, token, propertyId, a.clave, { presupuestoUsd: Number(texto) }), "Presupuesto actualizado.");
  }

  async function guardarGuard(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const input = {
      maxDescuentoPct: Number(form.maxDescuentoPct),
      maxReembolsoCentavos: Math.round(Number(form.maxReembolso) * 100),
      maxCargoFolioCentavos: Math.round(Number(form.maxCargoFolio) * 100),
      maxDestinatariosMasivo: Math.round(Number(form.maxDestinatarios)),
      palabrasBloqueadas: form.palabras.split(/[\n,]/).map((w) => w.trim()).filter(Boolean),
      ventanaEnvioInicio: form.inicio,
      ventanaEnvioFin: form.fin,
    };
    await run("guardrails", () => guardarGuardrails(fetch, apiBaseUrl, token, propertyId, input), "Guardrails guardados.");
  }

  async function guardarPol(e: FormEvent) {
    e.preventDefault();
    if (!edicion) return;
    const auto = edicion.modo === "auto_bajo_umbral";
    const umbral = Number(edicion.umbral);
    await run(
      `pol-${edicion.accion}`,
      async () => {
        await guardarPolitica(fetch, apiBaseUrl, token, propertyId, edicion.accion, {
          modo: edicion.modo,
          vigenciaMinutos: Math.round(Number(edicion.vigencia)),
          ...(auto && edicion.accion === "descuento_tarifa" ? { umbralPorcentaje: umbral } : {}),
          ...(auto && edicion.accion !== "descuento_tarifa" ? { umbralMontoCentavos: Math.round(umbral * 100) } : {}),
        });
        setEdicion(null);
      },
      "Política guardada.",
    );
  }

  async function crearPlant(e: FormEvent) {
    e.preventDefault();
    await run("plantilla", async () => {
      await crearPlantilla(fetch, apiBaseUrl, token, propertyId, { agente: nuevaPlantilla.agente, nombre: nuevaPlantilla.nombre.trim(), cuerpo: nuevaPlantilla.cuerpo.trim() });
      setNuevaPlantilla({ ...nuevaPlantilla, nombre: "", cuerpo: "" });
    }, "Plantilla creada como borrador (nueva versión).");
  }

  async function revisarPlantilla(p: Plantilla, accion: "aprobar" | "rechazar") {
    const motivo = await pedirTexto({
      titulo: accion === "aprobar" ? "Aprobar la plantilla" : "Rechazar la plantilla",
      descripcion: `${p.nombre} · versión ${p.version}. Quien la envió a revisión no puede decidirla (salvo la dirección).`,
      tono: accion === "aprobar" ? "default" : "danger",
      confirmar: accion === "aprobar" ? "Aprobar" : "Rechazar",
      cancelar: "Volver",
      campo: { etiqueta: "Motivo", multilinea: true, minLength: MIN_MOTIVO, maxLength: 300, validar: validarMotivo },
    });
    if (motivo === null) return;
    await run(p.id, () => accionPlantilla(fetch, apiBaseUrl, token, propertyId, p.id, accion, motivo), accion === "aprobar" ? "Plantilla aprobada." : "Plantilla rechazada.");
  }

  const colAgentes: DataTableColumna<AgenteCatalogo>[] = [
    {
      id: "agente",
      encabezado: "Agente",
      principal: true,
      valorOrden: (a) => a.nombre,
      celda: (a) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{a.nombre}</span>
          <span className="text-xs text-muted-foreground">{a.descripcion}</span>
          {!a.gobernado && <span className="text-xs text-muted-foreground">Aún sin proceso que consulte su interruptor o presupuesto.</span>}
        </div>
      ),
    },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (a) => a.estado,
      celda: (a) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge tone={estadoAgenteTono(a.estado)}>{ESTADO_AGENTE_LABELS[a.estado]}</StatusBadge>
          {a.motivoPausa && <span className="text-xs text-muted-foreground">{a.motivoPausa}</span>}
        </div>
      ),
    },
    { id: "presupuesto", encabezado: "Presupuesto del mes", alinear: "right", valorOrden: (a) => a.presupuestoUsd, celda: (a) => (a.presupuestoUsd === null ? "Sin tope propio" : `US$ ${a.presupuestoUsd.toFixed(2)}`) },
    { id: "gasto", encabezado: "Costo acumulado", alinear: "right", valorOrden: (a) => a.gastoUsd, celda: (a) => `US$ ${a.gastoUsd.toFixed(4)}${a.porcentajeUso !== null ? ` (${a.porcentajeUso} %)` : ""}` },
    { id: "llamadas", encabezado: "Llamadas", alinear: "right", valorOrden: (a) => a.llamadas, celda: (a) => a.llamadas },
    {
      id: "acciones",
      encabezado: "Acciones",
      celda: (a) =>
        gestiona ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={a.activo ? "outline" : "default"} disabled={busy === a.clave} onClick={() => void alternarAgente(a)}>
              {a.activo ? "Pausar" : "Reanudar"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy === a.clave} onClick={() => void fijarPresupuesto(a)}>
              Presupuesto
            </Button>
            {a.presupuestoUsd !== null && (
              <Button type="button" size="sm" variant="ghost" disabled={busy === a.clave} onClick={() => void run(a.clave, () => actualizarAgente(fetch, apiBaseUrl, token, propertyId, a.clave, { presupuestoUsd: null }), "Tope propio quitado.")}>
                Quitar tope
              </Button>
            )}
          </div>
        ) : null,
    },
  ];

  const colPoliticas: DataTableColumna<Politica>[] = [
    { id: "accion", encabezado: "Acción", principal: true, celda: (p) => <span className="font-medium">{ACCION_LABELS[p.accion]}</span> },
    {
      id: "modo",
      encabezado: "Quién la ejecuta",
      celda: (p) =>
        p.modo === "siempre_humano"
          ? "Siempre con aprobación humana"
          : `El agente sola hasta ${p.accion === "descuento_tarifa" ? `${p.umbralPorcentaje} %` : formatearCentavos(p.umbralMontoCentavos)}`,
    },
    { id: "vigencia", encabezado: "Vigencia", alinear: "right", celda: (p) => `${p.vigenciaMinutos} min` },
    { id: "aprobadores", encabezado: "Aprueban", celda: (p) => ["owner", ...p.aprobadores.filter((r) => r !== "owner")].join(", ") },
    {
      id: "acciones",
      encabezado: "Acciones",
      celda: (p) =>
        gestiona ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setEdicion({
                accion: p.accion,
                modo: p.modo,
                umbral: p.accion === "descuento_tarifa" ? String(p.umbralPorcentaje ?? "") : p.umbralMontoCentavos === null ? "" : String(p.umbralMontoCentavos / 100),
                vigencia: String(p.vigenciaMinutos),
              })
            }
          >
            Editar
          </Button>
        ) : null,
    },
  ];

  const colPlantillas: DataTableColumna<Plantilla>[] = [
    { id: "nombre", encabezado: "Plantilla", principal: true, valorOrden: (p) => p.nombre, celda: (p) => <span className="font-medium">{p.nombre} · v{p.version}</span> },
    { id: "agente", encabezado: "Agente", valorOrden: (p) => p.agente, celda: (p) => p.agente },
    { id: "cuerpo", encabezado: "Texto", celda: (p) => <span className="text-sm line-clamp-2">{p.cuerpo}</span> },
    {
      id: "estado",
      encabezado: "Estado",
      valorOrden: (p) => p.estado,
      celda: (p) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge tone={estadoPlantillaTono(p.estado)}>{ESTADO_PLANTILLA_LABELS[p.estado]}</StatusBadge>
          {p.motivoRevision && <span className="text-xs text-muted-foreground">{p.motivoRevision}</span>}
        </div>
      ),
    },
    {
      id: "acciones",
      encabezado: "Acciones",
      celda: (p) => (
        <div className="flex flex-wrap gap-2">
          {p.estado === "borrador" && redacta && (
            <Button type="button" size="sm" disabled={busy === p.id} onClick={() => void run(p.id, () => accionPlantilla(fetch, apiBaseUrl, token, propertyId, p.id, "enviar"), "Plantilla enviada a revisión.")}>
              Enviar a revisión
            </Button>
          )}
          {p.estado === "pendiente" && gestiona && (
            <>
              <Button type="button" size="sm" disabled={busy === p.id} onClick={() => void revisarPlantilla(p, "aprobar")}>
                Aprobar
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy === p.id} onClick={() => void revisarPlantilla(p, "rechazar")}>
                Rechazar
              </Button>
            </>
          )}
          {(p.estado === "aprobada" || p.estado === "rechazada") && gestiona && (
            <Button type="button" size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void run(p.id, () => accionPlantilla(fetch, apiBaseUrl, token, propertyId, p.id, "archivar"), "Plantilla archivada.")}>
              Archivar
            </Button>
          )}
        </div>
      ),
    },
  ];

  const noDisponible = catalogo && !catalogo.disponible;
  const campo = (etiqueta: string, valor: string, set: (v: string) => void, props: Record<string, unknown> = {}) => (
    <label className="text-xs text-muted-foreground flex flex-col gap-1">
      {etiqueta}
      <Input value={valor} onChange={(e) => set(e.target.value)} className="h-11" disabled={!gestiona} {...props} />
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-display font-semibold text-foreground flex items-center gap-2">
          <Bot className="w-5 h-5" strokeWidth={1.75} />
          Agentes
        </h1>
        {catalogo?.disponible && <p className="text-sm text-muted-foreground">Mes en curso: {catalogo.mes}</p>}
      </header>

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && <p role="status" className="text-sm text-foreground">{aviso}</p>}
      {!catalogo && !error && <EstadoCargando etiqueta="Cargando agentes…" />}

      {noDisponible && (
        <Callout tone="warning" titulo="Aún no activo en esta base de datos">
          El catálogo de agentes, las aprobaciones y las plantillas se activan cuando se aplique la actualización pendiente. Mientras tanto los agentes siguen funcionando como hasta ahora.
        </Callout>
      )}

      {catalogo?.disponible && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="agentes">Agentes</TabsTrigger>
            <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
            <TabsTrigger value="politicas">Políticas</TabsTrigger>
            <TabsTrigger value="plantillas">Plantillas WhatsApp</TabsTrigger>
          </TabsList>

          <TabsContent value="agentes" className="mt-4">
            <DataTable etiqueta="Catálogo de agentes" columnas={colAgentes} filas={catalogo.agentes} obtenerId={(a) => a.clave} paginacion={false} />
          </TabsContent>

          <TabsContent value="guardrails" className="mt-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground mb-3">
                  Topes duros: una propuesta por encima queda bloqueada y no llega a ninguna persona. {guardrails && !guardrails.configurados && "Hoy rigen los valores por defecto."}
                </p>
                {form && (
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void guardarGuard(e)}>
                    {campo("Tope de descuento (%)", form.maxDescuentoPct, (v) => setForm({ ...form, maxDescuentoPct: v }), { type: "number", min: 0, max: 100, step: "any" })}
                    {campo("Tope de reembolso (MXN)", form.maxReembolso, (v) => setForm({ ...form, maxReembolso: v }), { type: "number", min: 0, step: "any" })}
                    {campo("Tope de cargo al folio (MXN)", form.maxCargoFolio, (v) => setForm({ ...form, maxCargoFolio: v }), { type: "number", min: 0, step: "any" })}
                    {campo("Tope de destinatarios por mensaje masivo", form.maxDestinatarios, (v) => setForm({ ...form, maxDestinatarios: v }), { type: "number", min: 1, step: 1 })}
                    {campo("Mensajes masivos desde", form.inicio, (v) => setForm({ ...form, inicio: v }), { type: "time" })}
                    {campo("Mensajes masivos hasta", form.fin, (v) => setForm({ ...form, fin: v }), { type: "time" })}
                    <label className="text-xs text-muted-foreground flex flex-col gap-1 sm:col-span-2">
                      Palabras o frases bloqueadas (una por línea; no distinguen mayúsculas ni acentos)
                      <Textarea value={form.palabras} onChange={(e) => setForm({ ...form, palabras: e.target.value })} rows={4} disabled={!gestiona} />
                    </label>
                    {gestiona && (
                      <div className="sm:col-span-2">
                        <Button type="submit" disabled={busy === "guardrails"}>
                          {busy === "guardrails" ? "Guardando…" : "Guardar guardrails"}
                        </Button>
                      </div>
                    )}
                  </form>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="politicas" className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Por defecto toda acción sensible exige aprobación humana, vence a las 24 h y la deciden dirección o gerencia. Solo la dirección puede permitir que el agente ejecute sola bajo un umbral, y nunca el contenido para el huésped.
            </p>
            <DataTable etiqueta="Políticas de aprobación" columnas={colPoliticas} filas={politicas?.politicas ?? []} obtenerId={(p) => p.accion} paginacion={false} estado={politicas ? undefined : "loading"} />
            {edicion && (
              <Card>
                <CardContent className="p-4">
                  <h2 className="text-sm font-semibold text-foreground mb-2">Política: {ACCION_LABELS[edicion.accion]}</h2>
                  <form className="grid gap-3 sm:grid-cols-3 items-end" onSubmit={(e) => void guardarPol(e)}>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Ejecución
                      <NativeSelect value={edicion.modo} onChange={(e) => setEdicion({ ...edicion, modo: e.target.value as ModoPolitica })}>
                        <option value="siempre_humano">Siempre con aprobación humana</option>
                        {(politicas?.accionesAutomatizables ?? []).includes(edicion.accion) && <option value="auto_bajo_umbral">El agente sola bajo un umbral</option>}
                      </NativeSelect>
                    </label>
                    {edicion.modo === "auto_bajo_umbral" && (
                      <label className="text-xs text-muted-foreground flex flex-col gap-1">
                        {edicion.accion === "descuento_tarifa" ? "Umbral (%)" : "Umbral (MXN)"}
                        <Input type="number" min={0} step="any" value={edicion.umbral} onChange={(e) => setEdicion({ ...edicion, umbral: e.target.value })} className="h-11" />
                      </label>
                    )}
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Vigencia (minutos)
                      <Input type="number" min={5} max={10080} step={1} value={edicion.vigencia} onChange={(e) => setEdicion({ ...edicion, vigencia: e.target.value })} className="h-11" />
                    </label>
                    <div className="flex gap-2 sm:col-span-3">
                      <Button type="submit" disabled={busy === `pol-${edicion.accion}`}>
                        Guardar política
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setEdicion(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="plantillas" className="mt-4 flex flex-col gap-3">
            {redacta && (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-3">El texto de una plantilla no se edita: corregirlo crea una versión nueva. Solo una versión por nombre queda aprobada y vigente.</p>
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => void crearPlant(e)}>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Agente
                      <NativeSelect value={nuevaPlantilla.agente} onChange={(e) => setNuevaPlantilla({ ...nuevaPlantilla, agente: e.target.value as AgenteClave })}>
                        {AGENTE_CLAVES.map((k) => (
                          <option key={k} value={k}>
                            {catalogo.agentes.find((a) => a.clave === k)?.nombre ?? k}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1">
                      Nombre (minúsculas y guion bajo)
                      <Input value={nuevaPlantilla.nombre} maxLength={60} onChange={(e) => setNuevaPlantilla({ ...nuevaPlantilla, nombre: e.target.value })} placeholder="bienvenida_huesped" className="h-11" />
                    </label>
                    <label className="text-xs text-muted-foreground flex flex-col gap-1 sm:col-span-2">
                      Texto
                      <Textarea value={nuevaPlantilla.cuerpo} maxLength={1024} rows={3} onChange={(e) => setNuevaPlantilla({ ...nuevaPlantilla, cuerpo: e.target.value })} />
                    </label>
                    <div className="sm:col-span-2">
                      <Button type="submit" disabled={busy === "plantilla"}>
                        Crear borrador
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}
            <DataTable etiqueta="Plantillas de WhatsApp" columnas={colPlantillas} filas={plantillas?.plantillas ?? []} obtenerId={(p) => p.id} estado={plantillas ? undefined : "loading"} vacio={{ mensaje: "Todavía no hay plantillas." }} />
          </TabsContent>
        </Tabs>
      )}
      {dialogo}
    </div>
  );
}
