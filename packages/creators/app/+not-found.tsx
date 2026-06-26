import { Text, View } from 'react-native';
import { Link, Stack } from 'expo-router';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-2xl font-bold text-foreground mb-2">Page not found</Text>
        <Text className="text-sm text-muted-foreground text-center mb-6">
          This screen doesn&apos;t exist in the creator studio.
        </Text>
        <Link href="/" className="text-primary font-semibold text-base">
          Go to dashboard
        </Link>
      </View>
    </>
  );
}
