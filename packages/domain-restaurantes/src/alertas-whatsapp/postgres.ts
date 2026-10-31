// Adaptadores reales (Postgres + outbox + campana) de las alertas de WhatsApp, migracion 103. Base sin migrar: el barrido devuelve `disponible: false`
// (SAVEPOINT + 42883/42P01/42703), nunca un 500. Las notificaciones de la campana son best-effort (`emitirNotificacion` nunca lanza).
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { Lectura } from "../autopiloto/tipos.ts";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RestaurantesRepository } from "../repository.ts";
import type { AlertaCandidata, AlertaSucursalConfig, AlertasOutboxPort, AlertasPanelPort, AlertasRepositorio, DestinatarioAlerta, MotivoDegradacion, RegistroAlerta, TipoAlerta, VentanaHorario } from "./tipos.ts";

function esBaseSinMigrar(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42501" || code === "42883" || code === "42P01" || code === "42703";
}

interface FilaCandidata {
  tipo: TipoAlerta;
  clave: string;
  entidad_id: string;
  organization_id: string;
  property_id: string;
  desde: Date | string;
  minutos: number;
}

interface FilaConfig {
  organization_id: string;
  property_id: string;
  sucursal_nombre: string | null;
  activa: boolean;
  phone_number_id_aviso: string | null;
  plantilla_nombre: string | null;
  plantilla_idioma: string;
  plantilla_aprobada: boolean;
  zona_horaria: string;
  horario: unknown;
  minutos_sin_respuesta: number;
  destinatarios: unknown;
}

export function leerDestinatarios(raw: unknown): readonly DestinatarioAlerta[] {
  if (!Array.isArray(raw)) return [];
  const out: DestinatarioAlerta[] = [];
  for (const d of raw) {
    const o = d as { telefono?: unknown; nombre?: unknown; rol?: unknown } | null;
    if (o && typeof o.telefono === "string" && o.telefono.trim() !== "") out.push({ telefono: o.telefono, ...(typeof o.nombre === "string" ? { nombre: o.nombre } : {}), ...(typeof o.rol === "string" ? { rol: o.rol } : {}) });
  }
  return out;
}

export function leerHorario(raw: unknown): readonly VentanaHorario[] | null {
  if (!Array.isArray(raw)) return null;
  const out: VentanaHorario[] = [];
  for (const v of raw) {
    const o = v as { dias?: unknown; desde?: unknown; hasta?: unknown } | null;
    if (o && Array.isArray(o.dias) && typeof o.desde === "string" && typeof o.hasta === "string") out.push({ dias: o.dias.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6), desde: o.desde, hasta: o.hasta });
  }
  return out;
}

export class PostgresAlertasRepositorio implements AlertasRepositorio {
  constructor(private readonly db: TenantDbSession) {}

  async candidatas(ahora: Date, limite: number): Promise<Lectura<readonly AlertaCandidata[]>> {
    return runWithSavepointFallback<Lectura<readonly AlertaCandidata[]>>({
      session: this.db,
      savepointName: "sp_restaurantes_alertas_candidatas",
      primary: async () => {
        const { rows } = await this.db.query<FilaCandidata>(`select * from restaurantes.alertas_candidatas($1::timestamptz, $2::integer);`, [ahora.toISOString(), limite]);
        return { disponible: true, valor: rows.map((r) => ({ tipo: r.tipo, clave: r.clave, entidadId: r.entidad_id, organizationId: r.organization_id, propertyId: r.property_id, desde: new Date(r.desde), minutos: Number(r.minutos) })) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => ({ disponible: false, valor: [] }),
    });
  }

  async leerConfig(organizationId: string, propertyId: string): Promise<AlertaSucursalConfig | null> {
    return runWithSavepointFallback<AlertaSucursalConfig | null>({
      session: this.db,
      savepointName: "sp_restaurantes_alertas_config",
      primary: async () => {
        const { rows } = await this.db.query<FilaConfig>(
          `select c.organization_id, c.property_id, p.name as sucursal_nombre, c.activa, c.phone_number_id_aviso, c.plantilla_nombre, c.plantilla_idioma, c.plantilla_aprobada,
                  c.zona_horaria, c.horario, c.minutos_sin_respuesta, c.destinatarios
             from restaurantes.alerta_sucursal_config c join core.property p on p.id = c.property_id
            where c.property_id = $1 and c.organization_id = $2;`,
          [propertyId, organizationId],
        );
        const r = rows[0];
        if (!r) return null;
        return {
          organizationId: r.organization_id,
          propertyId: r.property_id,
          sucursalNombre: r.sucursal_nombre ?? "la sucursal",
          activa: r.activa === true,
          phoneNumberIdAviso: r.phone_number_id_aviso,
          plantillaNombre: r.plantilla_nombre,
          plantillaIdioma: r.plantilla_idioma,
          plantillaAprobada: r.plantilla_aprobada === true,
          zonaHoraria: r.zona_horaria,
          horario: leerHorario(r.horario),
          minutosSinRespuesta: Number(r.minutos_sin_respuesta),
          destinatarios: leerDestinatarios(r.destinatarios),
        };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => null,
    });
  }

  async registrar(r: RegistroAlerta): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_restaurantes_alerta_registrar",
      primary: async () => {
        const { rows } = await this.db.query<{ nuevo: boolean }>(`select restaurantes.alerta_registrar($1::uuid, $2::uuid, $3, $4, $5, $6, $7) as nuevo;`, [r.organizationId, r.propertyId, r.tipo, r.clave, r.destinoHash, r.estado, r.motivo]);
        return rows[0]?.nuevo === true;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => false,
    });
  }
}

/** Cola real: el mismo outbox de WhatsApp (idempotente por `dedupeKey`); el despachador existente lo drena. */
export function crearAlertasOutbox(repo: Pick<RestaurantesRepository, "enqueueMessagingOutbox">): AlertasOutboxPort {
  return { encolar: (organizationId, dedupeKey, payload) => repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.alerta_gerente", dedupeKey, payload) };
}

/** Campana del panel (catalogo: `restaurantes.alerta.degradada` y `restaurantes.chat.sin_respuesta`). */
export function crearAlertasPanel(db: TenantDbSession): AlertasPanelPort {
  return {
    async degradada(c: AlertaCandidata, motivo: MotivoDegradacion) {
      await emitirNotificacion(db, {
        evento: "restaurantes.alerta.degradada",
        organizationId: c.organizationId,
        propertyId: c.propertyId,
        clave: `${c.propertyId}:${motivo}:${new Date().toISOString().slice(0, 10)}`,
        parametros: { motivo },
        entidadTipo: "branch",
        entidadId: c.propertyId,
      });
    },
    async sinRespuesta(c: AlertaCandidata) {
      await emitirNotificacion(db, {
        evento: "restaurantes.chat.sin_respuesta",
        organizationId: c.organizationId,
        propertyId: c.propertyId,
        clave: c.clave.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 100),
        parametros: { minutos: c.minutos },
        entidadTipo: "whatsapp_conversation",
        entidadId: c.entidadId,
      });
    },
  };
}
