const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./database.db");

// ===============================
// CONFIGURACIÓN DE MONEDAS
// ===============================

const MONEDAS_DIVISAS = ["USD", "EUR"];
const MONEDAS_FONDOS = ["DOP", "USD", "EUR"];

const CONFIG_MONEDAS = {
  USD: {
    campoDisponible: "usd_disponibles",
    campoCosto: "costo_promedio_usd",
    campoGanancia: "ganancia_total_usd",
    campoTransaccion: "monto_usd"
  },
  EUR: {
    campoDisponible: "eur_disponibles",
    campoCosto: "costo_promedio_eur",
    campoGanancia: "ganancia_total_eur",
    campoTransaccion: "monto_eur"
  }
};

function normalizarMoneda(moneda, defecto = "USD") {
  return String(moneda || defecto).toUpperCase();
}

function configMoneda(moneda) {
  const monedaFinal = normalizarMoneda(moneda);
  return CONFIG_MONEDAS[monedaFinal];
}

function campoFondo(moneda) {
  const monedaFinal = normalizarMoneda(moneda, "DOP");

  if (monedaFinal === "DOP") return "presupuesto_dop";
  if (monedaFinal === "USD") return "usd_disponibles";
  if (monedaFinal === "EUR") return "eur_disponibles";

  return null;
}

function validarNumero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0;
}

// ===============================
// MIGRACIONES SEGURAS
// ===============================

