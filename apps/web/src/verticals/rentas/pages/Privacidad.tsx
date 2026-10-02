// Rn-07 -- Privacidad: solicitudes de derechos ARCO (acceso, rectificación, cancelación, oposición) de rentas. Los titulares
// (huéspedes, propietarios) las piden por correo, teléfono o en persona; el admin de la gestora las REGISTRA aquí y las mueve de
// estado (el servidor y la RLS de la migración 028 exigen el rol admin_gestora; este gate es UX). Los plazos (20 + 15 días de
// calendario) los calcula la base. Contra una base sin la migración 028 muestra "aún no disponible". Documentación operativa,
// no asesoría legal. La vista consolidada de todos los verticales vive en /rentas/:orgSlug/privacidad-organizacion.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label, NativeSelect, PageContainer, SolicitudesArcoPanel, SOLICITUD_ARCO_DERECHO_LABEL, SOLICITUD_ARCO_ESTADO_LABEL, Textarea } from "@atiende/ui";
import type { SolicitudArcoAccion, SolicitudArcoDerecho, SolicitudArcoEstado, SolicitudArcoVista } from "@atiende/ui";
import { cambiarEstadoSolicitudArco, ETIQUETA_CANAL_ARCO, fetchSolicitudesArco, registrarSolicitudArco } from "../lib/privacidad-client.ts";
import type { ArcoCanal, ArcoDerecho, ArcoEstado, SolicitudArco } from "../lib/privacidad-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

// Espejo web de PRIVACIDAD_ROLES (packages/domain-rentas/src/roles.ts).
const PRIVACIDAD_ROLES = new Set(["admin_gestora"]);
const PAGE_SIZE = 25;
const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
const ESTADOS_FILTRO: readonly ArcoEstado[] = ["recibida", "en_proceso", "bloqueada", "resuelta", "rechazada"];
const FORM_VACIO = { derecho: "acceso" as ArcoDerecho, canal: "correo" as ArcoCanal, solicitanteNombre: "", solicitanteContacto: "", detalle: "", recibidaEn: "" };

/** Vista del panel compartido: el "titular" muestra nombre, contacto y canal (la solicitud se registra a mano, no llega por WhatsApp). */
function aVista(s: SolicitudArco): SolicitudArcoVista {
  return {
    id: s.id,
    folio: s.folio,
    telefono: `${s.solicitanteNombre} · ${s.solicitanteContacto} · ${ETIQUETA_CANAL_ARCO[s.canal]}`,
    derecho: s.derecho,
    estado: s.estado,
    plazo: s.plazo === "cerrada" ? null : s.plazo,
    solicitadaEn: s.recibidaEn,
    respuestaVenceEn: s.respuestaVenceEn,
    ejecucionVenceEn: s.ejecucionVenceEn,
    notaResolucion: s.notaResolucion,
  };
}

