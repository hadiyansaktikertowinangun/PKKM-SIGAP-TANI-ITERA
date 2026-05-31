/**
 * ═══════════════════════════════════════════════════════════════════
 * SIGAP TANI — Smart Farming Dashboard
 * script.js  |  MQTT Logic + UI Interactivity
 *
 * Broker  : HiveMQ Public Broker (WebSocket)
 * URL     : wss://broker.hivemq.com:8000/mqtt
 * Library : MQTT.js (dimuat via CDN di index.html)
 *
 * ─────────────────────────────────────────────────────────────────
 * CARA PENYESUAIAN DENGAN ESP32:
 *   Sesuaikan nilai TOPICS di bawah agar sama persis dengan
 *   topic yang digunakan di kode Arduino/ESP32 Anda.
 *   Format payload harus konsisten antara ESP32 dan dashboard ini.
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────
   1. KONFIGURASI BROKER MQTT
   ─────────────────────────────────────────────────────────────────
   Ubah BROKER_URL jika menggunakan broker pribadi.
   CLIENT_ID harus unik agar tidak konflik saat banyak klien.
─────────────────────────────────────────────────────────────────── */
const BROKER_URL = 'wss://8511fa93d5ce422c99806a1449b516e4.s1.eu.hivemq.cloud:8884/mqtt';

const MQTT_OPTIONS = {
  // ID klien unik — digabung dengan timestamp agar tidak collision
  clientId: 'sigaptani_web_' + Math.random().toString(16).slice(2, 8),
  // Nama bersih yang tampil di broker (opsional)
  username: 'SIGAPTANI',
  password: 'Sigap123!@#',
  // Keep-alive dalam detik; reconnect otomatis jika koneksi putus
  keepalive: 60,
  // Coba konek ulang otomatis
  reconnectPeriod: 3000,
  // Timeout koneksi (ms)
  connectTimeout: 10000,
  // Gunakan MQTT versi 3.1.1
  protocolVersion: 4,
};

/* ─────────────────────────────────────────────────────────────────
   2. TOPIK MQTT (SESUAIKAN DENGAN ESP32 ANDA)
   ─────────────────────────────────────────────────────────────────
   FORMAT TOPIK: sigaptani/<modul>/<data>
   
   SUBSCRIBE → Dashboard menerima data dari ESP32
   PUBLISH   → Dashboard mengirim perintah ke ESP32
─────────────────────────────────────────────────────────────────── */
const TOPICS = {
  // ── SUBSCRIBE: Data sensor dari ESP32 ──────────────────────────

  /**
   * PIR Sensor
   * ESP32 publish: "1" = hama terdeteksi, "0" = aman
   * Contoh kode ESP32: client.publish("sigaptani/pir", "1");
   */
  PIR: 'sigaptani/pir',

  /**
   * INA219 — Data kelistrikan solar panel
   * ESP32 publish payload JSON: {"v":12.5,"i":350.2,"p":4.37}
   * v = voltage (Volt), i = current (mA), p = power (Watt)
   * Contoh: client.publish("sigaptani/ina219", "{\"v\":12.5,\"i\":350.2,\"p\":4.37}");
   */
  INA219: 'sigaptani/ina219',

  /**
   * Solar Tracker — Nilai 4 LDR
   * ESP32 publish payload JSON: {"tl":800,"tr":620,"bl":750,"br":580}
   * tl=top-left, tr=top-right, bl=bot-left, br=bot-right (nilai ADC 0–4095)
   */
  LDR: 'sigaptani/ldr',

  /**
   * Status Motor DC dari Solar Tracker
   * ESP32 publish: "DIAM" / "KIRI" / "KANAN" / "NAIK" / "TURUN"
   */
  MOTOR: 'sigaptani/motor',

  // ── PUBLISH: Perintah dari Dashboard ke ESP32 ─────────────────

  /**
   * Relay UV Trap
   * Dashboard publish: "ON" atau "OFF"
   * ESP32 subscribe: client.subscribe("sigaptani/relay/uvtrap");
   * ESP32 handler: if(payload=="ON") digitalWrite(RELAY_UV, HIGH);
   */
  RELAY_UVTRAP: 'sigaptani/relay/uvtrap',

  /**
   * Relay Speaker
   * Dashboard publish: "ON" atau "OFF"
   * ESP32 subscribe: client.subscribe("sigaptani/relay/speaker");
   */
  RELAY_SPEAKER: 'sigaptani/relay/speaker',
};