function agregarColumna(tabla, columna, definicion) {
  db.run(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`, () => {});
}

// ===============================
// TABLAS
// ===============================

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'cajero',
      activo INTEGER DEFAULT 1,
      presupuesto_dop REAL DEFAULT 0,

      usd_disponibles REAL DEFAULT 0,
      eur_disponibles REAL DEFAULT 0,

      costo_promedio REAL DEFAULT 0,
      costo_promedio_usd REAL DEFAULT 0,
      costo_promedio_eur REAL DEFAULT 0,

      ganancia_total REAL DEFAULT 0,
      ganancia_total_usd REAL DEFAULT 0,
      ganancia_total_eur REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS movimientos_fondos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cajero_id INTEGER,
      admin_id INTEGER,
      tipo TEXT,
      moneda TEXT DEFAULT 'DOP',
      monto REAL,
      fecha TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transacciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      tipo TEXT,
      moneda TEXT DEFAULT 'USD',

      cliente_nombre TEXT,
      cliente_documento TEXT,

      monto_usd REAL DEFAULT 0,
      monto_eur REAL DEFAULT 0,
      cantidad_divisa REAL DEFAULT 0,

      tasa REAL,
      monto_dop REAL,
      ganancia REAL DEFAULT 0,
      costo_promedio REAL DEFAULT 0,

      anulada INTEGER DEFAULT 0,
      motivo_anulacion TEXT,
      admin_anulo_id INTEGER,
      fecha_anulacion TEXT,

      fecha TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migraciones para bases de datos viejas
  agregarColumna("usuarios", "eur_disponibles", "REAL DEFAULT 0");
  agregarColumna("usuarios", "costo_promedio_usd", "REAL DEFAULT 0");
  agregarColumna("usuarios", "costo_promedio_eur", "REAL DEFAULT 0");
  agregarColumna("usuarios", "ganancia_total_usd", "REAL DEFAULT 0");
  agregarColumna("usuarios", "ganancia_total_eur", "REAL DEFAULT 0");

  agregarColumna("transacciones", "moneda", "TEXT DEFAULT 'USD'");
  agregarColumna("transacciones", "monto_eur", "REAL DEFAULT 0");
  agregarColumna("transacciones", "cantidad_divisa", "REAL DEFAULT 0");
  agregarColumna("transacciones", "anulada", "INTEGER DEFAULT 0");
  agregarColumna("transacciones", "motivo_anulacion", "TEXT");
  agregarColumna("transacciones", "admin_anulo_id", "INTEGER");
  agregarColumna("transacciones", "fecha_anulacion", "TEXT");

  // Copiar valores antiguos al nuevo costo USD si están en cero
  db.run(`
    UPDATE usuarios
    SET costo_promedio_usd = costo_promedio
    WHERE costo_promedio_usd = 0 AND costo_promedio > 0
  `);

  db.run(`
    UPDATE usuarios
    SET ganancia_total_usd = ganancia_total
    WHERE ganancia_total_usd = 0 AND ganancia_total > 0
  `);

  db.run(`
    UPDATE transacciones
    SET moneda = 'USD'
    WHERE moneda IS NULL OR moneda = ''
  `);

  db.run(`
    UPDATE transacciones
    SET cantidad_divisa = monto_usd
    WHERE (cantidad_divisa IS NULL OR cantidad_divisa = 0)
    AND monto_usd > 0
  `);

  // Crear admin inicial
  db.get("SELECT * FROM usuarios WHERE rol = 'admin'", async (err, admin) => {
    if (!admin) {
      const pass = await bcrypt.hash("admin123", 10);

      db.run(
        `INSERT INTO usuarios 
        (nombre, password, rol, presupuesto_dop, usd_disponibles, eur_disponibles)
        VALUES (?, ?, ?, ?, ?, ?)`,
        ["admin", pass, "admin", 0, 0, 0]
      );

      console.log("Admin creado: usuario admin / clave admin123");
    }
  });
});

// ===============================
// LOGIN
// ===============================

app.post("/login", (req, res) => {
  const { nombre, password } = req.body;

  db.get("SELECT * FROM usuarios WHERE nombre = ?", [nombre], async (err, user) => {
    if (err) return res.status(500).json({ error: "Error en login" });
    if (!user) return res.status(401).json({ error: "Usuario no existe" });
    if (user.activo !== 1) return res.status(403).json({ error: "Usuario inactivo" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });

    res.json({
      id: user.id,
      nombre: user.nombre,
      rol: user.rol,
      presupuesto_dop: user.presupuesto_dop || 0,
      usd_disponibles: user.usd_disponibles || 0,
      eur_disponibles: user.eur_disponibles || 0,
      costo_promedio_usd: user.costo_promedio_usd || user.costo_promedio || 0,
      costo_promedio_eur: user.costo_promedio_eur || 0,
      ganancia_total_usd: user.ganancia_total_usd || user.ganancia_total || 0,
      ganancia_total_eur: user.ganancia_total_eur || 0
    });
  });
});
// ===============================
// CREAR USUARIO / CAJERO - SOLO ADMIN
// ===============================

app.post("/usuarios", async (req, res) => {
  const { admin_id, nombre, password, rol } = req.body;

  if (!nombre || !password) {
    return res.status(400).json({ error: "Nombre y contraseña son obligatorios" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], async (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo el admin puede crear usuarios" });

    const hash = await bcrypt.hash(password, 10);

    db.run(
      `INSERT INTO usuarios 
      (nombre, password, rol, presupuesto_dop, usd_disponibles, eur_disponibles)
      VALUES (?, ?, ?, 0, 0, 0)`,
      [nombre, hash, rol || "cajero"],
      function (err) {
        if (err) return res.status(500).json({ error: "Error creando usuario: " + err.message });
        res.json({ mensaje: "Usuario creado", id: this.lastID });
      }
    );
  });
});

// ===============================
// LISTAR USUARIOS - SOLO ADMIN
// ===============================

app.get("/usuarios/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede ver usuarios" });

    db.all(
      `SELECT 
        id, nombre, rol, activo,
        presupuesto_dop,
        usd_disponibles,
        eur_disponibles,
        costo_promedio_usd,
        costo_promedio_eur,
        ganancia_total_usd,
        ganancia_total_eur
      FROM usuarios 
      ORDER BY id ASC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Error listando usuarios" });
        res.json(rows);
      }
    );
  });
});

// ===============================
// ACTIVAR / DESACTIVAR USUARIO
// ===============================

