import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ua.svitlo.ukraine',
  appName: 'Світло Україна',
  webDir: 'dist/public',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#18181b',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: true,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_lightning',
      iconColor: '#FACC15',
      sound: 'default',
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#18181b',
    },
  },
  android: {
    allowMixedContent: false,
    minWebViewVersion: '80',
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'SvitloUkraine',
  },
};

export default config;