/* ─────────────────────────────────────────────────────────────────
   3. STATE APLIKASI
─────────────────────────────────────────────────────────────────── */
let mqttClient = null;

/** Counter hama yang terdeteksi hari ini */
let pestDetectionCount = 0;

/** Riwayat data daya untuk sparkline chart (maks 30 titik) */
const powerHistory = {
  labels:  [],
  voltage: [],
  current: [],
  power:   [],
};
const MAX_HISTORY = 30;

/** Nilai maksimum referensi untuk bar progress */
const MAX_VOLTAGE = 25;   // Volt  — sesuaikan dengan rating panel Anda
const MAX_CURRENT = 2000; // mA
const MAX_POWER   = 50;   // Watt

/** Nilai maksimum LDR (ADC ESP32 = 0–4095) */
const MAX_LDR = 4095;

/** Canvas sparkline chart */
let chartCanvas = null;
let chartCtx    = null;

/* ─────────────────────────────────────────────────────────────────
   4. INISIALISASI — Dipanggil saat DOM siap
─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectMQTT();
  // Set tampilan awal
  updatePestUI(false);
  updateLDR({ tl: 0, tr: 0, bl: 0, br: 0 });
  updateMotorUI('DIAM');
});

/* ─────────────────────────────────────────────────────────────────
   5. KONEKSI MQTT
─────────────────────────────────────────────────────────────────── */
/**
 * connectMQTT()
 * Membuat koneksi ke broker HiveMQ via WebSocket.
 * MQTT.js (versi global window.mqtt) harus sudah dimuat oleh CDN.
 */
function connectMQTT() {
  setConnectionStatus('connecting');

  try {
    mqttClient = mqtt.connect(BROKER_URL, MQTT_OPTIONS);
  } catch (err) {
    console.error('[SIGAP TANI] Gagal inisialisasi MQTT:', err);
    setConnectionStatus('disconnected');
    return;
  }

  /* ── EVENT: Berhasil terhubung ── */
  mqttClient.on('connect', () => {
    console.log('[SIGAP TANI] ✅ Terhubung ke broker:', BROKER_URL);
    setConnectionStatus('connected');

    // Subscribe ke semua topik sensor yang diperlukan
    const subscribeTopics = [
      TOPICS.PIR,
      TOPICS.INA219,
      TOPICS.LDR,
      TOPICS.MOTOR,
    ];
    mqttClient.subscribe(subscribeTopics, { qos: 0 }, (err) => {
      if (err) {
        console.error('[SIGAP TANI] Gagal subscribe:', err);
      } else {
        console.log('[SIGAP TANI] 📡 Subscribe berhasil ke:', subscribeTopics);
      }
    });
  });

  /* ── EVENT: Menerima pesan ── */
  mqttClient.on('message', (topic, messageBuffer) => {
    const payload = messageBuffer.toString().trim();
    console.log(`[MQTT ←] ${topic}: ${payload}`);
    handleIncomingMessage(topic, payload);
  });

  /* ── EVENT: Koneksi terputus ── */
  mqttClient.on('disconnect', () => {
    console.warn('[SIGAP TANI] ⚠️ Koneksi terputus');
    setConnectionStatus('disconnected');
  });

  /* ── EVENT: Gagal terhubung / error ── */
  mqttClient.on('error', (err) => {
    console.error('[SIGAP TANI] ❌ Error MQTT:', err.message);
    setConnectionStatus('disconnected');
  });

  /* ── EVENT: Mencoba konek ulang ── */
  mqttClient.on('reconnect', () => {
    console.log('[SIGAP TANI] 🔄 Mencoba konek ulang...');
    setConnectionStatus('connecting');
  });

  /* ── EVENT: Koneksi ditutup ── */
  mqttClient.on('close', () => {
    setConnectionStatus('disconnected');
  });
}

