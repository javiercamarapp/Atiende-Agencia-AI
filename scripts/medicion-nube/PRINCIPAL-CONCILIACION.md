# Conciliacion banco principal -> catalogo real de PM

Generado por `c3-conciliar.py --banco principal` (sin red ni LLM). Fuente: `arnes/principal.fuente.json`; corrida seca: `principal-seco.json`.

## Sucursales del catalogo destino

- `prol-montejo` (Prolongación Montejo): status=active coords=si
- `fco-montejo` (Francisco de Montejo): status=active coords=si
- `pensiones` (Pensiones): status=active coords=si
- `galerias` (Galerías): status=inactive coords=NO
- `playa` (Playa (Chicxulub)): status=inactive coords=si
- `garcia-lavin` (García Lavín (Victory Platz)): status=active coords=si
- `altabrisa` (Victory Altabrisa): status=active coords=si

## Numero de WhatsApp por escenario (sucursal_chat)

Cada escenario escribe al numero de UNA sucursal (decision del dueno, 2026-11-06). Reglas y conteo: {'R5': 12, 'R4': 33, 'R3': 5, 'R1': 1}. Sucursal cruzada (escribe a una, entrega otra):
- S-NEW-018-zona-borde-dentro: escribe a pensiones, entrega/recoge fco-montejo (R1)

## Excluidos (1 de 51; no se corren)

- **S-NEW-005-sin-domicilio**: override del fixture sucursales.garcia-lavin.acepta_domicilio=false y en el catalogo real vale true: la cuenta real no reproduce la condicion que mide el escenario

## Escenarios con adaptaciones o riesgos (11 de 51; 8 adaptaciones, 3 riesgos)

- **S-PED-013-lo-de-siempre**
  - ADAPTADO: A5 nombre «Cliente Frecuente» -> «Cliente Prueba Frecuente» (el servidor rechaza nombres genericos al crear el pedido)
- **S-NEW-001-pedido-grande-por-aprobar**
  - ADAPTADO: U1 borde > 4000 se conserva con la lista real de garcia-lavin (total 4450)
- **S-NEW-002-limite-4000-exacto**
  - ADAPTADO: U1 borde == 4000 se conserva con la lista real de garcia-lavin (total 4000)
- **S-NEW-005-sin-domicilio**
  - EXCLUIDO (no se corre): override del fixture sucursales.garcia-lavin.acepta_domicilio=false y en el catalogo real vale true: la cuenta real no reproduce la condicion que mide el escenario
- **S-NEW-007-promo-recoger-con-promos**
  - ADAPTADO: P1 la cotizacion real en fco-montejo aplica la promo automatica LUNES2X1PM (-42): total a pagar 42 vs catalogo 84; sin total fijo (el verificador acepta los renglones de cortesia)
- **S-NEW-008-promo-recoger-sin-promos**
  - ADAPTADO: P1 la cotizacion real en garcia-lavin aplica la promo automatica LUNES2X1PM (-42): total a pagar 42 vs catalogo 84; sin total fijo (el verificador acepta los renglones de cortesia)
  - RIESGO (sin adaptar): el servidor destino aplica LUNES2X1PM en garcia-lavin, sucursal SIN promos segun la regla del dueno que mide el escenario (promos solo Fco. de Montejo, Pensiones y Galerias): los datos de promociones del destino la contradicen
- **S-NEW-015-minimo-domicilio**
  - ADAPTADO: U1 borde < 200 se conserva con la lista real de garcia-lavin (total 95)
- **S-NEW-016-fuera-de-zona-cercano**
  - RIESGO (sin adaptar): buscar_sucursal_cercana real con 'Kanasín' -> no_reconocida (el escenario espera fuera_de_zona; el agente vera no_reconocida y pedira otra referencia)
- **S-NEW-017-fuera-de-zona-lejano**
  - RIESGO (sin adaptar): buscar_sucursal_cercana real con 'Umán' -> no_reconocida (el escenario espera fuera_de_zona; el agente vera no_reconocida y pedira otra referencia)
- **S-NEW-018-zona-borde-dentro**
  - ADAPTADO: A3 sucursal de domicilio pensiones -> fco-montejo (buscar_sucursal_cercana real con colonia 'Caucel': 4.8 km)
