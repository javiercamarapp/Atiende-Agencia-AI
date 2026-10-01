// KYC negativo 69-B del SAT (L-08): consulta de un RFC o un lote (<= 50), semaforo por situacion
// (presunto / definitivo / desvirtuado / sentencia favorable) con la fecha de publicacion del SAT, fichas
// de proveedores y competidores propios y alerta cuando un PROVEEDOR propio figura como presunto o definitivo.
//
// Honestidad: "no aparece" NO es una constancia oficial; con la base sin la migracion 031 o sin la lista
// cargada la pantalla lo dice y no pinta ningun semaforo verde. El servidor es la unica barrera (rol, RFC,
// topes); aqui los roles solo ocultan lo que el servidor rechazaria. El RFC viaja en el cuerpo, no en la URL.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, Textarea, statusTone, useConfirm } from "@atiende/ui";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import { agregarFichaKyc, consultarKyc, fetchKycBitacora, fetchKycResumen, KYC_MAX_BATCH, parseRfcsDelTexto, quitarFichaKyc } from "../lib/kyc-69b-client.ts";
import type { KycBitacoraEntrada, KycConsultaResultado, KycFicha, KycResumen, KycRol, KycSemaforoInfo } from "../lib/kyc-69b-client.ts";
import { KYC_SEMAFORO_TONES } from "../lib/status-tones.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

// Espejos cosmeticos de WRITE_ROLES / DECISION_ROLES (domain-licitaciones/roles.ts); el servidor es la unica barrera.
const WRITE_ROLES = new Set(["owner", "admin", "analyst", "writer", "reviewer"]);
const DECISION_ROLES = new Set(["owner", "admin", "analyst"]);

const ROL_TEXT: Record<KycRol, string> = { proveedor: "Proveedor", competidor: "Competidor" };
const SITUACION_TEXT: Record<string, string> = { presunto: "Presunto", desvirtuado: "Desvirtuado", definitivo: "Definitivo", sentencia_favorable: "Sentencia favorable" };

const DATE_TIME = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

function Semaforo({ info }: { readonly info: KycSemaforoInfo }) {
  return <StatusBadge tone={statusTone(KYC_SEMAFORO_TONES, info.semaforo)}>{info.etiqueta}</StatusBadge>;
}

function fechaSat(fecha: string | null): string | null {
  return fecha ? formatFechaSolo(fecha) : null;
}

