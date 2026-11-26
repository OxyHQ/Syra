import { type ReactNode } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
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
 * Labeled text input themed with Bloom tokens; `placeholderTextColor` reads the
 * Bloom theme colour. A caller's `style` lands on the input, after the field's own.
 */
export function FormField({
  label,
  hint,
  error,
  trailing,
  style,
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
          style={[
            styles.input,
            multiline ? styles.inputMultiline : styles.inputSingleLine,
            error ? styles.inputError : null,
            style,
          ]}
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
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 14,
    color: t.foreground,
  },
  inputMultiline: { minHeight: 96, paddingVertical: 12 },
  inputSingleLine: { height: 48 },
  inputError: { borderColor: t.destructive },
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center' },
  text2: { marginTop: 4, fontSize: 12, color: t.destructive, lineHeight: 16 },
  mutedText: { marginTop: 4, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
}));
