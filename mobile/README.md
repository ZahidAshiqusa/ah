# Urooj Choudhary - Standalone Android Mobile Application

This directory contains the standalone **React Native Android Mobile Application** with an **embedded local server runtime**.

---

## 🔒 Security & Device Session Isolation
- **100% Device-Bound**: Every Android phone running this application generates a private cryptographic Device UUID stored in `AsyncStorage`.
- **Zero Web Leakage**: Sessions, WhatsApp credentials (`creds.json`), and database records are isolated strictly to the physical device. No external visitor on the web can see, intercept, or use your WhatsApp account.
- **Zero Startup Barrier**: When the app opens, it automatically connects directly to your WhatsApp pairing and controls without forcing sign-in or account registration.

---

## 🛠️ How to Build the Android APK

### Prerequisites
- Node.js 18+ or 20+
- Java Development Kit (JDK 17)
- Android Studio with Android SDK (API 34) and NDK

### Step 1: Install Mobile Dependencies
```bash
cd mobile
npm install
```

### Step 2: Build Release APK
```bash
cd android
./gradlew assembleRelease
```
The compiled Android APK will be generated at:
`mobile/android/app/build/outputs/apk/release/app-release.apk`

### Step 3: Install APK directly onto your Android Phone
Connect your phone with USB Debugging enabled, or copy the `.apk` file to your phone, then run:
```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

---

## 📱 Features Available in Mobile App
- **Native Live Location**: Share genuine WhatsApp live location with duration, coordinates, and instant stop button.
- **Fake Quoted Message Reply**: Quote messages that were never sent, with interactive buttons and custom author spoofing.
- **Scheduled Message Queue**: Schedule WhatsApp dispatches with precision date/time picker, presets, and live countdown.
- **Online Tracker**: Real-time WhatsApp contact presence monitoring.
- **PTV Video & Voice Notes**: Send authentic round push-to-video notes and push-to-talk audio.
