// Corpus etiquetado POR RAIZ del detector ARCO (regla de la casa para guardas regex): cada raiz de `RAICES_ARCO` lleva frases que DEBE detectar (`pos`) y frases
// "casi iguales" de restaurante que NO deben disparar NADA (`neg`, el detector completo debe devolver null). Una raiz sin entrada aqui hace fallar la prueba.
export interface CasosDeRaiz {
  readonly pos: readonly string[];
  readonly neg: readonly string[];
}

export const CASOS_POR_RAIZ: Readonly<Record<string, CasosDeRaiz>> = {
  "cancelacion.suprimir-mis-datos": {
    pos: ["borren mi telefono", "elimina mi correo de su sistema", "quiero que supriman mi nombre y mi apellido", "borra mi direccion de sus registros"],
    neg: ["borra mi nombre del pedido", "elimina mi direccion de la orden", "borren la cebolla y mi pedido", "borra el telefono del repartidor", "quiero eliminar el numero 4 de mi orden"],
  },
  "cancelacion.suprimir-mis-datos-generales": {
    pos: ["borren mis datos", "elimina toda mi informacion", "destruyan mi historial", "suprime mi perfil"],
    neg: ["borra los datos de la tarjeta de la orden", "elimina la informacion del menu", "borra el historial del chat", "puedes borrar la info de las promos"],
  },
  "cancelacion.mis-datos-y-luego-borren": {
    pos: ["mis datos, borrenlos", "mi telefono por favor eliminenlo", "mis datos personales que los borren", "mi info ya borrenla"],
    neg: ["mi nombre es Juan, borra la cebolla", "mi direccion es calle 5, elimina el refresco", "mis tacos que los borren del pedido", "mi pedido, borra la salsa"],
  },
  "cancelacion.dar-de-baja-mis-datos": {
    pos: ["quiero dar de baja mis datos", "den de baja mi numero", "dieran de baja mi correo"],
    neg: ["den de baja la orden de alitas", "dar de baja el combo 2 del menu", "dame de baja el volumen"],
  },
  "cancelacion.suprimir-todo-lo-mio": {
    pos: ["borren todo lo mio", "eliminen lo mio de su sistema", "supriman todos mis datos"],
    neg: ["borra todo el pedido", "elimina todo lo que lleve picante", "borra todo y empezamos"],
  },
  "cancelacion.mi-dato-ya-no-este-en-su-base": {
    pos: ["quiero que mi numero ya no este en su base", "que mi correo no siga en sus registros", "mi telefono ya no figure en sus listas"],
    neg: ["mi pedido ya no este en la lista de espera", "mi mesa ya no esta en su lista", "mi orden no aparece en su sistema de cobro"],
  },
  "cancelacion.salirme-de-la-lista": {
    pos: ["quiero salirme de la lista de promos", "salirme de su lista", "me salgo del grupo de promociones"],
    neg: ["salir de la fila del drive", "quiero salirme de la mesa un momento", "salir de dudas"],
  },
  "cancelacion.ya-no-ser-cliente": {
    pos: ["ya no quiero ser su cliente", "no deseo ser cliente de ustedes"],
    neg: ["quiero ser cliente frecuente", "como puedo ser su cliente vip"],
  },
  "oposicion.basta-de-mensajes": {
    pos: ["ya basta de mensajes", "basta de publicidad", "basta de promociones"],
    neg: ["basta de picante, gracias", "ya basta de esperar", "basta con dos tacos"],
  },
  "oposicion.no-vuelvan-a-mandar-nada": {
    pos: ["no vuelvan a mandarme nada", "no me vuelvan a enviar mensajes", "no me manden nada"],
    neg: ["no vuelvan a mandarme el refresco tibio", "no me mandaron nada de salsa", "no vuelvan a enviarme la cuenta separada"],
  },
  "oposicion.ya-no-me-las-manden": {
    pos: ["no me interesan sus promociones, ya no me las manden", "las ofertas ya no me las envien", "mensajes ya no me los manden"],
    neg: ["las salsas ya no me las manden", "ya no me las manden picosas, las quiero suaves"],
  },
  "oposicion.no-me-agreguen": {
    pos: ["no me agreguen a sus listas", "no me incluyan en el grupo de promociones", "no me suscriban a su boletin"],
    neg: ["no me agreguen cebolla", "no me anoten en la lista de espera de la terraza", "no me incluyan el postre"],
  },
  "oposicion.no-autorizo-publicidad": {
    pos: ["no autorizo publicidad", "no mas promociones", "no deseo mercadotecnia", "sin publicidad por favor"],
    neg: ["no autorizo cargos extra", "no autorizo mas cargos en mi tarjeta", "sin picante por favor"],
  },
  "acceso.a-quien-pasan-mis-datos": {
    pos: ["a quien le pasan mis datos", "venden mis datos?", "comparten mi informacion con alguien", "a quienes entregan mi telefono"],
    neg: ["a quien le pasan la comanda", "venden tamales", "comparten mesa con otros clientes"],
  },
  "acceso.cuanto-tiempo-guardan": {
    pos: ["cuanto tiempo guardan mis datos", "cuanto tiempo conservan mi informacion"],
    neg: ["cuanto tiempo guardan la reservacion", "cuanto tiempo tienen mi mesa apartada"],
  },
  "acceso.para-que-quieren-mis-datos": {
    pos: ["para que quieren mis datos", "para que necesitan mi numero", "que hacen con la informacion que les doy"],
    neg: ["para que quieren la direccion exacta del restaurante", "que hacen con el sobrante de comida", "para que necesitan el nombre del pedido"],
  },
  "rectificacion.mi-dato-es-otro-actualicen": {
    pos: ["mi numero de telefono es otro, actualicenlo", "mi correo cambio, registren el nuevo"],
    neg: ["mi numero de pedido es otro", "mi telefono es otro, el pedido es para llevar", "mi nombre es otro en la reservacion"],
  },
  "cancelacion.suprimir-el-dato-que-tienen": {
    pos: ["borren el telefono que tienen registrado", "eliminen la direccion que tienen guardada", "supriman los datos que guardan"],
    neg: ["borra el refresco que pedi", "elimina la direccion que te di para el envio", "borra el postre que tienen en la lista"],
  },
  "cancelacion.suprimir-lo-que-tengan-de-mi": {
    pos: ["borren todo lo que tengan de mi", "elimina lo que tienen mio", "borrenme lo que guardan sobre mi", "quiero que borren lo que saben de mi"],
    neg: ["borra todo lo que tengan de mi pedido", "elimina lo que tienen de postre", "borra lo que tenga queso", "quita todo lo que tenga picante"],
  },
  "cancelacion.suprimir-mi-cuenta": {
    pos: ["eliminen mi cuenta", "suprima mi cuenta por favor", "quiero que destruyan mi cuenta"],
    neg: ["elimina el refresco de la cuenta", "cuanto es mi cuenta", "me trae mi cuenta", "separen la cuenta en dos"],
  },
  "cancelacion.borrar-mi-cuenta-ambiguo": {
    pos: ["borra mi cuenta", "cancelen mi cuenta"],
    neg: ["la cuenta por favor", "cancela el postre de la cuenta", "borra la cuenta de la mesa 4"],
  },
  "cancelacion.cancelar-mi-registro": {
    pos: ["quiero cancelar mi registro", "cancelen mi suscripcion", "cancela mi perfil de cliente"],
    neg: ["cancela mi reservacion de las 8", "cancela mi pedido de hoy", "cancelen el registro del pedido anterior"],
  },
  "cancelacion.sacarme-yo": {
    pos: ["borrame", "bórrenme por favor", "sáquenme ya", "eliminame de todo", "quitenme ya"],
    neg: ["quitame la cebolla", "sacame de dudas", "sacame una coca", "bajame la cuenta", "borrame la salsa de la orden", "quitenme del pedido el refresco"],
  },
  "cancelacion.que-me-borren": {
    pos: ["que me borren", "quiero que me borren de todo", "que me eliminen por favor"],
    neg: ["que me borren la salsa", "que me quiten la cebolla", "que me saquen la cuenta", "que me bajen la musica"],
  },
  "cancelacion.me-pueden-borrar": {
    pos: ["me pueden borrar", "me podrian eliminar de su sistema", "me pueden dar de baja"],
    neg: ["me pueden quitar la cebolla", "me puedes sacar la cuenta", "me pueden borrar el refresco del pedido"],
  },
  "cancelacion.sacarme-de-la-lista": {
    pos: ["sáquenme de la lista", "quitenme de sus contactos", "retirenme de su base de datos", "que me saquen de la lista de difusion"],
    neg: ["quita el pozole de la lista", "saquen el postre de la lista de mi pedido", "bajen el precio de la lista", "quita la cebolla de la lista de ingredientes"],
  },
  "cancelacion.no-quiero-estar-en-su-sistema": {
    pos: ["no quiero estar en su sistema", "ya no quiero aparecer en su base de datos", "no quiero que me tengan en su lista"],
    neg: ["no quiero estar en la terraza", "ya no quiero estar en la fila", "no quiero aparecer en la foto del menu"],
  },
  "cancelacion.darme-de-baja": {
    pos: ["quiero darme de baja", "denme de baja", "me dan de baja por favor", "dame de baja por favor"],
    neg: ["dame de baja el volumen", "quiero dar de baja la orden de alitas", "denme de baja la cuenta del menu", "dame de baja la cebolla"],
  },
  "cancelacion.olvidense-de-mi": {
    pos: ["olvidense de mi", "olviden de mi numero", "olvidense de mi ya"],
    neg: ["olvidalo mejor sin cebolla", "olvida lo anterior", "olvide mi cartera en la mesa", "se olvidaron de mi pedido"],
  },
  "cancelacion.no-guarden-mis-datos": {
    pos: ["no guarden mi numero", "ya no quiero que tengan mi direccion", "no conserven mis datos", "nunca guarden mi correo"],
    neg: ["no guarden mi tarjeta", "no tengan mi pedido listo hasta las 8", "no guarden mi pedido en la barra", "no tengan mi nombre en la reservacion"],
  },
  "cancelacion.derecho-por-nombre": {
    pos: ["derecho de cancelacion", "solicito la supresion de mis datos", "cancelacion de datos", "quiero cancelar mis datos"],
    neg: ["cancelacion del pedido", "politica de cancelacion de reservaciones", "supresion de la salsa"],
  },
  "oposicion.frase-legal-con-objeto": {
    pos: ["me opongo al uso de mis datos", "revoco mi consentimiento", "oposicion al tratamiento", "retiro mi consentimiento para promociones"],
    neg: ["no consiento que cobren dos veces el postre", "estoy en oposicion de que suban los precios", "me opongo a pagar propina obligatoria"],
  },
  "oposicion.frase-legal-sin-objeto": {
    pos: ["me opongo", "oposicion", "revoco"],
    neg: ["me ofrece el postre", "no tengo oposicion al horario", "opongo mis motivos al final del dia"],
  },
  "oposicion.no-autorizo-uso": {
    pos: ["no autorizo que usen mi telefono", "no les doy permiso de usar mis datos", "no les di permiso de guardar mi numero", "no autorizo el uso de mis datos"],
    neg: ["no autorizo cobros extra en mi pedido", "no les doy permiso de cambiar la receta", "no autorizo que cambien mi pedido sin avisar"],
  },
  "oposicion.no-usen-mis-datos": {
    pos: ["no usen mi numero", "no compartan mi informacion con nadie", "no vendan mis datos", "no quiero que utilicen mi correo para promociones"],
    neg: ["no usen picante en mis tacos", "no usen mantequilla en mi orden", "no compartan mi mesa con extraños", "no vendan mi pedido a otra persona"],
  },
  "oposicion.dejen-de-usar-mis-datos": {
    pos: ["dejen de usar mi numero", "dejen de compartir mis datos", "dejen de utilizar mi informacion"],
    neg: ["dejen de usar tanta sal", "dejen de poner mi pedido en espera", "dejen de usar el telefono de la barra"],
  },
  "oposicion.derecho-por-nombre": {
    pos: ["mi derecho de oposicion", "oposicion de mis datos", "ejerzo mi derecho de revocacion"],
    neg: ["oposicion total a la musica alta", "no hay oposicion para la reservacion"],
  },
  "oposicion.no-escribir-mas": {
    pos: ["no me escriban mas", "no me llamen nunca", "no me contacten jamas"],
    neg: ["no me llamen mas tarde que estoy manejando", "no me escriban mas temprano de las 9"],
  },
  "oposicion.no-mandar-contacto-sustantivo": {
    pos: ["no me manden mas mensajes", "ya no me envien publicidad", "no quiero que me manden promociones", "ya no me manden mensajitos", "no me vuelvan a mandar ofertas"],
    neg: ["no me manden salsa verde", "no me manden mas servilletas", "ya no me manden el pedido tan tarde", "no me envien el ticket impreso", "no me manden cubiertos de plastico"],
  },
  "oposicion.no-escribir-con-marca": {
    pos: ["ya no me escriban", "no me vuelvan a llamar", "no quiero que me sigan llamando", "ya no me contacten", "no quiero que me sigan mandando mensajes"],
    neg: ["no me vuelvan a traer el refresco tibio", "ya no me traigan mas agua", "no me vuelvan a cobrar el envio", "ya no me sirvan mas pan"],
  },
  "oposicion.no-escribir-sin-marca": {
    pos: ["no me llamen", "no me escriban", "no me contacten"],
    neg: ["no me llamen cuando lleguen, toquen el timbre", "no me llamen al llegar, estoy afuera", "no me escribas la direccion otra vez", "no me llame el repartidor, solo toque"],
  },
  "oposicion.dejen-de-contactarme": {
    pos: ["dejen de llamarme", "dejen de contactarme", "dejen de mandarme promociones", "dejen de escribirme"],
    neg: ["dejen de mandar repartidores a la casa vieja", "dejen de mandarme tanta salsa", "dejen de llamar al timbre", "dejen de molestar al mesero"],
  },
  "oposicion.no-quiero-recibir": {
    pos: ["no quiero recibir publicidad", "no deseo recibir promociones", "ya no quiero mensajes", "no quiero recibir llamadas"],
    neg: ["no quiero recibir el pedido frio", "no deseo recibir cubiertos", "ya no quiero postre", "no quiero recibir salsa extra"],
  },
  "oposicion.que-no-me-contacten": {
    pos: ["no quiero que me contacten", "ya no quiero que me llamen", "no deseo que me escriban"],
    neg: ["no quiero que me traigan el pedido hasta las 8", "no quiero que me lo mezclen con salsa"],
  },
  "oposicion.desuscribirme": {
    pos: ["quiero desuscribirme", "cancelen mi suscripcion a las promociones", "desactiven las notificaciones", "unsubscribe"],
    neg: ["cancela el mensaje de error del pedido", "quita el aviso de picante del taco", "cancela la promocion de mi pedido anterior"],
  },
  "acceso.que-datos-tienen-de-mi": {
    pos: ["que datos tienen de mi", "que informacion personal guardan sobre mi", "cuales datos tienen mios", "que info mia tienen"],
    neg: ["que datos necesitas para el envio", "que tienen de mi pedido", "que datos ocupas para la factura", "que informacion tienen del menu de hoy"],
  },
  "acceso.que-saben-de-mi": {
    pos: ["que saben de mi", "que han guardado de mi", "cuanto saben sobre mi"],
    neg: ["que saben del menu del dia", "que saben de mi pedido", "que saben hacer de postre"],
  },
  "acceso.que-tienen-de-mi-sin-sustantivo": {
    pos: ["que tienen de mi", "que es lo que tienen sobre mi"],
    neg: ["que tienen de mi pedido", "que tienen de postres", "que tienen de tomar"],
  },
  "acceso.pedir-mis-datos": {
    pos: ["quiero mis datos", "quiero acceso a mis datos personales", "necesito ver mis datos", "quiero una copia de mi informacion"],
    neg: ["mis datos son Juan Perez 9991234567", "ya te pase mis datos", "te paso mis datos para la factura", "toma mis datos para el pedido", "quiero ver el menu"],
  },
  "acceso.todo-lo-que-tengan-de-mi": {
    pos: ["mandenme todo lo que tengan de mi", "envienme lo que guardan sobre mi", "quiero saber todo lo que tienen de mi"],
    neg: ["mandenme todo lo que tengan de postre", "quiero todo lo que tenga queso", "pasenme lo que tengan de mi pedido"],
  },
  "acceso.mis-datos-que-tienen": {
    pos: ["cuales son mis datos que tienen guardados", "mis datos que guardan de mi", "cuales son mis datos que manejan"],
    neg: ["cuales son mis opciones de postre", "mis tacos que tienen queso", "cuantos tacos vienen en la orden"],
  },
  "acceso.por-que-tienen-mi-dato": {
    pos: ["por que tienen mi numero", "como consiguieron mi telefono", "quien les dio mi numero", "de donde sacaron mi correo"],
    neg: ["por que tienen mi pedido en espera", "como consiguieron esa promo", "quien les dio la receta", "de donde sacaron los ingredientes"],
  },
  "acceso.con-quien-comparten": {
    pos: ["con quien comparten mi informacion", "con quienes comparten mis datos", "a quien venden mi numero"],
    neg: ["con quien comparten la mesa", "con quien viene el repartidor", "con quien comparten el postre"],
  },
  "acceso.que-hacen-con-mis-datos": {
    pos: ["que hacen con mis datos", "para que usan mi informacion", "como usan mi numero"],
    neg: ["que hacen con mis tacos", "para que usan el limon", "como usan el horno de lena"],
  },
  "acceso.tienen-mis-datos-guardados": {
    pos: ["tienen mis datos guardados", "guardan mi informacion registrada"],
    neg: ["ya tienen mis datos de la vez pasada", "tienen mi pedido guardado", "tienen mi mesa reservada"],
  },
  "acceso.derecho-por-nombre": {
    pos: ["derecho de acceso", "acceso a mis datos", "acceso de mi informacion"],
    neg: ["acceso a la terraza", "acceso a domicilio", "acceso para sillas de ruedas"],
  },
  "rectificacion.corregir-mis-datos": {
    pos: ["corrijan mi nombre", "actualicen mis datos", "cambien mi correo", "quiero modificar mis datos personales"],
    neg: ["cambien el nombre del pedido a Juan", "corrijan mi pedido", "actualiza mi direccion de entrega", "corrige mi nombre en la factura", "cambia mi orden a 3 tacos"],
  },
  "rectificacion.mi-dato-esta-mal": {
    pos: ["mi nombre esta mal", "mis datos estan mal", "tienen mal escrito mi apellido", "mi correo aparece incorrecto"],
    neg: ["mi pedido esta mal", "mi orden salio mal armada", "la direccion esta mal, es la 45", "mi sopa esta mal de sal"],
  },
  "rectificacion.rectificar-datos": {
    pos: ["quiero rectificar mis datos", "rectificacion de datos", "derecho de rectificacion"],
    neg: ["rectifica el precio del combo", "rectifiquen la hora de entrega del pedido"],
  },
  "rectificacion.rectificar-sin-objeto": {
    pos: ["quiero rectificar", "rectificacion"],
    neg: ["quiero corregir el pedido", "cambio de opinion"],
  },
  "privacidad.derechos-arco": {
    pos: ["derechos ARCO", "donde esta su aviso de privacidad", "quiero conocer mis datos personales", "proteccion de datos"],
    neg: ["arco de entrada del restaurante", "quiero ver el menu", "tienen estacionamiento", "tienen datos de contacto del gerente"],
  },
  "privacidad.palabra-suelta": {
    pos: ["quiero privacidad", "tienen politica de privacidad"],
    neg: ["quiero una mesa con privacidad", "una mesa con privacidad para dos", "hay un salon con privacidad para reservar"],
  },
};
