// Coleccion del perfil de empresa completo (productos y servicios, ubicaciones, restricciones, socios y representantes; L-P3-03).
// UNA sola pantalla generica para las cuatro, dirigida por una definicion de campos: lista con estado de aprobacion, autoria y procedencia,
// alta y edicion (el mismo formulario), baja y aprobar/rechazar. Todo llama a la API real (companyProfile.ts): cada control hace una
// escritura real; si la base aun no tiene la migracion 040 la pestaña lo declara ("no disponible aun") y no ofrece captura.
// El servidor decide siempre (roles, autor distinto del aprobador, validaciones, suma de participaciones): aqui solo se muestra su mensaje.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, StatusBadge, statusTone } from "@atiende/ui";
import { createProfileItem, deleteProfileItem, fetchProfileCollection, updateProfileItem } from "../lib/company-profile-client.ts";
import type { ProfileCollectionName } from "../lib/company-profile-client.ts";
import type { CompanyDataApprovalStatus, CompanyDataAuthorship, CompanyItemKind } from "../lib/company-data-client.ts";
import { authorshipLine } from "../lib/company-decision.ts";
import { APROBACION_DATO_TONES } from "../lib/status-tones.ts";
import { DecisionButtons } from "./DecisionActions.tsx";
import type { useCompanyDecision } from "./DecisionActions.tsx";
import { ProcedenciaLinea } from "./ProcedenciaLinea.tsx";

const APPROVAL_LABELS: Record<CompanyDataApprovalStatus, string> = { aprobado: "Aprobado", pendiente_aprobacion: "Pendiente de aprobación", rechazado: "Rechazado" };

export interface CampoDef {
  readonly key: string;
  readonly label: string;
  readonly tipo: "texto" | "select" | "fecha";
  readonly requerido?: boolean;
  readonly opciones?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly placeholder?: string;
  /** Solo en el alta (p. ej. el tipo de socio no se cambia despues). */
  readonly soloAlta?: boolean;
  /** Oculta el campo segun el resto del formulario (p. ej. el porcentaje solo aplica a los socios). */
  readonly visible?: (form: Readonly<Record<string, string>>) => boolean;
  readonly ayuda?: string;
}

type Item = CompanyDataAuthorship & { readonly id: string; readonly approvalStatus: CompanyDataApprovalStatus };

export interface ColeccionPerfilProps {
  readonly name: ProfileCollectionName;
  readonly kind: CompanyItemKind;
  readonly titulo: string;
  readonly descripcion: string;
  readonly vacio: string;
  readonly campos: readonly CampoDef[];
  readonly resumen: (item: never) => ReactNode;
  readonly etiqueta: (item: never) => string;
  /** Nombre en singular para los botones ("Agregar ubicación"). */
  readonly singular: string;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly role: string;
  readonly userId: string | null;
  readonly canWrite: boolean;
  /** Roles que pueden dar de baja (productos y ubicaciones: escritura; restricciones y socios: decision). */
  readonly canDelete: boolean;
  readonly decision: ReturnType<typeof useCompanyDecision>;
  readonly confirmar: (opts: { titulo: string; descripcion?: string; tono?: "danger"; confirmar?: string }) => Promise<boolean>;
  /** Cambia cuando una decision o un cambio externo obliga a recargar. */
  readonly refreshKey: number;
  readonly onChanged: () => void;
  readonly busy: boolean;
}

const FILA = "flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 text-sm";

function vacioDe(campos: readonly CampoDef[]): Record<string, string> {
  return Object.fromEntries(campos.map((c) => [c.key, c.tipo === "select" ? (c.opciones?.[0]?.value ?? "") : ""]));
}