app.put("/usuarios/:id/estado", (req, res) => {
  const { id } = req.params;
  const { admin_id, activo } = req.body;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede cambiar estado" });

    db.run("UPDATE usuarios SET activo = ? WHERE id = ?", [activo ? 1 : 0, id], (err) => {
      if (err) return res.status(500).json({ error: "Error actualizando estado" });
      res.json({ mensaje: "Estado actualizado" });
    });
  });
});

// ===============================
// ASIGNAR / RETIRAR FONDOS DOP, USD O EUR - SOLO ADMIN
// ===============================

app.post("/fondos", (req, res) => {
  const { admin_id, cajero_id, tipo, moneda, monto } = req.body;
  const cantidad = Number(monto);
  const monedaFinal = normalizarMoneda(moneda, "DOP");

  if (!["asignar", "retirar"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo inválido" });
  }

  if (!MONEDAS_FONDOS.includes(monedaFinal)) {
    return res.status(400).json({ error: "Moneda inválida" });
  }

  if (!validarNumero(cantidad)) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  const campo = campoFondo(monedaFinal);

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede mover fondos" });

    db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'cajero'", [cajero_id], (err, cajero) => {
      if (err) return res.status(500).json({ error: "Error buscando cajero" });
      if (!cajero) return res.status(404).json({ error: "Cajero no encontrado" });

      if (tipo === "asignar") {
        if (Number(admin[campo] || 0) < cantidad) {
          return res.status(400).json({ error: `Fondos ${monedaFinal} insuficientes en administración` });
        }

        db.run(`UPDATE usuarios SET ${campo} = ${campo} - ? WHERE id = ?`, [cantidad, admin_id], (err) => {
          if (err) return res.status(500).json({ error: "Error descontando al admin" });

          db.run(`UPDATE usuarios SET ${campo} = ${campo} + ? WHERE id = ?`, [cantidad, cajero_id], (err) => {
            if (err) return res.status(500).json({ error: "Error asignando al cajero" });

            db.run(
              "INSERT INTO movimientos_fondos (cajero_id, admin_id, tipo, moneda, monto) VALUES (?, ?, ?, ?, ?)",
              [cajero_id, admin_id, tipo, monedaFinal, cantidad],
              () => res.json({ mensaje: `Movimiento realizado correctamente en ${monedaFinal}` })
            );
          });
        });
      }

      if (tipo === "retirar") {
        if (Number(cajero[campo] || 0) < cantidad) {
          return res.status(400).json({ error: `El cajero no tiene suficientes ${monedaFinal}` });
        }

        db.run(`UPDATE usuarios SET ${campo} = ${campo} + ? WHERE id = ?`, [cantidad, admin_id], (err) => {
          if (err) return res.status(500).json({ error: "Error sumando al admin" });

          db.run(`UPDATE usuarios SET ${campo} = ${campo} - ? WHERE id = ?`, [cantidad, cajero_id], (err) => {
            if (err) return res.status(500).json({ error: "Error retirando al cajero" });

            db.run(
              "INSERT INTO movimientos_fondos (cajero_id, admin_id, tipo, moneda, monto) VALUES (?, ?, ?, ?, ?)",
              [cajero_id, admin_id, tipo, monedaFinal, cantidad],
              () => res.json({ mensaje: `Movimiento realizado correctamente en ${monedaFinal}` })
            );
          });
        });
      }
    });
  });
});

// ===============================
// MODIFICAR PRESUPUESTO GENERAL DOP DEL ADMIN
// ===============================

app.post("/admin/presupuesto", (req, res) => {
  const { admin_id, tipo, monto } = req.body;
  const cantidad = Number(monto);

  if (!validarNumero(cantidad)) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede modificar presupuesto general" });

    if (tipo === "agregar") {
      db.run(
        "UPDATE usuarios SET presupuesto_dop = presupuesto_dop + ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo agregar presupuesto" });
          res.json({ mensaje: "Presupuesto general agregado correctamente" });
        }
      );
    } else if (tipo === "reducir") {
      if (Number(admin.presupuesto_dop || 0) < cantidad) {
        return res.status(400).json({ error: "Fondos generales insuficientes" });
      }

      db.run(
        "UPDATE usuarios SET presupuesto_dop = presupuesto_dop - ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo reducir presupuesto" });
          res.json({ mensaje: "Presupuesto general reducido correctamente" });
        }
      );
    } else {
      res.status(400).json({ error: "Tipo inválido" });
    }
  });
});