export function PrivacidadPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puede = org ? PRIVACIDAD_ROLES.has(org.rol) : false;
  const [estado, setEstado] = useState<ArcoEstado | "">("");
  const [derecho, setDerecho] = useState<ArcoDerecho | "">("");
  const [items, setItems] = useState<readonly SolicitudArco[] | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [plazos, setPlazos] = useState({ respuestaDias: 20, ejecucionDias: 15 });
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [form, setForm] = useState(FORM_VACIO);
  const [enviando, setEnviando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Una respuesta vieja nunca se anexa a una lista que ya no corresponde a los filtros vigentes.
  const generacionRef = useRef(0);

  useEffect(() => {
    if (!puede) return;
    let cancelado = false;
    generacionRef.current += 1;
    setItems(null);
    setError(null);
    (async () => {
      try {
        const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: 0 });
        if (cancelado) return;
        setDisponible(pagina.disponible);
        setItems(pagina.items);
        setTotal(pagina.total);
        setNextOffset(pagina.nextOffset);
        setPlazos(pagina.plazos);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes ARCO.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, estado, derecho, puede, recarga]);

  async function cargarMas() {
    if (nextOffset === null || cargandoMas) return;
    const generacion = generacionRef.current;
    setCargandoMas(true);
    try {
      const pagina = await fetchSolicitudesArco(fetch, apiBaseUrl, token, propertyId, { estado: estado || null, derecho: derecho || null, limit: PAGE_SIZE, offset: nextOffset });
      if (generacion !== generacionRef.current) return;
      setItems((actual) => [...(actual ?? []), ...pagina.items]);
      setNextOffset(pagina.nextOffset);
    } catch (err) {
      if (generacion === generacionRef.current) setError(err instanceof Error ? err.message : "No se pudo cargar más.");
    } finally {
      setCargandoMas(false);
    }
  }

  async function cambiarEstado(id: string, accion: SolicitudArcoAccion, nota: string | null) {
    // El error se propaga al panel (lo muestra junto a la fila). Recarga completa: el plazo lo calcula el servidor.
    await cambiarEstadoSolicitudArco(fetch, apiBaseUrl, token, propertyId, id, accion, nota);
    setRecarga((n) => n + 1);
  }

  async function registrar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErrorForm(null);
    setAviso(null);
    try {
      const r = await registrarSolicitudArco(fetch, apiBaseUrl, token, propertyId, {
        derecho: form.derecho,
        canal: form.canal,
        solicitanteNombre: form.solicitanteNombre.trim(),
        solicitanteContacto: form.solicitanteContacto.trim(),
        detalle: form.detalle.trim() === "" ? null : form.detalle.trim(),
        recibidaEn: form.recibidaEn === "" ? null : new Date(form.recibidaEn).toISOString(),
      });
      setAviso(r.creada ? `Solicitud registrada (${r.folio}).` : `Ya existía una solicitud abierta de este titular para ese derecho (${r.folio}).`);
      setForm(FORM_VACIO);
      setRecarga((n) => n + 1);
    } catch (err) {
      setErrorForm(err instanceof Error ? err.message : "No se pudo registrar la solicitud.");
    } finally {
      setEnviando(false);
    }
  }

  const encabezado = (
    <header>
      <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Privacidad</h1>
      <p className="m-0 text-sm text-muted-foreground">
        Solicitudes de derechos ARCO (acceso, rectificación, cancelación y oposición) de huéspedes y propietarios. Regístralas cuando lleguen por correo, teléfono o en persona; los plazos corren desde la fecha de recepción. Los datos personales de la
        solicitud solo los ve el admin de la gestora.
      </p>
      <p className="m-0 mt-1 text-xs text-muted-foreground">Los plazos son una referencia operativa, no asesoría legal: valida tu aviso de privacidad y tu procedimiento con tu asesor jurídico.</p>
    </header>
  );

  if (!puede) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        {encabezado}
        <p className="m-0 text-sm text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso a esta sección. Rol con acceso: <strong className="text-foreground">admin_gestora</strong>.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="lg" className="gap-5 [&>*]:min-w-0">
      {encabezado}

      {disponible && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Registrar una solicitud</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={(e) => void registrar(e)}>
              <div className="flex flex-wrap gap-3">
                <Label className={`${LABEL_CLASES} min-w-[180px]`}>
                  Derecho
                  <NativeSelect value={form.derecho} onChange={(e) => setForm({ ...form, derecho: e.target.value as ArcoDerecho })}>
                    {(Object.keys(SOLICITUD_ARCO_DERECHO_LABEL) as SolicitudArcoDerecho[]).map((d) => (
                      <option key={d} value={d}>
                        {SOLICITUD_ARCO_DERECHO_LABEL[d]}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <Label className={`${LABEL_CLASES} min-w-[160px]`}>
                  Canal por el que llegó
                  <NativeSelect value={form.canal} onChange={(e) => setForm({ ...form, canal: e.target.value as ArcoCanal })}>
                    {(Object.keys(ETIQUETA_CANAL_ARCO) as ArcoCanal[]).map((c) => (
                      <option key={c} value={c}>
                        {ETIQUETA_CANAL_ARCO[c]}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <Label className={`${LABEL_CLASES} min-w-[200px]`}>
                  Fecha de recepción (opcional)
                  <Input type="datetime-local" value={form.recibidaEn} onChange={(e) => setForm({ ...form, recibidaEn: e.target.value })} />
                </Label>
              </div>
              <div className="flex flex-wrap gap-3">
                <Label className={`${LABEL_CLASES} min-w-[220px] flex-1`}>
                  Nombre del titular
                  <Input value={form.solicitanteNombre} maxLength={120} required onChange={(e) => setForm({ ...form, solicitanteNombre: e.target.value })} />
                </Label>
                <Label className={`${LABEL_CLASES} min-w-[220px] flex-1`}>
                  Correo o teléfono de contacto
                  <Input value={form.solicitanteContacto} maxLength={160} required onChange={(e) => setForm({ ...form, solicitanteContacto: e.target.value })} />
                </Label>
              </div>
              <Label className={LABEL_CLASES}>
                Detalle (opcional, sin datos sensibles)
                <Textarea value={form.detalle} maxLength={500} rows={2} onChange={(e) => setForm({ ...form, detalle: e.target.value })} />
              </Label>
              {errorForm && (
                <p role="alert" className="m-0 text-xs text-destructive">
                  {errorForm}
                </p>
              )}
              {aviso && <p className="m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground">{aviso}</p>}
              <div>
                <Button type="submit" size="sm" disabled={enviando || form.solicitanteNombre.trim() === "" || form.solicitanteContacto.trim() === ""}>
                  {enviando ? "Registrando…" : "Registrar solicitud"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Filtros</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          <Label className={`${LABEL_CLASES} min-w-[200px]`}>
            Estado
            <NativeSelect value={estado} onChange={(e) => setEstado(e.target.value as ArcoEstado | "")}>
              <option value="">Todos</option>
              {ESTADOS_FILTRO.map((e) => (
                <option key={e} value={e}>
                  {SOLICITUD_ARCO_ESTADO_LABEL[e as SolicitudArcoEstado]}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label className={`${LABEL_CLASES} min-w-[180px]`}>
            Derecho
            <NativeSelect value={derecho} onChange={(e) => setDerecho(e.target.value as ArcoDerecho | "")}>
              <option value="">Todos</option>
              {(Object.keys(SOLICITUD_ARCO_DERECHO_LABEL) as SolicitudArcoDerecho[]).map((d) => (
                <option key={d} value={d}>
                  {SOLICITUD_ARCO_DERECHO_LABEL[d]}
                </option>
              ))}
            </NativeSelect>
          </Label>
        </CardContent>
      </Card>

      {error && (
        <EstadoError
          mensaje={error}
          onReintentar={() => {
            setError(null);
            setRecarga((n) => n + 1);
          }}
        />
      )}
      {!error && items === null && <EstadoCargando lineas={4} />}
      {!error && items !== null && (
        <SolicitudesArcoPanel
          solicitudes={items.map(aVista)}
          disponible={disponible}
          puedeGestionar
          respuestaDias={plazos.respuestaDias}
          ejecucionDias={plazos.ejecucionDias}
          onCambiarEstado={cambiarEstado}
          mensajeNoDisponible="Las solicitudes ARCO de rentas todavía no están habilitadas en esta base de datos (falta aplicar la migración 028). Cuando se habiliten podrás registrarlas y darles seguimiento aquí."
        />
      )}
      {!error && items !== null && disponible && items.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" />
            {items.length} de {total}
          </span>
          {nextOffset !== null && (
            <Button type="button" variant="outline" size="sm" onClick={() => void cargarMas()} disabled={cargandoMas}>
              {cargandoMas ? "Cargando…" : "Cargar más"}
            </Button>
          )}
        </div>
      )}
    </PageContainer>
  );
}
