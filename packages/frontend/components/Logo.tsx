import React from "react";
import { View, StyleSheet, Pressable, Platform } from "react-native";
import { useRouter } from "expo-router";

import { LogoIcon } from "@/assets/logo";
import { useTheme } from '@oxyhq/bloom/theme';

interface LogoProps {
  color?: string;
}

export const Logo = ({ color }: LogoProps) => {
  const router = useRouter();
  const theme = useTheme();
  const logoColor = color ?? theme.colors.primary;

  return (
    <Pressable
      onPress={() => router.push("/")}
      style={({ pressed }) => [
        pressed ? { backgroundColor: `${logoColor}33` } : {},
        styles.container,
      ]}>
      <View style={styles.logo}>
        <LogoIcon style={styles.logoSvg} size={27}
          color={logoColor} />
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