/* ─────────────────────────────────────────────────────────────────
   6. ROUTER PESAN MQTT
─────────────────────────────────────────────────────────────────── */
/**
 * handleIncomingMessage(topic, payload)
 * Mengarahkan setiap pesan MQTT ke handler yang sesuai.
 *
 * @param {string} topic   - Topik MQTT yang diterima
 * @param {string} payload - Isi pesan sebagai string
 */
function handleIncomingMessage(topic, payload) {
  switch (topic) {
    case TOPICS.PIR:
      handlePIRData(payload);
      break;

    case TOPICS.INA219:
      handleINA219Data(payload);
      break;

    case TOPICS.LDR:
      handleLDRData(payload);
      break;

    case TOPICS.MOTOR:
      handleMotorData(payload);
      break;

    default:
      // Topik tidak dikenal — abaikan atau log untuk debug
      console.log('[SIGAP TANI] Topik tidak dikenal:', topic);
  }
}

/* ─────────────────────────────────────────────────────────────────
   7. HANDLER DATA SENSOR
─────────────────────────────────────────────────────────────────── */

/**
 * handlePIRData(payload)
 * Memproses data dari sensor PIR.
 *
 * Payload dari ESP32:
 *   "1" → Hama/gerakan terdeteksi
 *   "0" → Aman, tidak ada gerakan
 *
 * ESP32 Arduino contoh:
 *   if (digitalRead(PIR_PIN) == HIGH) {
 *     client.publish("sigaptani/pir", "1");
 *   } else {
 *     client.publish("sigaptani/pir", "0");
 *   }
 */
function handlePIRData(payload) {
  const isAlert = (payload === '1' || payload.toLowerCase() === 'detected');
  updatePestUI(isAlert);

  if (isAlert) {
    pestDetectionCount++;
    document.getElementById('totalDetections').textContent = pestDetectionCount;
    document.getElementById('lastTriggerTime').textContent = getCurrentTime();
    console.log('[PIR] 🚨 Hama terdeteksi! Total hari ini:', pestDetectionCount);
    
    // 👇 BARIS INI YANG DITAMBAHKAN UNTUK LOG
    addLog('🚨 Hama terdeteksi oleh Sensor PIR!', 'alert');
  } 
  // (Opsional) Jika ingin log saat kondisi kembali aman, hapus tanda // di bawah ini:
  /*
  else {
    addLog('Kondisi kembali aman, pergerakan hilang.', 'info');
  }
  */
}

/**
 * handleINA219Data(payload)
 * Memproses data kelistrikan dari sensor INA219.
 *
 * Payload dari ESP32 harus berupa JSON:
 *   {"v":12.5,"i":350.2,"p":4.37}
 *
 * Jika ESP32 kirim nilai terpisah (tiga topik berbeda),
 * ubah TOPICS di atas menjadi 3 topik individual dan
 * buat handler terpisah untuk masing-masing.
 */
function handleINA219Data(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch (e) {
    // Fallback: jika payload bukan JSON tapi angka tunggal (misal daya saja)
    console.warn('[INA219] Payload bukan JSON valid:', payload);
    return;
  }

  const voltage = parseFloat(data.v) || 0;
  const current = parseFloat(data.i) || 0;
  const power   = parseFloat(data.p) || 0;

  // Update tampilan nilai
  document.getElementById('voltageValue').textContent = voltage.toFixed(2);
  document.getElementById('currentValue').textContent = current.toFixed(1);
  document.getElementById('powerValue').textContent   = power.toFixed(2);

  // Update bar progress (persentase terhadap nilai maksimum referensi)
  setBarProgress('barVoltage', voltage, MAX_VOLTAGE);
  setBarProgress('barCurrent', current, MAX_CURRENT);
  setBarProgress('barPower',   power,   MAX_POWER);

  // Tambah ke riwayat chart
  addPowerHistory(voltage, current, power);
  drawChart();

  console.log(`[INA219] V=${voltage}V  I=${current}mA  P=${power}W`);
}

