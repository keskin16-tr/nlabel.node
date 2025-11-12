// app.js
//-----------------------------------------------------------
// Flask Etiket Sistemi'nin Node.js (Express + Nunjucks) versiyonu
//-----------------------------------------------------------

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nunjucks = require("nunjucks");
const xlsx = require("xlsx");
const csv = require("csvtojson");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_FOLDER = "uploads";
const ALLOWED_EXTENSIONS = [".csv", ".xlsx"];

// -----------------------------------------------------------
// Nunjucks yapılandırması
// -----------------------------------------------------------
const env = nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true,
  express: app,
  noCache: true,
});

env.addGlobal("url_for", (name, params) => {
  if (name === "generate_qrcode" && params?.data_to_encode) {
    return `/qrcode/${encodeURIComponent(params.data_to_encode)}`;
  }
  return `/${name}`;
});

env.addGlobal("request", { endpoint: "login" });

// -----------------------------------------------------------
// Express yapılandırması
// -----------------------------------------------------------
app.set("view engine", "html");
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "etiket-nodejs-gizli-anahtar",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// Upload klasörü yoksa oluştur
if (!fs.existsSync(UPLOAD_FOLDER)) {
  fs.mkdirSync(UPLOAD_FOLDER);
}

// -----------------------------------------------------------
// Multer dosya yükleme ayarları
// -----------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_FOLDER),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_")),
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
    cb(new Error("Sadece .csv ve .xlsx dosyaları destekleniyor."));
  },
});

// -----------------------------------------------------------
// Middleware
// -----------------------------------------------------------
app.use((req, res, next) => {
  res.locals.messages = req.session.messages || [];
  req.session.messages = [];

  const routePath = req.path.substring(1);
  const endpoint = routePath === "" ? "upload" : routePath.split("/")[0];
  env.addGlobal("request", { endpoint });
  env.addGlobal("session", req.session);
  next();
});

const loginRequired = (req, res, next) => {
  if (req.session.logged_in) return next();
  req.session.messages = [
    { category: "danger", message: "Bu sayfaya erişmek için giriş yapmalısınız." },
  ];
  res.redirect("/login");
};

// -----------------------------------------------------------
// 1️⃣ LOGIN
// -----------------------------------------------------------
app.get("/login", (req, res) => {
  res.render("login.html", { title: "Kullanıcı Girişi" });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "1234") {
    req.session.logged_in = true;
    req.session.username = username;
    req.session.messages = [{ category: "success", message: `Hoş geldiniz, ${username}!` }];
    return res.redirect("/upload");
  }
  req.session.messages = [{ category: "danger", message: "Geçersiz kullanıcı adı veya parola." }];
  res.redirect("/login");
});

app.get("/", (req, res) => res.redirect("/login"));

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// -----------------------------------------------------------
// 2️⃣ DOSYA YÜKLEME
// -----------------------------------------------------------
app.get("/upload", loginRequired, (req, res) => {
  res.render("upload.html", { title: "Dosya Yükleme" });
});

app.post("/upload", loginRequired, upload.single("file"), async (req, res) => {
  if (!req.file) {
    req.session.messages.push({ category: "danger", message: "Lütfen bir dosya seçin." });
    return res.redirect("/upload");
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    let data = [];

    if (ext === ".xlsx") {
      const wb = xlsx.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      data = xlsx.utils.sheet_to_json(ws);
    } else if (ext === ".csv") {
      data = await csv().fromFile(filePath);
    }

    fs.unlink(filePath, () => {});

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
      message: `${req.file.originalname} başarıyla yüklendi. ${data.length} satır okundu.`,
    });
    res.redirect("/table_view");
  } catch (err) {
    console.error("Dosya işleme hatası:", err);
    fs.unlink(filePath, () => {});
    req.session.messages.push({
      category: "danger",
      message: `Veri işlenirken hata oluştu: ${err.message}`,
    });
    res.redirect("/upload");
  }
});

// -----------------------------------------------------------
// 3️⃣ TABLO GÖRÜNÜMÜ
// -----------------------------------------------------------
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
      message: "Lütfen en az bir satır seçin.",
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
// -----------------------------------------------------------
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
      "Cache-Control": "public, max-age=31557600",
    });
    res.end(qr);
  } catch (err) {
    console.error("QR kod hatası:", err);
    res.status(500).send("QR kod oluşturulamadı.");
  }
});

// -----------------------------------------------------------
// 5️⃣ YAZDIRMA ÖNİZLEMESİ
// -----------------------------------------------------------
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
        (key) => `<div class="label-cell"><b>${key}</b>: ${row[key] || ""}</div>`
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
// Sunucu
// -----------------------------------------------------------
app.listen(PORT, () =>
  console.log(`✅ Server çalışıyor: http://localhost:${PORT}`)
);
