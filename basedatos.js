'use strict';

// Persistencia de l-gym. SQLite en fichero: una persona apuntando series en el
// gimnasio no justifica nada más grande.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DIR = process.env.DIR_DATOS || path.join(__dirname, 'datos');
fs.mkdirSync(DIR, { recursive: true });

const db = new Database(path.join(DIR, 'gym.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS grupos (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  dueno  TEXT NOT NULL,
  nombre TEXT NOT NULL,
  orden  INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL
);

-- Calentamientos y ejercicios viven en la misma tabla y se separan por 'tipo'.
-- Son la misma cosa -- un movimiento con nombre, foto y sitio en la lista -- y
-- partirlos en dos tablas obligaria a duplicar cada consulta.
CREATE TABLE IF NOT EXISTS ejercicios (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  grupo_id INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  tipo     TEXT NOT NULL CHECK (tipo IN ('calentamiento', 'ejercicio')),
  nombre   TEXT NOT NULL,
  notas    TEXT NOT NULL DEFAULT '',
  series   INTEGER NOT NULL DEFAULT 3,
  imagen   TEXT,
  orden    INTEGER NOT NULL DEFAULT 0,
  creado   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  dueno    TEXT NOT NULL,
  fecha    TEXT NOT NULL,
  grupo_id INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  notas    TEXT NOT NULL DEFAULT '',
  creada   TEXT NOT NULL,
  UNIQUE (dueno, fecha, grupo_id)
);

-- El visto de cada movimiento en una sesion. Vale para calentamientos y para
-- ejercicios; los calentamientos no tienen nada mas.
CREATE TABLE IF NOT EXISTS marcas (
  sesion_id    INTEGER NOT NULL REFERENCES sesiones(id) ON DELETE CASCADE,
  ejercicio_id INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
  hecho        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sesion_id, ejercicio_id)
);

-- Una fila por serie levantada. Es la tabla de la que sale todo el progreso,
-- asi que guarda el peso aunque la serie no se haya marcado como hecha.
CREATE TABLE IF NOT EXISTS series (
  sesion_id    INTEGER NOT NULL REFERENCES sesiones(id) ON DELETE CASCADE,
  ejercicio_id INTEGER NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
  numero       INTEGER NOT NULL,
  peso         REAL,
  repeticiones INTEGER,
  hecho        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sesion_id, ejercicio_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_ejercicios_grupo ON ejercicios (grupo_id, tipo, orden);
CREATE INDEX IF NOT EXISTS idx_sesiones_fecha   ON sesiones (dueno, fecha);
CREATE INDEX IF NOT EXISTS idx_series_ejercicio ON series (ejercicio_id);
`);

/*
 * Añadidos posteriores al esquema original. Se comprueba la columna en vez de
 * intentar el ALTER y tragarse el error: así el arranque no depende de que el
 * mensaje de error de SQLite siga diciendo lo mismo en versiones futuras.
 */
if (!db.prepare('PRAGMA table_info(sesiones)').all().some((c) => c.name === 'terminada')) {
  db.exec('ALTER TABLE sesiones ADD COLUMN terminada TEXT');
}
if (!db.prepare('PRAGMA table_info(grupos)').all().some((c) => c.name === 'diario')) {
  db.exec('ALTER TABLE grupos ADD COLUMN diario INTEGER NOT NULL DEFAULT 0');
}

/*
 * La biblioteca de movimientos importada de free-exercise-db (dominio publico).
 *
 * Va en su propia tabla y no en `ejercicios` porque son cosas distintas: un
 * ejercicio pertenece al grupo de alguien y acumula series; esto es un fichero
 * de consulta que no es de nadie. Se identifican por `clave`, la del dataset,
 * para poder reimportar sin duplicar.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS catalogo (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clave         TEXT NOT NULL UNIQUE,
  nombre        TEXT NOT NULL,
  nombre_en     TEXT NOT NULL DEFAULT '',
  tipo          TEXT NOT NULL CHECK (tipo IN ('calentamiento', 'ejercicio')),
  imagen        TEXT,
  musculos      TEXT NOT NULL DEFAULT '',
  secundarios   TEXT NOT NULL DEFAULT '',
  equipo        TEXT NOT NULL DEFAULT '',
  categoria     TEXT NOT NULL DEFAULT '',
  nivel         TEXT NOT NULL DEFAULT '',
  instrucciones TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_catalogo_busca ON catalogo (tipo, nombre);
`);

