require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { randomBytes } = require('crypto'); // Ditambahkan untuk nama file unik/pendek
const axios = require('axios'); // Ditambahkan untuk proxy dan Telegram
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); 

// --- 1. INISIALISASI SUPABASE ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);
const BUCKET_NAME = process.env.SUPABASE_BUCKET;

// --- 2. KONEKSI MONGODB & SCHEMA ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Terhubung ke MongoDB'))
    .catch((err) => console.error('❌ Gagal terhubung ke MongoDB:', err));

const fileSchema = new mongoose.Schema({
    originalName: String,
    cdnName: String,
    cdnUrl: String,
    mimetype: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now }
});

const File = mongoose.model('File', fileSchema);

// --- 3. KONFIGURASI MULTER (DENGAN BATASAN 25MB) ---
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 25 * 1024 * 1024 } // Batas ukuran 25MB
});

// --- FUNGSI NOTIFIKASI TELEGRAM ---
async function sendMessageToTelegram(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    // Jika tidak ada konfigurasi Telegram, lewati saja (tidak error)
    if (!botToken || !chatId) return;

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
        await axios.post(telegramApiUrl, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
        });
    } catch (err) {
        console.error('⚠️ Gagal mengirim pesan Telegram:', err.message);
    }
}

// --- 4. ENDPOINT: UPLOAD FILE KE CDN ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
        }

        // Buat nama file unik & pendek (contoh: a1b2c3d4.jpg)
        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueName = `${randomBytes(4).toString('hex')}.${fileExtension}`;

        // a. Upload file ke Supabase Storage
        const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(uniqueName, req.file.buffer, {
                contentType: req.file.mimetype,
                cacheControl: '3600', // Optimasi cache
                upsert: false
            });

        if (uploadError) throw uploadError;

        // b. Buat URL Custom secara Dinamis (mengikuti domain server saat ini)
        const proxyUrl = `${req.protocol}://${req.get('host')}/file/${uniqueName}`;

        // c. Simpan metadata ke MongoDB
        const newFile = new File({
            originalName: req.file.originalname,
            cdnName: uniqueName,
            cdnUrl: proxyUrl, // Simpan URL custom Anda
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        await newFile.save();

        // d. Kirim Notifikasi ke Telegram
        await sendMessageToTelegram(`📁 <b>File Baru Diunggah!</b>\n\n📄 <b>Nama:</b> ${newFile.originalName}\n🔗 <b>Link:</b> <a href="${proxyUrl}">${proxyUrl}</a>`);

        res.status(201).json({
            message: 'File berhasil diunggah ke CDN!',
            file: newFile
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Terjadi kesalahan server.', details: error.message });
    }
});

// --- 5. ENDPOINT: LIHAT SEMUA FILE ---
app.get('/api/files', async (req, res) => {
    try {
        const files = await File.find().sort({ uploadedAt: -1 });
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data file.' });
    }
});

// --- 5.2 ENDPOINT: HAPUS SEMUA FILE ---
app.delete('/api/files', async (req, res) => {
    try {
        // 1. Ambil semua daftar file dari MongoDB
        const files = await File.find();
        
        if (files.length === 0) {
            return res.status(404).json({ message: 'Tidak ada file untuk dihapus.' });
        }

        // 2. Kumpulkan semua nama file (cdnName) ke dalam bentuk Array
        const fileNames = files.map(file => file.cdnName);

        // 3. Hapus file fisik dari Supabase Storage sekaligus
        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove(fileNames);

        if (supabaseError) throw supabaseError;

        // 4. Hapus semua metadata dari MongoDB
        await File.deleteMany({});

        // (Opsional) Kirim notifikasi ke Telegram bahwa semua file dihapus
        await sendMessageToTelegram('⚠️ <b>PERINGATAN:</b> Semua file CDN telah dihapus dari server!');

        res.json({ message: `✅ Berhasil menghapus ${fileNames.length} file.` });

    } catch (error) {
        console.error('Error saat menghapus file:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});



// --- 7. ENDPOINT: HALAMAN ADMIN RAHASIA ---
// URL ini jangan disebar ke orang lain!
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/files', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'files.html'));
});


// --- 8. ENDPOINT: DELETE KHUSUS ADMIN DENGAN PASSWORD ---
app.delete('/api/secret-delete-all', async (req, res) => {
    try {
        // CEK KEAMANAN: Pastikan password (secret key) yang dikirim cocok
        const clientKey = req.headers['x-admin-key'];
        if (clientKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(403).json({ error: 'Akses Ditolak! Password salah atau tidak ada.' });
        }

        // 1. Ambil semua file dari MongoDB
        const files = await File.find();
        if (files.length === 0) {
            return res.status(404).json({ message: 'Tidak ada file untuk dihapus.' });
        }

        // 2. Kumpulkan nama file
        const fileNames = files.map(file => file.cdnName);

        // 3. Hapus dari Supabase Storage
        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove(fileNames);

        if (supabaseError) throw supabaseError;

        // 4. Hapus dari MongoDB
        await File.deleteMany({});

        res.json({ message: `✅ Berhasil menghapus ${fileNames.length} file CDN secara permanen.` });

    } catch (error) {
        console.error('Error saat menghapus:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});


// --- 5.6 ENDPOINT: HAPUS SATU FILE (DENGAN PASSWORD ADMIN) ---
app.delete('/api/file/:filename', async (req, res) => {
    try {
        // 1. Cek keamanan: Pastikan password admin benar
        const clientKey = req.headers['x-admin-key'];
        if (clientKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(403).json({ error: 'Akses Ditolak! Password salah.' });
        }

        const filename = req.params.filename;

        // 2. Hapus file fisik dari Supabase Storage
        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove([filename]);

        if (supabaseError) throw supabaseError;

        // 3. Hapus metadata dari MongoDB
        await File.deleteOne({ cdnName: filename });

        res.json({ message: '✅ File berhasil dihapus permanen.' });

    } catch (error) {
        console.error('Error saat menghapus file tunggal:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});


// --- 5.5 ENDPOINT: PROXY STREAM (MENYEMBUNYIKAN SUPABASE) ---
app.get('/file/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const supabaseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${filename}`;
        
        // Kita unduh secara streaming dari Supabase, lalu langsung diteruskan ke user
        const response = await axios.get(supabaseUrl, { responseType: 'stream' });
        
        // Atur header agar browser tahu ini adalah gambar/file yang benar
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
        
    } catch (error) {
        res.status(404).send('❌ File tidak ditemukan atau terjadi kesalahan proxy.');
    }
});

// --- MIDDLEWARE ERROR HANDLER (UNTUK MULTER/FILE SIZE) ---
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Ukuran file terlalu besar. Maksimal 25MB.' });
    }
    next(err);
});

// --- 6. JALANKAN SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server CDN berjalan di http://localhost:${PORT}`);
});