// ===============================
// MODIFICAR USD GENERAL DEL ADMIN
// ===============================

app.post("/admin/usd", (req, res) => {
  const { admin_id, tipo, monto } = req.body;
  const cantidad = Number(monto);

  if (!validarNumero(cantidad)) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede modificar USD general" });

    if (tipo === "agregar") {
      db.run(
        "UPDATE usuarios SET usd_disponibles = usd_disponibles + ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo agregar USD" });
          res.json({ mensaje: "USD general agregado correctamente" });
        }
      );
    } else if (tipo === "reducir") {
      if (Number(admin.usd_disponibles || 0) < cantidad) {
        return res.status(400).json({ error: "USD generales insuficientes" });
      }

      db.run(
        "UPDATE usuarios SET usd_disponibles = usd_disponibles - ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo reducir USD" });
          res.json({ mensaje: "USD general reducido correctamente" });
        }
      );
    } else {
      res.status(400).json({ error: "Tipo inválido" });
    }
  });
});

// ===============================
// MODIFICAR EUR GENERAL DEL ADMIN
// ===============================

app.post("/admin/eur", (req, res) => {
  const { admin_id, tipo, monto } = req.body;
  const cantidad = Number(monto);

  if (!validarNumero(cantidad)) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede modificar EUR general" });

    if (tipo === "agregar") {
      db.run(
        "UPDATE usuarios SET eur_disponibles = eur_disponibles + ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo agregar EUR" });
          res.json({ mensaje: "EUR general agregado correctamente" });
        }
      );
    } else if (tipo === "reducir") {
      if (Number(admin.eur_disponibles || 0) < cantidad) {
        return res.status(400).json({ error: "EUR generales insuficientes" });
      }

      db.run(
        "UPDATE usuarios SET eur_disponibles = eur_disponibles - ? WHERE id = ?",
        [cantidad, admin_id],
        (err) => {
          if (err) return res.status(500).json({ error: "No se pudo reducir EUR" });
          res.json({ mensaje: "EUR general reducido correctamente" });
        }
      );
    } else {
      res.status(400).json({ error: "Tipo inválido" });
    }
  });
});
// ===============================
// COMPRA DE DIVISA USD / EUR
// ===============================