const ahora = () => new Date().toISOString();

// ------------------------------------------------------------------ grupos

// El del calentamiento diario queda fuera: no es un grupo que se elija, es el
// que se cuela en todos los demás.
const listarGrupos = (dueno) => db.prepare(
  'SELECT * FROM grupos WHERE dueno = ? AND diario = 0 ORDER BY orden, nombre'
).all(dueno);

/*
 * El calentamiento diario, guardado como un grupo con diario = 1. Se crea la
 * primera vez que se pregunta por él: así hereda el editor, las fotos y el
 * orden de los ejercicios sin una segunda tabla que hiciera lo mismo.
 *
 * orden = -1 para que, si alguna consulta futura los mezcla, salga el primero.
 */
function grupoDiario(dueno) {
  let g = db.prepare('SELECT * FROM grupos WHERE dueno = ? AND diario = 1').get(dueno);
  if (!g) {
    const r = db.prepare(
      'INSERT INTO grupos (dueno, nombre, orden, creado, diario) VALUES (?, ?, -1, ?, 1)'
    ).run(dueno, 'Calentamiento diario', ahora());
    g = db.prepare('SELECT * FROM grupos WHERE id = ?').get(r.lastInsertRowid);
  }
  return g;
}

function crearGrupo(dueno, nombre) {
  const orden = db.prepare(
    'SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM grupos WHERE dueno = ?'
  ).get(dueno).n;
  const r = db.prepare(
    'INSERT INTO grupos (dueno, nombre, orden, creado) VALUES (?, ?, ?, ?)'
  ).run(dueno, nombre, orden, ahora());
  return grupo(dueno, r.lastInsertRowid);
}

const grupo = (dueno, id) => db.prepare(
  'SELECT * FROM grupos WHERE id = ? AND dueno = ?'
).get(id, dueno);

const renombrarGrupo = (dueno, id, nombre) => db.prepare(
  'UPDATE grupos SET nombre = ? WHERE id = ? AND dueno = ?'
).run(nombre, id, dueno).changes;

const borrarGrupo = (dueno, id) => db.prepare(
  'DELETE FROM grupos WHERE id = ? AND dueno = ?'
).run(id, dueno).changes;

// -------------------------------------------------------------- ejercicios

const listarEjercicios = (grupoId) => db.prepare(
  'SELECT * FROM ejercicios WHERE grupo_id = ? ORDER BY tipo DESC, orden, id'
).all(grupoId);

const ejercicio = (id) => db.prepare('SELECT * FROM ejercicios WHERE id = ?').get(id);

function crearEjercicio(d) {
  const orden = db.prepare(
    'SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM ejercicios WHERE grupo_id = ? AND tipo = ?'
  ).get(d.grupo_id, d.tipo).n;
  const r = db.prepare(`
    INSERT INTO ejercicios (grupo_id, tipo, nombre, notas, series, orden, creado)
    VALUES (@grupo_id, @tipo, @nombre, @notas, @series, @orden, @creado)
  `).run({ ...d, orden, creado: ahora() });
  return ejercicio(r.lastInsertRowid);
}

function editarEjercicio(id, d) {
  db.prepare(`
    UPDATE ejercicios SET nombre = @nombre, notas = @notas, series = @series
    WHERE id = @id
  `).run({ ...d, id });
  return ejercicio(id);
}

const ponerImagen = (id, nombre) =>
  db.prepare('UPDATE ejercicios SET imagen = ? WHERE id = ?').run(nombre, id).changes;

const borrarEjercicio = (id) =>
  db.prepare('DELETE FROM ejercicios WHERE id = ?').run(id).changes;