/**
 * handleLDRData(payload)
 * Memproses data 4 sensor LDR untuk solar tracker.
 *
 * Payload dari ESP32 (JSON):
 *   {"tl":800,"tr":620,"bl":750,"br":580}
 *   tl = top-left (Kiri Atas)
 *   tr = top-right (Kanan Atas)
 *   bl = bottom-left (Kiri Bawah)
 *   br = bottom-right (Kanan Bawah)
 *   Nilai: ADC 0–4095 (ESP32) atau 0–1023 (Arduino Uno)
 *
 * Sesuaikan MAX_LDR di atas jika pakai Arduino Uno (ganti 4095 → 1023).
 */
function handleLDRData(payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch (e) {
    console.warn('[LDR] Payload bukan JSON:', payload);
    return;
  }

  const ldrValues = {
    tl: parseInt(data.tl) || 0,
    tr: parseInt(data.tr) || 0,
    bl: parseInt(data.bl) || 0,
    br: parseInt(data.br) || 0,
  };

  updateLDR(ldrValues);
  updateSunCompass(ldrValues);
  console.log('[LDR] TL=%d TR=%d BL=%d BR=%d', ldrValues.tl, ldrValues.tr, ldrValues.bl, ldrValues.br);
}

/**
 * handleMotorData(payload)
 * Memproses status motor DC dari solar tracker.
 *
 * Payload dari ESP32 (string):
 *   "DIAM"  → Motor tidak bergerak
 *   "KIRI"  → Motor bergerak ke kiri (horizontal)
 *   "KANAN" → Motor bergerak ke kanan
 *   "NAIK"  → Motor bergerak ke atas (vertikal, jika ada dual axis)
 *   "TURUN" → Motor bergerak ke bawah
 *
 * Sesuaikan nilai string dengan apa yang dikirim ESP32 Anda.
 */
function handleMotorData(payload) {
  updateMotorUI(payload.toUpperCase());
}

/* ─────────────────────────────────────────────────────────────────
   8. FUNGSI UPDATE UI
─────────────────────────────────────────────────────────────────── */

/**
 * updatePestUI(isAlert)
 * Mengubah tampilan card hama antara status AMAN dan TERDETEKSI.
 *
 * @param {boolean} isAlert - true jika hama terdeteksi
 */
function updatePestUI(isAlert) {
  const card      = document.getElementById('cardPest');
  const radar     = document.querySelector('.pest-radar');
  const statusTxt = document.getElementById('pestStatusText');
  const detailTxt = document.getElementById('pestDetail');

  if (isAlert) {
    // Tampilan ALERT: merah, pulsing cepat
    radar.classList.add('state-alert');
    radar.classList.remove('state-safe');
    statusTxt.textContent = '⚠ HAMA TERDETEKSI!';
    detailTxt.textContent  = 'Pergerakan hama terdeteksi oleh sensor PIR';
    card.style.setProperty('--card-accent', 'var(--red)');
    card.style.boxShadow   = '0 4px 40px rgba(0,0,0,0.6), 0 0 0 1px #3a1010, 0 0 30px rgba(255,59,59,0.1)';
  } else {
    // Tampilan AMAN: hijau, pulse halus
    radar.classList.add('state-safe');
    radar.classList.remove('state-alert');
    statusTxt.textContent = 'AMAN';
    detailTxt.textContent  = 'Tidak ada pergerakan hama terdeteksi';
    card.style.boxShadow   = '';
  }
}