- **S-REC-004-pedido-grande-recoger**
  - ADAPTADO: U1 borde > 4000 se conserva con la lista real de altabrisa (total 5000)

## Corrida seca (herramientas reales, sin LLM)

- S-PED-001-efectivo-cambio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=524
- S-PED-002-tarjeta-terminal: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=291
- S-PED-003-orden-vs-pieza: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=697
- S-PED-004-bistec-no-suelto: colonia='None' -> -   km | cotiza=194
- S-PED-005-seis-tacos-bistec: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=388
- S-PED-006-kilo-mixto: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=1000
- S-PED-007-kilo-fuera-de-tabla: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=2250
- S-PED-008-nachos-mitad: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=494
- S-PED-009-complementos-y-notas: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=335
- S-PED-010-nombre-corregido: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=276
- S-PED-011-doble-envio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=362
- S-PED-012-rafaga: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=322
- S-PED-013-lo-de-siempre: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=262 | semilla=garcia-lavin $262 (origen $262) entregado hace 8640 min
- S-PED-014-producto-inexistente: colonia='None' -> -   km | cotiza=-
- S-PED-015-precio-subio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=232
- S-PED-016-direccion-por-referencia: colonia='Altabrisa' -> asignada altabrisa 1.1 km | cotiza=291
- S-PED-017-sucursal-por-zona-pensiones: colonia='Pensiones' -> asignada pensiones 2.4 km | cotiza=328
- S-NEW-001-pedido-grande-por-aprobar: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=4450
- S-NEW-002-limite-4000-exacto: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=4000
- S-NEW-003-sucursal-cerrada-antes-de-abrir: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-NEW-004-sucursal-cerrada-madrugada: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-NEW-006-promo-a-domicilio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-NEW-007-promo-recoger-con-promos: colonia='None' -> -   km | cotiza=42
- S-NEW-008-promo-recoger-sin-promos: colonia='None' -> -   km | cotiza=42
- S-NEW-009-propina-mencionada: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=247
- S-NEW-010-transferencia-pregunta: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=291
- S-NEW-011-ya-transferi-con-texto: colonia='None' -> -   km | cotiza=-
- S-NEW-012-ya-transferi-sin-texto: colonia='None' -> -   km | cotiza=-
- S-NEW-013-alcohol-a-domicilio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-NEW-014-alcohol-edad-ambigua: colonia='None' -> -   km | cotiza=-
- S-NEW-015-minimo-domicilio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-NEW-016-fuera-de-zona-cercano: colonia='Kanasín' -> no_reconocida None None km | cotiza=-
- S-NEW-017-fuera-de-zona-lejano: colonia='Umán' -> no_reconocida None None km | cotiza=-
- S-NEW-018-zona-borde-dentro: colonia='Caucel' -> asignada fco-montejo 4.8 km | cotiza=283
- S-REC-001-recoger-con-hora: colonia='None' -> -   km | cotiza=247
- S-REC-002-recoger-sin-hora: colonia='None' -> -   km | cotiza=675
- S-REC-003-recoger-muy-pronto: colonia='None' -> -   km | cotiza=206
- S-REC-004-pedido-grande-recoger: colonia='None' -> -   km | cotiza=5000
- S-ESC-001-cancelar: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=- | semilla=garcia-lavin $262 (origen $262) pending hace 45 min
- S-ESC-002-modificar-pedido: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=- | semilla=garcia-lavin $262 (origen $262) pending hace 4 min
- S-ESC-003-ya-salio: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=- | semilla=garcia-lavin $262 (origen $262) pending hace 25 min
- S-ESC-004-queja-faltante: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=- | semilla=garcia-lavin $262 (origen $262) entregado hace 50 min
- S-ESC-005-privacidad: colonia='None' -> -   km | cotiza=-
- S-ESC-006-factura: colonia='None' -> -   km | cotiza=-
- S-ESC-007-evento: colonia='None' -> -   km | cotiza=-
- S-ESC-008-alergia: colonia='None' -> -   km | cotiza=-
- S-ESC-009-spam: colonia='None' -> -   km | cotiza=-
- S-ESC-010-cobro-duplicado: colonia='None' -> -   km | cotiza=-
- S-ROB-001-precio-impuesto-por-cliente: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=-
- S-ROB-002-tiempo-de-entrega: colonia='Montebello' -> asignada garcia-lavin None km | cotiza=262
