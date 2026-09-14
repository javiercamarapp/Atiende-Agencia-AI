// Plantilla por defecto de cierre mensual — puerto EXACTO (títulos,
// categorías, `key`/`dependsOn`, `autoCheckQuery`) de
// `b2b_ai/features/monthly_close/templates.py::default_monthly_close_template`.
// Las 15 tareas son todas `required=true` (default del modelo Python, nunca
// sobreescrito en la plantilla real).
import type { CloseTemplate } from "./types.ts";

export const DEFAULT_MONTHLY_CLOSE_TEMPLATE: CloseTemplate = {
  name: "cierre_mensual",
  description: "Cierre mensual estándar de despacho contable: CFDI, conciliación bancaria, nómina, DIOT, contabilidad electrónica, declaraciones, auxiliares y reportes gerenciales.",
  tasks: [
    { key: "cfdi_verificado", title: "Verificar CFDIs del mes procesados", description: "Confirmar que todos los CFDIs emitidos/recibidos del período fueron procesados (auto-check: conteo de CFDIs pendientes = 0).", category: "cfdi", dependsOn: [], autoCheckQuery: "cfdi_pending_count", required: true },
    { title: "Validar folios fiscales y sellos", description: "Revisar que los CFDIs tengan folio fiscal válido y sellos SAT correctos.", category: "cfdi", dependsOn: ["cfdi_verificado"], autoCheckQuery: "cfdi_validacion", required: true },
    { key: "conciliacion", title: "Conciliación bancaria completada", description: "Conciliar los estados de cuenta del mes contra pólizas y CFDIs (bank_feeds).", category: "bank", dependsOn: ["cfdi_verificado"], autoCheckQuery: "bank_feeds_sync_status", required: true },
    { title: "Revisar movimientos sin conciliar", description: "Investigar transacciones bancarias que no matchearon con ningún CFDI o póliza.", category: "bank", dependsOn: ["conciliacion"], autoCheckQuery: null, required: true },
    { key: "nomina_timbrada", title: "Nóminas del mes timbradas", description: "Verificar que todas las nóminas del mes estén timbradas.", category: "nomina", dependsOn: [], autoCheckQuery: "nomina_status", required: true },
    { title: "Validar previsión social y percepciones", description: "Revisar percepciones, deducciones y exentos de nómina.", category: "nomina", dependsOn: ["nomina_timbrada"], autoCheckQuery: null, required: true },
    { key: "diot", title: "Generar DIOT del mes", description: "Generar la Declaración Informativa de Operaciones con Terceros.", category: "declaracion", dependsOn: ["cfdi_verificado"], autoCheckQuery: "diot_generada", required: true },
    { key: "declaraciones", title: "Revisar declaraciones mensuales (ISR/IVA)", description: "Revisar y validar las declaraciones mensuales de ISR e IVA antes de presentarlas.", category: "declaracion", dependsOn: ["conciliacion", "nomina_timbrada"], autoCheckQuery: "declaraciones_revisadas", required: true },
    { key: "contabilidad_elect", title: "Generar contabilidad electrónica del mes", description: "Generar balanza, pólizas y catálogo de contabilidad electrónica.", category: "electronica", dependsOn: ["conciliacion", "diot"], autoCheckQuery: "contabilidad_electronica", required: true },
    { key: "auxiliares", title: "Actualizar auxiliares contables", description: "Actualizar auxiliares por cuenta (clientes, proveedores, bancos).", category: "custom", dependsOn: ["contabilidad_elect"], autoCheckQuery: "auxiliares_actualizados", required: true },
    { key: "reportes", title: "Generar reportes gerenciales", description: "Generar estado de resultados, balance y flujo del mes.", category: "custom", dependsOn: ["auxiliares", "declaraciones"], autoCheckQuery: "reportes_gerenciales", required: true },
    { title: "Conciliar cuentas por cobrar / pagar", description: "Revisar saldos de clientes y proveedores contra auxiliares y conciliar diferencias.", category: "custom", dependsOn: ["auxiliares"], autoCheckQuery: null, required: true },
    { key: "revision_final", title: "Revisión final del contador", description: "Revisión integral del cierre por el contador responsable.", category: "custom", dependsOn: ["reportes", "contabilidad_elect", "declaraciones"], autoCheckQuery: null, required: true },
    { key: "cerrar_periodo", title: "Cerrar período y habilitar corte", description: "Cerrar oficialmente el período: bloquear cambios y habilitar el corte contable.", category: "custom", dependsOn: ["revision_final"], autoCheckQuery: null, required: true },
    { title: "Resguardar documentación del cierre", description: "Archivar y resguardar la documentación soporte del cierre en el gestor documental.", category: "custom", dependsOn: ["cerrar_periodo"], autoCheckQuery: null, required: true },
  ],
};

export function getTemplate(templateName?: string | null): CloseTemplate {
  if (!templateName || templateName === "cierre_mensual" || templateName === "default") return DEFAULT_MONTHLY_CLOSE_TEMPLATE;
  throw new Error(`Plantilla desconocida: ${templateName}`);
}
