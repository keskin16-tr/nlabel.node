// app.js
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nunjucks = require('nunjucks'); 
// Veri işleme kütüphaneleri
const xlsx = require('xlsx');
// Düzeltme 1: csvtojson kütüphanesini doğru şekilde import edin.
const csv = require('csvtojson'); 
const qrcode = require('qrcode');

const app = express();
// DEĞİŞİKLİK 1: Render'ın atadığı portu kullanmak için eklendi.
const PORT = process.env.PORT || 3000;
const UPLOAD_FOLDER = 'uploads';
const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];

// --- Nunjucks Yapılandırması ---
// ... (Diğer Nunjucks ayarları aynı kalmıştır) ...
const env = nunjucks.configure(path.join(__dirname, 'views'), {
    autoescape: true,
    express: app,
    noCache: true // Geliştirme aşamasında önbelleği kapat
});

// Flask'taki `url_for` taklidi için Nunjucks global filtresi
env.addGlobal('url_for', (name, params) => {
// ... (url_for mantığı aynı kalmıştır) ...
    if (name === 'generate_qrcode' && params && params.data_to_encode) {
        // QR kod rotasına yönlendirme için
        return `/qrcode/${encodeURIComponent(params.data_to_encode)}`;
    }
    // Ana rotalar için
    return `/${name}`; 
});

// Flask'taki `request.endpoint` taklidi. Navbar'daki 'active' sınıfı için
env.addGlobal('request', {
    endpoint: 'login' // Varsayılan değer
});


// --- Express Yapılandırması ---
// ... (Express ve Session ayarları aynı kalmıştır) ...
app.set('view engine', 'html'); // Şablon uzantısı .html olacak
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'cok_gizli_ve_guvenli_bir_anahtar',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Yükleme klasörünü oluştur
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

// Multer ile dosya yükleme ayarları (Aynı kalmıştır)
const storage = multer.diskStorage({
// ... (Multer ayarları aynı kalmıştır) ...
    destination: (req, file, cb) => {
        cb(null, UPLOAD_FOLDER);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
            return cb(null, true);
        }
        cb(new Error('Desteklenmeyen dosya türü. Sadece CSV ve XLSX desteklenir.'));
    }
});


// --- Middleware ---
// ... (Middleware ve Oturum kontrolü aynı kalmıştır) ...
app.use((req, res, next) => {
    // Nunjucks'ta kullanmak üzere Flash mesajlarını res.locals'a taşı
    res.locals.messages = req.session.messages || [];
    req.session.messages = [];
    
    // Flask'taki request.endpoint taklidi: Aktif rotayı navbar'da göstermek için
    // Express'te bunu manuel olarak ayarlamak gerekir
    const routePath = req.path.substring(1); // '/' karakterini kaldır
    const endpoint = routePath === '' ? 'upload' : routePath.split('/')[0];
    env.addGlobal('request', { endpoint: endpoint });
    
    // Nunjucks'ın session değişkenine doğrudan erişimini sağla
    env.addGlobal('session', req.session);

    next();
});

// Oturum kontrolü (Aynı kalmıştır)
const loginRequired = (req, res, next) => {
    if (req.session.logged_in) {
        return next();
    }
    req.session.messages = req.session.messages || []; // Yeni bir dizi oluştur
    req.session.messages.push({ category: 'danger', message: 'Bu sayfaya erişmek için giriş yapmalısınız.' });
    res.redirect('/login');
};

// --- Rotalar ---

// ... (Login, Logout rotaları aynı kalmıştır) ...

app.post('/upload', loginRequired, upload.single('file'), async (req, res) => {
    if (!req.file) {
        req.session.messages.push({ category: 'danger', message: 'Lütfen bir dosya seçin.' });
        return res.redirect('/upload');
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    try {
        let data;
        
        if (fileExt === '.xlsx') {
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            // Pandas'a benzer bir JSON dizisine dönüştürme
            data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        } else if (fileExt === '.csv') {
            // Düzeltme 2: csvtojson kütüphanesinin doğru kullanımı.
            data = await csv().fromFile(filePath); 
        } else {
            throw new Error('Geçersiz dosya uzantısı.');
        }

        if (data.length > 0) {
// ... (Dosya işleme ve yönlendirme mantığı aynı kalmıştır) ...
            const columns = Object.keys(data[0]);
            req.session.data_table = data;
            req.session.columns = columns;
            // Dosyayı başarılı yüklendikten sonra sil
            fs.unlink(filePath, (err) => { if (err) console.error("Geçici dosya silinemedi:", err); });

            req.session.messages.push({ category: 'success', message: `${req.file.originalname} başarıyla yüklendi. ${data.length} satır veri okundu.` });
            res.redirect('/table_view');
        } else {
            fs.unlink(filePath, (err) => { if (err) console.error("Geçici dosya silinemedi:", err); });
            req.session.messages.push({ category: 'warning', message: 'Dosya yüklendi ancak içinde veri bulunamadı.' });
            res.redirect('/upload');
        }

    } catch (error) {
        console.error("Dosya işleme hatası:", error);
        fs.unlink(filePath, (err) => { if (err) console.error("Geçici dosya silinemedi:", err); });
        req.session.messages.push({ category: 'danger', message: `Veri işlenirken bir hata oluştu: ${error.message}` });
        res.redirect('/upload');
    }
});


// ... (Diğer rotalar aynı kalmıştır) ...

// Varsayılan ana sayfayı upload'a yönlendir
app.get('/', (req, res) => {
    res.redirect('/upload');
});


// Sunucuyu Başlat
app.listen(PORT, () => {
    // Port dinamik olarak Render tarafından atanacaktır.
    console.log(`Server çalışıyor: http://localhost:${PORT}`);
});
