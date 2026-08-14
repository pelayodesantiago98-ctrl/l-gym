'use strict';

// l-gym: rutinas de gimnasio y progreso.
//
// Entra por el mismo SSO que el resto del ecosistema, asi que aqui no hay
// contrasenas ni usuarios propios: el portal dice quien eres y todo lo que se
// guarda cuelga de ese id.

const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const sso = require('/usr/local/lib/lepayimio/sso');
const temas = require('/usr/local/lib/lepayimio/tema');
const bd = require('./basedatos');

const PUERTO = Number(process.env.PUERTO || 3007);
const ZONA = process.env.ZONA_HORARIA || 'Europe/Madrid';
const IMAGENES = path.join(__dirname, 'public', 'imagenes');
fs.mkdirSync(IMAGENES, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

// El dia de hoy segun el reloj de Madrid, no el del proceso.
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());

const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const limpio = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const entero = (v, min, max, porDefecto) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : porDefecto;
};
// El peso admite decimales (mancuernas de 2,5) y tambien vacio: una serie
// apuntada sin peso todavia es una serie planeada.
const decimal = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
};

// ------------------------------------------------------------------ acceso

app.use(sso.exigirSesion());
const quien = (req) => req.sesion.id;

/* El tema elegido, por usuario y en el servidor: así te sigue del móvil al
   ordenador. Fichero propio en datos/, que ya es de lgym y se respalda con
   el resto. */
const tema = temas.crear(
  path.join(__dirname, 'datos', 'temas.json'),
  ['oscuro', 'crystal', 'dark-crystal'],
  'oscuro');

tema.rutas(app, quien);

/*
 * La portada se sirve a mano para poder marcarle el tema al <html> antes de
 * mandarla. Va ANTES del express.static de abajo o lo serviría él tal cual.
 *
 * Hacerlo aquí y no en el navegador es lo que quita el fogonazo: aplicándolo
 * desde el cliente hay que pintar primero el tema por defecto y corregirlo
 * después, y ese parpadeo se ve en cada carga.
 */
app.get('/', (req, res, siguiente) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
    if (err) return siguiente(err);

    /* La fecha de cada estático metida en su URL.
       Los estáticos van con cinco minutos de caché, y sin número de versión un
       cambio de CSS o de JS tarda ese rato en verse: el navegador reutiliza el
       que ya tiene y Cloudflare puede tener el suyo. Lo peor es el término
       medio -- HTML nuevo con estilo viejo -- porque parece un fallo del código
       y no de la caché. Con ?v=<fecha> la URL cambia cuando cambia el fichero. */
    for (const est of ['estilo.css', 'guion.js']) {
      let v = 0;
      try { v = Math.floor(fs.statSync(path.join(__dirname, 'public', est)).mtimeMs); } catch {}
      if (v) html = html.split('/' + est).join('/' + est + '?v=' + v);
    }

    res.set('Cache-Control', 'no-store');
    res.type('html').send(tema.inyectar(html, tema.de(quien(req))));
  });
});