function moverEjercicio(id, direccion) {
  const e = ejercicio(id);
  if (!e) return false;
  const vecino = db.prepare(`
    SELECT * FROM ejercicios
    WHERE grupo_id = ? AND tipo = ? AND orden ${direccion < 0 ? '<' : '>'} ?
    ORDER BY orden ${direccion < 0 ? 'DESC' : 'ASC'} LIMIT 1
  `).get(e.grupo_id, e.tipo, e.orden);
  if (!vecino) return false;
  const cambio = db.transaction(() => {
    db.prepare('UPDATE ejercicios SET orden = ? WHERE id = ?').run(vecino.orden, e.id);
    db.prepare('UPDATE ejercicios SET orden = ? WHERE id = ?').run(e.orden, vecino.id);
  });
  cambio();
  return true;
}

// ---------------------------------------------------------------- sesiones

// La sesion se crea sola la primera vez que se abre un grupo en una fecha: en
// el gimnasio nadie quiere pulsar "empezar entrenamiento" antes de apuntar.
function sesionDe(dueno, fecha, grupoId) {
  let s = db.prepare(
    'SELECT * FROM sesiones WHERE dueno = ? AND fecha = ? AND grupo_id = ?'
  ).get(dueno, fecha, grupoId);
  if (!s) {
    const r = db.prepare(
      'INSERT INTO sesiones (dueno, fecha, grupo_id, creada) VALUES (?, ?, ?, ?)'
    ).run(dueno, fecha, grupoId, ahora());
    s = db.prepare('SELECT * FROM sesiones WHERE id = ?').get(r.lastInsertRowid);
  }
  return s;
}

const marcasDe = (sesionId) =>
  db.prepare('SELECT ejercicio_id, hecho FROM marcas WHERE sesion_id = ?').all(sesionId);

/*
 * Marcas de unos ejercicios en CUALQUIER sesión del mismo día.
 *
 * El calentamiento diario se hace una vez, no una por grupo. Quien entrene
 * pecho por la mañana y pierna por la tarde tiene que ver por la tarde que ya
 * lo hizo, y no volver a mirarse una lista de tres cosas preguntándose si las
 * hizo. MAX(hecho) porque basta con haberlo marcado en una.
 */
