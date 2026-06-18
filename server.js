const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database(process.env.DB_PATH || "./database.db");

// =========================
// BASE DE DATOS
// =========================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      presupuesto_dop REAL DEFAULT 0,
      usd_disponibles REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transacciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      tipo TEXT,
      usd REAL,
      tasa REAL,
      monto_dop REAL,
      costo_promedio REAL DEFAULT 0,
      ganancia REAL DEFAULT 0,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`ALTER TABLE transacciones ADD COLUMN costo_promedio REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE transacciones ADD COLUMN ganancia REAL DEFAULT 0`, () => {});
});

// =========================
// PRUEBA
// =========================
app.get("/api", (req, res) => {
  res.json({ mensaje: "Servidor funcionando correctamente" });
});

// =========================
// RESUMEN
// =========================
function calcularResumen(usuario_id, callback) {
  db.all(
    `SELECT * FROM transacciones WHERE usuario_id = ? ORDER BY id ASC`,
    [usuario_id],
    (err, rows) => {
      if (err) return callback(err);

      let totalCompradoUSD = 0;
      let totalCompradoDOP = 0;
      let totalVendidoUSD = 0;
      let totalVendidoDOP = 0;
      let gananciaTotal = 0;

      rows.forEach(t => {
        if (t.tipo === "COMPRA") {
          totalCompradoUSD += Number(t.usd || 0);
          totalCompradoDOP += Number(t.monto_dop || 0);
        }

        if (t.tipo === "VENTA") {
          totalVendidoUSD += Number(t.usd || 0);
          totalVendidoDOP += Number(t.monto_dop || 0);
          gananciaTotal += Number(t.ganancia || 0);
        }
      });

      const costoPromedio =
        totalCompradoUSD > 0 ? totalCompradoDOP / totalCompradoUSD : 0;

      callback(null, {
        costo_promedio: costoPromedio,
        ganancia_total: gananciaTotal,
        total_comprado_usd: totalCompradoUSD,
        total_comprado_dop: totalCompradoDOP,
        total_vendido_usd: totalVendidoUSD,
        total_vendido_dop: totalVendidoDOP
      });
    }
  );
}

// =========================
// CREAR USUARIO
// =========================
app.post("/usuarios", (req, res) => {
  let { nombre, password, presupuesto, presupuesto_dop } = req.body;

  const presupuestoInicial = Number(presupuesto || presupuesto_dop);

  if (!nombre || !password || isNaN(presupuestoInicial)) {
    return res.status(400).json({
      error: "Debes llenar nombre, contraseña y presupuesto"
    });
  }

  db.run(
    `INSERT INTO usuarios(nombre, password, presupuesto_dop, usd_disponibles)
     VALUES (?, ?, ?, 0)`,
    [nombre.trim(), password.trim(), presupuestoInicial],
    function (err) {
      if (err) {
        if (err.message.includes("UNIQUE")) {
          return res.status(400).json({ error: "Ese usuario ya existe" });
        }

        return res.status(500).json({ error: "Error creando usuario" });
      }

      res.json({
        mensaje: "Usuario creado correctamente",
        id: this.lastID,
        nombre,
        presupuesto_dop: presupuestoInicial,
        usd_disponibles: 0
      });
    }
  );
});

// =========================
// LOGIN
// =========================
app.post("/login", (req, res) => {
  const { nombre, password } = req.body;

  if (!nombre || !password) {
    return res.status(400).json({
      error: "Faltan datos de login"
    });
  }

  db.get(
    `SELECT id, nombre, presupuesto_dop, usd_disponibles
     FROM usuarios
     WHERE nombre = ? AND password = ?`,
    [nombre.trim(), password.trim()],
    (err, user) => {
      if (err) {
        return res.status(500).json({
          error: "Error en login"
        });
      }

      if (!user) {
        return res.status(401).json({
          error: "Usuario o contraseña incorrectos"
        });
      }

      calcularResumen(user.id, (err, resumen) => {
        if (err) {
          return res.status(500).json({
            error: "Error calculando resumen"
          });
        }

        res.json({
          ...user,
          ...resumen
        });
      });
    }
  );
});

// =========================
// VER USUARIO POR ID
// =========================
app.get("/usuarios/:id", (req, res) => {
  db.get(
    `SELECT id, nombre, presupuesto_dop, usd_disponibles
     FROM usuarios
     WHERE id = ?`,
    [req.params.id],
    (err, user) => {
      if (err) {
        return res.status(500).json({
          error: "Error buscando usuario"
        });
      }

      if (!user) {
        return res.status(404).json({
          error: "Usuario no encontrado"
        });
      }

      calcularResumen(user.id, (err, resumen) => {
        if (err) {
          return res.status(500).json({
            error: "Error calculando resumen"
          });
        }

        res.json({
          ...user,
          ...resumen
        });
      });
    }
  );
});

