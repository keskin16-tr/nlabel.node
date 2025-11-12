// app.js
//-----------------------------------------------------------
// Flask Etiket Sistemi'nin Render uyumlu Node.js (Express + Nunjucks) sürümü
//-----------------------------------------------------------

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const nunjucks = require("nunjucks");
const xlsx = require("xlsx");
const csv = require("csvtojson");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------
// Nunjucks yapılandırması (Render uyumlu)
nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true,
  express: app,
  noCache: true,
});
app.set("view engine", "html");

// -----------------------------------------------------------
// Express yapılandırması
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "render_node_etiket_secret",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 6 * 60 * 60 * 1000 }, // 6 saatlik session
  })
);

// -----------------------------------------------------------
// Multer (RAM üzerinde çalışacak şekilde - Render uyumlu)
const upload = multer({ storage: multer.memoryStorage() });

// -----------------------------------------------------------
// Middleware
app.use((req, res, next) => {
  res.locals.messages = req.session.messages || [];
  req.session.messages = [];
  next();
});

// Giriş kontrolü
function loginRequired(req, res, next) {
  if (req.session.logged_in) return next();
  req.session.messages = [
    { category: "danger", message: "Bu sayfaya erişmek için giriş yapmalısınız." },
  ];
  return res.redirect("/login");
}

// -----------------------------------------------------------
// 1️⃣ LOGIN
app.get("/login", (req, res) => {
  res.render("login.html", { title: "Giriş Yap" });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "1234") {
    req.session.logged_in = true;
    req.session.username = username;
    req.session.messages = [
      { category: "success", message: `Hoş geldiniz, ${username}!` },
    ];
    return res.redirect("/upload");
  }
  req.session.messages = [
    { category: "danger", message: "Geçersiz kullanıcı adı veya parola." },
  ];
  res.redirect("/login");
});

app.get("/", (req, res) => res.redirect("/login"));

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// -----------------------------------------------------------
// 2️⃣ DOSYA YÜKLEME (Render uyumlu: memoryStorage)
app.get("/upload", loginRequired, (req, res) => {
  res.render("upload.html", { title: "Dosya Yükleme" });
});

app.post("/upload", loginRequired, upload.single("file"), async (req, res) => {
  if (!req.file) {
    req.session.messages.push({
      category: "danger",
      message: "Lütfen bir dosya seçin.",
    });
    return res.redirect("/upload");
  }

  const buffer = req.file.buffer;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    let data = [];

    if (ext === ".xlsx") {
      const wb = xlsx.read(buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      data = xlsx.utils.sheet_to_json(ws);
    } else if (ext === ".csv") {
      const text = buffer.toString("utf8");
      data = await csv().fromString(text);
    } else {
      throw new Error("Desteklenmeyen dosya türü. Sadece CSV ve XLSX desteklenir.");
    }

    if (!data.length) {
      req.session.messages.push({
        category: "warning",
        message: "Dosya yüklendi ancak içinde veri bulunamadı.",
      });
      return res.redirect("/upload");
    }

    req.session.data_table = data;
    req.session.columns = Object.keys(data[0]);
    req.session.messages.push({
      category: "success",
      message: `${req.file.originalname} başarıyla yüklendi (${data.length} satır).`,
    });

    res.redirect("/table_view");
  } catch (err) {
    console.error("Yükleme hatası:", err);
    req.session.messages.push({
      category: "danger",
      message: `Dosya okunamadı: ${err.message}`,
    });
    res.redirect("/upload");
  }
});

// -----------------------------------------------------------
// 3️⃣ TABLO GÖRÜNÜMÜ
app.get("/table_view", loginRequired, (req, res) => {
  res.render("table_view.html", {
    title: "Veri Tablosu",
    columns: req.session.columns || [],
    data: req.session.data_table || [],
    template_set: true,
  });
});

app.post("/prepare_for_print", loginRequired, (req, res) => {
  const selectedRows = Array.isArray(req.body.selected_rows)
    ? req.body.selected_rows.map(Number)
    : req.body.selected_rows
    ? [Number(req.body.selected_rows)]
    : [];

  if (!selectedRows.length) {
    req.session.messages.push({
      category: "warning",
      message: "Lütfen yazdırmak için en az bir satır seçin.",
    });
    return res.redirect("/table_view");
  }

  const allData = req.session.data_table || [];
  req.session.selected_data_for_print = selectedRows
    .map((i) => allData[i])
    .filter(Boolean);

  req.session.messages.push({
    category: "success",
    message: `${selectedRows.length} satır yazdırmaya hazırlandı.`,
  });
  res.redirect("/print_preview");
});

// -----------------------------------------------------------
// 4️⃣ QR CODE
app.get("/qrcode/:data_to_encode", async (req, res) => {
  try {
    const qr = await qrcode.toBuffer(req.params.data_to_encode, {
      errorCorrectionLevel: "H",
      type: "image/png",
      scale: 8,
    });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": qr.length,
    });
    res.end(qr);
  } catch (err) {
    console.error("QR Kod hatası:", err);
    res.status(500).send("QR Kod oluşturulamadı.");
  }
});

// -----------------------------------------------------------
// 5️⃣ YAZDIRMA ÖNİZLEMESİ
app.get("/print_preview", loginRequired, (req, res) => {
  const dataToPrint = req.session.selected_data_for_print || [];
  if (!dataToPrint.length) {
    req.session.messages.push({
      category: "warning",
      message: "Yazdırmak için seçilmiş veri yok.",
    });
    return res.redirect("/table_view");
  }

  const cols = req.session.columns || [];
  const labelsHtml = dataToPrint.map((row) => {
    const cells = cols
      .map(
        (key) =>
          `<div class="label-cell"><b>${key}</b>: ${row[key] || ""}</div>`
      )
      .join("");
    return `<div class="etiket-kutu"><div class="etiket-grid">${cells}</div></div>`;
  });

  res.render("print_preview.html", {
    title: "Yazdırma Önizlemesi",
    labels: labelsHtml,
  });
});

// -----------------------------------------------------------
// Sunucu (Render uyumlu)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server aktif: http://localhost:${PORT}`);
});