function marcasDelDia(dueno, fecha, ids) {
  if (!ids.length) return [];
  const huecos = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT m.ejercicio_id, MAX(m.hecho) AS hecho
    FROM marcas m JOIN sesiones s ON s.id = m.sesion_id
    WHERE s.dueno = ? AND s.fecha = ? AND m.ejercicio_id IN (${huecos})
    GROUP BY m.ejercicio_id
  `).all(dueno, fecha, ...ids);
}

const seriesDe = (sesionId) => db.prepare(
  'SELECT ejercicio_id, numero, peso, repeticiones, hecho FROM series WHERE sesion_id = ? ORDER BY numero'
).all(sesionId);

const marcar = (sesionId, ejercicioId, hecho) => db.prepare(`
  INSERT INTO marcas (sesion_id, ejercicio_id, hecho) VALUES (?, ?, ?)
  ON CONFLICT (sesion_id, ejercicio_id) DO UPDATE SET hecho = excluded.hecho
`).run(sesionId, ejercicioId, hecho ? 1 : 0);

const guardarSerie = (s) => db.prepare(`
  INSERT INTO series (sesion_id, ejercicio_id, numero, peso, repeticiones, hecho)
  VALUES (@sesion_id, @ejercicio_id, @numero, @peso, @repeticiones, @hecho)
  ON CONFLICT (sesion_id, ejercicio_id, numero) DO UPDATE SET
    peso = excluded.peso, repeticiones = excluded.repeticiones, hecho = excluded.hecho
`).run(s);

const quitarSerie = (sesionId, ejercicioId, numero) => db.prepare(
  'DELETE FROM series WHERE sesion_id = ? AND ejercicio_id = ? AND numero = ?'
).run(sesionId, ejercicioId, numero).changes;

/*
 * Cerrar o reabrir el entreno del día. Guarda CUÁNDO se cerró, no un simple
 * sí/no: si algún día interesa saber a qué hora se entrena, el dato ya está.
 * null = abierto.
 */
const terminar = (sesionId, cuando) =>
  db.prepare('UPDATE sesiones SET terminada = ? WHERE id = ?').run(cuando, sesionId);

const guardarNotas = (sesionId, notas) =>
  db.prepare('UPDATE sesiones SET notas = ? WHERE id = ?').run(notas, sesionId).changes;

// La sesion vacia no cuenta como entrenamiento: solo las que tienen algo hecho.
const historial = (dueno, limite) => db.prepare(`
  SELECT s.id, s.fecha, s.grupo_id, g.nombre AS grupo,
         (SELECT COUNT(*) FROM series x WHERE x.sesion_id = s.id AND x.hecho = 1) AS series_hechas,
         (SELECT COALESCE(SUM(x.peso * COALESCE(x.repeticiones, 1)), 0)
            FROM series x WHERE x.sesion_id = s.id AND x.hecho = 1 AND x.peso IS NOT NULL) AS volumen
  FROM sesiones s JOIN grupos g ON g.id = s.grupo_id
  WHERE s.dueno = ?
  ORDER BY s.fecha DESC LIMIT ?
`).all(dueno, limite);

/*
 * Lo que se levantó la última vez en este ejercicio, para proponerlo de
 * partida. Se busca el día anterior más reciente con series marcadas: las
 * apuntadas y no hechas no valen como referencia, porque a lo mejor se dejaron
 * a medias justamente por no poder con ese peso.
 *
 * "Anterior" es estrictamente antes de la fecha que se está mirando, no antes
 * de hoy: si se rellena un entreno de la semana pasada, la referencia buena es
 * la de la semana anterior a esa, no la de ayer.
 */
function ultimaVezDe(dueno, ejercicioId, antesDe) {
  const dia = db.prepare(`
    SELECT s.fecha FROM sesiones s JOIN series x ON x.sesion_id = s.id
    WHERE s.dueno = ? AND x.ejercicio_id = ? AND x.hecho = 1 AND s.fecha < ?
    ORDER BY s.fecha DESC LIMIT 1
  `).get(dueno, ejercicioId, antesDe);
  if (!dia) return null;

  return {
    fecha: dia.fecha,
    series: db.prepare(`
      SELECT x.numero, x.peso, x.repeticiones
      FROM series x JOIN sesiones s ON s.id = x.sesion_id
      WHERE s.dueno = ? AND x.ejercicio_id = ? AND s.fecha = ? AND x.hecho = 1
      ORDER BY x.numero
    `).all(dueno, ejercicioId, dia.fecha),
  };
}

// ---------------------------------------------------------------- progreso

// Una fila por sesion y ejercicio: el peso mas alto de ese dia y el volumen
// total. Son dos medidas de escala distinta, asi que en la web van en dos
// graficas separadas y nunca en dos ejes de la misma.
const progresoDe = (dueno, ejercicioId) => db.prepare(`
  SELECT s.fecha,
         MAX(x.peso) AS peso_max,
         SUM(x.peso * COALESCE(x.repeticiones, 1)) AS volumen,
         COUNT(*) AS series
  FROM series x
  JOIN sesiones s ON s.id = x.sesion_id
  WHERE s.dueno = ? AND x.ejercicio_id = ? AND x.peso IS NOT NULL AND x.hecho = 1
  GROUP BY s.fecha
  ORDER BY s.fecha
`).all(dueno, ejercicioId);

const resumen = (dueno) => db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM sesiones s WHERE s.dueno = ?
       AND EXISTS (SELECT 1 FROM series x WHERE x.sesion_id = s.id AND x.hecho = 1)) AS entrenos,
    (SELECT COUNT(*) FROM sesiones s JOIN series x ON x.sesion_id = s.id
       WHERE s.dueno = ? AND x.hecho = 1) AS series_totales,
    (SELECT COALESCE(SUM(x.peso * COALESCE(x.repeticiones, 1)), 0)
       FROM sesiones s JOIN series x ON x.sesion_id = s.id
       WHERE s.dueno = ? AND x.hecho = 1 AND x.peso IS NOT NULL) AS volumen_total,
    (SELECT MAX(s.fecha) FROM sesiones s WHERE s.dueno = ?
       AND EXISTS (SELECT 1 FROM series x WHERE x.sesion_id = s.id AND x.hecho = 1)) AS ultimo
`).get(dueno, dueno, dueno, dueno);