export function Kyc69bPage({ apiBaseUrl, token, propertyId, role }: LicitacionesShellContext) {
  const [resumen, setResumen] = useState<KycResumen | null>(null);
  const [bitacora, setBitacora] = useState<readonly KycBitacoraEntrada[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [texto, setTexto] = useState("");
  const [resultado, setResultado] = useState<KycConsultaResultado | null>(null);
  const [rfcNuevo, setRfcNuevo] = useState("");
  const [rolNuevo, setRolNuevo] = useState<KycRol>("proveedor");
  const [nombreNuevo, setNombreNuevo] = useState("");
  const puedeEscribir = WRITE_ROLES.has(role);
  const puedeVerBitacora = DECISION_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();

  const cargar = useCallback(async () => {
    const r = await fetchKycResumen(fetch, apiBaseUrl, token, propertyId);
    setResumen(r);
    if (r.available && puedeVerBitacora) {
      try {
        const b = await fetchKycBitacora(fetch, apiBaseUrl, token, propertyId);
        setBitacora(b.consultas);
      } catch {
        setBitacora([]); // la bitacora es complementaria: sin ella solo se oculta la tarjeta
      }
    }
  }, [apiBaseUrl, token, propertyId, puedeVerBitacora]);

  useEffect(() => {
    let vivo = true;
    cargar().catch((err: unknown) => {
      if (vivo) setError(err instanceof Error ? err.message : "No se pudo cargar el KYC de proveedores.");
    });
    return () => {
      vivo = false;
    };
  }, [cargar]);

  async function ejecutar(fn: () => Promise<void>) {
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(false);
    }
  }

  const rfcsDelTexto = parseRfcsDelTexto(texto);

  function consultar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rfcsDelTexto.length === 0) return;
    if (rfcsDelTexto.length > KYC_MAX_BATCH) {
      setError(`Máximo ${KYC_MAX_BATCH} RFC por consulta (pegaste ${rfcsDelTexto.length}).`);
      return;
    }
    void ejecutar(async () => {
      setResultado(await consultarKyc(fetch, apiBaseUrl, token, propertyId, rfcsDelTexto));
      await cargar(); // la consulta queda en la bitacora de la organizacion
    });
  }

  function agregarFicha(rfc: string, rol: KycRol, nombre: string) {
    void ejecutar(async () => {
      await agregarFichaKyc(fetch, apiBaseUrl, token, propertyId, { rfc, rol, nombre });
      await cargar();
      setAviso(`${ROL_TEXT[rol]} agregado a tu cartera.`);
    });
  }

  function enviarFicha(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    agregarFicha(rfcNuevo.trim().toUpperCase(), rolNuevo, nombreNuevo.trim());
    setRfcNuevo("");
    setNombreNuevo("");
  }

  async function quitar(f: KycFicha) {
    const ok = await confirmar({
      titulo: "Quitar de tu cartera",
      descripcion: `Se quitará ${f.rfc} (${ROL_TEXT[f.rol].toLowerCase()}) de tu cartera. Las consultas ya hechas se conservan en la bitácora.`,
      tono: "danger",
      confirmar: "Quitar",
    });
    if (!ok) return;
    await ejecutar(async () => {
      await quitarFichaKyc(fetch, apiBaseUrl, token, propertyId, f.id);
      await cargar();
      setAviso("Ficha quitada.");
    });
  }

  if (!resumen && !error) return <EstadoCargando />;
  if (!resumen) return <EstadoError mensaje={error ?? "No se pudo cargar."} />;

  const fichasProveedor = resumen.fichas.filter((f) => f.rol === "proveedor");
  const fichasCompetidor = resumen.fichas.filter((f) => f.rol === "competidor");

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">KYC de proveedores y competidores</h1>
        <p className="text-sm text-muted-foreground">
          Revisa si un RFC figura en la lista del SAT de contribuyentes con operaciones presuntamente inexistentes (art. 69-B del CFF) antes de contratar un proveedor o de medirte con un competidor en ComprasMX.
        </p>
      </div>

      {!resumen.available ? (
        <Callout tone="warning" titulo="Aún no disponible">
          La lista 69-B del SAT todavía no está habilitada en este ambiente. Cuando se habilite podrás consultar RFC y ver el semáforo de tus proveedores aquí.
        </Callout>
      ) : (
        <Callout tone="info" titulo="Cómo leer el resultado">
          {resumen.lista
            ? `Lista del SAT cargada: edición ${resumen.lista.periodo} (${resumen.lista.filas.toLocaleString("es-MX")} contribuyentes). `
            : "La lista del SAT aún no está cargada en la plataforma: no se puede afirmar nada de ningún RFC. "}
          Que un RFC no aparezca no es una constancia oficial: si el contrato lo amerita, verifica en el portal del SAT. Consultar un RFC queda registrado en la bitácora de tu organización; ninguna otra organización lo ve.
        </Callout>
      )}
      {error ? <EstadoError mensaje={error} /> : null}
      {aviso ? <Callout tone="success" titulo="Listo">{aviso}</Callout> : null}

      {resumen.alertas.length > 0 ? (
        <Callout tone="danger" titulo={`Alerta: ${resumen.alertas.length === 1 ? "un proveedor tuyo figura" : `${resumen.alertas.length} proveedores tuyos figuran`} en la lista 69-B`}>
          <ul className="mt-1 space-y-1">
            {resumen.alertas.map((a) => (
              <li key={a.id}>
                <strong>{a.nombre || a.rfc}</strong> ({a.rfc}) — {SITUACION_TEXT[a.situacion ?? ""] ?? a.etiqueta}
                {a.fechaPublicacion ? `, publicado por el SAT el ${fechaSat(a.fechaPublicacion)}` : ""}. Revisa tus contratos con este proveedor antes de seguir operando.
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {resumen.available ? (
        <Card>
          <CardHeader>
            <CardTitle>Consultar RFC</CardTitle>
            <CardDescription>Pega un RFC o hasta {KYC_MAX_BATCH} separados por comas, espacios o renglones. Persona moral: 12 caracteres; persona física: 13.</CardDescription>
          </CardHeader>
          <CardContent>
            {puedeEscribir ? (
              <form className="space-y-3" onSubmit={consultar}>
                <div className="space-y-1">
                  <Label htmlFor="kyc-rfcs">RFC a consultar</Label>
                  <Textarea id="kyc-rfcs" aria-label="RFC a consultar" rows={4} placeholder="AAA010101AAA, BBBB800101XX1" value={texto} onChange={(e) => setTexto(e.target.value)} />
                  <p className="text-xs text-muted-foreground">{rfcsDelTexto.length} RFC distintos</p>
                </div>
                <Button type="submit" disabled={ocupado || rfcsDelTexto.length === 0}>
                  Consultar
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Tu rol puede ver el semáforo de la cartera, pero no hacer consultas nuevas.</p>
            )}

            {resultado ? (
              <div className="mt-4 space-y-2" role="region" aria-label="Resultado de la consulta">
                {!resultado.listaDisponible ? <Callout tone="warning" titulo="Sin lista cargada">La lista del SAT aún no está cargada: no se puede decir nada de estos RFC.</Callout> : null}
                <ul className="divide-y rounded-md border">
                  {resultado.filas.map((f) => (
                    <li key={f.rfc} className="flex flex-wrap items-start justify-between gap-2 p-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className="font-mono">{f.rfc}</span>
                          <Semaforo info={f} />
                        </p>
                        {f.nombre ? <p className="text-sm text-muted-foreground">{f.nombre}</p> : null}
                        <p className="text-sm text-muted-foreground">{f.detalle}</p>
                        {f.fechaPublicacion ? <p className="text-xs text-muted-foreground">Publicado por el SAT el {fechaSat(f.fechaPublicacion)} (edición {f.periodo}).</p> : null}
                      </div>
                      {puedeEscribir ? (
                        <div className="flex gap-2">
                          <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => agregarFicha(f.rfc, "proveedor", f.nombre ?? "")}>
                            Agregar como proveedor
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => agregarFicha(f.rfc, "competidor", f.nombre ?? "")}>
                            Agregar como competidor
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {resumen.available ? (
        <Card>
          <CardHeader>
            <CardTitle>Mi cartera</CardTitle>
            <CardDescription>Semáforo vigente de tus proveedores y competidores contra la última edición de la lista.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {resumen.fichas.length === 0 ? (
              <EstadoVacio titulo="Sin fichas" mensaje="Agrega los RFC de tus proveedores y competidores para ver su semáforo y recibir la alerta si un proveedor aparece en la lista." compacto />
            ) : (
              <>
                {[
                  { titulo: "Proveedores", fichas: fichasProveedor },
                  { titulo: "Competidores", fichas: fichasCompetidor },
                ].map((grupo) =>
                  grupo.fichas.length === 0 ? null : (
                    <div key={grupo.titulo}>
                      <h2 className="mb-1 text-sm font-semibold">{grupo.titulo}</h2>
                      <ul className="divide-y rounded-md border">
                        {grupo.fichas.map((f) => (
                          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                <span className="font-mono">{f.rfc}</span>
                                <Semaforo info={f} />
                                {f.nombre ? <span className="font-normal text-muted-foreground">{f.nombre}</span> : null}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {f.fechaPublicacion ? `${SITUACION_TEXT[f.situacion ?? ""] ?? ""} · publicado por el SAT el ${fechaSat(f.fechaPublicacion)}` : f.detalle}
                              </p>
                            </div>
                            {puedeEscribir ? (
                              <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => void quitar(f)}>
                                Quitar
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </>
            )}

            {puedeEscribir ? (
              <form className="flex flex-wrap items-end gap-2 border-t pt-4" onSubmit={enviarFicha}>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor="kyc-rfc-nuevo">RFC</Label>
                  <Input id="kyc-rfc-nuevo" aria-label="RFC de la ficha" value={rfcNuevo} onChange={(e) => setRfcNuevo(e.target.value)} maxLength={13} required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="kyc-rol-nuevo">Es</Label>
                  <NativeSelect id="kyc-rol-nuevo" aria-label="Rol de la ficha" value={rolNuevo} onChange={(e) => setRolNuevo(e.target.value as KycRol)}>
                    <option value="proveedor">Proveedor</option>
                    <option value="competidor">Competidor</option>
                  </NativeSelect>
                </div>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor="kyc-nombre-nuevo">Nombre (opcional)</Label>
                  <Input id="kyc-nombre-nuevo" aria-label="Nombre de la ficha" value={nombreNuevo} onChange={(e) => setNombreNuevo(e.target.value)} maxLength={200} />
                </div>
                <Button type="submit" disabled={ocupado || rfcNuevo.trim().length === 0}>
                  Agregar a mi cartera
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {resumen.available && puedeVerBitacora && bitacora.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Consultas recientes de tu organización</CardTitle>
            <CardDescription>Solo las ve tu organización (owner, admin y analista).</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {bitacora.slice(0, 30).map((b) => (
                <li key={b.id} className="flex justify-between gap-2">
                  <span>
                    <span className="font-mono">{b.rfc}</span> — {b.situacion ? SITUACION_TEXT[b.situacion] : b.periodo ? "No aparece" : "Sin lista"}
                  </span>
                  <span className="text-muted-foreground">{DATE_TIME.format(new Date(b.consultadoEn))}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {dialogo}
    </PageContainer>
  );
}
