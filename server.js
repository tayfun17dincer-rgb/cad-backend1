const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Temp klasörleri
const uploadDir = path.join(os.tmpdir(), 'cad_uploads');
const outputDir = path.join(os.tmpdir(), 'cad_outputs');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.dwg', '.dxf'].includes(ext)) cb(null, true);
    else cb(new Error('Sadece DWG ve DXF dosyaları kabul edilir'));
  },
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'CAD Converter Server çalışıyor',
    version: '1.0.0',
    endpoints: ['/health', '/parse/dwg', '/parse/dxf', '/convert/dwg-to-dxf'],
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'CAD Converter Server çalışıyor' });
});

// ─────────────────────────────────────────────
// DWG PARSE (DWG → DXF → JSON)
// ─────────────────────────────────────────────

app.post('/parse/dwg', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi' });

  console.log(`📥 DWG: ${req.file.originalname} (${req.file.size} bytes)`);

  const inputPath = req.file.path;
  const dxfPath = inputPath.replace(/\.dwg$/i, '.dxf');

  try {
    // DWG → DXF
    await convertDWGtoDXF(inputPath, dxfPath);

    // DXF → JSON
    const content = fs.readFileSync(dxfPath, 'utf-8');
    const parsed = parseDXF(content);

    console.log(`✅ DWG parsed: ${parsed.entities.length} entities`);

    cleanup(inputPath, dxfPath);
    res.json(parsed);
  } catch (error) {
    console.error('❌ DWG error:', error.message);
    cleanup(inputPath, dxfPath);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────
// DXF PARSE (DXF → JSON)
// ─────────────────────────────────────────────

app.post('/parse/dxf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi' });

  console.log(`📥 DXF: ${req.file.originalname} (${req.file.size} bytes)`);

  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const parsed = parseDXF(content);

    console.log(`✅ DXF parsed: ${parsed.entities.length} entities`);

    cleanup(req.file.path);
    res.json(parsed);
  } catch (error) {
    console.error('❌ DXF error:', error.message);
    cleanup(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────
// DWG → DXF CONVERT (dosya indir)
// ─────────────────────────────────────────────

app.post('/convert/dwg-to-dxf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi' });

  console.log(`📥 Convert DWG: ${req.file.originalname}`);

  const inputPath = req.file.path;
  const dxfFileName = path.basename(req.file.originalname, '.dwg') + '.dxf';
  const dxfPath = path.join(outputDir, `${Date.now()}_${dxfFileName}`);

  try {
    await convertDWGtoDXF(inputPath, dxfPath);

    res.download(dxfPath, dxfFileName, () => {
      setTimeout(() => cleanup(inputPath, dxfPath), 5000);
    });
  } catch (error) {
    console.error('❌ Convert error:', error.message);
    cleanup(inputPath, dxfPath);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────
// DWG → DXF CONVERSION
// ─────────────────────────────────────────────

function convertDWGtoDXF(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // dwg2dxf (LibreDWG)
    const cmd = `dwg2dxf "${inputPath}" -o "${outputPath}"`;
    console.log(`🔧 Running: ${cmd}`);

    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`dwg2dxf hatası: ${stderr || error.message}`));
        return;
      }
      if (!fs.existsSync(outputPath)) {
        reject(new Error('Çıktı dosyası oluşturulamadı'));
        return;
      }
      resolve(outputPath);
    });
  });
}

// ─────────────────────────────────────────────
// DXF PARSER
// ─────────────────────────────────────────────