// Marcas personales: el peso mas alto de cada ejercicio y cuando se hizo.
const records = (dueno) => db.prepare(`
  SELECT e.id, e.nombre, g.nombre AS grupo, MAX(x.peso) AS peso,
         (SELECT s2.fecha FROM series x2 JOIN sesiones s2 ON s2.id = x2.sesion_id
          WHERE x2.ejercicio_id = e.id AND s2.dueno = ? AND x2.hecho = 1
          ORDER BY x2.peso DESC, s2.fecha DESC LIMIT 1) AS fecha
  FROM series x
  JOIN sesiones s ON s.id = x.sesion_id
  JOIN ejercicios e ON e.id = x.ejercicio_id
  JOIN grupos g ON g.id = e.grupo_id
  WHERE s.dueno = ? AND x.hecho = 1 AND x.peso IS NOT NULL AND e.tipo = 'ejercicio'
  GROUP BY e.id
  ORDER BY g.nombre, e.nombre
`).all(dueno, dueno);

// ------------------------------------------------- rutinas de otra gente

/*
 * Lo que han montado los demas. La rutina vacia no sale: no se copia nada de
 * un grupo sin ejercicios, y solo estorbaria en la lista.
 *
 * El calentamiento diario es un grupo mas (diario = 1), asi que entra aqui
 * solo; lo unico distinto es como se presenta y donde acaba al copiarlo.
 */
const rutinasExistentes = (dueno) => db.prepare(`
  SELECT g.id, g.nombre, g.dueno, g.diario,
         SUM(CASE WHEN e.tipo = 'ejercicio' THEN 1 ELSE 0 END) AS ejercicios,
         SUM(CASE WHEN e.tipo = 'calentamiento' THEN 1 ELSE 0 END) AS calentamientos
  FROM grupos g LEFT JOIN ejercicios e ON e.grupo_id = g.id
  WHERE g.dueno <> ?
  GROUP BY g.id
  HAVING ejercicios + calentamientos > 0
  ORDER BY g.dueno COLLATE NOCASE, g.diario DESC, g.nombre COLLATE NOCASE
`).all(dueno);

const rutinaCualquiera = (id) => db.prepare('SELECT * FROM grupos WHERE id = ?').get(id);

/*
 * Un nombre que no choque con los grupos que ya tiene esa persona. Copiar el
 * "Pecho" de otro cuando ya tienes un "Pecho" deja dos grupos con el mismo
 * nombre y no hay forma de saber cual es cual en la pantalla del entreno.
 */
function nombreLibre(dueno, nombre) {
  const usados = new Set(
    db.prepare('SELECT nombre FROM grupos WHERE dueno = ?').all(dueno)
      .map((g) => g.nombre.toLowerCase())
  );
  if (!usados.has(nombre.toLowerCase())) return nombre;
  for (let n = 2; n < 50; n += 1) {
    const probar = `${nombre} (${n})`;
    if (!usados.has(probar.toLowerCase())) return probar;
  }
  return `${nombre} (copia)`;
}

/*
 * Copia una rutina ajena a la cuenta de quien la pide. Se copia la ficha del
 * movimiento -- nombre, notas, series y foto --, nunca lo levantado: el
 * progreso es de cada uno.
 *
 * La foto no se duplica en disco, se apunta el mismo fichero. Por eso al
 * borrar un ejercicio hay que mirar antes si alguien mas usa esa imagen.
 *
 * Si lo que se copia es el calentamiento diario de otro, sus movimientos van
 * al calentamiento diario propio en vez de crear un grupo suelto, que es
 * donde de verdad hacen falta.
 */
function copiarRutina(dueno, id) {
  const origen = rutinaCualquiera(id);
  if (!origen || origen.dueno === dueno) return null;

  const movimientos = listarEjercicios(id);
  if (!movimientos.length) return null;

  return db.transaction(() => {
    const destino = origen.diario
      ? grupoDiario(dueno)
      : crearGrupo(dueno, nombreLibre(dueno, origen.nombre));

    for (const m of movimientos) {
      const tipo = origen.diario ? 'calentamiento' : m.tipo;
      const nuevo = crearEjercicio({
        grupo_id: destino.id,
        tipo,
        nombre: m.nombre,
        notas: m.notas,
        series: tipo === 'calentamiento' ? 0 : m.series,
      });
      if (m.imagen) ponerImagen(nuevo.id, m.imagen);
    }
    return { ...destino, copiados: movimientos.length };
  })();
}

