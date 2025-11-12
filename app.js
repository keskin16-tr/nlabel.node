// app.js
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nunjucks = require('nunjucks'); 
// Veri işleme kütüphaneleri
const xlsx = require('xlsx');
// KRİTİK DÜZELTME: csvtojson kütüphanesini doğru şekilde import edin.
const csv = require('csvtojson'); 
const qrcode = require('qrcode');

const app = express();
// RENDER UYUMLULUĞU DÜZELTİLDİ: Dinamik portu kullan
const PORT = process.env.PORT || 3000; 
const UPLOAD_FOLDER = 'uploads';
const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];

// --- Nunjucks Yapılandırması ---
const env = nunjucks.configure(path.join(__dirname, 'views'), {
    autoescape: true,
    express: app,
    noCache: true 
});

// Flask'taki `url_for` taklidi için Nunjucks global filtresi
env.addGlobal('url_for', (name, params) => {
    if (name === 'generate_qrcode' && params && params.data_to_encode) {
        return `/qrcode/${encodeURIComponent(params.data_to_encode)}`;
    }
    return `/${name}`; 
});

// Flask'taki `request.endpoint` taklidi.
env.addGlobal('request', {
    endpoint: 'login' 
});


// --- Express Yapılandırması ---
app.set('view engine', 'html'); 
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

// Multer ile dosya yükleme ayarları
const storage = multer.diskStorage({
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
app.use((req, res, next) => {
    res.locals.messages = req.session.messages || [];
    req.session.messages = [];
    
    const routePath = req.path.substring(1); 
    const endpoint = routePath === '' ? 'upload' : routePath.split('/')[0];
    env.addGlobal('request', { endpoint: endpoint });
    
    env.addGlobal('session', req.session);

    next();
});

// Oturum kontrolü
const loginRequired = (req, res, next) => {
    if (req.session.logged_in) {
        return next();
    }
    req.session.messages = req.session.messages || []; 
    req.session.messages.push({ category: 'danger', message: 'Bu sayfaya erişmek için giriş yapmalısınız.' });
    res.redirect('/login');
};

// --- Rotalar ---

// 1. GİRİŞ (LOGIN) ROTASI - En üstte olmalı
app.get('/login', (req, res) => {
    res.render('login.html', { title: 'Kullanıcı Girişi', form: {} });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '1234') {
        req.session.logged_in = true;
        req.session.username = username;
        req.session.messages = req.session.messages || [];
        req.session.messages.push({ category: 'success', message: `Hoş geldiniz, ${username}!` });
        res.redirect('/upload');
    } else {
        req.session.messages = req.session.messages || [];
        req.session.messages.push({ category: 'danger', message: 'Geçersiz kullanıcı adı veya parola.' });
        res.redirect('/login');
    }
});

// 2. KÖK DİZİN YÖNLENDİRMESİ - Uygulama açılışında /login'e yönlendirir.
app.get('/', (req, res) => {
    res.redirect('/login'); 
});


// Çıkış (Logout)
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error(err);
        }
        res.redirect('/login');
    });
});

// Yükleme (Upload) - loginRequired ile korunuyor
app.get('/upload', loginRequired, (req, res) => {
    res.render('upload.html', { title: 'Dosya Yükleme' });
});

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
            data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        } else if (fileExt === '.csv') {
            // DÜZELTME KULLANILDI: csvtojson kütüphanesinin doğru kullanımı.
            data = await csv().fromFile(filePath); 
        } else {
            throw new Error('Geçersiz dosya uzantısı.');
        }

        if (data.length > 0) {
            const columns = Object.keys(data[0]);
            req.session.data_table = data;
            req.session.columns = columns;
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


// Veri Tablosu (Table View) - loginRequired ile korunuyor
app.get('/table_view', loginRequired, (req, res) => {
    const templateSet = true; 
    
    res.render('table_view.html', { 
        title: 'Veri Tablosu',
        columns: req.session.columns || [],
        data: req.session.data_table || [],
        template_set: templateSet
    });
});

// Yazdırmaya Hazırlık Rotası (POST)
app.post('/prepare_for_print', loginRequired, (req, res) => {
    const selectedRowIndexes = Array.isArray(req.body.selected_rows) 
        ? req.body.selected_rows.map(index => parseInt(index, 10))
        : req.body.selected_rows 
            ? [parseInt(req.body.selected_rows, 10)] 
            : [];

    if (selectedRowIndexes.length === 0) {
        req.session.messages.push({ category: 'warning', message: 'Lütfen yazdırmak için en az bir satır seçin.' });
        return res.redirect('/table_view');
    }
    
    const allData = req.session.data_table || [];
    const selectedData = selectedRowIndexes.map(index => allData[index]).filter(row => row !== undefined);
    
    if (selectedData.length === 0) {
        req.session.messages.push({ category: 'danger', message: 'Seçilen satır verileri bulunamadı.' });
        return res.redirect('/table_view');
    }

    req.session.selected_data_for_print = selectedData;
    req.session.messages.push({ category: 'success', message: `${selectedData.length} satır yazdırmaya hazırlandı.` });
    res.redirect('/print_preview');
});

// QR Kod Oluşturma Rotası
app.get('/qrcode/:data_to_encode', async (req, res) => {
    try {
        const dataToEncode = req.params.data_to_encode; 
        
        const qrCodeBuffer = await qrcode.toBuffer(dataToEncode, {
             errorCorrectionLevel: 'H',
             type: 'image/png',
             scale: 8
        });
        
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': qrCodeBuffer.length,
            'Cache-Control': 'public, max-age=31557600' 
        });
        res.end(qrCodeBuffer);

    } catch (err) {
        console.error('QR Kod oluşturma hatası:', err);
        res.status(500).send('QR Kod oluşturulurken bir hata oluştu.');
    }
});

