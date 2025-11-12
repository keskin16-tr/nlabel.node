// app.js — Render.com uyumlu Express/Nunjucks etiket yazdırma uygulaması

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

// --- Nunjucks Ayarları ---
const env = nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true,
  express: app,
  noCache: process.env.NODE_ENV !== "production",
});

// Flask’taki url_for yerine basit bir yardımcı
env.addGlobal("url_for", (route) => `/${route}`);

// --- Express Ayarları ---
app.set("view engine", "html");
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "super_guvenli_anahtar",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// Upload klasörü yoksa oluştur
if (!fs.existsSync(UPLOAD_FOLDER)) fs.mkdirSync(UPLOAD_FOLDER);

// --- Multer Dosya Yükleme Ayarları ---
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_FOLDER),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error("Sadece CSV ve XLSX dosyaları desteklenir."));
  },
});

// --- Middleware ---
app.use((req, res, next) => {
  res.locals.messages = req.session.messages || [];
  req.session.messages = [];
  res.locals.session = req.session;
  next();
});

// --- Login kontrolü ---
const loginRequired = (req, res, next) => {
  if (req.session.logged_in) return next();
  req.session.messages = [{ category: "danger", message: "Lütfen giriş yapın." }];
  res.redirect("/login");
};

// --- ROUTES ---

// Login Sayfası
app.get("/login", (req, res) => {
  res.render("login.html", { title: "Kullanıcı Girişi", messages: res.locals.messages });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "1234") {
    req.session.logged_in = true;
    req.session.username = username;
    req.session.messages.push({ category: "success", message: `Hoş geldiniz, ${username}!` });
    res.redirect("/upload");
  } else {
    req.session.messages.push({ category: "danger", message: "Kullanıcı adı veya parola hatalı." });
    res.redirect("/login");
  }
});

app.get("/", (_, res) => res.redirect("/login"));

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// --- Upload Sayfası ---
app.get("/upload", loginRequired, (req, res) => {
  res.render("upload.html", { title: "Dosya Yükleme", messages: res.locals.messages });
});

app.post("/upload", loginRequired, upload.single("file"), async (req, res) => {
  if (!req.file) {
    req.session.messages.push({ category: "danger", message: "Lütfen bir dosya seçin." });
    return res.redirect("/upload");
  }

  const filePath = req.file.path;
  const fileExt = path.extname(req.file.originalname).toLowerCase();

  try {
    let data;
    if (fileExt === ".xlsx") {
      const wb = xlsx.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      data = xlsx.utils.sheet_to_json(ws);
    } else if (fileExt === ".csv") {
      data = await csv().fromFile(filePath);
    }

    fs.unlink(filePath, () => {});
    if (!data || data.length === 0) {
      req.session.messages.push({ category: "warning", message: "Dosya yüklendi ancak veri yok." });
      return res.redirect("/upload");
    }

    req.session.data_table = data;
    req.session.columns = Object.keys(data[0]);
    req.session.messages.push({
      category: "success",
      message: `${req.file.originalname} başarıyla yüklendi. (${data.length} satır okundu)`,
    });
    res.redirect("/table_view");
  } catch (err) {
    console.error("Yükleme hatası:", err);
    req.session.messages.push({ category: "danger", message: `Hata: ${err.message}` });
    res.redirect("/upload");
  }
});

// --- Veri Tablosu Sayfası ---
app.get("/table_view", loginRequired, (req, res) => {
  res.render("table_view.html", {
    title: "Veri Tablosu",
    columns: req.session.columns || [],
    data: req.session.data_table || [],
    template_set: true,
    messages: res.locals.messages,
  });
});

app.post("/table_view", loginRequired, (req, res) => {
  const selected = Array.isArray(req.body.selected_rows)
    ? req.body.selected_rows.map((i) => parseInt(i))
    : [parseInt(req.body.selected_rows || -1)].filter((x) => x >= 0);

  const allData = req.session.data_table || [];
  const selectedData = selected.map((i) => allData[i]).filter(Boolean);

  if (selectedData.length === 0) {
    req.session.messages.push({ category: "warning", message: "Hiç satır seçilmedi." });
    return res.redirect("/table_view");
  }

  req.session.selected_data_for_print = selectedData;
  req.session.messages.push({
    category: "success",
    message: `${selectedData.length} satır yazdırmaya hazırlandı.`,
  });
  res.redirect("/print_preview");
});

// --- QR Code ---
app.get("/qrcode/:data", async (req, res) => {
  try {
    const buffer = await qrcode.toBuffer(req.params.data, { errorCorrectionLevel: "H" });
    res.type("png").send(buffer);
  } catch (err) {
    console.error("QR Code Hatası:", err);
    res.status(500).send("QR Code oluşturulamadı.");
  }
});

// --- Yazdırma Önizlemesi ---
app.get("/print_preview", loginRequired, (req, res) => {
  const data = req.session.selected_data_for_print || [];
  if (data.length === 0) {
    req.session.messages.push({ category: "warning", message: "Yazdırılacak veri yok." });
    return res.redirect("/table_view");
  }

  const labels = data
    .map((row) => {
      return `
        <div class="etiket-kutu">
            <div class="etiket-grid">
                <div class="label-cell" style="grid-column: span 2;">Ürün Adı:</div>
                <div class="label-cell" style="grid-column: span 2;">${row.URUN_ADI || ""}</div>
                <div class="label-cell" style="grid-column: span 2;" rowspan="3">
                    <img src="/qrcode/${encodeURIComponent(row.SERI_NO || "BOS")}" alt="QR">
                </div>

                <div class="label-cell" style="grid-column: span 2;">Model:</div>
                <div class="label-cell" style="grid-column: span 2;">${row.MODEL || ""}</div>
                <div class="label-cell" style="grid-column: span 2;">Seri No:</div>
                <div class="label-cell" style="grid-column: span 2;">${row.SERI_NO || ""}</div>
            </div>
        </div>`;
    })
    .join("\n");

  res.render("print_preview.html", {
    title: "Yazdırma Önizlemesi",
    labels,
    messages: res.locals.messages,
  });
});

// --- Sunucuyu Başlat ---
app.listen(PORT, () => {
  console.log(`✅ Sunucu çalışıyor: http://localhost:${PORT}`);
});