// ------------------------------------------------- catalogo de movimientos

/*
 * Los movimientos que ya existen en la casa, vengan de quien vengan.
 *
 * Se agrupan por nombre sin mirar mayusculas ni de quien son: "Press banca" y
 * "press banca" son el mismo ejercicio, y quien lo busque quiere la foto que
 * ya hay subida, la pusiera quien la pusiera. Salen primero los que tienen
 * foto, y despues los mas repetidos, que son los que mas gente usa.
 */
const TOPE_SUGERENCIAS = 8;

/*
 * Primero lo de la casa y despues la biblioteca, y ese orden importa: la foto
 * que subio alguien es de la maquina que hay en ESE gimnasio, y vale mas que
 * el modelo generico del dataset. La biblioteca solo rellena lo que sobra.
 */
const buscarCatalogo = (tipo, patron) => {
  const casa = db.prepare(`
  SELECT e.nombre, e.tipo, COUNT(*) AS veces, MAX(e.series) AS series,
         (SELECT e2.imagen FROM ejercicios e2
           WHERE e2.nombre = e.nombre COLLATE NOCASE AND e2.tipo = e.tipo
             AND e2.imagen IS NOT NULL
           ORDER BY e2.id DESC LIMIT 1) AS imagen,
         (SELECT e3.notas FROM ejercicios e3
           WHERE e3.nombre = e.nombre COLLATE NOCASE AND e3.tipo = e.tipo
             AND e3.notas <> ''
           ORDER BY e3.id DESC LIMIT 1) AS notas
  FROM ejercicios e
  WHERE e.tipo = ? AND e.nombre LIKE ?
  GROUP BY LOWER(e.nombre), e.tipo
  ORDER BY (imagen IS NULL), veces DESC, e.nombre COLLATE NOCASE
  LIMIT 8
`).all(tipo, patron);

  const hueco = TOPE_SUGERENCIAS - casa.length;
  if (hueco <= 0) return casa;

  // Por longitud: los nombres cortos son los canonicos ("Curl con barra" antes
  // que "Curl con barra tumbado en banco alto").
  const biblioteca = db.prepare(`
    SELECT nombre, tipo, 0 AS veces, 3 AS series, imagen, '' AS notas,
           musculos, equipo, nivel, 1 AS biblioteca
      FROM catalogo
     WHERE tipo = ? AND nombre LIKE ?
     ORDER BY LENGTH(nombre), nombre COLLATE NOCASE
     LIMIT ?
  `).all(tipo, patron, hueco + TOPE_SUGERENCIAS);

  const yaEsta = new Set(casa.map((m) => m.nombre.toLowerCase()));
  return casa.concat(
    biblioteca.filter((m) => !yaEsta.has(m.nombre.toLowerCase())).slice(0, hueco)
  );
};

// Que esa foto sea de verdad una foto de la casa o de la biblioteca, y no una
// ruta inventada en la peticion.
const enBiblioteca = (nombre) => !!db.prepare(
  'SELECT 1 FROM catalogo WHERE imagen = ? LIMIT 1'
).get(nombre);

const existeImagen = (nombre) => enBiblioteca(nombre) || !!db.prepare(
  'SELECT 1 FROM ejercicios WHERE imagen = ? LIMIT 1'
).get(nombre);

/*
 * Si otro ejercicio comparte la foto, el fichero no se borra del disco.
 *
 * Las de la biblioteca cuentan siempre como compartidas: son de todos, y que
 * alguien borre su ejercicio no puede dejar al resto sin la foto del catalogo.
 */
const imagenCompartida = (nombre, exceptoId) => enBiblioteca(nombre) || !!db.prepare(
  'SELECT 1 FROM ejercicios WHERE imagen = ? AND id <> ? LIMIT 1'
).get(nombre, exceptoId);


// ── El registro ──────────────────────────────────────────────────────────────
//
// Lo que se hizo cada dia. Los datos ya estaban —sesiones, marcas y series—,
// aqui solo se consultan.

/*
 * Los dias en los que hubo algo, del mas reciente al mas antiguo.
 *
 * Un dia puede tener mas de un grupo (mañana pecho, tarde pierna), asi que se
 * devuelve una fila por dia con la lista de lo que se toco. Se cuenta lo hecho
 * de verdad —marcas y series— y no lo que la rutina tenia previsto: el registro
 * es de lo que paso, no de lo que estaba planeado.
 */