/**
 * setBarProgress(barId, value, maxValue)
 * Mengatur lebar bar progress berdasarkan nilai sensor.
 *
 * @param {string} barId    - ID elemen bar
 * @param {number} value    - Nilai saat ini
 * @param {number} maxValue - Nilai maksimum referensi
 */
function setBarProgress(barId, value, maxValue) {
  const bar     = document.getElementById(barId);
  const percent = Math.min((value / maxValue) * 100, 100);
  bar.style.width = percent + '%';
}

/**
 * updateLDR(values)
 * Memperbarui tampilan 4 ring lingkaran LDR.
 * Ring diisi proporsional terhadap MAX_LDR.
 * Sel dengan nilai tertinggi di-highlight.
 *
 * @param {{ tl, tr, bl, br }} values - Nilai ADC tiap LDR
 */
function updateLDR(values) {
  const cells = {
    tl: { val: 'valTL', ring: 'ringTL', cell: 'ldrTL' },
    tr: { val: 'valTR', ring: 'ringTR', cell: 'ldrTR' },
    bl: { val: 'valBL', ring: 'ringBL', cell: 'ldrBL' },
    br: { val: 'valBR', ring: 'ringBR', cell: 'ldrBR' },
  };

  // Panjang keliling lingkaran = 2πr = 2π×34 ≈ 213.63
  const CIRCUMFERENCE = 213.63;

  // Cari nilai maksimum untuk highlight
  const maxVal = Math.max(values.tl, values.tr, values.bl, values.br);

  Object.keys(cells).forEach((key) => {
    const ids   = cells[key];
    const value = values[key] || 0;

    // Update teks nilai
    document.getElementById(ids.val).textContent = value;

    // Update ring SVG: offset = circumference × (1 - rasio)
    const ratio  = Math.min(value / MAX_LDR, 1);
    const offset = CIRCUMFERENCE * (1 - ratio);
    document.getElementById(ids.ring).style.strokeDashoffset = offset;

    // Highlight sel dengan cahaya terkuat
    const cellEl = document.getElementById(ids.cell);
    if (value === maxVal && maxVal > 0) {
      cellEl.classList.add('ldr-max');
    } else {
      cellEl.classList.remove('ldr-max');
    }
  });
}

/**
 * updateSunCompass(values)
 * Menggerakkan titik matahari pada kompas sesuai distribusi cahaya LDR.
 * Posisi dihitung dari selisih kiri-kanan (horizontal) dan atas-bawah (vertikal).
 *
 * @param {{ tl, tr, bl, br }} values
 */
function updateSunCompass(values) {
  const sumLeft   = values.tl + values.bl;
  const sumRight  = values.tr + values.br;
  const sumTop    = values.tl + values.tr;
  const sumBottom = values.bl + values.br;
  const total     = sumLeft + sumRight || 1; // hindari div-by-zero

  // Rasio -1 (kiri/atas penuh) hingga +1 (kanan/bawah penuh)
  const ratioH = (sumRight - sumLeft) / total;  // positif = kanan
  const ratioV = (sumBottom - sumTop) / total;  // positif = bawah

  // Kompas berukuran 200px, radius area aman = 80px
  const RADIUS = 80;
  const CENTER = 50; // persen

  const leftPct = CENTER + ratioH * RADIUS / 2 + '%';
  const topPct  = CENTER + ratioV * RADIUS / 2 + '%';

  document.getElementById('sunDot').style.left = leftPct;
  document.getElementById('sunDot').style.top  = topPct;
}

/**
 * updateMotorUI(direction)
 * Memperbarui tampilan status motor dengan arah dan panah.
 *
 * @param {string} direction - "DIAM" | "KIRI" | "KANAN" | "NAIK" | "TURUN"
 */