app.post("/compra", (req, res) => {
  const {
    usuario_id,
    cliente_nombre,
    cliente_documento,
    monto_dop,
    tasa,
    moneda
  } = req.body;

  const monedaFinal = normalizarMoneda(moneda, "USD");
  const dop = Number(monto_dop);
  const tasaNum = Number(tasa);

  if (!MONEDAS_DIVISAS.includes(monedaFinal)) {
    return res.status(400).json({ error: "Moneda inválida" });
  }

  if (!validarNumero(dop) || !validarNumero(tasaNum)) {
    return res.status(400).json({ error: "Monto y tasa son obligatorios" });
  }

  const cfg = configMoneda(monedaFinal);
  const cantidadDivisa = dop / tasaNum;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (Number(user.presupuesto_dop || 0) < dop) {
      return res.status(400).json({ error: "Fondos DOP insuficientes" });
    }

    const divisaActual = Number(user[cfg.campoDisponible] || 0);
    const costoActual = Number(user[cfg.campoCosto] || 0);

    const nuevoCostoPromedio =
      divisaActual + cantidadDivisa > 0
        ? ((divisaActual * costoActual) + dop) / (divisaActual + cantidadDivisa)
        : tasaNum;

    db.run(
      `UPDATE usuarios
       SET presupuesto_dop = presupuesto_dop - ?,
           ${cfg.campoDisponible} = ${cfg.campoDisponible} + ?,
           ${cfg.campoCosto} = ?
       WHERE id = ?`,
      [dop, cantidadDivisa, nuevoCostoPromedio, usuario_id],
      (err) => {
        if (err) {
          console.log("ERROR COMPRA:", err.message);
          return res.status(500).json({ error: "Error registrando compra: " + err.message });
        }

        const montoUsd = monedaFinal === "USD" ? cantidadDivisa : 0;
        const montoEur = monedaFinal === "EUR" ? cantidadDivisa : 0;

        db.run(
          `INSERT INTO transacciones 
          (
            usuario_id, tipo, moneda,
            cliente_nombre, cliente_documento,
            monto_usd, monto_eur, cantidad_divisa,
            tasa, monto_dop, ganancia, costo_promedio
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuario_id,
            "compra",
            monedaFinal,
            cliente_nombre || "",
            cliente_documento || "",
            montoUsd,
            montoEur,
            cantidadDivisa,
            tasaNum,
            dop,
            0,
            nuevoCostoPromedio
          ],
          (err) => {
            if (err) {
              console.log("ERROR INSERT COMPRA:", err.message);
              return res.status(500).json({ error: "Error guardando compra: " + err.message });
            }

            res.json({
              mensaje: `Compra ${monedaFinal} registrada`,
              moneda: monedaFinal,
              cantidad_divisa: cantidadDivisa,
              monto_dop: dop,
              costo_promedio: nuevoCostoPromedio
            });
          }
        );
      }
    );
  });
});

// ===============================
// VENTA DE DIVISA USD / EUR
// ===============================

app.post("/venta", (req, res) => {
  const {
    usuario_id,
    cliente_nombre,
    cliente_documento,
    monto_usd,
    monto_eur,
    cantidad_divisa,
    tasa,
    moneda
  } = req.body;

  const monedaFinal = normalizarMoneda(moneda, "USD");
  const tasaNum = Number(tasa);

  if (!MONEDAS_DIVISAS.includes(monedaFinal)) {
    return res.status(400).json({ error: "Moneda inválida" });
  }

  const cantidad = Number(
    cantidad_divisa ||
    (monedaFinal === "USD" ? monto_usd : monto_eur)
  );

  const dop = cantidad * tasaNum;
  const cfg = configMoneda(monedaFinal);

  if (!validarNumero(cantidad) || !validarNumero(tasaNum)) {
    return res.status(400).json({ error: "Cantidad y tasa son obligatorios" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (Number(user[cfg.campoDisponible] || 0) < cantidad) {
      return res.status(400).json({ error: `${monedaFinal} insuficientes` });
    }

    const costoPromedio = Number(user[cfg.campoCosto] || 0);
    const ganancia = (tasaNum - costoPromedio) * cantidad;

    db.run(
      `UPDATE usuarios
       SET ${cfg.campoDisponible} = ${cfg.campoDisponible} - ?,
           presupuesto_dop = presupuesto_dop + ?,
           ${cfg.campoGanancia} = ${cfg.campoGanancia} + ?
       WHERE id = ?`,
      [cantidad, dop, ganancia, usuario_id],
      (err) => {
        if (err) {
          console.log("ERROR VENTA:", err.message);
          return res.status(500).json({ error: "Error registrando venta: " + err.message });
        }

        const montoUsd = monedaFinal === "USD" ? cantidad : 0;
        const montoEur = monedaFinal === "EUR" ? cantidad : 0;

        db.run(
          `INSERT INTO transacciones
          (
            usuario_id, tipo, moneda,
            cliente_nombre, cliente_documento,
            monto_usd, monto_eur, cantidad_divisa,
            tasa, monto_dop, ganancia, costo_promedio
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            usuario_id,
            "venta",
            monedaFinal,
            cliente_nombre || "",
            cliente_documento || "",
            montoUsd,
            montoEur,
            cantidad,
            tasaNum,
            dop,
            ganancia,
            costoPromedio
          ],
          (err) => {
            if (err) {
              console.log("ERROR INSERT VENTA:", err.message);
              return res.status(500).json({ error: "Error guardando venta: " + err.message });
            }

            res.json({
              mensaje: `Venta ${monedaFinal} registrada`,
              moneda: monedaFinal,
              monto_dop: dop,
              cantidad_divisa: cantidad,
              ganancia,
              costo_promedio: costoPromedio
            });
          }
        );
      }
    );
  });
});