export function ColeccionPerfil(props: ColeccionPerfilProps) {
  const { name, kind, titulo, descripcion, vacio, campos, apiBaseUrl, token, propertyId, role, userId, canWrite, canDelete, decision, confirmar, refreshKey, onChanged, busy } = props;
  const [items, setItems] = useState<readonly Item[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() => vacioDe(campos));
  const [editing, setEditing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const view = await fetchProfileCollection<Item>(fetch, apiBaseUrl, token, propertyId, name);
      setItems(view.items);
      setDisponible(view.disponible);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, refreshKey]);

  function payload(esAlta: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const c of campos) {
      if (c.soloAlta && !esAlta) continue;
      if (c.visible && !c.visible(form)) continue;
      const valor = (form[c.key] ?? "").trim();
      if (valor === "") {
        // Editar: un opcional vacio se borra (null); alta: se omite.
        if (!esAlta && !c.requerido) body[c.key] = null;
        continue;
      }
      body[c.key] = valor;
    }
    return body;
  }

  async function guardar() {
    setActionError(null);
    setSubmitting(true);
    try {
      if (editing) await updateProfileItem(fetch, apiBaseUrl, token, propertyId, name, editing, payload(false));
      else await createProfileItem(fetch, apiBaseUrl, token, propertyId, name, payload(true));
      setForm(vacioDe(campos));
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setSubmitting(false);
    }
  }

  function editar(item: Item) {
    const origen = item as unknown as Record<string, unknown>;
    setForm(Object.fromEntries(campos.map((c) => [c.key, origen[c.key] === null || origen[c.key] === undefined ? "" : String(origen[c.key])])));
    setEditing(item.id);
    setActionError(null);
  }

  async function borrar(item: Item) {
    const ok = await confirmar({ titulo: `Eliminar ${props.etiqueta(item as never)}`, descripcion: "Se da de baja de la empresa y queda registrado en la bitácora. No se puede deshacer.", tono: "danger", confirmar: "Eliminar" });
    if (!ok) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await deleteProfileItem(fetch, apiBaseUrl, token, propertyId, name, item.id);
      if (editing === item.id) {
        setEditing(null);
        setForm(vacioDe(campos));
      }
      await load();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "No se pudo eliminar.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && items.length === 0) return <EstadoCargando etiqueta={`Cargando ${titulo.toLowerCase()}…`} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{titulo}</CardTitle>
        <CardDescription>{descripcion}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
        {!disponible && (
          <EstadoVacio titulo="No disponible aún" mensaje="Esta sección requiere la migración 040 en la base de datos de tu organización. En cuanto se aplique podrás capturar aquí; mientras tanto no se usa ni se inventa ningún dato." compacto />
        )}
        {disponible && !error && items.length === 0 && <EstadoVacio mensaje={vacio} compacto />}
        {disponible &&
          items.map((item) => (
            <div key={item.id} className={FILA}>
              <div className="min-w-0 text-foreground">
                {props.resumen(item as never)}
                {authorshipLine(item, userId) && <div className="text-xs text-muted-foreground">{authorshipLine(item, userId)}</div>}
                <ProcedenciaLinea item={item} userId={userId} exige />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusBadge tone={statusTone(APROBACION_DATO_TONES, item.approvalStatus)} className="whitespace-nowrap">
                  {APPROVAL_LABELS[item.approvalStatus]}
                </StatusBadge>
                <DecisionButtons kind={kind} id={item.id} etiqueta={props.etiqueta(item as never)} item={item} role={role} userId={userId} decision={decision} busy={busy || submitting} />
                {canWrite && (
                  <Button type="button" variant="outline" size="sm" disabled={busy || submitting} onClick={() => editar(item)} aria-label={`Editar ${props.etiqueta(item as never)}`}>
                    <Pencil />
                    Editar
                  </Button>
                )}
                {canDelete && (
                  <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={busy || submitting} onClick={() => void borrar(item)} aria-label={`Eliminar ${props.etiqueta(item as never)}`}>
                    <Trash2 />
                    Eliminar
                  </Button>
                )}
              </div>
            </div>
          ))}
        {disponible && canWrite && (
          <form
            className="flex flex-wrap items-end gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              void guardar();
            }}
          >
            {campos
              .filter((c) => !(c.soloAlta && editing) && (!c.visible || c.visible(form)))
              .map((c) => (
                <div key={c.key} className="flex min-w-[180px] flex-1 flex-col gap-1.5">
                  <Label htmlFor={`${name}-${c.key}`}>
                    {c.label}
                    {c.requerido ? "" : " (opcional)"}
                  </Label>
                  {c.tipo === "select" ? (
                    <NativeSelect id={`${name}-${c.key}`} value={form[c.key] ?? ""} onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}>
                      {c.opciones?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Input id={`${name}-${c.key}`} type={c.tipo === "fecha" ? "date" : "text"} required={c.requerido} placeholder={c.placeholder} value={form[c.key] ?? ""} onChange={(e) => setForm({ ...form, [c.key]: e.target.value })} />
                  )}
                  {c.ayuda && <span className="text-xs text-muted-foreground">{c.ayuda}</span>}
                </div>
              ))}
            <Button type="submit" size="sm" disabled={busy || submitting}>
              <Plus />
              {submitting ? "Guardando…" : editing ? "Guardar cambios" : `Agregar ${props.singular}`}
            </Button>
            {editing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setEditing(null);
                  setForm(vacioDe(campos));
                }}
              >
                Cancelar edición
              </Button>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
