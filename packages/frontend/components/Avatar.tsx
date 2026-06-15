import React from 'react';
import { StyleSheet, StyleProp, ViewStyle, ImageStyle, ImageSourcePropType } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Avatar as BloomAvatar } from '@oxyhq/bloom/avatar';
import { useTheme } from '@oxyhq/bloom/theme';
import { VerifiedIcon } from '@/assets/icons/verified-icon';

interface AvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  verified?: boolean;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  label?: string; // initials or single char to show when no image
  onPress?: () => void;
}

// White shield outline behind the verified check, matching the Twitter-style
// badge convention. The check mark itself is themed via `theme.colors.primary`.
const VerifiedBadge: React.FC<{ size: number }> = ({ size }) => {
  const theme = useTheme();
  const badgeSize = Math.round(size * 0.36);
  return (
    <>
      <Svg width={badgeSize} height={badgeSize} viewBox="0 0 24 24" style={StyleSheet.absoluteFill}>
        <Path
          fill="#FFFFFF"
          d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"
        />
      </Svg>
      <VerifiedIcon size={badgeSize} color={theme.colors.primary} />
    </>
  );
};

const Avatar: React.FC<AvatarProps> = ({ source, size = 40, verified = false, style, imageStyle, label, onPress }) => (
  <BloomAvatar
    source={source}
    size={size}
    verified={verified}
    verifiedIcon={verified ? <VerifiedBadge size={size} /> : undefined}
    name={label}
    style={style}
    imageStyle={imageStyle}
    onPress={onPress}
  />
);

export default React.memo(Avatar);