// ===============================
// BALANCE
// ===============================

app.get("/balance/:id", (req, res) => {
  db.get(
    `SELECT 
      id, 
      nombre, 
      rol, 
      presupuesto_dop, 
      usd_disponibles,
      eur_disponibles,
      costo_promedio,
      costo_promedio_usd,
      costo_promedio_eur,
      ganancia_total,
      ganancia_total_usd,
      ganancia_total_eur
    FROM usuarios 
    WHERE id = ?`,
    [req.params.id],
    (err, user) => {
      if (err) return res.status(500).json({ error: "Error buscando balance" });
      if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

      res.json({
        ...user,
        costo_promedio_usd: user.costo_promedio_usd || user.costo_promedio || 0,
        ganancia_total_usd: user.ganancia_total_usd || user.ganancia_total || 0,
        costo_promedio_eur: user.costo_promedio_eur || 0,
        ganancia_total_eur: user.ganancia_total_eur || 0
      });
    }
  );
});

// ===============================
// HISTORIAL DE OPERACIONES
// ===============================

app.get("/historial/:usuario_id", (req, res) => {
  const { usuario_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const sqlAdmin = `
      SELECT 
        t.*,
        u.nombre AS cajero
      FROM transacciones t
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      ORDER BY t.id DESC
    `;

    const sqlCajero = `
      SELECT 
        t.*,
        u.nombre AS cajero
      FROM transacciones t
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.usuario_id = ?
      ORDER BY t.id DESC
    `;

    if (user.rol === "admin") {
      db.all(sqlAdmin, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error cargando historial: " + err.message });
        res.json(rows);
      });
    } else {
      db.all(sqlCajero, [usuario_id], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error cargando historial: " + err.message });
        res.json(rows);
      });
    }
  });
});

// ===============================
// HISTORIAL DE FONDOS
// ===============================

