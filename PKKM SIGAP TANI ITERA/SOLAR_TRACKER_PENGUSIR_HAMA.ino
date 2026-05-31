/**
 * ============================================================================
 * SIGAP TANI — Sistem Agrikultur Pintar Berbasis ESP32
 * Firmware Version : 3.4.0 (NTP RTC UV Auto & PIR Speaker Timer)
 * Target Hardware  : ESP32 (ESP32-WROOM-32D / DevKitC v4)
 * IDE              : Arduino IDE 2.x  |  Baud Rate: 115200
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <LiquidCrystal_I2C.h>
#include <time.h> // Library bawaan ESP32 untuk mengambil waktu

// ─────────────────────────────────────────────────────────────────────────────
//  KONFIGURASI HARDWARE (PINOUT ESP32)
// ─────────────────────────────────────────────────────────────────────────────
#define PIN_PIR             13
#define PIN_LDR_TL          32
#define PIN_LDR_TR          34
#define PIN_LDR_BL          33
#define PIN_LDR_BR          35

#define PIN_RELAY_UV        16
#define PIN_RELAY_SPK       17

#define PIN_MOTOR_EN_H      15  
#define PIN_MOTOR_EN_V      14  
#define PIN_MOTOR_IN1       12  
#define PIN_MOTOR_IN2       27  
#define PIN_MOTOR_IN3       26  
#define PIN_MOTOR_IN4       25  

#define RELAY_ON            LOW
#define RELAY_OFF           HIGH

// ─────────────────────────────────────────────────────────────────────────────
//  KONFIGURASI NETWORK, HIVEMQ, & NTP (WAKTU)
// ─────────────────────────────────────────────────────────────────────────────
const char* WIFI_SSID       = "Kontrakan";
const char* WIFI_PASSWORD   = "kntrkn23";

const char* MQTT_BROKER     = "8511fa93d5ce422c99806a1449b516e4.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORT    = 8883; 
const char* DEVICE_ID       = "sigaptani_edge_01";
const char* MQTT_USER       = "SIGAPTANI";
const char* MQTT_PASS       = "Sigap123!@#";

// Topik MQTT
const char* TOPIC_PIR       = "sigaptani/pir";
const char* TOPIC_INA219    = "sigaptani/ina219";
const char* TOPIC_LDR       = "sigaptani/ldr";
const char* TOPIC_MOTOR     = "sigaptani/motor";
const char* TOPIC_UV_TRAP   = "sigaptani/relay/uvtrap";
const char* TOPIC_SPEAKER   = "sigaptani/relay/speaker";
const char* TOPIC_STATUS    = "sigaptani/status";

// Konfigurasi PWM Motor
const uint32_t PWM_FREQUENCY  = 5000;
const uint8_t  PWM_RESOLUTION = 8;

// Konfigurasi NTP Server (Waktu WIB: UTC + 7 jam)
const char* NTP_SERVER      = "pool.ntp.org";
const long  GMT_OFFSET_SEC  = 25200; // 7 * 3600 (WIB)
const int   DAYLIGHT_OFFSET_SEC = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  INSTANSIASI OBJEK & STRUKTUR DATA
// ─────────────────────────────────────────────────────────────────────────────
Adafruit_INA219   ina219;
WiFiClientSecure  wifiClient;
PubSubClient      mqttClient(wifiClient);
LiquidCrystal_I2C lcd(0x27, 16, 4);

struct SensorData {
  float voltage_V;
  float current_mA;
  float power_W;
  bool  pir_detected;
  int   ldr_tl, ldr_tr, ldr_bl, ldr_br;
} g_sensor;

struct ActuatorState {
  bool uv_trap;
  bool speaker;
  int  motor_h_speed; 
  int  motor_v_speed; 
  char motor_h_dir[8]; 
  char motor_v_dir[8]; 
} g_relay;

// Timer Global
unsigned long g_last_send_ms = 0;
const unsigned long INTERVAL_SEND_MS = 3000; 

// Variabel Kontrol Timer Speaker
unsigned long g_speaker_timer_ms = 0;
bool g_speaker_active = false;
bool g_speaker_cooldown = false;

// Prototipe Fungsi
void updateLCDDisplay();
void logHeartbeat();
void checkUVSchedule();

// ─────────────────────────────────────────────────────────────────────────────
//  FUNGSI PENGATURAN MOTOR
// ─────────────────────────────────────────────────────────────────────────────
void initLedc() {
  ledcAttach(PIN_MOTOR_EN_H, PWM_FREQUENCY, PWM_RESOLUTION);
  ledcAttach(PIN_MOTOR_EN_V, PWM_FREQUENCY, PWM_RESOLUTION);
}

void setMotors(const char* dirH, const char* dirV, int speedH, int speedV) {
  g_relay.motor_h_speed = speedH;
  g_relay.motor_v_speed = speedV;
  strncpy(g_relay.motor_h_dir, dirH, sizeof(g_relay.motor_h_dir));
  strncpy(g_relay.motor_v_dir, dirV, sizeof(g_relay.motor_v_dir));

  if (strcmp(dirH, "MAJU") == 0) {
    digitalWrite(PIN_MOTOR_IN1, HIGH);
    digitalWrite(PIN_MOTOR_IN2, LOW);
  } else if (strcmp(dirH, "MUNDUR") == 0) {
    digitalWrite(PIN_MOTOR_IN1, LOW);
    digitalWrite(PIN_MOTOR_IN2, HIGH);
  } else { 
    digitalWrite(PIN_MOTOR_IN1, LOW);
    digitalWrite(PIN_MOTOR_IN2, LOW);
  }

  if (strcmp(dirV, "MAJU") == 0) {
    digitalWrite(PIN_MOTOR_IN3, HIGH);
    digitalWrite(PIN_MOTOR_IN4, LOW);
  } else if (strcmp(dirV, "MUNDUR") == 0) {
    digitalWrite(PIN_MOTOR_IN3, LOW);
    digitalWrite(PIN_MOTOR_IN4, HIGH);
  } else { 
    digitalWrite(PIN_MOTOR_IN3, LOW);
    digitalWrite(PIN_MOTOR_IN4, LOW);
  }

  if (strcmp(dirH, "DIAM") == 0) ledcWrite(PIN_MOTOR_EN_H, 0);
  else ledcWrite(PIN_MOTOR_EN_H, speedH);

  if (strcmp(dirV, "DIAM") == 0) ledcWrite(PIN_MOTOR_EN_V, 0);
  else ledcWrite(PIN_MOTOR_EN_V, speedV);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNGSI UTALITAS RELAY
// ─────────────────────────────────────────────────────────────────────────────
void setRelay(uint8_t pin, bool state, const char* label) {
  digitalWrite(pin, state ? RELAY_ON : RELAY_OFF);
  Serial.printf("[RELAY] %-20s → %s\n", label, state ? "ON" : "OFF");
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNGSI BROADCAST DATA SENSOR (MQTT PUBLISH)
// ─────────────────────────────────────────────────────────────────────────────
void publishSensorData() {
  StaticJsonDocument<128> docIna;
  docIna["v"] = serialized(String(g_sensor.voltage_V, 2));
  docIna["i"] = serialized(String(g_sensor.current_mA, 1));
  docIna["p"] = serialized(String(g_sensor.power_W, 2));
  char bufIna[128];
  serializeJson(docIna, bufIna);
  mqttClient.publish(TOPIC_INA219, bufIna);

  StaticJsonDocument<128> docLdr;
  docLdr["tl"] = g_sensor.ldr_tl;
  docLdr["tr"] = g_sensor.ldr_tr;
  docLdr["bl"] = g_sensor.ldr_bl;
  docLdr["br"] = g_sensor.ldr_br;
  char bufLdr[128];
  serializeJson(docLdr, bufLdr);
  mqttClient.publish(TOPIC_LDR, bufLdr);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MQTT CALLBACK (MENERIMA PERINTAH DASHBOARD)
// ─────────────────────────────────────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  
  Serial.printf("[MQTT RECV] Topik: %s | Payload: %s\n", topic, msg.c_str());

  if (strcmp(topic, TOPIC_UV_TRAP) == 0) {
    g_relay.uv_trap = (msg == "ON");
    setRelay(PIN_RELAY_UV, g_relay.uv_trap, "UV Pest Trap (Manual)");
  } else if (strcmp(topic, TOPIC_SPEAKER) == 0) {
    // Mode manual MQTT, timer otomatis akan meng-override jika PIR mendeteksi sesuatu
    g_relay.speaker = (msg == "ON");
    setRelay(PIN_RELAY_SPK, g_relay.speaker, "Hoot Speaker (Manual)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MANAJEMEN KONEKSI NETWORK & BROKER
// ─────────────────────────────────────────────────────────────────────────────
void connectToNetwork() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.print(F("[NET] Menghubungkan ke WiFi..."));
    lcd.setCursor(0, 2);
    lcd.print("WiFi: Connecting...");
    
    while (WiFi.status() != WL_CONNECTED) {
      delay(500);
      Serial.print(".");
    }
    Serial.printf("\n[NET] Terhubung! IP: %s\n", WiFi.localIP().toString().c_str());
    lcd.setCursor(0, 2);
    lcd.print("WiFi: Connected    ");

    // Sinkronisasi Waktu Server setiap kali WiFi connect
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  }

  while (!mqttClient.connected()) {
    Serial.print(F("[NET] Menghubungkan ke HiveMQ..."));
    String lwt = "{\"status\":\"offline\",\"device\":\"" + String(DEVICE_ID) + "\"}";
    
    if (mqttClient.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, TOPIC_STATUS, 0, false, lwt.c_str())) {
      Serial.println(F(" Sukses!"));
      mqttClient.publish(TOPIC_STATUS, "{\"status\":\"online\"}", true);
      mqttClient.subscribe(TOPIC_UV_TRAP);
      mqttClient.subscribe(TOPIC_SPEAKER);
    } else {
      delay(5000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNGSI PENGECEKAN JADWAL LAMPU UV
// ─────────────────────────────────────────────────────────────────────────────
void checkUVSchedule() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    return; // Gagal ambil waktu, lewatkan eksekusi
  }

  int currentHour = timeinfo.tm_hour;
  
  // Logika: ON jika jam >= 18 ATAU jam < 6 (Malam hari)
  bool shouldUvBeOn = (currentHour >= 18 || currentHour < 6);

  if (g_relay.uv_trap != shouldUvBeOn) {
    g_relay.uv_trap = shouldUvBeOn;
    setRelay(PIN_RELAY_UV, g_relay.uv_trap, "UV Pest Trap (Auto Timer)");
    
    // Update status ke MQTT agar Dashboard tersinkron
    mqttClient.publish(TOPIC_UV_TRAP, g_relay.uv_trap ? "ON" : "OFF");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOID SETUP
// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("=== SIGAP TANI ===");

  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_RELAY_UV, OUTPUT);
  pinMode(PIN_RELAY_SPK, OUTPUT);
  
  pinMode(PIN_MOTOR_IN1, OUTPUT);
  pinMode(PIN_MOTOR_IN2, OUTPUT);
  pinMode(PIN_MOTOR_IN3, OUTPUT);
  pinMode(PIN_MOTOR_IN4, OUTPUT);

  setRelay(PIN_RELAY_UV, false, "UV Pest Trap (Init)");
  setRelay(PIN_RELAY_SPK, false, "Hoot Speaker (Init)");
  
  initLedc();
  setMotors("DIAM", "DIAM", 0, 0);

  if (!ina219.begin()) {
    Serial.println(F("[WARN] Sensor INA219 tidak terdeteksi!"));
  }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  wifiClient.setInsecure(); 

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  
  lcd.clear();
  lcd.print("=== SIGAP TANI ===");
}

// ─────────────────────────────────────────────────────────────────────────────
//  VOID LOOP
// ─────────────────────────────────────────────────────────────────────────────
void loop() {
  connectToNetwork();
  mqttClient.loop();

  unsigned long currentMillis = millis();

  // ═══════════════════════════════════════════════════════════════════════
  //  1. LOGIKA SENSOR PIR & AUTO SPEAKER (10s ON -> 5s COOLDOWN)
  // ═══════════════════════════════════════════════════════════════════════
  bool currentPir = (digitalRead(PIN_PIR) == HIGH);
  
  if (currentPir != g_sensor.pir_detected) {
    g_sensor.pir_detected = currentPir;
    mqttClient.publish(TOPIC_PIR, g_sensor.pir_detected ? "1" : "0");
    Serial.printf("[EVENT] Perubahan PIR → %s\n", g_sensor.pir_detected ? "TERDETEKSI" : "AMAN");
    updateLCDDisplay();
  }

  // Jika PIR terdeteksi, speaker tidak sedang menyala, dan tidak dalam masa cooldown
  if (g_sensor.pir_detected && !g_speaker_active && !g_speaker_cooldown) {
    g_speaker_active = true;
    g_speaker_timer_ms = currentMillis; // Catat waktu mulai
    g_relay.speaker = true;
    setRelay(PIN_RELAY_SPK, true, "Speaker (PIR Trigger)");
    mqttClient.publish(TOPIC_SPEAKER, "ON");
  }

  // Jika Speaker sedang menyala dan sudah melewati 10 detik
  if (g_speaker_active && (currentMillis - g_speaker_timer_ms >= 10000)) {
    g_speaker_active = false;
    g_speaker_cooldown = true;          // Masuk masa jeda
    g_speaker_timer_ms = currentMillis; // Catat waktu mulai jeda
    g_relay.speaker = false;
    setRelay(PIN_RELAY_SPK, false, "Speaker (Timeout 10s)");
    mqttClient.publish(TOPIC_SPEAKER, "OFF");
  }

  // Jika Speaker sedang dalam masa cooldown dan sudah melewati 5 detik
  if (g_speaker_cooldown && (currentMillis - g_speaker_timer_ms >= 5000)) {
    g_speaker_cooldown = false; // Reset cooldown, siap bunyi lagi
    Serial.println("[INFO] Speaker siap menerima trigger PIR lagi.");
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  2. TASK BERKALA (SENSOR & SOLAR TRACKER) - Tiap 3 Detik
  // ═══════════════════════════════════════════════════════════════════════
  if (currentMillis - g_last_send_ms >= INTERVAL_SEND_MS) {
    g_last_send_ms = currentMillis;

    // Cek jadwal waktu UV Trap
    checkUVSchedule();

    g_sensor.ldr_tl = analogRead(PIN_LDR_TL);
    g_sensor.ldr_tr = analogRead(PIN_LDR_TR);
    g_sensor.ldr_bl = analogRead(PIN_LDR_BL);
    g_sensor.ldr_br = analogRead(PIN_LDR_BR);

    g_sensor.voltage_V = ina219.getBusVoltage_V();
    g_sensor.current_mA = ina219.getCurrent_mA();
    g_sensor.power_W = (g_sensor.voltage_V * g_sensor.current_mA) / 1000.0;
    if (g_sensor.power_W < 0) g_sensor.power_W = 0.0;

    int avgLeft   = (g_sensor.ldr_tl + g_sensor.ldr_bl) / 2;
    int avgRight  = (g_sensor.ldr_tr + g_sensor.ldr_br) / 2;
    int avgTop    = (g_sensor.ldr_tl + g_sensor.ldr_tr) / 2;
    int avgBottom = (g_sensor.ldr_bl + g_sensor.ldr_br) / 2;

    const char* dirH = "DIAM";
    const char* dirV = "DIAM";
    
    int trackingSpeedH = 215; 
    int trackingSpeedV = 180; 
    int threshold = 300;      

    if (abs(avgLeft - avgRight) > threshold) {
      if (avgLeft > avgRight) dirH = "MAJU";
      else dirH = "MUNDUR";
    }

    if (abs(avgTop - avgBottom) > threshold) {
      if (avgTop > avgBottom) dirV = "MAJU";
      else dirV = "MUNDUR";
    }

    setMotors(dirH, dirV, trackingSpeedH, trackingSpeedV);
    
    String motorStatusJson = "{\"h\":\"" + String(dirH) + "\",\"v\":\"" + String(dirV) + "\"}";
    mqttClient.publish(TOPIC_MOTOR, motorStatusJson.c_str());

    publishSensorData();
    logHeartbeat();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNGSI UPDATE LCD (Menampilkan data ke LCD 16x4)
// ─────────────────────────────────────────────────────────────────────────────
void updateLCDDisplay() {
  char buffer[21]; 
  
  snprintf(buffer, sizeof(buffer), "V:%5.2fV I:%4.0fmA", g_sensor.voltage_V, g_sensor.current_mA);
  lcd.setCursor(0, 0);
  lcd.print(buffer);
  
  snprintf(buffer, sizeof(buffer), "P:%5.2fW PIR:%-3s", g_sensor.power_W, g_sensor.pir_detected ? "DET" : "CLR");
  lcd.setCursor(0, 1);
  lcd.print(buffer);
  
  int ldrAvg = (g_sensor.ldr_tl + g_sensor.ldr_tr + g_sensor.ldr_bl + g_sensor.ldr_br) / 4;
  snprintf(buffer, sizeof(buffer), "LDR Avg: %4d   ", ldrAvg);
  lcd.setCursor(0, 2);
  lcd.print(buffer);
  
  snprintf(buffer, sizeof(buffer), "MQTT: %-10s", mqttClient.connected() ? "CONNECTED" : "DISCONN");
  lcd.setCursor(0, 3);
  lcd.print(buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERIAL HEARTBEAT LOG (Fungsi Diagnostik Terminal)
// ─────────────────────────────────────────────────────────────────────────────
void logHeartbeat() {
  Serial.println(F("\n──────────────── HEARTBEAT ────────────────"));
  
  // Mencetak waktu lokal di serial monitor
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    Serial.printf("  Waktu WIB : %02d:%02d:%02d\n", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  }
  
  Serial.printf("  Uptime    : %lu s\n", millis() / 1000);
  Serial.printf("  WiFi      : %-13s | RSSI: %d dBm\n",
                WiFi.isConnected() ? "CONNECTED" : "DISCONNECTED", WiFi.RSSI());
  Serial.printf("  MQTT      : %s\n", mqttClient.connected() ? "CONNECTED" : "DISCONNECTED");
  
  Serial.println(F("  ── Sensor Data ──"));
  Serial.printf("  Voltage   : %.2f V\n",  g_sensor.voltage_V);
  Serial.printf("  Current   : %.1f mA\n", g_sensor.current_mA);
  Serial.printf("  Power     : %.2f W\n",  g_sensor.power_W);
  Serial.printf("  PIR       : %s\n",      g_sensor.pir_detected ? "DETECTED" : "CLEAR");
  
  updateLCDDisplay(); 
  
  Serial.println(F("  ── Actuator State ──"));
  Serial.printf("  UV Trap   : %s\n", g_relay.uv_trap   ? "ON"   : "OFF");
  Serial.printf("  Speaker   : %s\n", g_relay.speaker   ? "ON"   : "OFF");
  Serial.printf("  Motor H   : %s (Speed: %d)\n", g_relay.motor_h_dir, g_relay.motor_h_speed);
  Serial.printf("  Motor V   : %s (Speed: %d)\n", g_relay.motor_v_dir, g_relay.motor_v_speed);
  Serial.println(F("────────────────────────────────────────────\n"));
}