// Todo detras del SSO, tambien los estaticos. Las fotos de los ejercicios son
// del usuario, y servirlas desde nginx las dejaria abiertas a quien acertase
// el nombre del fichero. Cuesta un salto por Node y se evita el problema.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: '5m',
  setHeaders: (res, ruta) => {
    if (ruta.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ------------------------------------------------------------------ rutina

/*
 * Cerrar sesión. Se hace aquí y no contra el /salir del portal porque su nginx
 * corta con 403 las peticiones que llegan de otro origen, y este subdominio lo
 * es. La galleta es del dominio padre, así que desde aquí se puede borrar:
 * hay que repetir dominio y ruta o el navegador no la da por la misma.
 */
app.post('/salir', (req, res) => {
  res.clearCookie(sso.COOKIE, {
    httpOnly: true, secure: true, sameSite: 'lax', domain: '.lepayimio.es', path: '/',
  });
  res.redirect(sso.LOGIN);
});

app.get('/api/rutina', (req, res) => {
  const grupos = bd.listarGrupos(quien(req));
  const d = bd.grupoDiario(quien(req));
  res.json({
    hoy: hoy(),
    usuario: req.sesion.nombre,
    diario: { ...d, ejercicios: bd.listarEjercicios(d.id) },
    grupos: grupos.map((g) => ({ ...g, ejercicios: bd.listarEjercicios(g.id) })),
  });
});

app.post('/api/grupos', (req, res) => {
  const nombre = limpio(req.body.nombre, 60);
  if (nombre.length < 2) return res.status(400).json({ error: 'nombre' });
  res.json(bd.crearGrupo(quien(req), nombre));
});

app.patch('/api/grupos/:id', (req, res) => {
  const nombre = limpio(req.body.nombre, 60);
  if (nombre.length < 2) return res.status(400).json({ error: 'nombre' });
  if (!bd.renombrarGrupo(quien(req), Number(req.params.id), nombre)) {
    return res.status(404).json({ error: 'no-existe' });
  }
  res.json({ ok: true });
});

app.delete('/api/grupos/:id', (req, res) => {
  // El del calentamiento diario no se borra: la pantalla no ofrece el botón,
  // pero la ruta no debería fiarse de eso.
  const g = bd.grupo(quien(req), Number(req.params.id));
  if (g && g.diario) return res.status(400).json({ error: 'no-se-borra' });

  if (!bd.borrarGrupo(quien(req), Number(req.params.id))) {
    return res.status(404).json({ error: 'no-existe' });
  }
  res.json({ ok: true });
});

// Que el ejercicio pertenece a un grupo de quien pregunta. Sin esto, cambiando
// un numero en la peticion se podria tocar la rutina de otro.
function miEjercicio(req) {
  const e = bd.ejercicio(Number(req.params.id));
  if (!e) return null;
  return bd.grupo(quien(req), e.grupo_id) ? e : null;
}

app.post('/api/ejercicios', (req, res) => {
  const grupoId = Number(req.body.grupo_id);
  if (!bd.grupo(quien(req), grupoId)) return res.status(404).json({ error: 'grupo' });

  const tipo = req.body.tipo === 'calentamiento' ? 'calentamiento' : 'ejercicio';
  const nombre = limpio(req.body.nombre, 80);
  if (nombre.length < 2) return res.status(400).json({ error: 'nombre' });

  const nuevo = bd.crearEjercicio({
    grupo_id: grupoId,
    tipo,
    nombre,
    notas: limpio(req.body.notas, 300),
    series: tipo === 'calentamiento' ? 0 : entero(req.body.series, 1, 12, 3),
  });

  /*
   * Si viene del catalogo, se queda con la foto que ya habia. Se comprueba
   * contra la base y no contra el disco: asi lo unico que se puede enlazar es
   * una foto que de verdad pertenece a algun ejercicio, y no un fichero
   * cualquiera del directorio.
   */
  const imagen = limpio(req.body.imagen, 120);
  if (imagen && bd.existeImagen(imagen)) {
    bd.ponerImagen(nuevo.id, imagen);
    nuevo.imagen = imagen;
  }

  res.json(nuevo);
});

app.patch('/api/ejercicios/:id', (req, res) => {
  const e = miEjercicio(req);
  if (!e) return res.status(404).json({ error: 'no-existe' });
  const nombre = limpio(req.body.nombre, 80);
  if (nombre.length < 2) return res.status(400).json({ error: 'nombre' });
  res.json(bd.editarEjercicio(e.id, {
    nombre,
    notas: limpio(req.body.notas, 300),
    series: e.tipo === 'calentamiento' ? 0 : entero(req.body.series, 1, 12, e.series),
  }));
});

app.post('/api/ejercicios/:id/mover', (req, res) => {
  const e = miEjercicio(req);
  if (!e) return res.status(404).json({ error: 'no-existe' });
  res.json({ ok: bd.moverEjercicio(e.id, Number(req.body.direccion) < 0 ? -1 : 1) });
});

/*
 * Quitar del disco la foto de un ejercicio, salvo que otro la comparta.
 *
 * Desde que los movimientos se pueden coger del catalogo, dos ejercicios de
 * dos personas distintas pueden apuntar al mismo fichero. Borrarlo sin mirar
 * dejaba a la otra persona con la ficha sin foto.
 */
function soltarImagen(imagen, exceptoId) {
  if (!imagen || bd.imagenCompartida(imagen, exceptoId)) return;
  try { fs.unlinkSync(path.join(IMAGENES, imagen)); } catch {}
}

app.delete('/api/ejercicios/:id', (req, res) => {
  const e = miEjercicio(req);
  if (!e) return res.status(404).json({ error: 'no-existe' });
  soltarImagen(e.imagen, e.id);
  bd.borrarEjercicio(e.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------- imagenes

// Se sube el fichero crudo por PUT, como la foto de perfil del portal. sharp la
// recomprime a webp: ademas de pesar menos, eso descarta de paso los metadatos
// EXIF del movil, que suelen traer el modelo y a veces la ubicacion.
app.put('/api/ejercicios/:id/imagen',
  express.raw({ type: ['image/*'], limit: '8mb' }),
  async (req, res) => {
    const e = miEjercicio(req);
    if (!e) return res.status(404).json({ error: 'no-existe' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'vacio' });

    const nombre = `e${e.id}-${Date.now().toString(36)}.webp`;
    try {
      await sharp(req.body, { failOn: 'none' })
        .rotate()
        .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(IMAGENES, nombre));
    } catch (err) {
      return res.status(400).json({ error: 'no-es-imagen' });
    }

    soltarImagen(e.imagen, e.id);
    bd.ponerImagen(e.id, nombre);
    res.json({ ok: true, imagen: nombre });
  });

app.delete('/api/ejercicios/:id/imagen', (req, res) => {
  const e = miEjercicio(req);
  if (!e) return res.status(404).json({ error: 'no-existe' });
  soltarImagen(e.imagen, e.id);
  bd.ponerImagen(e.id, null);
  res.json({ ok: true });
});

// ------------------------------------------------- rutinas de otra gente

/*
 * El catalogo de la casa. Lo comparte todo el mundo a proposito: la gracia es
 * que quien anada "Press banca" se encuentre el que ya existe, con su foto,
 * en vez de volver a crearlo y a fotografiarlo.
 */
app.get('/api/catalogo', (req, res) => {
  const tipo = req.query.tipo === 'calentamiento' ? 'calentamiento' : 'ejercicio';
  const q = limpio(req.query.q, 80);
  if (q.length < 2) return res.json({ movimientos: [] });

  // Los comodines de LIKE se escapan para que no los meta quien busca.
  const patron = `%${q.replace(/[%_]/g, ' ')}%`;
  res.json({ movimientos: bd.buscarCatalogo(tipo, patron) });
});

app.get('/api/rutinas-existentes', (req, res) => {
  res.json({ rutinas: bd.rutinasExistentes(quien(req)) });
});

app.get('/api/rutinas-existentes/:id', (req, res) => {
  const g = bd.rutinaCualquiera(Number(req.params.id));
  if (!g || g.dueno === quien(req)) return res.status(404).json({ error: 'no-existe' });
  res.json({ ...g, ejercicios: bd.listarEjercicios(g.id) });
});

app.post('/api/rutinas-existentes/:id/copiar', (req, res) => {
  const copia = bd.copiarRutina(quien(req), Number(req.params.id));
  if (!copia) return res.status(404).json({ error: 'no-existe' });
  res.json(copia);
});

// ------------------------------------------------------------------ sesion

app.get('/api/sesion', (req, res) => {
  const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
  const grupoId = Number(req.query.grupo);
  const g = bd.grupo(quien(req), grupoId);
  if (!g) return res.status(404).json({ error: 'grupo' });

  const s = bd.sesionDe(quien(req), fecha, grupoId);

  /*
   * El calentamiento diario va por delante del propio del grupo, y marcado
   * como tal para que la pantalla pueda decir de dónde sale sin deducirlo del
   * id del grupo. Solo se cuelan los de tipo calentamiento: si algún día se
   * mete un ejercicio con series ahí dentro, no tiene sentido repetirlo.
   */
  const d = bd.grupoDiario(quien(req));
  const diarios = bd.listarEjercicios(d.id)
    .filter((e) => e.tipo === 'calentamiento')
    .map((e) => ({ ...e, diario: 1 }));
  const ejercicios = [...diarios, ...bd.listarEjercicios(grupoId)];

  // Para los diarios manda lo del día entero, no lo de esta sesión.
  const idsDiarios = diarios.map((e) => e.id);
  const enDiarios = new Set(idsDiarios);
  const marcas = bd.marcasDe(s.id)
    .filter((m) => !enDiarios.has(m.ejercicio_id))
    .concat(bd.marcasDelDia(quien(req), fecha, idsDiarios));

  // Lo de la última vez, para proponerlo de partida. Va aparte de `series` a
  // propósito: es una sugerencia, no algo guardado, y no debe contar en el
  // volumen ni en las marcas hasta que se confirme.
  const ultimaVez = {};
  for (const e of ejercicios) {
    if (e.tipo !== 'ejercicio') continue;
    const u = bd.ultimaVezDe(quien(req), e.id, fecha);
    if (u) ultimaVez[e.id] = u;
  }

  res.json({
    sesion: s,
    grupo: g,
    ejercicios,
    marcas,
    series: bd.seriesDe(s.id),
    ultimaVez,
  });
});

// Que la sesion es de quien la toca, igual que con los ejercicios.
function miSesion(req) {
  const s = bd.db.prepare('SELECT * FROM sesiones WHERE id = ?').get(Number(req.params.id));
  return s && s.dueno === quien(req) ? s : null;
}

app.post('/api/sesion/:id/marca', (req, res) => {
  const s = miSesion(req);
  if (!s) return res.status(404).json({ error: 'no-existe' });
  bd.marcar(s.id, Number(req.body.ejercicio_id), Boolean(req.body.hecho));
  res.json({ ok: true });
});

app.post('/api/sesion/:id/serie', (req, res) => {
  const s = miSesion(req);
  if (!s) return res.status(404).json({ error: 'no-existe' });
  bd.guardarSerie({
    sesion_id: s.id,
    ejercicio_id: Number(req.body.ejercicio_id),
    numero: entero(req.body.numero, 1, 50, 1),
    peso: decimal(req.body.peso),
    repeticiones: req.body.repeticiones === '' || req.body.repeticiones == null
      ? null : entero(req.body.repeticiones, 0, 999, null),
    hecho: req.body.hecho ? 1 : 0,
  });
  res.json({ ok: true });
});

app.delete('/api/sesion/:id/serie', (req, res) => {
  const s = miSesion(req);
  if (!s) return res.status(404).json({ error: 'no-existe' });
  bd.quitarSerie(s.id, Number(req.query.ejercicio), entero(req.query.numero, 1, 50, 1));
  res.json({ ok: true });
});

app.post('/api/sesion/:id/notas', (req, res) => {
  const s = miSesion(req);
  if (!s) return res.status(404).json({ error: 'no-existe' });
  bd.guardarNotas(s.id, limpio(req.body.notas, 1000));
  res.json({ ok: true });
});

/*
 * Cerrar el entreno del día, o reabrirlo si se envía { abierto: true }.
 * Reabrir tiene que ser posible: se cierra y a los dos minutos te acuerdas de
 * una serie que faltaba.
 */
app.post('/api/sesion/:id/terminar', (req, res) => {
  const s = miSesion(req);
  if (!s) return res.status(404).json({ error: 'no-existe' });
  const cuando = req.body.abierto ? null : new Date().toISOString();
  bd.terminar(s.id, cuando);
  res.json({ terminada: cuando });
});

// ---------------------------------------------------------------- progreso

app.get('/api/progreso/:id', (req, res) => {
  const e = miEjercicio(req);
  if (!e) return res.status(404).json({ error: 'no-existe' });
  res.json({ ejercicio: e, puntos: bd.progresoDe(quien(req), e.id) });
});

app.get('/api/stats', (req, res) => {
  res.json({
    resumen: bd.resumen(quien(req)),
    records: bd.records(quien(req)),
    historial: bd.historial(quien(req), 60),
  });
});

// ── El registro ──────────────────────────────────────────────────────────────

/* Los dias en los que se entreno. Se puede acotar por fechas y por grupo. */
app.get('/api/registro', (req, res) => {
  const q = req.query || {};
  res.json({
    dias: bd.diasConSesion(quien(req), {
      desde: /^\d{4}-\d{2}-\d{2}$/.test(String(q.desde || '')) ? String(q.desde) : null,
      hasta: /^\d{4}-\d{2}-\d{2}$/.test(String(q.hasta || '')) ? String(q.hasta) : null,
      grupoId: Number(q.grupo) || null,
    }),
  });
});

/* Todo lo de un dia. */
app.get('/api/registro/:fecha', (req, res) => {
  const fecha = String(req.params.fecha || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ error: 'Esa fecha no vale.' });
  }
  res.json({ fecha, sesiones: bd.detalleDelDia(quien(req), fecha) });
});

/*
 * Sacar los datos.
 *
 * El periodo se cuenta en dias hacia atras desde hoy, y «todo» no pone limite.
 * En CSV va una fila por serie: es lo que abre una hoja de calculo sin tener
 * que deshacer nada. En JSON, lo mismo pero sin aplanar.
 */
const PERIODOS = { '24h': 1, '7d': 7, '30d': 30, '1a': 365, todo: null };

app.get('/api/exportar', (req, res) => {
  const q = req.query || {};
  if (!(String(q.periodo) in PERIODOS)) {
    return res.status(400).json({ error: 'Periodo desconocido.' });
  }
  const dias = PERIODOS[String(q.periodo)];
  let desde = null;
  if (dias !== null) {
    const d = new Date();
    d.setDate(d.getDate() - dias);
    desde = d.toISOString().slice(0, 10);
  }

  const filas = bd.paraExportar(quien(req), desde);
  const sello = new Date().toISOString().slice(0, 10);
  const nombre = 'l-gym-' + String(q.periodo) + '-' + sello;

  if (String(q.formato) === 'csv') {
    /* Punto y coma y BOM: es lo que hace que Excel en español lo abra en
       columnas y con los acentos bien a la primera. */
    const cab = ['fecha', 'grupo', 'ejercicio', 'tipo', 'serie', 'peso',
                 'repeticiones', 'hecho', 'notas'];
    const escapar = (v) => {
      const t = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const cuerpo = [cab.join(';')].concat(
      filas.map((f) => cab.map((c) => escapar(f[c])).join(';'))).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '.csv"');
    return res.send('\ufeff' + cuerpo);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '.json"');
  res.send(JSON.stringify({ exportado: new Date().toISOString(),
                            periodo: String(q.periodo), filas }, null, 2));
});

/* Y meterlos de vuelta. Añade; no borra nada de lo que ya haya. */
app.post('/api/importar', (req, res) => {
  const d = req.body || {};
  const filas = Array.isArray(d) ? d : (Array.isArray(d.filas) ? d.filas : null);
  if (!filas) return res.status(400).json({ error: 'No veo las filas.' });
  if (filas.length > 20000) {
    return res.status(413).json({ error: 'Demasiadas filas de una vez.' });
  }
  try {
    res.json(bd.importar(quien(req), filas));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'no-existe' }));

/*
 * Comprobación al arrancar de que se puede leer la clave del SSO.
 *
 * El módulo compartido se traga el error de lectura a propósito -- para él, no
 * poder verificar es "no hay sesión" -- y eso, si el permiso falta, deja la app
 * rechazando a todo el mundo sin una sola línea en el registro que lo explique.
 * Ya pasó al montarla: l-gym corre con usuario propio y la clave es del grupo
 * www-data, así que necesita un permiso puntual:
 *
 *     setfacl -m u:lgym:r /etc/lepayimio/sso.key
 *
 * Si algún día se rota la clave y se recrea el fichero, ese permiso se pierde.
 * Por eso esto grita al arrancar en vez de fallar en silencio.
 */
function comprobarClaveSSO() {
  const ruta = process.env.SSO_KEY_FILE || '/etc/lepayimio/sso.key';
  try {
    if (!fs.readFileSync(ruta).length) throw new Error('está vacía');
    return true;
  } catch (e) {
    console.error('AVISO GRAVE: no puedo leer la clave del SSO en ' + ruta);
    console.error('  ' + e.message);
    console.error('  Mientras siga así, nadie va a poder entrar.');
    console.error('  Se arregla con: setfacl -m u:lgym:r ' + ruta);
    return false;
  }
}




app.listen(PUERTO, '127.0.0.1', () => {
  console.log(`l-gym en 127.0.0.1:${PUERTO}`);
  if (comprobarClaveSSO()) console.log('clave del SSO: legible');
});