function updateMotorUI(direction) {
  const arrowMap = {
    'DIAM':  { arrow: '·',  color: 'var(--text-dim)', label: 'DIAM', speed: '0 PWM' },
    'KIRI':  { arrow: '←',  color: 'var(--green)',    label: 'BERGERAK KIRI',  speed: 'Auto' },
    'KANAN': { arrow: '→',  color: 'var(--green)',    label: 'BERGERAK KANAN', speed: 'Auto' },
    'NAIK':  { arrow: '↑',  color: 'var(--amber)',    label: 'BERGERAK NAIK',  speed: 'Auto' },
    'TURUN': { arrow: '↓',  color: 'var(--amber)',    label: 'BERGERAK TURUN', speed: 'Auto' },
  };

  const config = arrowMap[direction] || arrowMap['DIAM'];

  const arrowEl = document.getElementById('motorArrow');
  const dirEl   = document.getElementById('motorDirection');
  const spdEl   = document.getElementById('motorSpeed');

  arrowEl.textContent    = config.arrow;
  arrowEl.style.color    = config.color;
  arrowEl.style.textShadow = `0 0 12px ${config.color}`;
  dirEl.textContent      = config.label;
  spdEl.textContent      = 'Kecepatan: ' + config.speed;
}

/**
 * setConnectionStatus(state)
 * Mengubah badge status koneksi MQTT di header.
 *
 * @param {'connected'|'disconnected'|'connecting'} state
 */
function setConnectionStatus(state) {
  const badge = document.getElementById('mqttStatusBadge');
  const label = document.getElementById('statusLabel');

  badge.classList.remove('connected', 'disconnected', 'connecting');

  const map = {
    connected:    { text: 'TERHUBUNG',    cls: 'connected' },
    disconnected: { text: 'TERPUTUS',     cls: 'disconnected' },
    connecting:   { text: 'MENGHUBUNGKAN…', cls: 'connecting' },
  };

  const cfg   = map[state] || map['disconnected'];
  badge.classList.add(cfg.cls);
  label.textContent = cfg.text;
}

/* ─────────────────────────────────────────────────────────────────
   9. PUBLISH — KONTROL RELAY
─────────────────────────────────────────────────────────────────── */

/**
 * handleRelayToggle(relay, isOn)
 * Mengirim perintah ON/OFF ke relay melalui MQTT.
 * Dipanggil oleh event onchange pada elemen <input type="checkbox">.
 *
 * @param {'uvtrap'|'speaker'} relay - Identifikasi relay yang dikontrol
 * @param {boolean}            isOn  - true = ON, false = OFF
 *
 * TOPIC yang dipublish:
 *   UV Trap  → sigaptani/relay/uvtrap
 *   Speaker  → sigaptani/relay/speaker
 *
 * PAYLOAD: "ON" atau "OFF"
 *
 * ESP32 Arduino contoh (untuk UV Trap):
 *   client.subscribe("sigaptani/relay/uvtrap");
 *   void callback(char* topic, byte* payload, unsigned int length) {
 *     String msg = "";
 *     for (int i=0; i<length; i++) msg += (char)payload[i];
 *     if (String(topic) == "sigaptani/relay/uvtrap") {
 *       digitalWrite(RELAY_UV_PIN, msg == "ON" ? HIGH : LOW);
 *     }
 *   }
 */