function diasConSesion(dueno, filtro = {}) {
  const donde = ['s.dueno = ?'];
  const args = [dueno];
  if (filtro.desde) { donde.push('s.fecha >= ?'); args.push(filtro.desde); }
  if (filtro.hasta) { donde.push('s.fecha <= ?'); args.push(filtro.hasta); }
  if (filtro.grupoId) { donde.push('s.grupo_id = ?'); args.push(Number(filtro.grupoId)); }

  const filas = db.prepare(`
    SELECT s.id, s.fecha, s.grupo_id, s.notas, s.terminada, g.nombre AS grupo,
           (SELECT COUNT(*) FROM marcas m WHERE m.sesion_id = s.id AND m.hecho = 1) AS hechos,
           (SELECT COUNT(*) FROM series x WHERE x.sesion_id = s.id AND x.hecho = 1) AS series
    FROM sesiones s
    JOIN grupos g ON g.id = s.grupo_id
    WHERE ${donde.join(' AND ')}
    ORDER BY s.fecha DESC, g.nombre
  `).all(...args);

  /* Solo los dias en los que se hizo algo: una sesion que se abrio y se cerro
     sin tocar nada no es un dia de entrenamiento. */
  const dias = new Map();
  for (const f of filas) {
    if (!f.hechos && !f.series) continue;
    if (!dias.has(f.fecha)) dias.set(f.fecha, { fecha: f.fecha, grupos: [] });
    dias.get(f.fecha).grupos.push({
      sesionId: f.id, grupoId: f.grupo_id, grupo: f.grupo,
      hechos: f.hechos, series: f.series, notas: f.notas, terminada: f.terminada,
    });
  }
  return [...dias.values()];
}

/* Todo lo de un dia: cada grupo, sus ejercicios y las series que se anotaron. */
function detalleDelDia(dueno, fecha) {
  const sesiones = db.prepare(`
    SELECT s.id, s.grupo_id, s.notas, s.terminada, g.nombre AS grupo
    FROM sesiones s JOIN grupos g ON g.id = s.grupo_id
    WHERE s.dueno = ? AND s.fecha = ? ORDER BY g.nombre
  `).all(dueno, fecha);

  return sesiones.map((s) => {
    const ejercicios = db.prepare(`
      SELECT e.id, e.nombre, e.tipo, e.notas, e.series AS previstas,
             COALESCE(m.hecho, 0) AS hecho
      FROM ejercicios e
      LEFT JOIN marcas m ON m.ejercicio_id = e.id AND m.sesion_id = ?
      WHERE e.grupo_id = ?
      ORDER BY e.tipo DESC, e.orden, e.id
    `).all(s.id, s.grupo_id);

    const series = db.prepare(
      'SELECT ejercicio_id, numero, peso, repeticiones, hecho FROM series ' +
      'WHERE sesion_id = ? ORDER BY ejercicio_id, numero').all(s.id);

    const porEjercicio = new Map();
    for (const x of series) {
      if (!porEjercicio.has(x.ejercicio_id)) porEjercicio.set(x.ejercicio_id, []);
      porEjercicio.get(x.ejercicio_id).push(x);
    }

    return {
      sesionId: s.id, grupoId: s.grupo_id, grupo: s.grupo,
      notas: s.notas, terminada: s.terminada,
      ejercicios: ejercicios.map((e) => ({ ...e, series: porEjercicio.get(e.id) || [] })),
    };
  });
}

/* Lo de un periodo, en plano: una fila por serie anotada, mas las sesiones sin
   series para que un dia de solo calentamiento no desaparezca del volcado. */
function paraExportar(dueno, desde) {
  const args = [dueno];
  let filtro = '';
  if (desde) { filtro = ' AND s.fecha >= ?'; args.push(desde); }

  return db.prepare(`
    SELECT s.fecha, g.nombre AS grupo, e.nombre AS ejercicio, e.tipo,
           x.numero AS serie, x.peso, x.repeticiones, x.hecho,
           s.notas
    FROM sesiones s
    JOIN grupos g ON g.id = s.grupo_id
    LEFT JOIN series x ON x.sesion_id = s.id
    LEFT JOIN ejercicios e ON e.id = x.ejercicio_id
    WHERE s.dueno = ?${filtro}
    ORDER BY s.fecha DESC, g.nombre, e.nombre, x.numero
  `).all(...args);
}

