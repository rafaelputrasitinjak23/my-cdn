require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { randomBytes } = require('crypto'); 
const axios = require('axios'); 
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); 

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);
const BUCKET_NAME = process.env.SUPABASE_BUCKET;

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

const shortUrlSchema = new mongoose.Schema({
    originalUrl: { type: String, required: true },
    shortCode: { type: String, required: true, unique: true },
    clicks: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const ShortUrl = mongoose.model('ShortUrl', shortUrlSchema);

const File = mongoose.model('File', fileSchema);

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 25 * 1024 * 1024 } 
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
        }

        const fileExtension = req.file.originalname.split('.').pop();
        const uniqueName = `${randomBytes(4).toString('hex')}.${fileExtension}`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(uniqueName, req.file.buffer, {
                contentType: req.file.mimetype,
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) throw uploadError;

        const proxyUrl = `${req.protocol}://${req.get('host')}/file/${uniqueName}`;

        const newFile = new File({
            originalName: req.file.originalname,
            cdnName: uniqueName,
            cdnUrl: proxyUrl, 
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        await newFile.save();

        if (typeof sendMessageToTelegram === 'function') {
            await sendMessageToTelegram(`📁 <b>File Baru Diunggah!</b>\n\n📄 <b>Nama:</b> ${newFile.originalName}\n🔗 <b>Link:</b> <a href="${proxyUrl}">${proxyUrl}</a>`);
        }

        res.status(201).json({
            message: 'File berhasil diunggah ke CDN!',
            file: newFile
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Terjadi kesalahan server.', details: error.message });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const files = await File.find().sort({ uploadedAt: -1 });
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil data file.' });
    }
});

app.delete('/api/files', async (req, res) => {
    try {
        const files = await File.find();
        
        if (files.length === 0) {
            return res.status(404).json({ message: 'Tidak ada file untuk dihapus.' });
        }

        const fileNames = files.map(file => file.cdnName);

        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove(fileNames);

        if (supabaseError) throw supabaseError;

        await File.deleteMany({});

        if (typeof sendMessageToTelegram === 'function') {
            await sendMessageToTelegram('⚠️ <b>PERINGATAN:</b> Semua file CDN telah dihapus dari server!');
        }

        res.json({ message: `✅ Berhasil menghapus ${fileNames.length} file.` });

    } catch (error) {
        console.error('Error saat menghapus file:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/files', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'files.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.delete('/api/secret-delete-all', async (req, res) => {
    try {
        const clientKey = req.headers['x-admin-key'];
        if (clientKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(403).json({ error: 'Akses Ditolak! Password salah atau tidak ada.' });
        }

        const files = await File.find();
        if (files.length === 0) {
            return res.status(404).json({ message: 'Tidak ada file untuk dihapus.' });
        }

        const fileNames = files.map(file => file.cdnName);

        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove(fileNames);

        if (supabaseError) throw supabaseError;

        await File.deleteMany({});

        res.json({ message: `✅ Berhasil menghapus ${fileNames.length} file CDN secara permanen.` });

    } catch (error) {
        console.error('Error saat menghapus:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});

app.delete('/api/file/:filename', async (req, res) => {
    try {
        const clientKey = req.headers['x-admin-key'];
        if (clientKey !== process.env.ADMIN_SECRET_KEY) {
            return res.status(403).json({ error: 'Akses Ditolak! Password salah.' });
        }

        const filename = req.params.filename;

        const { error: supabaseError } = await supabase.storage
            .from(BUCKET_NAME)
            .remove([filename]);

        if (supabaseError) throw supabaseError;

        await File.deleteOne({ cdnName: filename });

        res.json({ message: '✅ File berhasil dihapus permanen.' });

    } catch (error) {
        console.error('Error saat menghapus file tunggal:', error);
        res.status(500).json({ error: 'Gagal menghapus file.', details: error.message });
    }
});

app.get('/file/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const supabaseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${filename}`;
        
        const response = await axios.get(supabaseUrl, { responseType: 'stream' });
        
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
        
    } catch (error) {
        res.status(404).send('❌ File tidak ditemukan atau terjadi kesalahan proxy.');
    }
});

app.post('/api/shorten', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL asli tidak boleh kosong.' });
        }

        const urlRegex = /^(http|https):\/\/[^ "]+$/;
        if (!urlRegex.test(url)) {
            return res.status(400).json({ error: 'Format URL tidak valid. Harus diawali http:// atau https://' });
        }

        const shortCode = randomBytes(3).toString('hex'); 
        
        const newShortUrl = new ShortUrl({
            originalUrl: url,
            shortCode: shortCode
        });

        await newShortUrl.save();

        const shortLink = `${req.protocol}://${req.get('host')}/s/${shortCode}`;

        res.status(201).json({
            message: '✅ URL berhasil dipendekkan!',
            originalUrl: url,
            shortUrl: shortLink,
            shortCode: shortCode
        });

    } catch (error) {
        console.error('Error membuat short URL:', error);
        res.status(500).json({ error: 'Terjadi kesalahan saat memendekkan URL.' });
    }
});

app.get('/s/:shortCode', async (req, res) => {
    try {
        const { shortCode } = req.params;
        const urlData = await ShortUrl.findOne({ shortCode: shortCode });

        if (!urlData) {
            return res.status(404).send('<h1>❌ 404 - Link Tidak Ditemukan</h1><p>Short URL ini tidak terdaftar di sistem kami.</p>');
        }

        urlData.clicks += 1;
        await urlData.save();

        res.redirect(urlData.originalUrl);

    } catch (error) {
        console.error('Error redirect URL:', error);
        res.status(500).send('❌ Terjadi kesalahan server saat memproses link.');
    }
});

app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Ukuran file terlalu besar. Maksimal 25MB.' });
    }
    next(err);
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server CDN berjalan di http://localhost:${PORT}`);
    });
}

module.exports = app;