// =========================
// COMPRAR USD
// =========================
app.post("/comprar", (req, res) => {
  const usuario_id = Number(req.body.usuario_id);
  const usd = Number(req.body.usd);
  const tasa = Number(req.body.tasa);

  if (!usuario_id || isNaN(usd) || isNaN(tasa) || usd <= 0 || tasa <= 0) {
    return res.status(400).json({
      error: "Datos inválidos para compra"
    });
  }

  const costo = usd * tasa;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) {
      return res.status(500).json({
        error: "Error buscando usuario"
      });
    }

    if (!user) {
      return res.status(404).json({
        error: "Usuario no encontrado"
      });
    }

    if (user.presupuesto_dop < costo) {
      return res.status(400).json({
        error: "Fondos insuficientes en DOP"
      });
    }

    db.run(
      `UPDATE usuarios
       SET presupuesto_dop = presupuesto_dop - ?,
           usd_disponibles = usd_disponibles + ?
       WHERE id = ?`,
      [costo, usd, usuario_id],
      err => {
        if (err) {
          return res.status(500).json({
            error: "Error realizando compra"
          });
        }

        db.run(
          `INSERT INTO transacciones(usuario_id, tipo, usd, tasa, monto_dop, costo_promedio, ganancia)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [usuario_id, "COMPRA", usd, tasa, costo, tasa, 0],
          err => {
            if (err) {
              return res.status(500).json({
                error: "Error guardando historial"
              });
            }

            res.json({
              mensaje: "Compra realizada correctamente",
              usd,
              tasa,
              costo_dop: costo
            });
          }
        );
      }
    );
  });
});

// =========================
// VENDER USD
// =========================
app.post("/vender", (req, res) => {
  const usuario_id = Number(req.body.usuario_id);
  const usd = Number(req.body.usd);
  const tasa = Number(req.body.tasa);

  if (!usuario_id || isNaN(usd) || isNaN(tasa) || usd <= 0 || tasa <= 0) {
    return res.status(400).json({
      error: "Datos inválidos para venta"
    });
  }

  const ingreso = usd * tasa;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) {
      return res.status(500).json({
        error: "Error buscando usuario"
      });
    }

    if (!user) {
      return res.status(404).json({
        error: "Usuario no encontrado"
      });
    }

    if (user.usd_disponibles < usd) {
      return res.status(400).json({
        error: "USD insuficientes"
      });
    }

    calcularResumen(usuario_id, (err, resumen) => {
      if (err) {
        return res.status(500).json({
          error: "Error calculando ganancia"
        });
      }

      const costoPromedio = resumen.costo_promedio || 0;
      const costoReal = usd * costoPromedio;
      const ganancia = ingreso - costoReal;

      db.run(
        `UPDATE usuarios
         SET presupuesto_dop = presupuesto_dop + ?,
             usd_disponibles = usd_disponibles - ?
         WHERE id = ?`,
        [ingreso, usd, usuario_id],
        err => {
          if (err) {
            return res.status(500).json({
              error: "Error realizando venta"
            });
          }

          db.run(
            `INSERT INTO transacciones(usuario_id, tipo, usd, tasa, monto_dop, costo_promedio, ganancia)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [usuario_id, "VENTA", usd, tasa, ingreso, costoPromedio, ganancia],
            err => {
              if (err) {
                return res.status(500).json({
                  error: "Error guardando historial"
                });
              }

              res.json({
                mensaje: "Venta realizada correctamente",
                usd,
                tasa,
                ingreso_dop: ingreso,
                costo_promedio: costoPromedio,
                ganancia
              });
            }
          );
        }
      );
    });
  });
});

// =========================
// REPORTES: GANANCIA POR DÍA Y MES
// =========================
app.get("/reportes/:id", (req, res) => {
  const usuario_id = req.params.id;

  db.all(
    `
    SELECT 
      DATE(fecha) as dia,
      SUM(ganancia) as ganancia_dia
    FROM transacciones
    WHERE usuario_id = ?
      AND tipo = 'VENTA'
    GROUP BY DATE(fecha)
    ORDER BY dia DESC
    `,
    [usuario_id],
    (err, gananciasDia) => {
      if (err) {
        return res.status(500).json({
          error: "Error calculando ganancia por día"
        });
      }

      db.all(
        `
        SELECT 
          STRFTIME('%Y-%m', fecha) as mes,
          SUM(ganancia) as ganancia_mes
        FROM transacciones
        WHERE usuario_id = ?
          AND tipo = 'VENTA'
        GROUP BY STRFTIME('%Y-%m', fecha)
        ORDER BY mes DESC
        `,
        [usuario_id],
        (err, gananciasMes) => {
          if (err) {
            return res.status(500).json({
              error: "Error calculando ganancia por mes"
            });
          }

          res.json({
            gananciasDia,
            gananciasMes
          });
        }
      );
    }
  );
});

// =========================
// HISTORIAL
// =========================
app.get("/historial/:id", (req, res) => {
  db.all(
    `SELECT *
     FROM transacciones
     WHERE usuario_id = ?
     ORDER BY fecha DESC`,
    [req.params.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          error: "Error cargando historial"
        });
      }

      res.json(rows);
    }
  );
});

// =========================
// SERVER
// =========================
app.listen(PORT, () => {
  console.log("=================================");
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log("=================================");
});