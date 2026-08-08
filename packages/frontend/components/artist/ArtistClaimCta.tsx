import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@oxyhq/bloom/toast';
import { entityService } from '@/services/entityService';
import { useAuthGate } from '@/hooks/useAuthGate';
import { createScopedLogger } from '@/utils/logger';

/**
 * "Is this you?" — the claim call to action on a contributed artist profile.
 *
 * Shown only on a profile that was created from somebody else's file tags and is
 * still unclaimed. It asks for evidence in the claimant's own words because the
 * backend NEVER auto-grants: a profile built from a stranger's upload is exactly
 * where impersonation would happen, so a claim opens a pending review instead.
 * Saying that up front is part of the design — a button that looked like it
 * granted access immediately would be lying about what happens next.
 */

const logger = createScopedLogger('ArtistClaimCta');

interface ArtistClaimCtaProps {
  artistId: string;
  artistName: string;
}

export const ArtistClaimCta: React.FC<ArtistClaimCtaProps> = ({ artistId, artistName }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const [isOpen, setIsOpen] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  const claim = useMutation({
    mutationFn: () => entityService.claimArtist(artistId, evidence.trim()),
    onSuccess: () => {
      setIsSubmitted(true);
      setIsOpen(false);
      toast.success(t('artist.claim.submitted'));
    },
    onError: (error: Error) => {
      logger.error('Artist claim failed', { artistId, error });
      toast.error(error.message || t('artist.claim.failed'));
    },
  });

  // The backend requires non-empty evidence; refusing here means the claimant
  // finds out before the round trip rather than after.
  const canSubmit = evidence.trim().length > 0 && !claim.isPending;

  if (isSubmitted) {
    return (
      <View className="bg-popover" style={styles.container}>
        <View style={styles.headerRow}>
          <Ionicons name="hourglass-outline" size={18} color={theme.colors.textSecondary} />
          <Text className="text-foreground" style={styles.title}>
            {t('artist.claim.pendingTitle')}
          </Text>
        </View>
        <Text className="text-muted-foreground" style={styles.body}>
          {t('artist.claim.pendingBody')}
        </Text>
      </View>
    );
  }

  return (
    <View className="bg-popover" style={styles.container}>
      <View style={styles.headerRow}>
        <Ionicons name="person-add-outline" size={18} color={theme.colors.primary} />
        <Text className="text-foreground" style={styles.title}>
          {t('artist.claim.title', { name: artistName })}
        </Text>
      </View>
      <Text className="text-muted-foreground" style={styles.body}>
        {t('artist.claim.body')}
      </Text>

      {!isOpen ? (
        <Pressable
          onPress={() => setIsOpen(true)}
          className="bg-primary" style={styles.button}
          accessibilityRole="button"
        >
          <Text className="text-primary-foreground" style={styles.buttonText}>
            {t('artist.claim.cta')}
          </Text>
        </Pressable>
      ) : (
        <>
          <Text className="text-foreground" style={styles.label}>
            {t('artist.claim.evidenceLabel')}
          </Text>
          <TextInput className="bg-surface text-foreground"
            value={evidence}
            onChangeText={setEvidence}
            placeholder={t('artist.claim.evidencePlaceholder')}
            placeholderTextColor={theme.colors.textSecondary}
            multiline
            numberOfLines={4}
            editable={!claim.isPending}
            style={[
              styles.input,
            ]}
          />
          {!gate.canUsePrivateApi && (
            <Text className="text-error" style={styles.body}>
              {t('artist.claim.signInRequired')}
            </Text>
          )}
          <View style={styles.actions}>
            <Pressable
              onPress={() => setIsOpen(false)}
              className="bg-surface" style={styles.button}
              accessibilityRole="button"
              disabled={claim.isPending}
            >
              <Text className="text-foreground" style={styles.buttonText}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => claim.mutate()}
              disabled={!canSubmit || !gate.canUsePrivateApi}
              style={[
                styles.button,
                {
                  backgroundColor:
                    canSubmit && gate.canUsePrivateApi
                      ? theme.colors.primary
                      : theme.colors.backgroundSecondary,
                },
              ]}
              accessibilityRole="button"
            >
              {claim.isPending ? (
                <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.buttonText,
                    {
                      color:
                        canSubmit && gate.canUsePrivateApi
                          ? theme.colors.primaryForeground
                          : theme.colors.textSecondary,
                    },
                  ]}
                >
                  {t('artist.claim.submit')}
                </Text>
              )}
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    padding: 14,
    gap: 8,
    marginTop: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '700',
  },
});
