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

// TABLAS
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
  costo_promedio REAL DEFAULT 0,
  ganancia_total REAL DEFAULT 0
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
  cliente_nombre TEXT,
  cliente_documento TEXT,
  monto_usd REAL,
  tasa REAL,
  monto_dop REAL,
  ganancia REAL DEFAULT 0,
  costo_promedio REAL DEFAULT 0,
  fecha TEXT DEFAULT CURRENT_TIMESTAMP
)
  `);

  db.get("SELECT * FROM usuarios WHERE rol = 'admin'", async (err, admin) => {
    if (!admin) {
      const pass = await bcrypt.hash("admin123", 10);
      db.run(
        "INSERT INTO usuarios (nombre, password, rol, presupuesto_dop, usd_disponibles) VALUES (?, ?, ?, ?, ?)",
        ["admin", pass, "admin", 0, 0]
      );
      console.log("Admin creado: usuario admin / clave admin123");
    }
  });
});

// LOGIN
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
      presupuesto_dop: user.presupuesto_dop,
      usd_disponibles: user.usd_disponibles
    });
  });
});

// CREAR CAJERO - SOLO ADMIN
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
      "INSERT INTO usuarios (nombre, password, rol) VALUES (?, ?, ?)",
      [nombre, hash, rol || "cajero"],
      function (err) {
        if (err) return res.status(500).json({ error: "Error creando usuario" });
        res.json({ mensaje: "Usuario creado", id: this.lastID });
      }
    );
  });
});

// LISTAR USUARIOS - SOLO ADMIN
app.get("/usuarios/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede ver usuarios" });

    db.all(
      "SELECT id, nombre, rol, activo, presupuesto_dop, usd_disponibles FROM usuarios ORDER BY id ASC",
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Error listando usuarios" });
        res.json(rows);
      }
    );
  });
});

// ACTIVAR / DESACTIVAR USUARIO
app.put("/usuarios/:id/estado", (req, res) => {
  const { id } = req.params;
  const { admin_id, activo } = req.body;

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede cambiar estado" });

    db.run("UPDATE usuarios SET activo = ? WHERE id = ?", [activo, id], (err) => {
      if (err) return res.status(500).json({ error: "Error actualizando estado" });
      res.json({ mensaje: "Estado actualizado" });
    });
  });
});
// ASIGNAR / RETIRAR FONDOS DOP O USD - SOLO ADMIN
app.post("/fondos", (req, res) => {
  const { admin_id, cajero_id, tipo, moneda, monto } = req.body;
  const cantidad = Number(monto);
  const monedaFinal = moneda || "DOP";

  if (!["asignar", "retirar"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo inválido" });
  }

  if (!["DOP", "USD"].includes(monedaFinal)) {
    return res.status(400).json({ error: "Moneda inválida" });
  }

  if (!cantidad || cantidad <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'", [admin_id], (err, admin) => {
    if (err) return res.status(500).json({ error: "Error buscando admin" });
    if (!admin) return res.status(403).json({ error: "Solo admin puede mover fondos" });

    db.get("SELECT * FROM usuarios WHERE id = ? AND rol = 'cajero'", [cajero_id], (err, cajero) => {
      if (err) return res.status(500).json({ error: "Error buscando cajero" });
      if (!cajero) return res.status(404).json({ error: "Cajero no encontrado" });

      const campo = monedaFinal === "DOP" ? "presupuesto_dop" : "usd_disponibles";

      if (tipo === "asignar") {
        if (Number(admin[campo]) < cantidad) {
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
        if (Number(cajero[campo]) < cantidad) {
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

// MODIFICAR PRESUPUESTO GENERAL DOP DEL ADMIN
app.post("/admin/presupuesto", (req, res) => {
  const { admin_id, tipo, monto } = req.body;
  const cantidad = Number(monto);

  if (!cantidad || cantidad <= 0) {
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
      if (Number(admin.presupuesto_dop) < cantidad) {
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

// MODIFICAR USD GENERAL DEL ADMIN
app.post("/admin/usd", (req, res) => {
  const { admin_id, tipo, monto } = req.body;
  const cantidad = Number(monto);

  if (!cantidad || cantidad <= 0) {
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
      if (Number(admin.usd_disponibles) < cantidad) {
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

// COMPRA USD
// COMPRA USD
app.post("/compra", (req, res) => {
  const { usuario_id, cliente_nombre, cliente_documento, monto_dop, tasa } = req.body;

  const dop = Number(monto_dop);
  const tasaNum = Number(tasa);
  const usd = dop / tasaNum;

  if (!dop || !tasaNum || dop <= 0 || tasaNum <= 0) {
    return res.status(400).json({ error: "Monto y tasa son obligatorios" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (Number(user.presupuesto_dop) < dop) {
      return res.status(400).json({ error: "Fondos DOP insuficientes" });
    }

    const usdActual = Number(user.usd_disponibles || 0);
    const costoActual = Number(user.costo_promedio || 0);

    const nuevoCostoPromedio =
      usdActual + usd > 0
        ? ((usdActual * costoActual) + dop) / (usdActual + usd)
        : tasaNum;

    db.run(
      `UPDATE usuarios
       SET presupuesto_dop = presupuesto_dop - ?,
           usd_disponibles = usd_disponibles + ?,
           costo_promedio = ?
       WHERE id = ?`,
      [dop, usd, nuevoCostoPromedio, usuario_id],
      (err) => {
        if (err) return res.status(500).json({ error: "Error registrando compra" });

        db.run(
          `INSERT INTO transacciones 
          (usuario_id, tipo, cliente_nombre, cliente_documento, monto_usd, tasa, monto_dop, ganancia, costo_promedio)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [usuario_id, "compra", cliente_nombre, cliente_documento, usd, tasaNum, dop, 0, nuevoCostoPromedio],
          (err) => {
            if (err) {
              console.log("ERROR INSERT COMPRA:", err.message);
              return res.status(500).json({ error: "Error guardando compra: " + err.message });
            }

            res.json({
              mensaje: "Compra registrada",
              usd,
              costo_promedio: nuevoCostoPromedio
            });
          }
        );
      }
    );
  });
});
// VENTA USD
// VENTA USD
app.post("/venta", (req, res) => {
  const { usuario_id, cliente_nombre, cliente_documento, monto_usd, tasa } = req.body;

  const usd = Number(monto_usd);
  const tasaNum = Number(tasa);
  const dop = usd * tasaNum;

  if (!usd || !tasaNum || usd <= 0 || tasaNum <= 0) {
    return res.status(400).json({ error: "USD y tasa son obligatorios" });
  }

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (Number(user.usd_disponibles) < usd) {
      return res.status(400).json({ error: "USD insuficientes" });
    }

    const costoPromedio = Number(user.costo_promedio || 0);
    const ganancia = (tasaNum - costoPromedio) * usd;

    db.run(
      `UPDATE usuarios
       SET usd_disponibles = usd_disponibles - ?,
           presupuesto_dop = presupuesto_dop + ?,
           ganancia_total = ganancia_total + ?
       WHERE id = ?`,
      [usd, dop, ganancia, usuario_id],
      (err) => {
        if (err) return res.status(500).json({ error: "Error registrando venta" });

        db.run(
          `INSERT INTO transacciones
          (usuario_id, tipo, cliente_nombre, cliente_documento, monto_usd, tasa, monto_dop, ganancia, costo_promedio)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [usuario_id, "venta", cliente_nombre, cliente_documento, usd, tasaNum, dop, ganancia, costoPromedio],
          (err) => {
            if (err) return res.status(500).json({ error: "Error guardando venta" });

            res.json({
              mensaje: "Venta registrada",
              dop,
              ganancia,
              costo_promedio: costoPromedio
            });
          }
        );
      }
    );
  });
});

// BALANCE
app.get("/balance/:id", (req, res) => {
  db.get(
    `SELECT 
      id, 
      nombre, 
      rol, 
      presupuesto_dop, 
      usd_disponibles,
      costo_promedio,
      ganancia_total
    FROM usuarios 
    WHERE id = ?`,
    [req.params.id],
    (err, user) => {
      if (err) return res.status(500).json({ error: "Error buscando balance" });
      if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
      res.json(user);
    }
  );
});
// HISTORIAL DE OPERACIONES
app.get("/historial/:usuario_id", (req, res) => {
  const { usuario_id } = req.params;

  db.get("SELECT * FROM usuarios WHERE id = ?", [usuario_id], (err, user) => {
    if (err) return res.status(500).json({ error: "Error buscando usuario" });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (user.rol === "admin") {
      db.all(
        "SELECT * FROM transacciones ORDER BY id DESC",
        [],
        (err, rows) => {
          if (err) return res.status(500).json({ error: "Error cargando historial: " + err.message });
          res.json(rows);
        }
      );
    } else {
      db.all(
        "SELECT * FROM transacciones WHERE usuario_id = ? ORDER BY id DESC",
        [usuario_id],
        (err, rows) => {
          if (err) return res.status(500).json({ error: "Error cargando historial: " + err.message });
          res.json(rows);
        }
      );
    }
  });
});
// HISTORIAL DE FONDOS
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
      ORDER BY mf.fecha DESC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: "Error cargando historial de fondos" });
        res.json(rows);
      }
    );
  });
});
app.get("/historial-fondos/:admin_id", (req, res) => {
  const { admin_id } = req.params;

  db.get(
    "SELECT * FROM usuarios WHERE id = ? AND rol = 'admin'",
    [admin_id],
    (err, admin) => {
      if (err) return res.status(500).json({ error: "Error buscando admin" });
      if (!admin) return res.status(403).json({ error: "Solo admin puede ver historial de fondos" });

      db.all(
        `
        SELECT 
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
        ORDER BY mf.id DESC
        `,
        [],
        (err, rows) => {
          if (err) return res.status(500).json({ error: "Error cargando historial de fondos" });
          res.json(rows);
        }
      );
    }
  );
});
// REPORTES DE GANANCIA
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

    db.get(
      `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_hoy
       FROM transacciones
       ${filtro ? filtro + " AND" : "WHERE"} tipo = 'venta'
       AND date(fecha) = date('now')`,
      params,
      (err, hoy) => {
        if (err) return res.status(500).json({ error: "Error calculando ganancia hoy" });

        db.get(
          `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_mes
           FROM transacciones
           ${filtro ? filtro + " AND" : "WHERE"} tipo = 'venta'
           AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now')`,
          params,
          (err, mes) => {
            if (err) return res.status(500).json({ error: "Error calculando ganancia mes" });

            db.get(
              `SELECT COALESCE(SUM(ganancia), 0) AS ganancia_total
               FROM transacciones
               ${filtro ? filtro + " AND" : "WHERE"} tipo = 'venta'`,
              params,
              (err, total) => {
                if (err) return res.status(500).json({ error: "Error calculando ganancia total" });

                res.json({
                  ganancia_hoy: hoy.ganancia_hoy || 0,
                  ganancia_mes: mes.ganancia_mes || 0,
                  ganancia_total: total.ganancia_total || 0,
                  costo_promedio: user.costo_promedio || 0
                });
              }
            );
          }
        );
      }
    );
  });
});
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

      const usd = Number(t.monto_usd || 0);
      const dop = Number(t.monto_dop || 0);
      const ganancia = Number(t.ganancia || 0);

      let updateUsuario = "";
      let valores = [];

      if (t.tipo === "compra") {
        updateUsuario = `
          UPDATE usuarios
          SET presupuesto_dop = presupuesto_dop + ?,
              usd_disponibles = usd_disponibles - ?
          WHERE id = ?
        `;
        valores = [dop, usd, t.usuario_id];
      } else if (t.tipo === "venta") {
        updateUsuario = `
          UPDATE usuarios
          SET presupuesto_dop = presupuesto_dop - ?,
              usd_disponibles = usd_disponibles + ?,
              ganancia_total = ganancia_total - ?
          WHERE id = ?
        `;
        valores = [dop, usd, ganancia, t.usuario_id];
      } else {
        return res.status(400).json({ error: "Tipo de transacción inválido" });
      }

      db.run(updateUsuario, valores, (err) => {
        if (err) return res.status(500).json({ error: "Error revirtiendo balance" });

        db.run(
          `UPDATE transacciones
           SET anulada = 1,
               motivo_anulacion = ?,
               admin_anulo_id = ?,
               fecha_anulacion = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [motivo || "Sin motivo", admin_id, transaccion_id],
          (err) => {
            if (err) return res.status(500).json({ error: "Error anulando transacción" });

            res.json({ mensaje: "Transacción anulada correctamente" });
          }
        );
      });
    });
  });
});
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
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});