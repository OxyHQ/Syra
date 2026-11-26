import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { EntityProfile } from '@syra/shared-types';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface ArtistAboutProps {
  entity: EntityProfile;
  hasImage: boolean;
  onNavigateArtist: (id: string) => void;
  onOpenLink: (url: string) => void;
}

/** Render stored facts only. Partial dates stay partial; missing end dates are not "present". */
export function ArtistAbout({ entity, hasImage, onNavigateArtist, onOpenLink }: ArtistAboutProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const licence = hasImage ? entity.imageLicence : undefined;
  const facts = [
    { label: t('artist.activeFrom'), value: entity.activeFrom },
    { label: t('artist.activeUntil'), value: entity.activeUntil },
    { label: t('artist.aliases'), value: entity.aliases?.join(', ') },
    { label: t('artist.labels'), value: entity.labels?.join(', ') },
  ].filter((fact) => fact.value);
  if (
    !entity.bio &&
    !entity.disambiguation &&
    facts.length === 0 &&
    !entity.members?.length &&
    !licence
  )
    return null;

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('common.about')}
      </Text>
      {entity.bio ? (
        <Text selectable style={styles.bio}>
          {entity.bio}
        </Text>
      ) : null}
      {entity.disambiguation ? (
        <Text selectable style={styles.mutedText}>
          {entity.disambiguation}
        </Text>
      ) : null}
      {facts.map((fact) => (
        <View key={fact.label} style={styles.stack}>
          <Text style={styles.mutedText}>{fact.label}</Text>
          <Text selectable style={styles.text}>
            {fact.value}
          </Text>
        </View>
      ))}
      {entity.members?.length ? (
        <View style={styles.stack2}>
          <Text style={styles.mutedText}>{t('artist.members')}</Text>
          {entity.members.map((member, index) => (
            <View key={`${member.nameKey}:${index}`} style={styles.stack}>
              {member.catalogEntityId ? (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => {
                    if (member.catalogEntityId) onNavigateArtist(member.catalogEntityId);
                  }}
                >
                  <Text style={styles.text2}>{member.name}</Text>
                </Pressable>
              ) : (
                <Text selectable style={styles.text3}>
                  {member.name}
                </Text>
              )}
              {member.from ? (
                <Text style={styles.mutedText}>
                  {t('artist.memberFrom', { date: member.from })}
                </Text>
              ) : null}
              {member.until ? (
                <Text style={styles.mutedText}>
                  {t('artist.memberUntil', { date: member.until })}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {licence ? (
        <View style={styles.stack2}>
          <Text style={styles.mutedText}>{t('artist.imageCredit')}</Text>
          <Text selectable style={styles.text}>
            {licence.attribution}
          </Text>
          {licence.licenceUrl && /^https?:\/\//i.test(licence.licenceUrl) ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                if (licence.licenceUrl) onOpenLink(licence.licenceUrl);
              }}
            >
              <Text style={styles.text4}>{licence.licence}</Text>
            </Pressable>
          ) : (
            <Text selectable style={styles.text}>
              {licence.licence}
            </Text>
          )}
          {/^https?:\/\//i.test(licence.sourceUrl) ? (
            <Pressable accessibilityRole="link" onPress={() => onOpenLink(licence.sourceUrl)}>
              <Text style={styles.text4}>{t('artist.imageSource')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  container: { maxWidth: 896, gap: 16, paddingHorizontal: 24, paddingVertical: 24 },
  title: { fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText: { color: t.mutedForeground },
  stack: { gap: 4 },
  text: { color: t.foreground },
  stack2: { gap: 8 },
  text2: { fontSize: 16, color: t.primary, lineHeight: 24 },
  text3: { fontSize: 16, color: t.foreground, lineHeight: 24 },
  text4: { color: t.primary },
  bio: { fontSize: 16, color: t.foreground, lineHeight: 24 },
}));