app.get("/historial-fondos/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede ver historial de fondos" });

    db.all(
      `SELECT 
        mf.id,
        mf.tipo,
        mf.moneda,
        mf.monto,
        mf.fecha,
        c.nombre AS cajero,
        a.nombre AS admin
      FROM movimientos_fondos mf
      LEFT JOIN usuarios c ON c.id = mf.cajero_id
      LEFT JOIN usuarios a ON a.id = mf.admin_id
      ORDER BY mf.id DESC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Error cargando historial de fondos" });
        res.json(rows);
      }
    );
  });
});
// ===============================
// REPORTES DE GANANCIA
// ===============================

app.get("/reportes-ganancia/:usuario_id", (req, res) => {
  const { usuario_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    let filtro = "";
    let params = [];

    if (user.rol !== "admin") {
      filtro = "WHERE usuario_id = ?";
      params = [usuario_id];
    }

    const whereBase = filtro ? filtro + " AND" : "WHERE";

    db.get(
      `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_hoy
       FROM transacciones
       ${whereBase} tipo = 'venta'
       AND anulada = 0
       AND date(fecha) = date('now')`,
      params,
      (err, hoy) => {
        if (err) return res.status(500).json({ error: "Error calculando ganancia hoy" });

        db.get(
          `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_mes
           FROM transacciones
           ${whereBase} tipo = 'venta'
           AND anulada = 0
           AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now')`,
          params,
          (err, mes) => {
            if (err) return res.status(500).json({ error: "Error calculando ganancia mes" });

            db.get(
              `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_total
               FROM transacciones
               ${whereBase} tipo = 'venta'
               AND anulada = 0`,
              params,
              (err, total) => {
                if (err) return res.status(500).json({ error: "Error calculando ganancia total" });

                db.all(
                  `SELECT 
                    moneda,
                    COALESCE(SUM(CASE WHEN date(fecha) = date('now') THEN ganancia ELSE 0 END), 0) AS ganancia_hoy,
                    COALESCE(SUM(CASE WHEN strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now') THEN ganancia ELSE 0 END), 0) AS ganancia_mes,
                    COALESCE(SUM(ganancia), 0) AS ganancia_total
                   FROM transacciones
                   ${whereBase} tipo = 'venta'
                   AND anulada = 0
                   GROUP BY moneda`,
                  params,
                  (err, porMoneda) => {
                    if (err) return res.status(500).json({ error: "Error calculando ganancias por moneda" });

                    res.json({
                      ganancia_hoy: hoy.ganancia_hoy || 0,
                      ganancia_mes: mes.ganancia_mes || 0,
                      ganancia_total: total.ganancia_total || 0,
                      ganancia_por_moneda: porMoneda || [],
                      costo_promedio_usd: user.costo_promedio_usd || user.costo_promedio || 0,
                      costo_promedio_eur: user.costo_promedio_eur || 0
                    });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// ===============================
// ANULAR TRANSACCIÓN USD / EUR
// ===============================

app.post("/transacciones/:id/anular", (req, res) => {
  const transaccion_id = req.params.id;
  const { admin_id, motivo } = req.body;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede anular transacciones" });

    db.get("SELECT * FROM transacciones WHERE id = ?", [transaccion_id], (err, t) => {
      if (err) return res.status(500).json({ error: "Error buscando transacción" });
      if (!t) return res.status(404).json({ error: "Transacción no encontrada" });
      if (t.anulada === 1) return res.status(400).json({ error: "Esta transacción ya está anulada" });

      const monedaFinal = normalizarMoneda(t.moneda, "USD");

      if (!MONEDAS_DIVISAS.includes(monedaFinal)) {
        return res.status(400).json({ error: "Moneda inválida en la transacción" });
      }

      const cfg = configMoneda(monedaFinal);
      const cantidad = Number(t.cantidad_divisa || t.monto_usd || t.monto_eur || 0);
      const dop = Number(t.monto_dop || 0);
      const ganancia = Number(t.ganancia || 0);

      let updateUsuario = "";
      let valores = [];

      if (t.tipo === "compra") {
        updateUsuario = `
          UPDATE usuarios
          SET presupuesto_dop = presupuesto_dop + ?,
              ${cfg.campoDisponible} = ${cfg.campoDisponible} - ?
          WHERE id = ?
        `;
        valores = [dop, cantidad, t.usuario_id];
      } else if (t.tipo === "venta") {
        updateUsuario = `
          UPDATE usuarios
          SET presupuesto_dop = presupuesto_dop - ?,
              ${cfg.campoDisponible} = ${cfg.campoDisponible} + ?,
              ${cfg.campoGanancia} = ${cfg.campoGanancia} - ?
          WHERE id = ?
        `;
        valores = [dop, cantidad, ganancia, t.usuario_id];
      } else {
        return res.status(400).json({ error: "Tipo de transacción inválido" });
      }

      db.run(updateUsuario, valores, (err) => {
        if (err) {
          console.log("ERROR ANULAR BALANCE:", err.message);
          return res.status(500).json({ error: "Error revirtiendo balance: " + err.message });
        }

        db.run(
          `UPDATE transacciones
           SET anulada = 1,
               motivo_anulacion = ?,
               admin_anulo_id = ?,
               fecha_anulacion = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [motivo || "Sin motivo", admin_id, transaccion_id],
          (err) => {
            if (err) {
              console.log("ERROR ANULAR TRANSACCION:", err.message);
              return res.status(500).json({ error: "Error anulando transacción: " + err.message });
            }

            res.json({ mensaje: "Transacción anulada correctamente" });
          }
        );
      });
    });
  });
});

// ===============================
// CAMBIAR CONTRASEÑA - SOLO ADMIN
// ===============================

app.post("/cambiar-password", async (req, res) => {
  const { admin_id, usuario_id, nueva_password } = req.body;

  if (!nueva_password || nueva_password.length < 4) {
    return res.status(400).json({
      error: "La contraseña debe tener al menos 4 caracteres"
    });
  }

  db.get(
    "SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'",
    [admin_id],
    async (err, admin) => {
      if (err) return res.status(500).json({ error: "Error buscando admin" });

      if (!admin) {
        return res.status(403).json({
          error: "Solo administradores pueden cambiar contraseñas"
        });
      }

      const hash = await bcrypt.hash(nueva_password, 10);

      db.run(
        "UPDATE usuarios SET password = ? WHERE id = ?",
        [hash, usuario_id],
        function (err) {
          if (err) {
            return res.status(500).json({
              error: "Error actualizando contraseña"
            });
          }

          res.json({
            mensaje: "Contraseña actualizada correctamente"
          });
        }
      );
    }
  );
});

// ===============================
// BACKUP BASE DE DATOS - SOLO ADMIN
// ===============================

app.get("/backup-db/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).send("Error buscando admin");
    if (!admin) return res.status(403).send("Solo admin puede descargar backup");

    res.download("./database.db", `backup-divisas-pro-${Date.now()}.db`);
  });
});
// ===============================
// EXPORTAR OPERACIONES CSV - SOLO ADMIN
// ===============================

app.get("/exportar-operaciones/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).send("Error buscando admin");
    if (!admin) return res.status(403).send("Solo admin puede exportar operaciones");

    db.all(
      `SELECT 
        t.id,
        u.nombre AS cajero,
        t.tipo,
        t.moneda,
        t.cliente_nombre,
        t.cliente_documento,
        t.monto_usd,
        t.monto_eur,
        t.cantidad_divisa,
        t.tasa,
        t.monto_dop,
        t.ganancia,
        t.costo_promedio,
        t.anulada,
        t.motivo_anulacion,
        t.fecha
      FROM transacciones t
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      ORDER BY t.id DESC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).send("Error exportando operaciones: " + err.message);

        let csv = "ID,Cajero,Tipo,Moneda,Cliente,Documento,USD,EUR,Cantidad Divisa,Tasa,DOP,Ganancia,Costo Promedio,Anulada,Motivo,Fecha\n";

        rows.forEach(r => {
          csv += [
            r.id,
            r.cajero || "",
            r.tipo || "",
            r.moneda || "USD",
            r.cliente_nombre || "",
            r.cliente_documento || "",
            r.monto_usd || 0,
            r.monto_eur || 0,
            r.cantidad_divisa || 0,
            r.tasa || 0,
            r.monto_dop || 0,
            r.ganancia || 0,
            r.costo_promedio || 0,
            r.anulada ? "SI" : "NO",
            r.motivo_anulacion || "",
            r.fecha || ""
          ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=operaciones-divisas-pro-${Date.now()}.csv`);
        res.send(csv);
      }
    );
  });
});

// ===============================
// CAMBIAR ROL DE USUARIO - SOLO ADMIN
// ===============================

app.post("/cambiar-rol", (req, res) => {
  const { admin_id, usuario_id, nuevo_rol } = req.body;

  if (Number(usuario_id) === 1) {
    return res.status(400).json({
      error: "No se puede modificar el rol del administrador principal"
    });
  }

  if (!["admin", "cajero"].includes(nuevo_rol)) {
    return res.status(400).json({ error: "Rol inválido" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede cambiar roles" });

    db.run(
      "UPDATE usuarios SET rol = ? WHERE id = ?",
      [nuevo_rol, usuario_id],
      (err) => {
        if (err) return res.status(500).json({ error: "Error cambiando rol" });
        res.json({ mensaje: "Rol actualizado correctamente" });
      }
    );
  });
});

// ===============================
// INICIAR SERVIDOR
// ===============================

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});