import { type ReactNode } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

interface FormFieldProps extends Omit<TextInputProps, 'placeholderTextColor'> {
  label: string;
  /** Optional helper or error text under the field. */
  hint?: string;
  error?: string;
  /** Optional trailing content (e.g. a unit suffix). */
  trailing?: ReactNode;
}

/**
 * Labeled text input themed with NativeWind tokens. `placeholderTextColor` has
 * no NativeWind equivalent, so it reads the Bloom theme color directly.
 */
export function FormField({ label, hint, error, trailing, className, multiline, ...rest }: FormFieldProps) {
  const theme = useTheme();
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">{label}</Text>
      <View className="flex-row items-center">
        <TextInput
          className={cn(
            'flex-1 rounded-xl border border-border bg-surface px-3.5 text-foreground',
            multiline ? 'py-3 min-h-[96px]' : 'h-12',
            error ? 'border-destructive' : '',
            className,
          )}
          placeholderTextColor={theme.colors.textSecondary}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          {...rest}
        />
        {trailing}
      </View>
      {error ? (
        <Text className="text-xs text-destructive mt-1">{error}</Text>
      ) : hint ? (
        <Text className="text-xs text-muted-foreground mt-1">{hint}</Text>
      ) : null}
    </View>
  );
}