function handleRelayToggle(relay, isOn) {
  const payload = isOn ? 'ON' : 'OFF';
  let topic, itemId, stateId;

  if (relay === 'uvtrap') {
    topic   = TOPICS.RELAY_UVTRAP;
    itemId  = 'relayUVItem';
    stateId = 'uvTrapState';
  } else if (relay === 'speaker') {
    topic   = TOPICS.RELAY_SPEAKER;
    itemId  = 'relaySpeakerItem';
    stateId = 'speakerState';
  } else {
    console.warn('[RELAY] Relay tidak dikenal:', relay);
    return;
  }

  // Kirim via MQTT
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
      if (err) {
        console.error(`[RELAY] Gagal publish ${topic}:`, err);
      } else {
        console.log(`[MQTT →] ${topic}: ${payload}`);
      }
    });
  } else {
    console.warn('[RELAY] Tidak terhubung ke broker. Perintah tidak terkirim.');
    // Kembalikan toggle ke posisi sebelumnya jika tidak terkoneksi
    alert('⚠️ Tidak terhubung ke broker MQTT. Periksa koneksi internet.');
    document.getElementById('toggle' + (relay === 'uvtrap' ? 'UVTrap' : 'Speaker')).checked = !isOn;
    return;
  }

  // Update tampilan UI relay
  const itemEl  = document.getElementById(itemId);
  const stateEl = document.getElementById(stateId);

  if (isOn) {
    itemEl.classList.add('active');
    stateEl.textContent = 'MENYALA';
  } else {
    itemEl.classList.remove('active');
    stateEl.textContent = 'MATI';
  }
}

/* ─────────────────────────────────────────────────────────────────
   10. SPARKLINE CHART (Canvas API)
   Chart sederhana tanpa library eksternal — menampilkan riwayat
   tegangan, arus, dan daya dari INA219.
─────────────────────────────────────────────────────────────────── */

/**
 * initChart()
 * Inisialisasi canvas untuk sparkline chart.
 */
function initChart() {
  chartCanvas = document.getElementById('powerChart');
  if (!chartCanvas) return;
  chartCtx = chartCanvas.getContext('2d');
  // Ukuran pixel actual
  chartCanvas.width  = chartCanvas.offsetWidth  || 600;
  chartCanvas.height = 80;
  window.addEventListener('resize', () => {
    if (!chartCanvas) return;
    chartCanvas.width = chartCanvas.offsetWidth;
    drawChart();
  });
}

/**
 * addPowerHistory(voltage, current, power)
 * Menambah data baru ke riwayat dan menjaga panjang array.
 */
function addPowerHistory(voltage, current, power) {
  const now = getCurrentTime();
  powerHistory.labels.push(now);
  powerHistory.voltage.push(voltage);
  powerHistory.current.push(current);
  powerHistory.power.push(power);

  // Batasi panjang riwayat
  if (powerHistory.labels.length > MAX_HISTORY) {
    powerHistory.labels.shift();
    powerHistory.voltage.shift();
    powerHistory.current.shift();
    powerHistory.power.shift();
  }
}

/**
 * drawChart()
 * Menggambar sparkline 3 garis (V, I, P) di canvas.
 */
function drawChart() {
  if (!chartCtx || powerHistory.power.length < 2) return;

  const w = chartCanvas.width;
  const h = chartCanvas.height;
  const n = powerHistory.power.length;

  chartCtx.clearRect(0, 0, w, h);

  // Background transparan (sudah ditangani CSS)

  /**
   * drawLine(data, maxVal, color, alpha)
   * Fungsi bantu untuk menggambar satu garis sparkline.
   */
  const drawLine = (data, maxVal, color, alpha = 0.8) => {
    if (data.length < 2) return;
    chartCtx.beginPath();
    chartCtx.strokeStyle = color;
    chartCtx.lineWidth   = 1.5;
    chartCtx.globalAlpha = alpha;

    data.forEach((val, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - (Math.min(val, maxVal) / maxVal) * (h - 8) - 4;
      i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    });
    chartCtx.stroke();
    chartCtx.globalAlpha = 1;
  };

  // Gambar garis tiap parameter
  drawLine(powerHistory.voltage, MAX_VOLTAGE, '#00ff6a', 0.7);  // Hijau = Tegangan
  drawLine(powerHistory.current, MAX_CURRENT, '#00aaff', 0.5);  // Biru  = Arus
  drawLine(powerHistory.power,   MAX_POWER,   '#ffb800', 0.9);  // Kuning= Daya

  // Legend kecil di sudut kanan atas
  chartCtx.font         = '10px Rajdhani, sans-serif';
  chartCtx.fillStyle    = '#00ff6a';
  chartCtx.fillText('V', w - 46, 12);
  chartCtx.fillStyle    = '#00aaff';
  chartCtx.fillText('I',  w - 30, 12);
  chartCtx.fillStyle    = '#ffb800';
  chartCtx.fillText('P',  w - 14, 12);
}