/*
 * Meter datos de vuelta.
 *
 * Se identifica por nombre y no por numero: un volcado de otra instalacion —o
 * del mismo sitio tras rehacer las rutinas— trae unos identificadores que aqui
 * no significan nada. Lo que falte se crea; lo que ya este se respeta.
 *
 * No borra nada. Importar sobre lo que ya hay añade, no reemplaza: perder un
 * historial por importar un fichero equivocado no tiene arreglo.
 */
function importar(dueno, filas) {
  let metidas = 0, saltadas = 0;
  const meter = db.transaction((lista) => {
    for (const f of lista) {
      const fecha = String(f.fecha || '').slice(0, 10);
      const grupo = String(f.grupo || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !grupo) { saltadas++; continue; }

      let g = db.prepare('SELECT id FROM grupos WHERE dueno = ? AND nombre = ?')
        .get(dueno, grupo);
      if (!g) {
        const r = db.prepare(
          'INSERT INTO grupos (dueno, nombre, orden, creado) VALUES (?, ?, 0, ?)')
          .run(dueno, grupo, new Date().toISOString());
        g = { id: r.lastInsertRowid };
      }

      let s = db.prepare('SELECT id FROM sesiones WHERE dueno = ? AND fecha = ? AND grupo_id = ?')
        .get(dueno, fecha, g.id);
      if (!s) {
        const r = db.prepare(
          'INSERT INTO sesiones (dueno, fecha, grupo_id, notas, creada) VALUES (?, ?, ?, ?, ?)')
          .run(dueno, fecha, g.id, String(f.notas || ''), new Date().toISOString());
        s = { id: r.lastInsertRowid };
      }

      const nombre = String(f.ejercicio || '').trim();
      if (!nombre) { metidas++; continue; }   // dia sin series: la sesion ya existe

      let e = db.prepare('SELECT id FROM ejercicios WHERE grupo_id = ? AND nombre = ?')
        .get(g.id, nombre);
      if (!e) {
        const r = db.prepare(
          'INSERT INTO ejercicios (grupo_id, tipo, nombre, notas, series, orden, creado) ' +
          "VALUES (?, ?, ?, '', 3, 0, ?)")
          .run(g.id, f.tipo === 'calentamiento' ? 'calentamiento' : 'ejercicio',
               nombre, new Date().toISOString());
        e = { id: r.lastInsertRowid };
      }

      db.prepare('INSERT OR IGNORE INTO marcas (sesion_id, ejercicio_id, hecho) VALUES (?, ?, 1)')
        .run(s.id, e.id);

      const numero = Number(f.serie);
      if (numero) {
        db.prepare('INSERT OR REPLACE INTO series ' +
                   '(sesion_id, ejercicio_id, numero, peso, repeticiones, hecho) ' +
                   'VALUES (?, ?, ?, ?, ?, ?)')
          .run(s.id, e.id, numero,
               f.peso === '' || f.peso == null ? null : Number(f.peso),
               f.repeticiones === '' || f.repeticiones == null ? null : Number(f.repeticiones),
               Number(f.hecho) ? 1 : 0);
      }
      metidas++;
    }
  });
  meter(filas);
  return { metidas, saltadas };
}


module.exports = {
  diasConSesion, detalleDelDia, paraExportar, importar,
  db,
  listarGrupos, crearGrupo, grupo, renombrarGrupo, borrarGrupo, grupoDiario,
  listarEjercicios, ejercicio, crearEjercicio, editarEjercicio,
  ponerImagen, borrarEjercicio, moverEjercicio,
  sesionDe, marcasDe, marcasDelDia, seriesDe, marcar, guardarSerie, quitarSerie,
  guardarNotas, terminar, ultimaVezDe,
  historial, progresoDe, resumen, records,
  rutinasExistentes, rutinaCualquiera, copiarRutina,
  buscarCatalogo, existeImagen, imagenCompartida,
};