function parseDXF(content) {
  // Normalize line endings
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim());

  const entities = [];
  const layers = new Set(['0']);

  // ENTITIES bölümünü bul
  let entitiesIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toUpperCase() === 'ENTITIES') {
      entitiesIndex = i;
      break;
    }
  }

  if (entitiesIndex === -1) {
    console.warn('⚠️ ENTITIES section not found');
    return { format: 'DXF', entities: [], layers: ['0'], bounds: null };
  }

  const KNOWN_TYPES = new Set([
    'LINE', 'CIRCLE', 'ARC', 'ELLIPSE',
    'POLYLINE', 'LWPOLYLINE', 'SPLINE',
    'POINT', 'TEXT', 'MTEXT', 'INSERT',
    'SOLID', 'TRACE', 'HATCH',
  ]);

  let i = entitiesIndex + 1;
  let currentEntity = null;
  let currentCode = '';
  let isCode = true;

  while (i < lines.length && lines[i].toUpperCase() !== 'ENDSEC') {
    const line = lines[i];

    if (!line) { i++; isCode = true; continue; }

    if (isCode) {
      currentCode = line;
      isCode = false;
    } else {
      const value = line;

      if (currentCode === '0') {
        if (currentEntity && isValidEntity(currentEntity)) {
          entities.push(currentEntity);
        }

        const type = value.toUpperCase();
        currentEntity = KNOWN_TYPES.has(type)
          ? { type, layer: '0', properties: {} }
          : null;
      } else if (currentEntity) {
        switch (currentCode) {
          case '8':  currentEntity.layer = value; layers.add(value); break;
          case '10': currentEntity.properties.x  = parseFloat(value) || 0; break;
          case '20': currentEntity.properties.y  = parseFloat(value) || 0; break;
          case '30': currentEntity.properties.z  = parseFloat(value) || 0; break;
          case '11': currentEntity.properties.x2 = parseFloat(value) || 0; break;
          case '21': currentEntity.properties.y2 = parseFloat(value) || 0; break;
          case '40': 
            currentEntity.properties.radius = parseFloat(value) || 0;
            currentEntity.properties.height = parseFloat(value) || 0;
            break;
          case '41': currentEntity.properties.radiusX = parseFloat(value) || 0; break;
          case '42': currentEntity.properties.radiusY = parseFloat(value) || 0; break;
          case '50': currentEntity.properties.startAngle = (parseFloat(value) || 0) * Math.PI / 180; break;
          case '51': currentEntity.properties.endAngle   = (parseFloat(value) || 0) * Math.PI / 180; break;
          case '1':  // TEXT içeriği
          case '3':  // MTEXT içeriği (ek satırlar)
            if (!currentEntity.properties.text) {
              currentEntity.properties.text = value;
            } else {
              currentEntity.properties.text += value;
            }
            break;
        }
      }

      isCode = true;
    }

    i++;
  }

  if (currentEntity && isValidEntity(currentEntity)) {
    entities.push(currentEntity);
  }

  console.log(`📊 Parsed: ${entities.length} entities, layers: ${Array.from(layers).join(', ')}`);

  return {
    format: 'DXF',
    entities,
    layers: Array.from(layers),
    bounds: calculateBounds(entities),
  };
}

function isValidEntity(e) {
  if (!e.type) return false;
  const p = e.properties;
  if (e.type === 'LINE')   return p.x !== undefined && p.y !== undefined;
  if (e.type === 'CIRCLE') return p.x !== undefined && p.radius !== undefined;
  if (e.type === 'ARC')    return p.x !== undefined && p.radius !== undefined;
  return true;
}

function calculateBounds(entities) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  // İlk geçiş: sadece LINE ve CIRCLE entity'leri say
  let validCount = 0;
  for (const e of entities) {
    if (e.type !== 'LINE' && e.type !== 'CIRCLE' && e.type !== 'ARC') continue;
    
    const p = e.properties;
    const xs = [p.x, p.x2].filter(v => v !== undefined && isFinite(v));
    const ys = [p.y, p.y2].filter(v => v !== undefined && isFinite(v));

    if (xs.length === 0 || ys.length === 0) continue;
    validCount++;

    for (const x of xs) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    for (const y of ys) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }

    if (p.radius && p.x !== undefined) {
      minX = Math.min(minX, p.x - p.radius);
      maxX = Math.max(maxX, p.x + p.radius);
      minY = Math.min(minY, p.y - p.radius);
      maxY = Math.max(maxY, p.y + p.radius);
    }
  }

  if (!isFinite(minX) || validCount === 0) {
    return { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  }

  // Çok büyük bounds kontrolü - muhtemelen hatalı koordinatlar
  const width = maxX - minX;
  const height = maxY - minY;

  if (width > 1e6 || height > 1e6) {
    console.log(`⚠️ Suspiciously large bounds: ${width.toFixed(0)}x${height.toFixed(0)}`);
    console.log(`   MinX: ${minX}, MaxX: ${maxX}, MinY: ${minY}, MaxY: ${maxY}`);
    
    // Medyan hesapla - outlier'ları at
    const allX = [];
    const allY = [];
    
    for (const e of entities) {
      if (e.type !== 'LINE' && e.type !== 'CIRCLE') continue;
      const p = e.properties;
      if (p.x !== undefined && isFinite(p.x)) allX.push(p.x);
      if (p.y !== undefined && isFinite(p.y)) allY.push(p.y);
      if (p.x2 !== undefined && isFinite(p.x2)) allX.push(p.x2);
      if (p.y2 !== undefined && isFinite(p.y2)) allY.push(p.y2);
    }
    
    allX.sort((a, b) => a - b);
    allY.sort((a, b) => a - b);
    
    // %5 ve %95 percentile kullan (outlier'ları at)
    const p5X = allX[Math.floor(allX.length * 0.05)];
    const p95X = allX[Math.floor(allX.length * 0.95)];
    const p5Y = allY[Math.floor(allY.length * 0.05)];
    const p95Y = allY[Math.floor(allY.length * 0.95)];
    
    minX = p5X;
    maxX = p95X;
    minY = p5Y;
    maxY = p95Y;
    
    console.log(`   Adjusted bounds: ${(maxX-minX).toFixed(0)}x${(maxY-minY).toFixed(0)}`);
  }

  const padX = (maxX - minX) * 0.05;
  const padY = (maxY - minY) * 0.05;

  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minY: minY - padY,
    maxY: maxY + padY,
  };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CAD Server running on port ${PORT}`);
});
