// Rn-19 -- Catálogo: alta y edición de propiedades, unidades y propietarios desde el panel (hasta ahora solo el registro
// inicial creaba esas filas). Solo admin_gestora escribe (`puedeEditar` del servidor, cosmético: el servidor y la función
// SQL vuelven a exigirlo); el operador de acceso total y el contador ven el catálogo en solo lectura.
//
// Validación: zona horaria IANA y moneda MXN/USD. Cambiar la moneda de una propiedad con movimientos financieros se
// rechaza en el servidor (mezclaría monedas en sus reportes); el formulario avisa y muestra el mensaje real si ocurre.
import { useCallback, useEffect, useState } from "react";
import { Building2, Pencil, Plus, UserRound } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormDialog, Input, Label, NativeSelect, PageContainer, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { crearPropiedad, crearPropietario, crearUnidad, editarPropiedad, editarPropietario, editarUnidad, fetchCatalogo, fijarResponsableLimpieza, MONEDAS } from "../lib/catalogo-client.ts";
import { fetchAsignables } from "../lib/limpieza-client.ts";
import type { AsignableLimpieza } from "../lib/limpieza-client.ts";
import type { Catalogo, Moneda, Propietario, UnidadCatalogo } from "../lib/catalogo-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
const ZONAS_COMUNES = ["America/Mexico_City", "America/Cancun", "America/Merida", "America/Monterrey", "America/Chihuahua", "America/Mazatlan", "America/Hermosillo", "America/Tijuana", "America/Bogota", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
const ROLES_LECTURA = new Set(["admin_gestora", "operador:acceso_total", "contador"]);

type Formulario =
  | { readonly tipo: "propiedad-editar"; readonly nombre: string; readonly zonaHoraria: string; readonly moneda: Moneda }
  | { readonly tipo: "propiedad-nueva"; readonly nombre: string; readonly zonaHoraria: string; readonly moneda: Moneda }
  | { readonly tipo: "unidad"; readonly id: string | null; readonly nombre: string; readonly propietarioId: string; readonly noches: string; readonly responsableId: string; readonly responsableOriginal: string }
  | { readonly tipo: "propietario"; readonly id: string | null; readonly nombre: string; readonly email: string };

function aMoneda(valor: string | null): Moneda {
  return valor === "USD" ? "USD" : "MXN";
}

export function CatalogoPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeVer = org ? ROLES_LECTURA.has(org.rol) : false;

  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [form, setForm] = useState<Formulario | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  // Personas del equipo que pueden ser responsables de limpieza (solo quien edita el catálogo las pide; sin lista, el campo se oculta).
  const [equipo, setEquipo] = useState<readonly AsignableLimpieza[]>([]);
  const [equipoDisponible, setEquipoDisponible] = useState(false);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setError(null);
    fetchCatalogo(fetch, apiBaseUrl, token, propertyId).then(
      (c) => {
        if (!cancelado) setCatalogo(c);
      },
      (err: unknown) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeVer, recarga]);

  const puedeEditarCatalogo = catalogo?.puedeEditar === true;
  useEffect(() => {
    if (!puedeEditarCatalogo) return;
    let cancelado = false;
    fetchAsignables(fetch, apiBaseUrl, token, propertyId).then(
      (r) => {
        if (cancelado) return;
        setEquipo(r.asignables);
        setEquipoDisponible(r.disponible);
      },
      () => {
        // Sin la lista no hay a quién ofrecer como responsable: el campo se oculta (nunca un selector vacío que parezca funcional).
        if (!cancelado) setEquipoDisponible(false);
      },
    );
    return () => {
      cancelado = true;
    };
  }, [puedeEditarCatalogo, apiBaseUrl, token, propertyId]);

  const abrir = useCallback((f: Formulario) => {
    setErrorForm(null);
    setForm(f);
  }, []);

  const guardar = useCallback(async () => {
    if (!form) return;
    setErrorForm(null);
    setGuardando(true);
    try {
      if (form.tipo === "propiedad-editar") {
        await editarPropiedad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), zonaHoraria: form.zonaHoraria.trim(), moneda: form.moneda });
      } else if (form.tipo === "propiedad-nueva") {
        await crearPropiedad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), zonaHoraria: form.zonaHoraria.trim(), moneda: form.moneda });
      } else if (form.tipo === "unidad") {
        const noches = Number(form.noches);
        if (!Number.isInteger(noches) || noches < 1 || noches > 365) {
          setErrorForm("La estancia mínima debe ser un número entero de noches entre 1 y 365.");
          return;
        }
        const propietarioId = form.propietarioId === "" ? null : form.propietarioId;
        if (form.id) {
          await editarUnidad(fetch, apiBaseUrl, token, propertyId, form.id, { nombre: form.nombre.trim(), propietarioId, duracionMinimaNoches: noches });
          // Responsable de limpieza por omisión: solo si el campo se ofreció (hay lista del equipo) y cambió.
          if (equipoDisponible && form.responsableId !== form.responsableOriginal) {
            await fijarResponsableLimpieza(fetch, apiBaseUrl, token, propertyId, form.id, form.responsableId === "" ? null : form.responsableId);
          }
        } else await crearUnidad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), propietarioId, duracionMinimaNoches: noches });
      } else {
        const email = form.email.trim() === "" ? null : form.email.trim();
        if (form.id) await editarPropietario(fetch, apiBaseUrl, token, propertyId, form.id, { nombre: form.nombre.trim(), email });
        else await crearPropietario(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), email });
      }
      setForm(null);
      setAviso("Cambios guardados.");
      setRecarga((n) => n + 1);
    } catch (err) {
      // El formulario queda abierto con el mensaje real del servidor (nombre duplicado, moneda inmutable, sin permiso...).
      setErrorForm(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }, [form, apiBaseUrl, token, propertyId, equipoDisponible]);

  if (!puedeVer) {
    return (
      <PageContainer padding="none" size="sm" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Catálogo</h1>
        <p className="m-0 text-sm text-muted-foreground">Tu rol actual{org ? ` (${org.rol})` : ""} no tiene acceso al catálogo de propiedades, unidades y propietarios.</p>
      </PageContainer>
    );
  }

  const puedeEditar = catalogo?.puedeEditar === true;
  const propiedad = catalogo?.propiedad ?? null;
  const propietarios = catalogo?.propietarios ?? [];
  const unidades = catalogo?.unidades ?? [];

  function editarUnidadForm(u: UnidadCatalogo) {
    abrir({ tipo: "unidad", id: u.id, nombre: u.nombre, propietarioId: u.propietarioId ?? "", noches: String(u.duracionMinimaNoches), responsableId: u.responsableLimpiezaId ?? "", responsableOriginal: u.responsableLimpiezaId ?? "" });
  }
  function editarPropietarioForm(p: Propietario) {
    abrir({ tipo: "propietario", id: p.id, nombre: p.nombre, email: p.email ?? "" });
  }

  const titulos: Record<Formulario["tipo"], string> = {
    "propiedad-editar": "Editar la propiedad",
    "propiedad-nueva": "Nueva propiedad",
    unidad: form?.tipo === "unidad" && form.id ? "Editar la unidad" : "Nueva unidad",
    propietario: form?.tipo === "propietario" && form.id ? "Editar el propietario" : "Nuevo propietario",
  };

  return (
    <PageContainer padding="none" size="md" className="gap-6 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Catálogo</h1>
        <p className="m-0 text-sm text-muted-foreground">
          Propiedades, unidades y propietarios de tu gestora.
          {catalogo && !puedeEditar && " Tu rol es de solo lectura: solo la administradora de la gestora puede crear o editar."}
        </p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {aviso && (
        <p role="status" className="m-0 text-sm text-success">
          {aviso}
        </p>
      )}
      {!catalogo && !error && <EstadoCargando etiqueta="Cargando catálogo…" />}

      {catalogo && (
        <>
          <Card>
            <CardHeader className="gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="h-4 w-4" strokeWidth={1.75} /> Propiedad
                </CardTitle>
                {puedeEditar && (
                  <div className="flex flex-wrap gap-2">
                    {propiedad && (
                      <Button type="button" size="sm" variant="outline" onClick={() => abrir({ tipo: "propiedad-editar", nombre: propiedad.nombre, zonaHoraria: propiedad.zonaHoraria ?? "America/Mexico_City", moneda: aMoneda(propiedad.moneda) })}>
                        <Pencil /> Editar
                      </Button>
                    )}
                    <Button type="button" size="sm" onClick={() => abrir({ tipo: "propiedad-nueva", nombre: "", zonaHoraria: "America/Mexico_City", moneda: "MXN" })}>
                      <Plus /> Nueva propiedad
                    </Button>
                  </div>
                )}
              </div>
              <CardDescription>La zona horaria define el "hoy" del calendario y la moneda es la de sus reportes.</CardDescription>
            </CardHeader>
            <CardContent>
              {propiedad ? (
                <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Nombre</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.nombre}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Zona horaria</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.zonaHoraria ?? "Sin configurar"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Moneda</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.moneda ?? "Sin configurar"}</dd>
                  </div>
                </dl>
              ) : (
                <EstadoVacio mensaje="No se encontró la configuración de esta propiedad." />
              )}
              {catalogo.propiedades.length > 1 && (
                <p className="m-0 mt-3 text-xs text-muted-foreground">
                  Tu organización tiene {catalogo.propiedades.length} propiedades: {catalogo.propiedades.map((p) => p.nombre).join(", ")}. Cámbiala con el selector de propiedad.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Unidades de esta propiedad</CardTitle>
                {puedeEditar && (
                  <Button type="button" size="sm" onClick={() => abrir({ tipo: "unidad", id: null, nombre: "", propietarioId: "", noches: "1", responsableId: "", responsableOriginal: "" })}>
                    <Plus /> Nueva unidad
                  </Button>
                )}
              </div>
              <CardDescription>Cada unidad es lo que se renta: el calendario, los precios y la limpieza cuelgan de ella.</CardDescription>
            </CardHeader>
            <CardContent>
              {unidades.length === 0 ? (
                <EstadoVacio mensaje="Esta propiedad todavía no tiene unidades." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nombre</TableHead>
                      <TableHead>Propietario</TableHead>
                      <TableHead>Estancia mínima</TableHead>
                      {equipoDisponible && <TableHead>Responsable de limpieza</TableHead>}
                      {puedeEditar && <TableHead className="text-right">Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unidades.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.nombre}</TableCell>
                        <TableCell>{u.propietarioNombre ?? <span className="text-muted-foreground">Sin propietario</span>}</TableCell>
                        <TableCell>{u.duracionMinimaNoches} {u.duracionMinimaNoches === 1 ? "noche" : "noches"}</TableCell>
                        {equipoDisponible && (
                          <TableCell>{u.responsableLimpiezaId ? (equipo.find((p) => p.id === u.responsableLimpiezaId)?.nombre || "Persona asignada") : <span className="text-muted-foreground">Sin asignar</span>}</TableCell>
                        )}
                        {puedeEditar && (
                          <TableCell className="text-right">
                            <Button type="button" size="sm" variant="outline" aria-label={`Editar la unidad ${u.nombre}`} onClick={() => editarUnidadForm(u)}>
                              <Pencil /> Editar
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <UserRound className="h-4 w-4" strokeWidth={1.75} /> Propietarios
                </CardTitle>
                {puedeEditar && (
                  <Button type="button" size="sm" onClick={() => abrir({ tipo: "propietario", id: null, nombre: "", email: "" })}>
                    <Plus /> Nuevo propietario
                  </Button>
                )}
              </div>
              <CardDescription>Los dueños de los inmuebles que administras. Reciben sus statements y acceden a su portal con el correo que registres.</CardDescription>
            </CardHeader>
            <CardContent>
              {propietarios.length === 0 ? (
                <EstadoVacio mensaje="Todavía no hay propietarios registrados." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nombre</TableHead>
                      <TableHead>Correo</TableHead>
                      {puedeEditar && <TableHead className="text-right">Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {propietarios.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.nombre}</TableCell>
                        <TableCell>{p.email ?? <span className="text-muted-foreground">Sin correo</span>}</TableCell>
                        {puedeEditar && (
                          <TableCell className="text-right">
                            <Button type="button" size="sm" variant="outline" aria-label={`Editar al propietario ${p.nombre}`} onClick={() => editarPropietarioForm(p)}>
                              <Pencil /> Editar
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <FormDialog
        open={form !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setForm(null);
        }}
        titulo={form ? titulos[form.tipo] : ""}
        anchoClase="max-w-2xl"
        onGuardar={() => void guardar()}
        guardando={guardando}
        textoBotonGuardar="Guardar"
      >
        {form && (form.tipo === "propiedad-editar" || form.tipo === "propiedad-nueva") && (
          <div className="flex flex-col gap-3">
            <Label className={LABEL_CLASES}>
              Nombre
              <Input value={form.nombre} maxLength={120} required onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </Label>
            <Label className={LABEL_CLASES}>
              Zona horaria (IANA)
              <Input list="rentas-zonas-horarias" value={form.zonaHoraria} placeholder="America/Mexico_City" required onChange={(e) => setForm({ ...form, zonaHoraria: e.target.value })} />
              <datalist id="rentas-zonas-horarias">
                {ZONAS_COMUNES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Label>
            <Label className={LABEL_CLASES}>
              Moneda
              <NativeSelect value={form.moneda} onChange={(e) => setForm({ ...form, moneda: aMoneda(e.target.value) })}>
                {MONEDAS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            {form.tipo === "propiedad-editar" && <p className="m-0 text-xs text-muted-foreground">Una propiedad con movimientos financieros ya registrados no puede cambiar de moneda.</p>}
            {errorForm && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {errorForm}
              </p>
            )}
          </div>
        )}
        {form && form.tipo === "unidad" && (
          <div className="flex flex-col gap-3">
            <Label className={LABEL_CLASES}>
              Nombre de la unidad
              <Input value={form.nombre} maxLength={120} required onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </Label>
            <Label className={LABEL_CLASES}>
              Propietario
              <NativeSelect value={form.propietarioId} onChange={(e) => setForm({ ...form, propietarioId: e.target.value })}>
                <option value="">Sin propietario</option>
                {propietarios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={LABEL_CLASES}>
              Estancia mínima (noches)
              <Input type="number" inputMode="numeric" value={form.noches} onChange={(e) => setForm({ ...form, noches: e.target.value })} />
            </Label>
            {form.id && equipoDisponible && (
              <Label className={LABEL_CLASES}>
                Responsable de limpieza por omisión
                <NativeSelect value={form.responsableId} onChange={(e) => setForm({ ...form, responsableId: e.target.value })}>
                  <option value="">Sin responsable (cola «Sin asignar»)</option>
                  {equipo.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre || "Persona sin nombre"}
                    </option>
                  ))}
                </NativeSelect>
                <span className="text-xs text-muted-foreground">La tarea de limpieza de cada salida de esta unidad nace asignada a esta persona.</span>
              </Label>
            )}
            {errorForm && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {errorForm}
              </p>
            )}
          </div>
        )}
        {form && form.tipo === "propietario" && (
          <div className="flex flex-col gap-3">
            <Label className={LABEL_CLASES}>
              Nombre
              <Input value={form.nombre} maxLength={120} required onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
            </Label>
            <Label className={LABEL_CLASES}>
              Correo (opcional)
              <Input type="email" value={form.email} maxLength={200} placeholder="propietario@ejemplo.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Label>
            {errorForm && (
              <p role="alert" className="m-0 text-sm text-destructive">
                {errorForm}
              </p>
            )}
          </div>
        )}
      </FormDialog>
    </PageContainer>
  );
}
