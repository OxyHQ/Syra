import React from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import type { RadioGate } from '@syra/shared-types';
import { EmptyState } from '@/components/common/EmptyState';

interface GuestPreviewGateProps {
  gate: RadioGate;
}

/**
 * Where a signed-out listener's radio station stops.
 *
 * The backend hands a guest a fixed number of tracks and then returns a
 * {@link RadioGate} in place of more of them. This explains why the station
 * ended and offers the one thing that lifts the limit. It sits at the END of
 * the tracks already served rather than over them — the preview stays usable,
 * so this is a nudge, not a wall.
 *
 * Sign-in goes through the Oxy SDK's in-app account dialog, the same entry
 * point the home screen's signed-out sections use.
 */
export const GuestPreviewGate: React.FC<GuestPreviewGateProps> = ({ gate }) => {
  const { t } = useTranslation();
  const { openAccountDialog } = useOxy();

  return (
    <EmptyState
      icon={{ name: 'radio-outline' }}
      title={t('radio.gate.title')}
      subtitle={t('radio.gate.subtitle', { seconds: gate.previewSeconds })}
      action={{
        label: t('common.signIn'),
        onPress: () => openAccountDialog('signin'),
        icon: 'log-in-outline',
      }}
      containerStyle={styles.container}
    />
  );
};

const styles = StyleSheet.create({
  // `EmptyState` is built to fill a screen; at the foot of a track list it has
  // to size to its own content and let the station background show through.
  container: {
    flex: 0,
    backgroundColor: 'transparent',
    paddingVertical: 24,
  },
});
