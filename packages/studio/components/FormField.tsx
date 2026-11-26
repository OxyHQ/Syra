import { type ReactNode } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { cn } from '@/lib/utils';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
export function FormField({
  label,
  hint,
  error,
  trailing,
  className,
  multiline,
  ...rest
}: FormFieldProps) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>{label}</Text>
      <View style={styles.row}>
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
        <Text style={styles.text2}>{error}</Text>
      ) : hint ? (
        <Text style={styles.mutedText}>{hint}</Text>
      ) : null}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center' },
  text2: { marginTop: 4, fontSize: 12, color: t.destructive, lineHeight: 16 },
  mutedText: { marginTop: 4, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
}));
