// App.tsx — root of the bui Expo app.
//
// Navigation shape (React Navigation native-stack):
//   Pairing  → the QR-scan + manual-entry screen (unpaired entry point)
//   Sessions → the read-only session list (post-pairing)
//
// On launch we check expo-secure-store for stored credentials: paired users go
// straight to Sessions; unpaired users see Pairing. The pairing screen calls
// onPaired(creds) to persist + navigate.

import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { loadCredentials, type StoredCredentials } from "./src/api/credentials";
import { PairingScreen } from "./src/screens/PairingScreen";
import { SessionListScreen } from "./src/screens/SessionListScreen";
import { colors } from "./src/theme";

export type RootStackParamList = {
  Pairing: undefined;
  Sessions: { credentials: StoredCredentials };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  // undefined = still loading; null = unpaired; creds = paired.
  const [initial, setInitial] = useState<StoredCredentials | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let alive = true;
    loadCredentials()
      .then((creds) => {
        if (alive) setInitial(creds);
      })
      .catch(() => {
        if (alive) setInitial(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (initial === undefined) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {initial ? (
          <Stack.Screen
            name="Sessions"
            component={SessionListScreen}
            initialParams={{ credentials: initial }}
            options={{ title: "Sessions" }}
          />
        ) : (
          <Stack.Screen
            name="Pairing"
            component={PairingScreen}
            options={{ title: "Connect to your box" }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
});
