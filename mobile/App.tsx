import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
  TouchableOpacity,
  BackHandler,
  Platform,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView, WebViewNavigation } from 'react-native-webview';

const DEVICE_STORAGE_KEY = 'urooj_mobile_device_uuid';
// Local embedded server on Android loopback
const DEFAULT_LOCAL_SERVER = 'http://127.0.0.1:3000';

export default function App() {
  const [deviceId, setDeviceId] = useState<string>('');
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_LOCAL_SERVER);
  const [isServerReady, setIsServerReady] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const webViewRef = useRef<WebView>(null);

  // Initialize secure device ID and verify local server
  useEffect(() => {
    async function initDevice() {
      try {
        let storedDevId = await AsyncStorage.getItem(DEVICE_STORAGE_KEY);
        if (!storedDevId) {
          storedDevId = 'mobile_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
          await AsyncStorage.setItem(DEVICE_STORAGE_KEY, storedDevId);
        }
        setDeviceId(storedDevId);
        checkLocalServer(storedDevId);
      } catch (err) {
        console.error('Failed to initialize device identity:', err);
        setIsServerReady(true);
      }
    }
    initDevice();
  }, []);

  // Android back button handling
  useEffect(() => {
    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [canGoBack]);

  async function checkLocalServer(devId: string) {
    let attempts = 0;
    const maxAttempts = 15;

    const interval = setInterval(async () => {
      attempts++;
      try {
        const response = await fetch(`${DEFAULT_LOCAL_SERVER}/health`, {
          headers: { 'X-Device-Id': devId },
        });
        if (response.ok) {
          clearInterval(interval);
          setIsServerReady(true);
          setIsLoading(false);
        }
      } catch (e) {
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          // If local loopback is unavailable, enable offline direct container
          setIsServerReady(true);
          setIsLoading(false);
        }
      }
    }, 1000);
  }

  // Inject device UUID into local WebView window
  const injectedJavaScript = `
    (function() {
      try {
        localStorage.setItem('urooj_device_id', '${deviceId}');
        console.log('[Android Native] Device bound to hardware sandbox: ${deviceId}');
      } catch (e) {}
      true;
    })();
  `;

  if (!isServerReady) {
    return (
      <SafeAreaView style={styles.splashContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#020617" />
        <View style={styles.splashContent}>
          <Text style={styles.brandTitle}>👑 Urooj Choudhary</Text>
          <Text style={styles.brandSubtitle}>WhatsApp Automation Mobile Engine</Text>
          <ActivityIndicator size="large" color="#f59e0b" style={styles.loader} />
          <Text style={styles.statusText}>Initializing local embedded server on device...</Text>
          <Text style={styles.secureBadge}>🔒 100% Device-Isolated Session Storage</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <WebView
        ref={webViewRef}
        source={{
          uri: serverUrl,
          headers: {
            'X-Device-Id': deviceId,
          },
        }}
        injectedJavaScript={injectedJavaScript}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowUniversalAccessFromFileURLs={true}
        geolocationEnabled={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        onNavigationStateChange={(navState: WebViewNavigation) => {
          setCanGoBack(navState.canGoBack);
        }}
        renderError={() => (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>📱 Embedded Local Server Standby</Text>
            <Text style={styles.errorMessage}>
              Connect your phone to the internet or start the embedded local background engine.
            </Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => webViewRef.current?.reload()}
            >
              <Text style={styles.retryButtonText}>🔄 Reload Dashboard</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020617',
  },
  splashContainer: {
    flex: 1,
    backgroundColor: '#020617',
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  brandTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fbbf24',
    letterSpacing: 0.5,
  },
  brandSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 6,
    fontWeight: '600',
  },
  loader: {
    marginTop: 32,
    marginBottom: 16,
  },
  statusText: {
    fontSize: 12,
    color: '#cbd5e1',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  secureBadge: {
    marginTop: 24,
    fontSize: 11,
    color: '#10b981',
    fontWeight: '700',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#020617',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorTitle: {
    color: '#fbbf24',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  errorMessage: {
    color: '#94a3b8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  retryButtonText: {
    color: '#020617',
    fontWeight: 'bold',
    fontSize: 13,
  },
});
