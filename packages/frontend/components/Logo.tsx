import React from "react";
import { View, TouchableOpacity, StyleSheet, AccessibilityInfo, Pressable, Platform } from "react-native";
import { Stack, Link, useRouter } from "expo-router";

import { LogoIcon } from "@/assets/logo";
import { useTheme } from '@oxyhq/bloom/theme';

export const Logo = () => {
  const router = useRouter();
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => router.push("/")}
      style={({ pressed }) => [
        pressed ? { backgroundColor: `${theme.colors.primary}33` } : {},
        styles.container,
      ]}>
      <View style={styles.logo}>
        <LogoIcon style={styles.logoSvg} size={27}
          color={theme.colors.primary} />
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
    width: 'auto',
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderRadius: 1000,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  logo: {
    padding: 0,
    margin: 0,
  },
  logoSvg: {
  },
});