// Yazdırma Önizlemesi (Print Preview) - loginRequired ile korunuyor
app.get('/print_preview', loginRequired, (req, res) => {
    const dataToPrint = req.session.selected_data_for_print || [];
    
    if (dataToPrint.length === 0) {
        req.session.messages.push({ category: 'warning', message: 'Yazdırmak için seçilmiş veri bulunamadı.' });
        return res.redirect('/table_view');
    }

    // STATİK ŞABLON TANIMI
    const defaultTemplate = [
        { "id": "cell1", "type": "static_text", "content": "Ürün Adı:", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "10pt", "color": "#000000", "bg_color": "" }},
        { "id": "cell2", "type": "text", "name": "URUN_ADI", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "10pt", "color": "#007bff", "bg_color": "" }},
        { "id": "cell3", "type": "qrcode", "name": "SERI_NO", "rowspan": 3, "colspan": 2, "align": "center", "style": { "font_size": "10pt", "color": "#000000", "bg_color": "" }},

        { "id": "cell4", "type": "static_text", "content": "Model:", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "8pt", "color": "#000000", "bg_color": "" }},
        { "id": "cell5", "type": "text", "name": "MODEL", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "8pt", "color": "#000000", "bg_color": "" }},
        
        { "id": "cell6", "type": "static_text", "content": "Seri No:", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "8pt", "color": "#000000", "bg_color": "" }},
        { "id": "cell7", "type": "text", "name": "SERI_NO", "rowspan": 1, "colspan": 2, "align": "left", "style": { "font_size": "8pt", "color": "#000000", "bg_color": "" }},

        { "id": "cell8", "type": "barcode_text", "name": "SERI_NO", "rowspan": 1, "colspan": 6, "align": "center", "style": { "font_size": "14pt", "color": "#000000", "bg_color": "#f0f0f0" }},
    ];

    // Etiket HTML Oluşturma Mantığı
    const generateLabels = (data, template) => {
        const labels = [];
        const TOTAL_COLS = 6;
        
        for (const row of data) {
            let labelContent = '';
            let currentGrid = 0; 
            let rowSpans = new Array(TOTAL_COLS).fill(0); 
            let templateIndex = 0;

            labelContent += '<div class="etiket-kutu">';
            labelContent += '<div class="etiket-grid">';

            while (templateIndex < template.length || rowSpans.some(span => span > 0)) {
                
                while(currentGrid < TOTAL_COLS && rowSpans[currentGrid] > 0) {
                    rowSpans[currentGrid]--;
                    currentGrid++;
                }

                if (currentGrid >= TOTAL_COLS) {
                    currentGrid = 0;
                    continue; 
                }
                
                const item = template[templateIndex];
                
                if (!item) {
                    while (currentGrid < TOTAL_COLS) {
                         if (rowSpans[currentGrid] <= 0) { 
                             labelContent += '<div class="label-cell" style="grid-column: span 1; visibility: hidden; border: none;"></div>';
                         }
                         if(rowSpans[currentGrid] > 0) rowSpans[currentGrid]--;
                         currentGrid++;
                    }
                    break; 
                }
                
                const colspan = item.colspan || 1;
                const rowspan = item.rowspan || 1;
                
                if (colspan > (TOTAL_COLS - currentGrid)) {
                   console.error("HATA: Statik şablon grid sınırlarını aşıyor!");
                   templateIndex++;
                   continue;
                }

                let commonTextStyle = `font-size: ${item.style.font_size}; color: ${item.style.color}; background-color: ${item.style.bg_color || 'transparent'};`;

                labelContent += `<div class="label-cell" style="grid-column: span ${colspan}; grid-row: span ${rowspan}; text-align: ${item.align};">`;
                
                const itemType = item.type;
                if (itemType === 'qrcode' || itemType === 'barcode_image') {
                    const dataValue = row[item.name] || 'VERI_YOK';
                    const encodedData = encodeURIComponent(dataValue);
                    const qrCodeUrl = `/qrcode/${encodedData}`;
                    
                    labelContent += `<div style="text-align: center; padding: 5px; height: 100%;">
                        <img src="${qrCodeUrl}" alt="QR Kod: ${dataValue}" style="max-height: 100%; width: auto; max-width: 100%; display: block; margin: 0 auto;">
                    </div>`;

                } else if (itemType === 'static_text') {
                    labelContent += `<div style="text-align: ${item.align}; ${commonTextStyle}">${item.content}</div>`;
                } else if (itemType === 'text' || itemType === 'barcode_text') {
                    const dataValue = row[item.name] || 'VERI YOK';
                    const textAlign = itemType === 'barcode_text' ? 'center' : item.align;
                    labelContent += `<div style="text-align: ${textAlign}; ${commonTextStyle}">${dataValue}</div>`;
                }
                
                labelContent += '</div>'; 

                if (rowspan > 1) {
                    for(let i=currentGrid; i < currentGrid + colspan; i++) {
                       rowSpans[i] = rowspan - 1; 
                    }
                }
                
                currentGrid += colspan;
                templateIndex++;
            }
            
            labelContent += '</div>'; 
            labelContent += '</div>'; 
            labels.push(labelContent);
        }
        return labels;
    };
    
    const labelsHtml = generateLabels(dataToPrint, defaultTemplate);
    
    res.render('print_preview.html', { 
        title: 'Yazdırma Önizlemesi',
        labels: labelsHtml, 
    });
});


// Sunucuyu Başlat
app.listen(PORT, () => {
    console.log(`Server çalışıyor: http://localhost:${PORT}`);
});