/* ─────────────────────────────────────────────────────────────────
   11. FUNGSI UTILITAS
─────────────────────────────────────────────────────────────────── */

/**
 * getCurrentTime()
 * Mengembalikan waktu lokal saat ini dalam format HH:MM:SS.
 *
 * @returns {string}
 */
function getCurrentTime() {
  return new Date().toLocaleTimeString('id-ID', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/* ─────────────────────────────────────────────────────────────────
   12. SIMULASI DATA (DEVELOPMENT ONLY)
   ─────────────────────────────────────────────────────────────────
   Blok ini digunakan saat TIDAK ada ESP32 yang terhubung.
   Ini akan mengirim data palsu ke fungsi handler secara langsung
   (bukan via MQTT) agar UI bisa diuji di browser.
   
   ⚠️  HAPUS atau NONAKTIFKAN blok ini saat ESP32 sudah aktif!
   Caranya: ubah   SIMULATE_DATA = true   menjadi   false
─────────────────────────────────────────────────────────────────── */
const SIMULATE_DATA = false; // ← Ganti ke false jika ESP32 sudah aktif

if (SIMULATE_DATA) {
  console.warn('[SIGAP TANI] 🧪 Mode simulasi AKTIF — data palsu akan digunakan.');

  // Simulasi status koneksi "connected" setelah 1 detik
  setTimeout(() => setConnectionStatus('connected'), 1000);

  let simTick = 0;

  setInterval(() => {
    simTick++;

    // ── Simulasi INA219 ──
    const simVoltage = +(12 + Math.sin(simTick * 0.1) * 2).toFixed(2);
    const simCurrent = +(350 + Math.random() * 100 - 50).toFixed(1);
    const simPower   = +(simVoltage * simCurrent / 1000).toFixed(2);
    handleINA219Data(JSON.stringify({ v: simVoltage, i: simCurrent, p: simPower }));

    // ── Simulasi LDR ──
    const ldrBase = 2000;
    const simLDR  = {
      tl: Math.floor(ldrBase + Math.random() * 500),
      tr: Math.floor(ldrBase + Math.random() * 500),
      bl: Math.floor(ldrBase + Math.random() * 500),
      br: Math.floor(ldrBase + Math.random() * 500),
    };
    handleLDRData(JSON.stringify(simLDR));

    // ── Simulasi Motor ──
    const dirs = ['DIAM', 'DIAM', 'DIAM', 'KIRI', 'KANAN'];
    handleMotorData(dirs[simTick % dirs.length]);

    // ── Simulasi PIR (hama muncul setiap ~15 detik) ──
    if (simTick % 15 === 0) {
      handlePIRData('1');
      setTimeout(() => handlePIRData('0'), 3000); // Kembali aman setelah 3 detik
    }

  }, 2000); // Update setiap 2 detik
}


function addLog(message, type = 'info') {
  const logContainer = document.getElementById('activityLog');
  if (!logContainer) return;

  const logItem = document.createElement('div');
  logItem.className = `log-item ${type}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = getCurrentTime(); // Memanggil fungsi waktu yang sudah ada

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-message';
  msgSpan.textContent = message;

  logItem.appendChild(timeSpan);
  logItem.appendChild(msgSpan);

  // Masukkan log terbaru di posisi paling atas
  logContainer.insertBefore(logItem, logContainer.firstChild);

  // Batasi agar maksimal hanya 50 log yang tampil agar tidak berat
  if (logContainer.children.length > 50) {
    logContainer.removeChild(logContainer.lastChild);
  }
}