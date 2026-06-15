import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface RowIconProps {
  name: IoniconName;
  destructive?: boolean;
}

/**
 * Leading icon for a settings row. Colors itself via the live Bloom theme so it
 * tracks the active color preset / mode (red for destructive actions).
 */
export const RowIcon: React.FC<RowIconProps> = ({ name, destructive }) => {
  const { colors } = useTheme();
  return (
    <Ionicons
      name={name}
      size={20}
      color={destructive ? colors.error : colors.textSecondary}
    />
  );
};
