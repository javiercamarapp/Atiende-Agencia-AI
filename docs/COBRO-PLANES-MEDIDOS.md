# Cobro por plan medido (restaurantes primero)

Migraciones: `packages/db/migrations/0103_cobro_planes_medidos.sql` (tarifa del plan) y
`packages/domain-restaurantes/migrations/203_uso_facturable.sql` (uso del mes). Espejos en `supabase/migrations/20240101000910_*` y `..._911_*`.
Verificación contra Postgres real: `scripts/verify-cobro-planes-medidos/` (la corre el gate de CI).

## Por qué

El plan sembrado en 0028 para restaurantes cobra por agente de voz y no cubre el costo medido: la voz es ~85 % del costo
y depende de los **minutos**, no del número de agentes. El precio tiene que vivir en datos, poder ser a la medida de un
cliente y medirse contra lo que de verdad se usó. **Esta migración no siembra ningún precio**: el superadmin lo captura.

## Modelo de la tarifa (`core.plan`, `modelo_cobro = 'medido'`)

| Columna | Significado |
|---|---|
| `precio_base_mxn_centavos` (de 0028) | Cuota fija mensual (sin IVA). |
| `precio_sucursal_mxn_centavos` | Precio por sucursal ACTIVA arriba de `sucursales_incluidas`. NULL = no se cobra por sucursal. |
| `minutos_voz_incluidos` + `minutos_voz_incluidos_por_sucursal` | Minutos incluidos al mes (fijos + por sucursal cubierta). |
| `precio_minuto_voz_excedente_mxn_centavos` | Precio del minuto adicional. NULL = el excedente solo se avisa. |
| `conversaciones_wa_incluidas` + `..._por_sucursal` / `precio_conversacion_wa_excedente_mxn_centavos` | Igual para WhatsApp. |
| `uso_justo_pct` | Tope de uso justo en % de lo incluido (p. ej. 150). Lo que pasa del tope **no se cobra solo**: se marca para renegociar. |
| `cuota_alta_mxn_centavos` | Cuota de alta (una vez, primera factura). |
| `tasa_iva_bp` | IVA en puntos base (1600 = 16 %). El IVA se traslada encima del subtotal. |
| `organizacion_exclusiva_id` | Plan **a la medida**: solo asignable a esa organización (trigger en `core.organization_plan`). |

Los planes existentes quedan como `por_asiento` y siguen igual.

## Unidades medidas

- **Minuto de voz**: suma de `duration_s` de `restaurantes.voice_conversation` con `canal = 'llamada'` (los previews no cuentan) que empezaron en el mes, redondeada hacia arriba sobre el total del mes.
- **Conversación de WhatsApp**: cliente distinto (`phone_hash`) con al menos un mensaje entrante procesado (`restaurantes.whatsapp_inbound_events`) por día del negocio; equivale a la ventana de 24 h de Meta.
- **Mes**: calendario en la zona horaria del negocio, igual que el medidor de mensajes de 0046.

## Cálculo

`@atiende/billing::calcularFacturaPlanMedido(tarifa, uso, { incluirCuotaAlta })` devuelve renglones (cuota fija, sucursales,
excedente de minutos, excedente de conversaciones, cuota de alta), subtotal, IVA, total y avisos (excedente sin precio, uso
justo superado). Todo en centavos enteros. Una tarifa incompleta lanza `TarifaInvalida`: nunca se factura una cifra inventada.

## API

- `GET /superadmin/planes/tarifas`: tarifa de todo el catálogo (superadmin; el rol `finanzas` también la lee).
- `PUT /superadmin/planes/:id/tarifa` (superadmin + step-up MFA): fija la tarifa; los montos van en pesos y la base guarda centavos.
  Primero se crea el plan con `PUT /superadmin/planes/:id` (nombre, vertical, cuota fija); después se le pone la tarifa.
- `GET /billing/plan-medido[?organizationId=&mes=YYYY-MM]` (miembro de la organización o superadmin): tarifa, uso del mes y
  factura **estimada**.

Base sin migrar: las lecturas responden `disponible: false` y la escritura 503; nunca 500.

## Dar de alta un plan a la medida (ejemplo de pasos, sin cifras)

1. `PUT /superadmin/planes/<id>` con `nombre`, `vertical: "restaurantes"` y `precioBaseMxn` (la cuota fija acordada).
2. `PUT /superadmin/planes/<id>/tarifa` con `modeloCobro: "medido"`, `sucursalesIncluidas`, `minutosVozIncluidos`,
   `conversacionesWaIncluidas`, los precios de excedente, `usoJustoPct`, `tasaIvaPct` y `organizacionExclusivaId`.
3. Asignarlo con el flujo de dos pasos de siempre (`POST /superadmin/planes/asignaciones` → confirmar).

## Orden de despliegue

1. Desplegar el código: contra la base vieja todo responde «no disponible» y nada cambia.
2. Aplicar `20240101000910_0103_cobro_planes_medidos.sql` y después `20240101000911_203_uso_facturable.sql` (solo aditivas).
3. Capturar los planes y tarifas desde el superadmin.

## Rollback

Las instrucciones exactas están en la cabecera de cada migración (drop de funciones, triggers y columnas). Se pierde la tarifa capturada.
